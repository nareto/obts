use super::*;
use crate::config::{EmbeddingConfig, EmbeddingMode};
use crate::workers::{LocalAiEmbeddingClient, run_trusted_embedding_pass};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::Semaphore;
use tokio::time::{Duration, timeout};

struct Provider {
    pause: AtomicBool,
    fail: AtomicBool,
    degraded: AtomicBool,
    entered: Semaphore,
    release: Semaphore,
    requests: AtomicUsize,
    max_batch: AtomicUsize,
    max_bytes: AtomicUsize,
    frontmatter: AtomicBool,
}
async fn provider(
    axum::extract::State(state): axum::extract::State<Arc<Provider>>,
    axum::Json(body): axum::Json<Value>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let inputs = body["input"].as_array().unwrap();
    state.requests.fetch_add(1, Ordering::SeqCst);
    state.max_batch.fetch_max(inputs.len(), Ordering::SeqCst);
    for input in inputs {
        let text = input.as_str().unwrap();
        state.max_bytes.fetch_max(text.len(), Ordering::SeqCst);
        if text.contains("only-frontmatter-marker") {
            state.frontmatter.store(true, Ordering::SeqCst);
        }
    }
    if state.pause.load(Ordering::SeqCst) {
        state.entered.add_permits(1);
        state.release.acquire().await.unwrap().forget();
    }
    if state.degraded.load(Ordering::SeqCst) {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({"error":"synthetic outage"})),
        );
    }
    if state.fail.load(Ordering::SeqCst) {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error":"synthetic failure"})),
        );
    }
    (
        axum::http::StatusCode::OK,
        axum::Json(
            serde_json::json!({"data":inputs.iter().enumerate().map(|(index,_)|serde_json::json!({"index":index,"embedding":vec![0.25;64]})).collect::<Vec<_>>()}),
        ),
    )
}
async fn fake_provider(
    pause: bool,
) -> (Arc<Provider>, EmbeddingConfig, tokio::task::JoinHandle<()>) {
    let state = Arc::new(Provider {
        pause: AtomicBool::new(pause),
        fail: AtomicBool::new(false),
        degraded: AtomicBool::new(false),
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
        requests: AtomicUsize::new(0),
        max_batch: AtomicUsize::new(0),
        max_bytes: AtomicUsize::new(0),
        frontmatter: AtomicBool::new(false),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = EmbeddingConfig {
        mode: EmbeddingMode::Localai,
        dimensions: 64,
        batch_size: 8,
        note_chunk_bytes: 256,
        ..Default::default()
    };
    config.localai.model = "synthetic".into();
    config.localai.url = format!("http://{}/v1/embeddings", listener.local_addr().unwrap());
    let router = axum::Router::new()
        .route("/v1/embeddings", axum::routing::post(provider))
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (state, config, server)
}
async fn entered(p: &Provider) {
    timeout(Duration::from_secs(10), p.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
}
fn release(p: &Provider) {
    p.pause.store(false, Ordering::SeqCst);
    p.release.add_permits(1);
}
async fn private_fixture() -> Fixture {
    let f = Fixture::with_pool_limit(128, 8 * 1024 * 1024, 1).await;
    std::fs::write(f.root.path().join("Private.md"),"---\ntags: [private]\nmarker: only-frontmatter-marker\n---\n# Private\n\nSynthetic private body.\n").unwrap();
    f.project().await;
    f
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_worker_private_note_block_localai_and_local_empty_queue() {
    let f = private_fixture().await;
    let (p, mut config, server) = fake_provider(false).await;
    f.service.store.set_embedding_settings(config.clone()).await;
    let client = LocalAiEmbeddingClient::new(&config).unwrap();
    let pass = run_trusted_embedding_pass(&f.service, &config, Some(&client), "")
        .await
        .unwrap();
    assert_eq!(pass.matched, 2);
    assert!(!p.frontmatter.load(Ordering::SeqCst));
    assert!(matches!(
        f.service
            .get_note(&reader(), &NoteId::new("Private.md"))
            .await,
        Err(ServiceError::NotFound) | Err(ServiceError::Forbidden)
    ));
    assert_eq!(
        run_trusted_embedding_pass(&f.service, &config, Some(&client), "")
            .await
            .unwrap()
            .candidates,
        0
    );
    std::fs::write(f.root.path().join("Empty.md"), "").unwrap();
    f.project().await;
    config.mode = EmbeddingMode::Local;
    f.service
        .store
        .db()
        .ensure_embedding_schema(config.schema_model(), 64, 16, 64)
        .await
        .unwrap();
    let pass = run_trusted_embedding_pass(&f.service, &config, None, "")
        .await
        .unwrap();
    assert_eq!(pass.matched, 3);
    assert_eq!(
        run_trusted_embedding_pass(&f.service, &config, None, "")
            .await
            .unwrap()
            .candidates,
        0
    );
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        1
    );
    f.assert_no_resident_text().await;
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_worker_provider_stale_success_failure_source_hash_epoch_schema() {
    for block in [false, true] {
        for failure in [false, true] {
            for change in ["revision", "hash", "derived", "schema"] {
                if !block && matches!(change, "hash" | "derived") {
                    continue;
                }
                let f = private_fixture().await;
                let (p, mut config, server) = fake_provider(true).await;
                config.block_embedding_enabled = block;
                p.fail.store(failure, Ordering::SeqCst);
                if block {
                    sqlx::query("UPDATE notes SET embedding=$1")
                        .bind(pgvector::Vector::from(vec![0.5; 64]))
                        .execute(&f.service.store.db().pool)
                        .await
                        .unwrap();
                }
                let client = LocalAiEmbeddingClient::new(&config).unwrap();
                let service = f.service.clone();
                let c = config.clone();
                let work = tokio::spawn(async move {
                    run_trusted_embedding_pass(&service, &c, Some(&client), "")
                        .await
                        .unwrap()
                });
                entered(&p).await;
                match change {
                    "schema" => {
                        f.service
                            .store
                            .db()
                            .ensure_embedding_schema("replacement", 64, 16, 64)
                            .await
                            .unwrap();
                    }
                    "revision" => {
                        sqlx::query("UPDATE notes SET couchdb_rev='new-projection'")
                            .execute(&f.service.store.db().pool)
                            .await
                            .unwrap();
                    }
                    "hash" => {
                        sqlx::query("UPDATE blocks SET content_hash='new-hash'")
                            .execute(&f.service.store.db().pool)
                            .await
                            .unwrap();
                    }
                    "derived" => {
                        sqlx::query("UPDATE blocks SET derived_epoch=nextval('bridge_embedding_generation')").execute(&f.service.store.db().pool).await.unwrap();
                    }
                    _ => unreachable!(),
                }
                let table = if block { "blocks" } else { "notes" };
                sqlx::query(&format!(
                    "UPDATE {table} SET embedding=$1,embedding_failures=2"
                ))
                .bind(pgvector::Vector::from(vec![0.75; 64]))
                .execute(&f.service.store.db().pool)
                .await
                .unwrap();
                release(&p);
                let pass = timeout(Duration::from_secs(10), work)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    (pass.matched, pass.failed),
                    (0, 0),
                    "{block}/{failure}/{change}"
                );
                let (vector, retries): (pgvector::Vector, i32) = sqlx::query_as(&format!(
                    "SELECT embedding,embedding_failures FROM {table} LIMIT 1"
                ))
                .fetch_one(&f.service.store.db().pool)
                .await
                .unwrap();
                assert_eq!(vector.to_vec(), vec![0.75; 64]);
                assert_eq!(retries, 2);
                assert_eq!(
                    f.service
                        .filesystem
                        .as_ref()
                        .unwrap()
                        .available_body_slots(),
                    1
                );
                server.abort();
                f.cleanup().await;
            }
        }
    }
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_worker_real_shared_headless_single_slot_and_cancel_drain() {
    for block in [false, true] {
        for failure in [false, true] {
            for cancel in [false, true] {
                let mut f = private_fixture().await;
                let script = f.root.path().join("synthetic-headless.cjs");
                std::fs::write(&script,"console.log(JSON.stringify({type:'event',event:'ready',state:{vault_id:'synthetic',device_id:'synthetic'}}));process.stdin.resume();setInterval(()=>{},1000);").unwrap();
                let config = crate::config::ClientConfig {
                    headless_command: format!("node {}", script.display()),
                    vault_dir: f.root.path().display().to_string(),
                    ..Default::default()
                };
                let headless = crate::headless::HeadlessClient::spawn(&config)
                    .await
                    .unwrap();
                f.service.headless = Some(headless.clone());
                let (p, mut config, server) = fake_provider(true).await;
                config.block_embedding_enabled = block;
                p.fail.store(failure, Ordering::SeqCst);
                if block {
                    sqlx::query("UPDATE notes SET embedding=$1")
                        .bind(pgvector::Vector::from(vec![0.5; 64]))
                        .execute(&f.service.store.db().pool)
                        .await
                        .unwrap();
                }
                let client = LocalAiEmbeddingClient::new(&config).unwrap();
                let held = headless.lock_filesystem().await.unwrap();
                let service = f.service.clone();
                let work = tokio::spawn(async move {
                    run_trusted_embedding_pass(&service, &config, Some(&client), "")
                        .await
                        .unwrap()
                });
                tokio::time::sleep(Duration::from_millis(50)).await;
                assert_eq!(
                    f.service
                        .filesystem
                        .as_ref()
                        .unwrap()
                        .available_body_slots(),
                    1,
                    "worker must not own body while blocked on headless"
                );
                drop(held);
                entered(&p).await;
                let service = f.service.clone();
                let api = tokio::spawn(async move {
                    service
                        .get_note(&admin(), &NoteId::new("Private.md"))
                        .await
                        .unwrap()
                });
                tokio::time::sleep(Duration::from_millis(50)).await;
                assert!(
                    timeout(Duration::from_millis(50), headless.lock_filesystem())
                        .await
                        .is_err(),
                    "API must hold the real shared headless guard while waiting for body"
                );
                if cancel {
                    work.abort();
                    assert!(work.await.unwrap_err().is_cancelled());
                    assert_eq!(
                        f.service
                            .filesystem
                            .as_ref()
                            .unwrap()
                            .available_body_slots(),
                        0,
                        "cancelled provider still owns input until drained"
                    );
                } else {
                    release(&p);
                    let pass = timeout(Duration::from_secs(10), work)
                        .await
                        .unwrap()
                        .unwrap();
                    assert_eq!(
                        (pass.matched, pass.failed),
                        if failure { (0, 1) } else { (1, 0) }
                    );
                }
                if cancel {
                    release(&p);
                }
                drop(
                    timeout(Duration::from_secs(10), api)
                        .await
                        .unwrap()
                        .unwrap(),
                );
                let table = if block { "blocks" } else { "notes" };
                let (embedded, retries): (bool, i32) = sqlx::query_as(&format!(
                    "SELECT embedding IS NOT NULL,embedding_failures FROM {table}"
                ))
                .fetch_one(&f.service.store.db().pool)
                .await
                .unwrap();
                assert_eq!(
                    embedded,
                    !cancel && !failure,
                    "late cancelled reply must not apply"
                );
                assert_eq!(retries, if !cancel && failure { 1 } else { 0 });
                assert_eq!(
                    f.service
                        .filesystem
                        .as_ref()
                        .unwrap()
                        .available_body_slots(),
                    1
                );
                server.abort();
                f.cleanup().await;
            }
        }
    }
}

async fn extra_pool(f: &Fixture, connections: u32) -> sqlx::PgPool {
    let url = std::env::var("OBTS_SYNTHETIC_POSTGRES_URL").unwrap();
    PgPoolOptions::new()
        .max_connections(connections)
        .connect_with(
            url.parse::<sqlx::postgres::PgConnectOptions>()
                .unwrap()
                .database(&f.database),
        )
        .await
        .unwrap()
}
async fn wait_locks(f: &Fixture, count: i64) {
    timeout(Duration::from_secs(10), async {
        loop {
            let waiting: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
            )
            .bind(&f.database)
            .fetch_one(&f.admin_pool)
            .await
            .unwrap();
            if waiting >= count {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_worker_blocked_completion_sql_schema_reset_already_null_pool_one() {
    for block in [false, true] {
        for failure in [false, true] {
            let f = private_fixture().await;
            let note = f
                .service
                .store
                .embedding_candidates("", 1, 3, true, "synthetic", 64)
                .await
                .unwrap()
                .remove(0);
            let token = if block {
                Some(
                    f.service
                        .store
                        .embedding_blocks(&note, -1, 3)
                        .await
                        .unwrap()
                        .remove(0),
                )
            } else {
                None
            };
            let external = extra_pool(&f, 2).await;
            let mut blocker = external.begin().await.unwrap();
            sqlx::query("SELECT id FROM notes ORDER BY id FOR UPDATE")
                .fetch_all(&mut *blocker)
                .await
                .unwrap();
            let reset_db = PostgresPersistence {
                pool: external.clone(),
            };
            let reset = tokio::spawn(async move {
                reset_db
                    .ensure_embedding_schema("new-same-dimension-model", 64, 16, 64)
                    .await
                    .unwrap()
            });
            wait_locks(&f, 1).await;
            let store = f.service.store.clone();
            let completion = tokio::spawn(async move {
                store
                    .complete_embedding(
                        &note,
                        token.as_ref(),
                        if failure { None } else { Some(vec![0.25; 64]) },
                    )
                    .await
                    .unwrap()
            });
            wait_locks(&f, 2).await;
            blocker.commit().await.unwrap();
            assert!(reset.await.unwrap().reset_embeddings);
            assert_eq!(
                timeout(Duration::from_secs(10), completion)
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
            let table = if block { "blocks" } else { "notes" };
            let (pending, retries): (bool, i32) = sqlx::query_as(&format!(
                "SELECT embedding IS NULL,embedding_failures FROM {table} LIMIT 1"
            ))
            .fetch_one(&f.service.store.db().pool)
            .await
            .unwrap();
            assert!(pending);
            assert_eq!(retries, 0);
            assert!(
                f.service
                    .store
                    .embedding_candidates("", 128, 3, true, "synthetic", 64)
                    .await
                    .unwrap()
                    .is_empty(),
                "old worker model must not capture new epochs"
            );
            let new = f
                .service
                .store
                .embedding_candidates("", 128, 3, true, "new-same-dimension-model", 64)
                .await
                .unwrap()
                .remove(0);
            let token = if block {
                Some(
                    f.service
                        .store
                        .embedding_blocks(&new, -1, 3)
                        .await
                        .unwrap()
                        .remove(0),
                )
            } else {
                None
            };
            assert_eq!(
                f.service
                    .store
                    .complete_embedding(&new, token.as_ref(), Some(vec![0.75; 64]))
                    .await
                    .unwrap(),
                1
            );
            external.close().await;
            f.cleanup().await;
        }
    }
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_worker_blocked_parent_replacement_and_combined_guards() {
    for failure in [false, true] {
        for replacement in ["revision", "hash", "derived", "combined"] {
            let f = private_fixture().await;
            let note = f
                .service
                .store
                .embedding_candidates("", 1, 3, true, "synthetic", 64)
                .await
                .unwrap()
                .remove(0);
            let token = f
                .service
                .store
                .embedding_blocks(&note, -1, 3)
                .await
                .unwrap()
                .remove(0);
            let external = extra_pool(&f, 1).await;
            let mut blocker = external.begin().await.unwrap();
            sqlx::query("SELECT id FROM notes FOR UPDATE")
                .fetch_all(&mut *blocker)
                .await
                .unwrap();
            let store = f.service.store.clone();
            let completion = tokio::spawn(async move {
                store
                    .complete_embedding(
                        &note,
                        Some(&token),
                        if failure { None } else { Some(vec![0.25; 64]) },
                    )
                    .await
                    .unwrap()
            });
            wait_locks(&f, 1).await;
            if matches!(replacement, "revision" | "combined") {
                sqlx::query("UPDATE notes SET couchdb_rev='replacement'")
                    .execute(&mut *blocker)
                    .await
                    .unwrap();
            }
            if matches!(replacement, "hash" | "combined") {
                sqlx::query("UPDATE blocks SET content_hash='replacement'")
                    .execute(&mut *blocker)
                    .await
                    .unwrap();
            }
            if matches!(replacement, "derived" | "combined") {
                sqlx::query(
                    "UPDATE blocks SET derived_epoch=nextval('bridge_embedding_generation')",
                )
                .execute(&mut *blocker)
                .await
                .unwrap();
            }
            if replacement == "combined" {
                sqlx::query(
                    "UPDATE blocks SET embedding_epoch=nextval('bridge_embedding_generation')",
                )
                .execute(&mut *blocker)
                .await
                .unwrap();
            }
            sqlx::query("UPDATE blocks SET embedding=$1,embedding_failures=2")
                .bind(pgvector::Vector::from(vec![0.75; 64]))
                .execute(&mut *blocker)
                .await
                .unwrap();
            blocker.commit().await.unwrap();
            assert_eq!(
                timeout(Duration::from_secs(10), completion)
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
            let (v, retries): (pgvector::Vector, i32) =
                sqlx::query_as("SELECT embedding,embedding_failures FROM blocks LIMIT 1")
                    .fetch_one(&f.service.store.db().pool)
                    .await
                    .unwrap();
            assert_eq!(v.to_vec(), vec![0.75; 64]);
            assert_eq!(retries, 2);
            external.close().await;
            f.cleanup().await;
        }
    }
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_worker_multipage_queue_blocks_reindex_delete_and_attestation() {
    let f = Fixture::with_pool_limit(7, 4096, 1).await;
    let config = EmbeddingConfig {
        mode: EmbeddingMode::Local,
        dimensions: 64,
        batch_size: 128,
        block_min_chars: 0,
        block_chunk_bytes: 128,
        block_chunk_overlap_sentences: 0,
        ..Default::default()
    };
    f.service.store.set_embedding_settings(config.clone()).await;
    f.service
        .store
        .db()
        .ensure_embedding_schema(config.schema_model(), 64, 16, 64)
        .await
        .unwrap();
    for i in 0..133 {
        std::fs::write(
            f.root.path().join(format!("n{i:03}.md")),
            "# Synthetic\n\nPrivate-safe fixture body.",
        )
        .unwrap();
    }
    let many = (0..270)
        .map(|i| format!("# Section {i}\n\nSynthetic block body.\n\n"))
        .collect::<String>();
    std::fs::write(f.root.path().join("Blocks.md"), many).unwrap();
    f.project().await;
    let pass = run_trusted_embedding_pass(&f.service, &config, None, "")
        .await
        .unwrap();
    assert_eq!(pass.candidates, 128);
    assert_eq!(pass.matched, 525);
    let pass2 = run_trusted_embedding_pass(&f.service, &config, None, &pass.last_id)
        .await
        .unwrap();
    assert_eq!(pass2.candidates, 6);
    assert_eq!(pass2.matched, 12);
    assert_eq!(
        run_trusted_embedding_pass(&f.service, &config, None, "")
            .await
            .unwrap()
            .candidates,
        0
    );
    std::fs::write(f.root.path().join("Blocks.md"), "# One\n\nReplacement.").unwrap();
    f.project().await;
    assert_eq!(
        run_trusted_embedding_pass(&f.service, &config, None, "")
            .await
            .unwrap()
            .matched,
        2
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM blocks WHERE note_id='Blocks.md'")
        .fetch_one(&f.service.store.db().pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    sqlx::query("DELETE FROM blocks WHERE note_id='Blocks.md'")
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    f.project().await;
    assert_eq!(
        run_trusted_embedding_pass(&f.service, &config, None, "")
            .await
            .unwrap()
            .matched,
        1
    );
    let token = f
        .service
        .store
        .embedding_candidates("", 1, 3, true, config.schema_model(), 64)
        .await
        .unwrap();
    assert!(token.is_empty());
    sqlx::query("UPDATE notes SET embedding=NULL WHERE id='Blocks.md'")
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    let token = f
        .service
        .store
        .embedding_candidates("", 1, 3, true, config.schema_model(), 64)
        .await
        .unwrap()
        .remove(0);
    std::fs::write(f.root.path().join("Blocks.md"), "unprojected replacement").unwrap();
    assert!(f.service.capture_embedding_source(&token).await.is_err());
    f.project().await;
    std::fs::remove_file(f.root.path().join("Blocks.md")).unwrap();
    f.project().await;
    assert!(
        f.service
            .capture_embedding_source(&token)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        1
    );
    f.assert_no_resident_text().await;
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_worker_near_64mib_bounded_selection_no_corpus_admission() {
    let f = Fixture::with_pool_limit(128, 8 * 1024 * 1024, 1).await;
    let (p, mut config, server) = fake_provider(false).await;
    config.block_embedding_enabled = false;
    config.block_chunk_bytes = 256 * 1024;
    config.block_chunk_overlap_sentences = 0;
    config.note_chunk_bytes = 4096;
    config.batch_size = 8;
    f.service.store.set_embedding_settings(config.clone()).await;
    let raw = "x".repeat(63 * 1024 * 1024);
    std::fs::write(f.root.path().join("Large.md"), &raw).unwrap();
    drop(raw);
    f.project().await;
    let client = LocalAiEmbeddingClient::new(&config).unwrap();
    let pass = run_trusted_embedding_pass(&f.service, &config, Some(&client), "")
        .await
        .unwrap();
    assert_eq!(pass.matched, 1);
    assert_eq!(pass.max_input_bytes, 63 * 1024 * 1024);
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .input_highwater
            .load(Ordering::SeqCst),
        1
    );
    assert_eq!(pass.max_selected_chunks, 256);
    assert!(pass.max_chunk_bytes <= 4096);
    assert_eq!(pass.max_provider_batch, 8);
    assert_eq!(p.requests.load(Ordering::SeqCst), 32);
    assert_eq!(p.max_batch.load(Ordering::SeqCst), 8);
    assert!(p.max_bytes.load(Ordering::SeqCst) <= 4096);
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        1
    );
    f.assert_no_resident_text().await;
    eprintln!(
        "synthetic worker highwaters: input_bytes={} selected_chunks={} raw_chunk_bytes={} provider_batch={} normalized_provider_chunk_bytes={} requests={} normal_rows={} normal_bytes={} singleton_bytes={}",
        pass.max_input_bytes,
        pass.max_selected_chunks,
        pass.max_chunk_bytes,
        pass.max_provider_batch,
        p.max_bytes.load(Ordering::SeqCst),
        p.requests.load(Ordering::SeqCst),
        f.service
            .store
            .projection_metrics
            .normal_rows
            .load(Ordering::Relaxed),
        f.service
            .store
            .projection_metrics
            .normal_bytes
            .load(Ordering::Relaxed),
        f.service
            .store
            .projection_metrics
            .singleton_bytes
            .load(Ordering::Relaxed)
    );
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_worker_old_backend_statement_survives_owner_exit() {
    if let Ok(database) = std::env::var("OBTS_WORKER_CHILD_DATABASE") {
        let url = std::env::var("OBTS_SYNTHETIC_POSTGRES_URL").unwrap();
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect_with(
                url.parse::<sqlx::postgres::PgConnectOptions>()
                    .unwrap()
                    .database(&database),
            )
            .await
            .unwrap();
        let store = VaultStore::new_with_persistence(20, Arc::new(PostgresPersistence { pool }));
        let note = store
            .embedding_candidates("", 1, 3, true, "synthetic", 64)
            .await
            .unwrap()
            .remove(0);
        let block = if std::env::var("OBTS_WORKER_CHILD_BLOCK").unwrap() == "true" {
            Some(
                store
                    .embedding_blocks(&note, -1, 3)
                    .await
                    .unwrap()
                    .remove(0),
            )
        } else {
            None
        };
        let vector = if std::env::var("OBTS_WORKER_CHILD_FAILURE").unwrap() == "true" {
            None
        } else {
            Some(vec![0.25; 64])
        };
        store
            .complete_embedding(&note, block.as_ref(), vector)
            .await
            .unwrap();
        panic!("parent must kill this process while its backend statement is blocked");
    }
    for block in [false, true] {
        for failure in [false, true] {
            let f = private_fixture().await;
            let external = extra_pool(&f, 2).await;
            let mut blocker = external.begin().await.unwrap();
            sqlx::query("SELECT id FROM notes FOR UPDATE")
                .fetch_all(&mut *blocker)
                .await
                .unwrap();
            let reset_db = PostgresPersistence {
                pool: external.clone(),
            };
            let reset = tokio::spawn(async move {
                reset_db
                    .ensure_embedding_schema("replacement-after-owner-exit", 64, 16, 64)
                    .await
                    .unwrap()
            });
            wait_locks(&f, 1).await;
            let mut child=tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact","store::sql::tests::embedding::postgres_worker_old_backend_statement_survives_owner_exit","--ignored"])
            .env("OBTS_WORKER_CHILD_DATABASE",&f.database).env("OBTS_WORKER_CHILD_BLOCK",block.to_string()).env("OBTS_WORKER_CHILD_FAILURE",failure.to_string())
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true).spawn().unwrap();
            wait_locks(&f, 2).await;
            child.kill().await.unwrap();
            assert!(!child.wait().await.unwrap().success());
            let waiting: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
            )
            .bind(&f.database)
            .fetch_one(&f.admin_pool)
            .await
            .unwrap();
            assert_eq!(
                waiting, 2,
                "the old PostgreSQL statement must outlive its killed Rust owner"
            );
            blocker.commit().await.unwrap();
            reset.await.unwrap();
            timeout(Duration::from_secs(10),async {
            loop {
                let waiting:i64=sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'").bind(&f.database).fetch_one(&f.admin_pool).await.unwrap();
                if waiting==0 {break;}
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
            let (notes,blocks):(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM notes WHERE embedding IS NOT NULL OR embedding_failures<>0),(SELECT count(*) FROM blocks WHERE embedding IS NOT NULL OR embedding_failures<>0)").fetch_one(&f.service.store.db().pool).await.unwrap();
            assert_eq!((notes, blocks), (0, 0));
            let note = f
                .service
                .store
                .embedding_candidates("", 1, 3, true, "replacement-after-owner-exit", 64)
                .await
                .unwrap()
                .remove(0);
            let token = if block {
                Some(
                    f.service
                        .store
                        .embedding_blocks(&note, -1, 3)
                        .await
                        .unwrap()
                        .remove(0),
                )
            } else {
                None
            };
            assert_eq!(
                f.service
                    .store
                    .complete_embedding(&note, token.as_ref(), Some(vec![0.75; 64]))
                    .await
                    .unwrap(),
                1
            );
            external.close().await;
            f.cleanup().await;
        }
    }
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_worker_sql_outage_has_no_empty_inner_fallback() {
    let f = private_fixture().await;
    let config = EmbeddingConfig {
        dimensions: 64,
        ..Default::default()
    };
    f.service.store.db().pool.close().await;
    assert!(
        run_trusted_embedding_pass(&f.service, &config, None, "")
            .await
            .is_err()
    );
    assert!(f.service.store.inner.read().await.notes.is_empty());
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        1
    );
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_worker_provider_outage_does_not_quarantine_blocks() {
    let f = private_fixture().await;
    sqlx::query("UPDATE notes SET embedding=$1")
        .bind(pgvector::Vector::from(vec![0.5; 64]))
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    let (p, config, server) = fake_provider(false).await;
    p.degraded.store(true, Ordering::SeqCst);
    let client = LocalAiEmbeddingClient::new(&config).unwrap();
    let pass = run_trusted_embedding_pass(&f.service, &config, Some(&client), "")
        .await
        .unwrap();
    assert_eq!(pass.failed, 0);
    let failures: i32 = sqlx::query_scalar("SELECT embedding_failures FROM blocks LIMIT 1")
        .fetch_one(&f.service.store.db().pool)
        .await
        .unwrap();
    assert_eq!(failures, 0);
    p.degraded.store(false, Ordering::SeqCst);
    assert_eq!(
        run_trusted_embedding_pass(&f.service, &config, Some(&client), "")
            .await
            .unwrap()
            .matched,
        1
    );
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_review_context_provider_pool_body_order() {
    for singleton in [false, true] {
        for failure in [false, true] {
            let mut f = private_fixture().await;
            if singleton {
                f.service.store.projection_batch_bytes = 64;
            }
            let (p, mut config, server) = fake_provider(true).await;
            config.block_embedding_enabled = false;
            p.fail.store(failure, Ordering::SeqCst);
            let client = LocalAiEmbeddingClient::new(&config).unwrap();
            let service = f.service.clone();
            let mut worker = tokio::spawn(async move {
                run_trusted_embedding_pass(&service, &config, Some(&client), "")
                    .await
                    .unwrap()
            });
            entered(&p).await;
            let service = f.service.clone();
            let mut context = tokio::spawn(async move {
                service
                    .assemble_context(
                        &admin(),
                        AssembleContextRequest {
                            seeds: vec![NoteId::new("Private.md")],
                            seed_query: None,
                            max_depth: Some(0),
                            max_tokens: Some(2048),
                            include_graph_summary: None,
                            format: None,
                        },
                    )
                    .await
                    .unwrap()
            });
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(!context.is_finished());
            release(&p);
            let result = timeout(Duration::from_secs(3), &mut worker).await;
            let progressed = result.is_ok();
            if let Ok(pass) = result {
                let pass = pass.unwrap();
                assert_eq!(
                    (pass.matched, pass.failed),
                    if failure { (0, 1) } else { (1, 0) }
                );
            }
            if progressed {
                let response = timeout(Duration::from_secs(3), &mut context)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(response.notes.iter().any(|n| {
                    n.content
                        .as_deref()
                        .is_some_and(|s| s.contains("Synthetic private body"))
                }));
                drop(response);
            } else {
                context.abort();
                let _ = context.await;
                timeout(Duration::from_secs(3), worker)
                    .await
                    .unwrap()
                    .unwrap();
            }
            assert_eq!(
                f.service
                    .filesystem
                    .as_ref()
                    .unwrap()
                    .available_body_slots(),
                1
            );
            if singleton {
                assert!(
                    f.service
                        .store
                        .projection_metrics
                        .singleton_operations
                        .load(Ordering::Relaxed)
                        > 0
                );
            }
            server.abort();
            f.cleanup().await;
            assert!(
                progressed,
                "context held Pool-1 while waiting for the provider-owned body; SQL timeout is not progress"
            );
        }
    }
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_review_insert_during_schema_reset_fences_new_note_and_block() {
    for block in [false, true] {
        for failure in [false, true] {
            let f = private_fixture().await;
            let external = extra_pool(&f, 2).await;
            let mut blocker = external.begin().await.unwrap();
            sqlx::query("SELECT id FROM blocks WHERE note_id='Private.md' FOR UPDATE")
                .fetch_all(&mut *blocker)
                .await
                .unwrap();
            let reset_db = PostgresPersistence {
                pool: external.clone(),
            };
            let reset = tokio::spawn(async move {
                reset_db
                    .ensure_embedding_schema("insert-reset-model", 64, 16, 64)
                    .await
                    .unwrap()
            });
            wait_locks(&f, 1).await;
            std::fs::write(
                f.root.path().join("New.md"),
                "# New\n\nInserted while reset is blocked.\n",
            )
            .unwrap();
            timeout(Duration::from_secs(3), f.project()).await.unwrap();
            let note = f
                .service
                .store
                .embedding_candidates("", 128, 3, true, "synthetic", 64)
                .await
                .unwrap()
                .into_iter()
                .find(|n| n.id == "New.md")
                .unwrap();
            let token = if block {
                Some(
                    f.service
                        .store
                        .embedding_blocks(&note, -1, 3)
                        .await
                        .unwrap()
                        .remove(0),
                )
            } else {
                None
            };
            let captured = f
                .service
                .capture_embedding_source(&note)
                .await
                .unwrap()
                .unwrap();
            blocker.commit().await.unwrap();
            reset.await.unwrap();
            let matched = f
                .service
                .store
                .complete_embedding(
                    &note,
                    token.as_ref(),
                    if failure { None } else { Some(vec![0.25; 64]) },
                )
                .await
                .unwrap();
            drop(captured);
            let table = if block {
                "blocks WHERE note_id='New.md'"
            } else {
                "notes WHERE id='New.md'"
            };
            let unchanged: bool = sqlx::query_scalar(&format!(
                "SELECT embedding IS NULL AND embedding_failures=0 FROM {table}"
            ))
            .fetch_one(&f.service.store.db().pool)
            .await
            .unwrap();
            let current = f
                .service
                .store
                .embedding_candidates("", 128, 3, true, "insert-reset-model", 64)
                .await
                .unwrap()
                .into_iter()
                .find(|n| n.id == "New.md");
            if matched == 0 {
                let current = current.unwrap();
                let token = if block {
                    Some(
                        f.service
                            .store
                            .embedding_blocks(&current, -1, 3)
                            .await
                            .unwrap()
                            .remove(0),
                    )
                } else {
                    None
                };
                assert_eq!(
                    f.service
                        .store
                        .complete_embedding(&current, token.as_ref(), Some(vec![0.75; 64]))
                        .await
                        .unwrap(),
                    1
                );
            }
            external.close().await;
            f.cleanup().await;
            assert_eq!(
                matched, 0,
                "new row escaped schema reset: block={block}, failure={failure}"
            );
            assert!(unchanged);
        }
    }
}
