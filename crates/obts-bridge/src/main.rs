use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use obts_bridge::api::{ApiTokenState, AppState, serve};
use obts_bridge::config::AppConfig;
use obts_bridge::filesystem::{
    FilesystemSource, hydrate_runtime_snapshot, spawn_filesystem_worker,
    synchronize_commit_projection, synchronize_snapshot,
};
use obts_bridge::headless::{HeadlessClient, spawn_maintenance};
use obts_bridge::new_note::NewNotePathSettings;
use obts_bridge::persistence::PostgresPersistence;
use obts_bridge::runtime_config::{
    DEFAULT_CONFIG_RELOAD_INTERVAL_SECONDS, RuntimeConfigState, spawn_config_reload_poll_worker,
    spawn_config_reload_sighup_worker,
};
use obts_bridge::service::VaultBridgeService;
use obts_bridge::workers::spawn_embedding_worker;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let loaded_config =
        AppConfig::load_with_source_from_env_or_default().context("failed to load config")?;
    let config = loaded_config.config;
    let runtime_config = RuntimeConfigState::new(&config, loaded_config.source_path.clone());

    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(config.server.log_level.clone())),
        )
        .compact()
        .init();

    let persistence = if config.database.is_configured() {
        let database_host = config
            .database
            .host_for_diagnostics()
            .unwrap_or_else(|| "<unknown>".to_string());
        if Path::new("/.dockerenv").exists() && config.database.points_to_localhost() {
            anyhow::bail!(
                "database.url points to localhost ({database_host}) inside the container; use the Compose service name `postgres`"
            );
        }
        let persistence = Arc::new(
            PostgresPersistence::connect_and_migrate(&config.database, config.embedding.dimensions)
                .await
                .with_context(|| {
                    format!("failed to initialize PostgreSQL persistence at {database_host}")
                })?,
        );
        let schema = persistence
            .ensure_embedding_schema(
                config.embedding.schema_model(),
                config.embedding.dimensions,
                config.embedding.hnsw_m,
                config.embedding.hnsw_ef_construction,
            )
            .await
            .context("failed to align embedding schema with runtime config")?;
        if schema.reset_embeddings || schema.rebuilt_embedding_index {
            info!(
                reset_embeddings = schema.reset_embeddings,
                rebuilt_embedding_index = schema.rebuilt_embedding_index,
                "embedding schema updated"
            );
        }
        Some(persistence)
    } else {
        warn!(
            "database persistence is disabled; semantic and durable indexed operation is not production-ready"
        );
        None
    };

    let projection_persistence = persistence.clone();
    let store = if let Some(persistence) = persistence {
        let store = obts_bridge::store::VaultStore::new_with_persistence_and_auth_config(
            config.indexer.hub_note_threshold,
            persistence,
            runtime_config.auth_config(),
        );
        store
            .hydrate_from_persistence()
            .await
            .context("failed to hydrate the bridge index")?;
        store
    } else {
        obts_bridge::store::VaultStore::new_with_auth_config(
            config.indexer.hub_note_threshold,
            runtime_config.auth_config(),
        )
    };
    configure_store(&store, &config).await;

    let filesystem = Arc::new(if let Some(persistence) = projection_persistence {
        FilesystemSource::new_with_persistence(&config.client.vault_dir, persistence)
            .await
            .context("failed to initialize the durable headless vault projection")?
    } else {
        FilesystemSource::new(&config.client.vault_dir)
            .context("failed to initialize the headless vault filesystem")?
    });
    let headless = if config.client.auto_start {
        Some(
            HeadlessClient::spawn(&config.client)
                .await
                .context("failed to start the headless OBTS client")?,
        )
    } else {
        warn!("headless OBTS client autostart is disabled");
        None
    };
    if let Some(client) = headless.as_ref() {
        let mut guard = client
            .lock_filesystem()
            .await
            .context("failed to coordinate the initial commit projection")?;
        let had_cursor = filesystem.indexed_commit().is_some();
        if had_cursor {
            hydrate_runtime_snapshot(&store, &filesystem)
                .await
                .context("failed to hydrate runtime content from the headless vault")?;
        }
        match synchronize_commit_projection(&store, &filesystem, &mut guard, client).await {
            Ok(projected) => info!(
                projected,
                vault_dir = %filesystem.root().display(),
                "initial commit projection ready"
            ),
            Err(error) => warn!(
                error = %error,
                "initial commit projection deferred until the headless client is paired and synchronized"
            ),
        }
    } else {
        let projected = synchronize_snapshot(&store, &filesystem)
            .await
            .context("failed to build the development filesystem projection")?;
        hydrate_runtime_snapshot(&store, &filesystem)
            .await
            .context("failed to hydrate development runtime content")?;
        filesystem
            .purge_persisted_raw_content()
            .await
            .context("failed to finalize the derived-only development projection")?;
        info!(
            projected,
            vault_dir = %filesystem.root().display(),
            "development filesystem projection ready without headless commit attestation"
        );
    }

    let mut worker_handles = vec![spawn_filesystem_worker(
        store.clone(),
        filesystem.clone(),
        headless.clone(),
        Duration::from_secs(config.client.scan_interval_seconds.max(1)),
    )];
    if let Some(client) = headless.clone() {
        worker_handles.push(spawn_maintenance(
            client,
            filesystem.clone(),
            Duration::from_secs(config.client.scan_interval_seconds.max(1)),
        ));
    }
    if let Some(handle) = spawn_embedding_worker(store.clone(), &config) {
        worker_handles.push(handle);
    }
    enable_config_reload(
        &runtime_config,
        loaded_config.source_path,
        &mut worker_handles,
    )
    .await?;

    let service = VaultBridgeService::new_with_filesystem(store, filesystem, headless);
    let api_tokens = ApiTokenState::from_env_with_auth_config(runtime_config.auth_config());
    let mcp = Some(obts_bridge::mcp::McpState::from_env_with_auth_config(
        service.clone(),
        runtime_config.auth_config(),
    )?);
    let state = AppState {
        service,
        api_tokens,
        mcp,
        runtime_config,
    };
    let addr: SocketAddr = config
        .server_addr()
        .parse()
        .context("invalid server host/port combination")?;
    info!(%addr, "starting OBTS Bridge API");
    serve(state, addr).await
}

