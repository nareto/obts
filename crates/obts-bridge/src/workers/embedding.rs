use super::*;
use crate::markdown::{breadcrumb_prefix, parse_frontmatter, semantic_blocks};
use crate::service::{ServiceError, VaultBridgeService};
use sha2::{Digest, Sha256};

#[derive(Debug, Default)]
pub(crate) struct EmbeddingPass {
    pub matched: u64,
    pub failed: u64,
    pub provider_degraded: bool,
    pub candidates: usize,
    pub max_input_bytes: usize,
    pub max_chunk_bytes: usize,
    pub max_selected_chunks: usize,
    pub max_provider_batch: usize,
    pub last_id: String,
}

pub fn spawn_embedding_worker(
    service: VaultBridgeService,
    config: &AppConfig,
) -> Option<JoinHandle<()>> {
    let config = config.embedding.clone();
    if config.mode == EmbeddingMode::Disabled {
        return None;
    }
    Some(tokio::spawn(async move {
        let client = if config.mode == EmbeddingMode::Localai {
            match LocalAiEmbeddingClient::new(&config) {
                Ok(client) => Some(client),
                Err(_) => {
                    warn!("embedding worker: client initialization failed");
                    return;
                }
            }
        } else {
            None
        };
        let mut after = String::new();
        loop {
            match run_trusted_embedding_pass(&service, &config, client.as_ref(), &after).await {
                Ok(pass) => {
                    after = pass.last_id;
                    if pass.candidates == 0 {
                        after.clear();
                    }
                    if pass.matched > 0 {
                        service.store.record_embedding_provider_success().await;
                    }
                    if pass.failed > 0 || pass.provider_degraded {
                        service
                            .store
                            .record_embedding_provider_error("provider request failed")
                            .await;
                    }
                    debug!(
                        matched = pass.matched,
                        failed = pass.failed,
                        candidates = pass.candidates,
                        max_input_bytes = pass.max_input_bytes,
                        max_chunk_bytes = pass.max_chunk_bytes,
                        max_selected_chunks = pass.max_selected_chunks,
                        max_provider_batch = pass.max_provider_batch,
                        "embedding worker: bounded pass"
                    );
                }
                Err(_) => {
                    warn!("embedding worker: source or SQL unavailable; no fallback");
                    after.clear();
                }
            }
            sleep(config.poll_interval()).await;
        }
    }))
}

pub(crate) async fn run_trusted_embedding_pass(
    service: &VaultBridgeService,
    config: &EmbeddingConfig,
    client: Option<&LocalAiEmbeddingClient>,
    after: &str,
) -> Result<EmbeddingPass, ServiceError> {
    let store = &service.store;
    let candidates = store
        .embedding_candidates(
            after,
            config.batch_size,
            config.max_embedding_failures.max(1),
            config.block_embedding_enabled,
            config.schema_model(),
            config.dimensions.max(1),
        )
        .await?;
    let mut pass = EmbeddingPass {
        candidates: candidates.len(),
        ..Default::default()
    };
    for note in candidates {
        pass.last_id = note.id.clone();
        let Some((file, title)) = service.capture_embedding_source(&note).await? else {
            continue;
        };
        let service = service.clone();
        let config = config.clone();
        let client = client.cloned();
        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cancel_on_drop = CancelOnDrop(cancelled.clone());
        let result = tokio::spawn(async move {
            embed_captured_file(service, config, client, note, file, title, cancelled).await
        })
        .await
        .map_err(|_| ServiceError::IndexCatchingUp)??;
        drop(cancel_on_drop);
        pass.matched += result.matched;
        pass.failed += result.failed;
        pass.provider_degraded |= result.provider_degraded;
        pass.max_input_bytes = pass.max_input_bytes.max(result.max_input_bytes);
        pass.max_chunk_bytes = pass.max_chunk_bytes.max(result.max_chunk_bytes);
        pass.max_selected_chunks = pass.max_selected_chunks.max(result.max_selected_chunks);
        pass.max_provider_batch = pass.max_provider_batch.max(result.max_provider_batch);
    }
    Ok(pass)
}