async fn configure_store(store: &obts_bridge::store::VaultStore, config: &AppConfig) {
    store
        .set_hub_settings(
            config.indexer.hub_note_threshold,
            config.indexer.hub_note_fanout,
            config.indexer.hub_note_folders.clone(),
        )
        .await;
    store
        .set_link_context_chars(config.indexer.max_link_context_chars)
        .await;
    store
        .set_context_settings(
            config.context_assembly.default_max_tokens,
            config.context_assembly.max_max_tokens,
            config.context_assembly.default_max_depth,
        )
        .await;
    store.set_embedding_settings(config.embedding.clone()).await;
    store
        .set_new_note_path_settings(NewNotePathSettings::from(&config.new_note))
        .await;
    store
        .set_audit_settings(config.audit.enabled, config.audit.retention_days)
        .await;
}

async fn enable_config_reload(
    runtime_config: &RuntimeConfigState,
    config_path: Option<std::path::PathBuf>,
    handles: &mut Vec<tokio::task::JoinHandle<()>>,
) -> anyhow::Result<()> {
    let Some(config_path) = config_path else {
        info!("config hot reload disabled because no config file was loaded");
        return Ok(());
    };
    let poll_interval = config_reload_poll_interval()?;
    runtime_config
        .enable_reload(&config_path, poll_interval)
        .await;
    if let Some(interval) = poll_interval {
        handles.push(spawn_config_reload_poll_worker(
            runtime_config.clone(),
            config_path.clone(),
            interval,
        ));
    }
    match spawn_config_reload_sighup_worker(runtime_config.clone(), config_path.clone()) {
        Ok(handle) => {
            runtime_config.set_sighup_enabled(true).await;
            handles.push(handle);
        }
        Err(error) => warn!(error = %error, "SIGHUP config reload disabled"),
    }
    info!(path = %config_path.display(), "authorization config hot reload enabled");
    Ok(())
}

fn config_reload_poll_interval() -> anyhow::Result<Option<Duration>> {
    let raw = std::env::var("CONFIG_RELOAD_INTERVAL_SECONDS")
        .unwrap_or_else(|_| DEFAULT_CONFIG_RELOAD_INTERVAL_SECONDS.to_string());
    let trimmed = raw.trim();
    let seconds = trimmed.parse::<u64>().with_context(|| {
        format!("CONFIG_RELOAD_INTERVAL_SECONDS must be a non-negative integer, got '{raw}'")
    })?;
    Ok((seconds > 0).then(|| Duration::from_secs(seconds)))
}