struct CancelOnDrop(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

async fn embed_captured_file(
    service: VaultBridgeService,
    config: EmbeddingConfig,
    client: Option<LocalAiEmbeddingClient>,
    note: crate::store::EmbeddingNoteToken,
    file: crate::filesystem::FilesystemFile,
    title: String,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<EmbeddingPass, ServiceError> {
    let store = &service.store;
    let mut pass = EmbeddingPass::default();
    let is_cancelled = || cancelled.load(std::sync::atomic::Ordering::SeqCst);
    if is_cancelled() {
        return Ok(pass);
    }
    pass.max_input_bytes = pass.max_input_bytes.max(file.content.len());
    let (_, body) = parse_frontmatter(&file.content);
    if note.pending_note {
        let result = if let Some(client) = client.as_ref() {
            let prefix = breadcrumb_prefix(&file.path, &title, &[]);
            let text = if prefix.is_empty() {
                body.clone()
            } else {
                format!("{prefix}\n{body}")
            };
            embed_note_with_chunks(client, &text, config.note_chunk_bytes(), config.batch_size)
                .await
                .map(|result| {
                    if result.failed_chunk_count > 0 {
                        warn!(
                            failed_chunks = result.failed_chunk_count,
                            "embedding worker: skipped isolated chunks"
                        );
                    }
                    pass.max_chunk_bytes = pass.max_chunk_bytes.max(result.max_chunk_bytes);
                    pass.max_selected_chunks = pass
                        .max_selected_chunks
                        .max(result.chunk_count - result.skipped_chunk_count);
                    pass.max_provider_batch = pass.max_provider_batch.max(
                        (result.chunk_count - result.skipped_chunk_count)
                            .min(config.batch_size.clamp(1, 128)),
                    );
                    result.embedding
                })
        } else {
            Ok(crate::search::embed_text(&body, config.dimensions.max(1)))
        };
        if is_cancelled() {
            return Ok(pass);
        }
        let failed = result.is_err();
        let count = store.complete_embedding(&note, None, result.ok()).await?;
        if failed {
            pass.failed += count;
        } else {
            pass.matched += count;
        }
    }
    if config.block_embedding_enabled && !is_cancelled() {
        let (min, max, overlap) = store.embedding_block_settings().await;
        let mut page = store
            .embedding_blocks(&note, -1, config.max_embedding_failures.max(1))
            .await?
            .into_iter()
            .peekable();
        let mut last = -1i64;
        for block in semantic_blocks(&body, min, max, overlap) {
            if is_cancelled() {
                return Ok(pass);
            }
            if page.peek().is_none() {
                page = store
                    .embedding_blocks(&note, last, config.max_embedding_failures.max(1))
                    .await?
                    .into_iter()
                    .peekable();
            }
            let Some(token) = page.peek() else { break };
            if block.block_index < token.index {
                continue;
            }
            if block.block_index != token.index
                || hex::encode(Sha256::digest(block.content.as_bytes())) != token.hash
            {
                store.invalidate_embedding_projection(&note).await?;
                service.filesystem.as_ref().unwrap().mark_dirty();
                break;
            }
            let token = page.next().unwrap();
            last = token.index as i64;
            let prefix = breadcrumb_prefix(&file.path, &title, &block.heading_path);
            let text = format!("{prefix}\n{}", block.content);
            pass.max_chunk_bytes = pass.max_chunk_bytes.max(text.len());
            pass.max_provider_batch = pass.max_provider_batch.max(1);
            let result = if let Some(client) = client.as_ref() {
                client.embed_batch(&[text]).await.and_then(|mut vectors| {
                    if vectors.len() != 1 {
                        Err(WorkerError::LocalAiBatchSizeMismatch {
                            expected: 1,
                            got: vectors.len(),
                        })
                    } else {
                        Ok(vectors.remove(0))
                    }
                })
            } else {
                Ok(crate::search::embed_text(&text, config.dimensions.max(1)))
            };
            if is_cancelled() {
                return Ok(pass);
            }
            if let Err(error) = &result {
                let payload_specific = if error.should_isolate_payload() {
                    true
                } else if error.may_be_payload_specific() {
                    client
                        .as_ref()
                        .expect("LocalAI error")
                        .health_probe()
                        .await
                        .is_ok()
                } else {
                    false
                };
                if is_cancelled() {
                    return Ok(pass);
                }
                if !payload_specific {
                    pass.provider_degraded = true;
                    return Ok(pass);
                }
            }
            let failed = result.is_err();
            let count = store
                .complete_embedding(&note, Some(&token), result.ok())
                .await?;
            if failed {
                pass.failed += count;
            } else {
                pass.matched += count;
            }
        }
        if page.peek().is_some()
            || !store
                .embedding_blocks(&note, last, config.max_embedding_failures.max(1))
                .await?
                .is_empty()
        {
            store.invalidate_embedding_projection(&note).await?;
            service.filesystem.as_ref().unwrap().mark_dirty();
        }
    }
    drop(body);
    drop(file);
    Ok(pass)
}
