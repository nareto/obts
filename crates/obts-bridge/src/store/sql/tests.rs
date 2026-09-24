use super::*;
use crate::authorization::{AccessMatcher, AccessPolicy};
use crate::filesystem::{FilesystemSource, synchronize_snapshot};
use crate::service::VaultBridgeService;
use crate::vault_export::MarkdownExportResponse;
use sqlx::postgres::PgPoolOptions;
use tempfile::TempDir;

struct Fixture {
    service: VaultBridgeService,
    root: TempDir,
    database: String,
    admin_pool: sqlx::PgPool,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_budgets(128, 8 * 1024 * 1024).await
    }
    async fn with_budgets(rows: usize, bytes: u64) -> Self {
        Self::with_pool_limit(rows, bytes, 4).await
    }
    async fn with_pool_limit(rows: usize, bytes: u64, connections: u32) -> Self {
        let url = std::env::var("OBTS_SYNTHETIC_POSTGRES_URL").expect(
            "set OBTS_SYNTHETIC_POSTGRES_URL to a disposable synthetic PostgreSQL database",
        );
        let admin_pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("synthetic PostgreSQL must be available; this test never silently skips");
        let database = format!(
            "bounded_{}_{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        );
        sqlx::query(&format!("CREATE DATABASE {database}"))
            .execute(&admin_pool)
            .await
            .unwrap();
        let options = url
            .parse::<sqlx::postgres::PgConnectOptions>()
            .unwrap()
            .database(&database);
        let pool = PgPoolOptions::new()
            .max_connections(connections)
            .connect_with(options)
            .await
            .unwrap();
        let persistence = Arc::new(PostgresPersistence { pool });
        persistence
            .prepare_embedding_column_for_migrations(64)
            .await
            .unwrap();
        persistence.migrate().await.unwrap();
        persistence
            .ensure_embedding_schema("synthetic", 64, 16, 64)
            .await
            .unwrap();
        let root = tempfile::tempdir().unwrap();
        let source = Arc::new(
            FilesystemSource::new_with_persistence_and_budgets(
                root.path(),
                persistence.clone(),
                64 * 1024 * 1024,
                1,
            )
            .await
            .unwrap(),
        );
        let store = VaultStore::new_with_persistence(20, persistence)
            .with_filesystem(source.clone())
            .with_projection_budgets(rows, bytes);
        store
            .set_authorization_config(std::collections::BTreeMap::from([
                ("admin".to_string(), AccessPolicy::admin()),
                (
                    "reader".to_string(),
                    AccessPolicy {
                        read: vec![
                            AccessRule::deny(AccessMatcher {
                                tags_any: vec!["private".to_string()],
                                ..Default::default()
                            }),
                            AccessRule::allow(AccessMatcher::allow_all()),
                        ],
                        ..Default::default()
                    },
                ),
            ]))
            .await;
        Self {
            service: VaultBridgeService::new_with_filesystem(store, source, None),
            root,
            database,
            admin_pool,
        }
    }
    async fn project(&self) {
        synchronize_snapshot(
            &self.service.store,
            self.service.filesystem.as_ref().unwrap(),
        )
        .await
        .unwrap();
    }
    async fn assert_no_resident_text(&self) {
        let inner = self.service.store.inner.read().await;
        assert!(inner.notes.is_empty());
        assert!(inner.vault_files.is_empty());
        assert!(inner.links.is_empty());
        drop(inner);
        let raw: i64=sqlx::query_scalar("SELECT (SELECT count(*) FROM notes WHERE content<>'' OR search_text<>'')+(SELECT count(*) FROM vault_files WHERE content<>'')+(SELECT count(*) FROM blocks WHERE content<>'')")
            .fetch_one(&self.service.store.db().pool).await.unwrap();
        assert_eq!(raw, 0);
    }
    async fn cleanup(self) {
        self.service.store.db().pool.close().await;
        sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", self.database))
            .execute(&self.admin_pool)
            .await
            .unwrap();
        self.admin_pool.close().await;
    }
}
fn admin() -> AuthContext {
    AuthContext::new(ContextName::new("admin"), "synthetic-admin".to_string())
}
fn reader() -> AuthContext {
    AuthContext::new(ContextName::new("reader"), "synthetic-reader".to_string())
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn root_ignore_removes_stale_sql_projection_without_touching_file() {
    let f = Fixture::new().await;
    std::fs::write(f.root.path().join("Visible.md"), "# Visible\n").unwrap();
    std::fs::write(f.root.path().join("Local.md"), "# Local\n").unwrap();
    f.project().await;
    assert_eq!(f.service.store.sql_revisions().await.unwrap().len(), 2);
    std::fs::write(f.root.path().join(".gitignore"), "Local.md\n").unwrap();
    f.project().await;
    let projected = f.service.store.sql_revisions().await.unwrap();
    assert_eq!(
        projected.keys().cloned().collect::<Vec<_>>(),
        vec!["Visible.md"]
    );
    let stale: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM notes WHERE id='Local.md')+(SELECT count(*) FROM vault_files WHERE path='Local.md')+(SELECT count(*) FROM tags WHERE note_id='Local.md')+(SELECT count(*) FROM links WHERE source_id='Local.md')+(SELECT count(*) FROM blocks WHERE note_id='Local.md')")
        .fetch_one(&f.service.store.db().pool).await.unwrap();
    assert_eq!(stale, 0);
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("Local.md")).unwrap(),
        "# Local\n"
    );
    let read = f
        .service
        .get_vault_file(&admin(), &NoteId::new("Local.md"))
        .await
        .unwrap();
    assert_eq!(read.content, "# Local\n");
    let updated = f
        .service
        .update_note(
            &admin(),
            &NoteId::new("Local.md"),
            UpdateNoteRequest {
                content: Some("changed".into()),
                content_patch: None,
                tags: None,
                metadata: None,
                expected_revision: Some(read.revision),
            },
        )
        .await
        .unwrap();
    let local_content = std::fs::read_to_string(f.root.path().join("Local.md")).unwrap();
    assert!(local_content.ends_with("\nchanged\n"));
    assert_eq!(
        updated.revision,
        crate::store::whole_file_revision(&local_content)
    );
    f.project().await;
    assert_eq!(f.service.store.sql_revisions().await.unwrap().len(), 1);
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_projection_reads_queries_acl_edits_and_faults() {
    let f = Fixture::new().await;
    let raw = "---\ntags: [project]\nstatus: active\n---\n# Heading alpha\n\nUniquequartz alpha body links [[Beta.md]] and [[Private.md]].\n";
    std::fs::write(f.root.path().join("Alpha.md"), raw).unwrap();
    std::fs::write(
        f.root.path().join("Beta.md"),
        "# Beta\n\nUniquequartz beta body [[Alpha.md]].\n",
    )
    .unwrap();
    std::fs::write(
        f.root.path().join("Private.md"),
        "---\ntags: [private]\n---\n# Private\n\nUniquequartz hidden.\n",
    )
    .unwrap();
    std::fs::write(
        f.root.path().join("Table.base"),
        "views:\n  - type: table\n",
    )
    .unwrap();
    f.project().await;
    f.assert_no_resident_text().await;
    assert_eq!(f.service.store.status().await.index.total_notes, 3);
    let auth = admin();
    let read = reader();
    let id = NoteId::new("Alpha.md");
    let file = f.service.get_vault_file(&auth, &id).await.unwrap();
    assert_eq!(file.content, raw);
    assert_eq!(
        file.content_sha256,
        hex::encode(Sha256::digest(raw.as_bytes()))
    );
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        0
    );
    assert!(
        serde_json::to_value(&file)
            .unwrap()
            .get("_body_lease")
            .is_none()
    );
    drop(file);
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        1
    );
    let note = f.service.get_note(&read, &id).await.unwrap();
    assert!(note.content.contains("Uniquequartz alpha body"));
    assert!(!note.content.contains("tags: [project]"));
    assert_eq!(note.heading_title.as_deref(), Some("Heading alpha"));
    assert_eq!(note.links, vec![NoteId::new("Beta.md")]);
    drop(note);
    assert!(f.service.get_note_by_title(&read, "Alpha").await.is_ok());
    let hits = f
        .service
        .search(&read, "Uniquequartz", SearchMode::Fulltext, 10)
        .await
        .unwrap();
    assert_eq!(hits.results.len(), 2);
    assert!(
        hits.results
            .iter()
            .all(|hit| hit.snippet.contains("Uniquequartz"))
    );
    drop(hits);
    let private_count:i64=sqlx::query_scalar("SELECT count(*) FROM notes WHERE id='Private.md' AND search_vector @@ plainto_tsquery('simple','Uniquequartz')")
        .fetch_one(&f.service.store.db().pool).await.unwrap();
    assert_eq!(private_count, 1);
    let query = f
        .service
        .query_notes(
            &read,
            QueryNotesRequest {
                tags_all: vec!["project".to_string()],
                has_frontmatter: vec!["status".to_string()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(query.total, 1);
    assert_eq!(query.notes[0].id, id);
    let base=f.service.query_base(&read,QueryBaseRequest { base_query:"filters:\n  and:\n    - 'file.hasTag(\"project\")'\nviews:\n  - type: table\n    order: [file.name, status]\n".to_string(),..Default::default() }).await.unwrap();
    assert_eq!(base.total, 1);
    assert_eq!(base.rows[0].note_id, id);
    assert_eq!(
        f.service
            .neighbors(&read, &id, 1, NeighborDirection::Outgoing)
            .await
            .unwrap()
            .nodes
            .len(),
        1
    );
    assert_eq!(
        f.service
            .backlinks(&read, &id)
            .await
            .unwrap()
            .backlinks
            .len(),
        1
    );
    assert_eq!(
        f.service
            .shortest_path(&read, &id, &NoteId::new("Beta.md"))
            .await
            .unwrap()
            .length,
        Some(1)
    );
    assert_eq!(
        f.service
            .list_tags(&read, NoteTimeFilter::default())
            .await
            .unwrap()
            .tags
            .len(),
        1
    );
    let context = f
        .service
        .assemble_context(
            &read,
            AssembleContextRequest {
                seeds: vec![id.clone()],
                seed_query: None,
                max_depth: Some(1),
                max_tokens: Some(2048),
                include_graph_summary: None,
                format: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(context.notes.len(), 2);
    assert!(context.notes.iter().any(|n| {
        n.content
            .as_ref()
            .is_some_and(|c| c.contains("Uniquequartz alpha"))
    }));
    drop(context);
    std::fs::remove_file(f.root.path().join("Private.md")).unwrap();
    assert!(matches!(
        f.service.get_note(&read, &NoteId::new("Private.md")).await,
        Err(ServiceError::NotFound)
    ));
    assert!(f.service.filesystem.as_ref().unwrap().is_index_current());
    assert!(matches!(
        f.service
            .edit_vault_file(
                &auth,
                &id,
                serde_json::from_value(
                    serde_json::json!({"content":"# changed", "expected_revision":format!("v1:sha256:{}", "0".repeat(64))})
                )
                .unwrap()
            )
            .await,
        Err(ServiceError::Write(WriteError::RevisionMismatch))
    ));
    f.service
        .store
        .log_access(
            "admin",
            "synthetic",
            &serde_json::json!({}),
            &[id.clone()],
            0,
        )
        .await;
    let audit_before: i64 = sqlx::query_scalar("SELECT count(*) FROM access_log")
        .fetch_one(&f.service.store.db().pool)
        .await
        .unwrap();
    assert!(audit_before > 0);
    std::fs::write(f.root.path().join("Alpha.md"), "# Source drift\n").unwrap();
    assert!(matches!(
        f.service.get_note(&auth, &id).await,
        Err(ServiceError::IndexCatchingUp)
    ));
    f.project().await;
    std::fs::remove_file(f.root.path().join("Alpha.md")).unwrap();
    assert!(matches!(
        f.service.get_vault_file(&auth, &id).await,
        Err(ServiceError::IndexCatchingUp)
    ));
    f.project().await;
    let audit_after: i64 = sqlx::query_scalar("SELECT count(*) FROM access_log")
        .fetch_one(&f.service.store.db().pool)
        .await
        .unwrap();
    assert_eq!(audit_before, audit_after);
    f.assert_no_resident_text().await;
    f.service.store.db().pool.close().await;
    assert!(matches!(
        f.service
            .query_notes(&auth, QueryNotesRequest::default())
            .await,
        Err(ServiceError::IndexCatchingUp)
    ));
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_distributed_corpus_above_64_mib_has_no_body_mirror() {
    let f = Fixture::new().await;
    let text = format!(
        "# Synthetic distributed corpus\n\n{}",
        "boundedword ".repeat(94_000)
    );
    let mut bytes = 0;
    for i in 0..64 {
        std::fs::write(f.root.path().join(format!("Synthetic-{i:03}.md")), &text).unwrap();
        bytes += text.len();
    }
    assert!(bytes > 64 * 1024 * 1024);
    drop(text);
    f.project().await;
    f.assert_no_resident_text().await;
    let result = f
        .service
        .search(&admin(), "boundedword", SearchMode::Fulltext, 3)
        .await
        .unwrap();
    assert_eq!(result.results.len(), 3);
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        0
    );
    assert!(
        serde_json::to_value(&result)
            .unwrap()
            .get("_body_lease")
            .is_none()
    );
    drop(result);
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        1
    );
    let file = f
        .service
        .get_vault_file(&admin(), &NoteId::new("Synthetic-000.md"))
        .await
        .unwrap();
    assert!(file.content.len() > 1024 * 1024);
    drop(file);
    f.assert_no_resident_text().await;
    f.cleanup().await;
}

impl Fixture {
    async fn delta(
        &self,
        head: &str,
        base: Option<&str>,
        changed: bool,
    ) -> crate::headless::HeadlessIndexDelta {
        let source = self.service.filesystem.as_ref().unwrap();
        let file = source.read("Fault.md").await.unwrap();
        let oid = file.oid.clone();
        drop(file);
        crate::headless::HeadlessIndexDelta {
            head: Some(head.to_string()),
            base: base.map(str::to_string),
            mode: if base.is_some() {
                "incremental"
            } else {
                "rebuild"
            }
            .to_string(),
            files: vec![crate::headless::HeadlessIndexFile {
                path: "Fault.md".to_string(),
                oid: oid.clone(),
            }],
            changes: if changed {
                vec![crate::headless::HeadlessIndexChange {
                    path: "Fault.md".to_string(),
                    kind: "modify".to_string(),
                    oid: Some(oid),
                }]
            } else {
                Vec::new()
            },
        }
    }
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_failed_block_batch_retains_cursor_and_revert_replays() {
    use crate::filesystem::apply_commit_delta;
    let f = Fixture::new().await;
    let source = f.service.filesystem.as_ref().unwrap();
    let old = format!("# Fault\n\n{}", "Original synthetic body. ".repeat(40));
    std::fs::write(f.root.path().join("Fault.md"), &old).unwrap();
    let first = "1".repeat(40);
    let second = "2".repeat(40);
    let reverted = "3".repeat(40);
    apply_commit_delta(
        &f.service.store,
        source,
        None,
        f.delta(&first, None, false).await,
        true,
        false,
    )
    .await
    .unwrap();
    f.service
        .store
        .log_access(
            "admin",
            "synthetic",
            &serde_json::json!({}),
            &[NoteId::new("Fault.md")],
            0,
        )
        .await;
    let audit: i64 = sqlx::query_scalar("SELECT count(*) FROM access_log")
        .fetch_one(&f.service.store.db().pool)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE FUNCTION fail_blocks() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic block write failure'; END $$; CREATE TRIGGER fail_blocks BEFORE INSERT OR UPDATE ON blocks FOR EACH ROW EXECUTE FUNCTION fail_blocks();")
        .execute(&f.service.store.db().pool).await.unwrap();
    std::fs::write(
        f.root.path().join("Fault.md"),
        format!("# Fault\n\n{}", "Changed synthetic body. ".repeat(40)),
    )
    .unwrap();
    assert!(
        apply_commit_delta(
            &f.service.store,
            source,
            Some(first.clone()),
            f.delta(&second, Some(&first), true).await,
            false,
            false
        )
        .await
        .is_err()
    );
    let state = f
        .service
        .store
        .db()
        .load_obts_projection_state()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state.indexed_commit, Some(first.clone()));
    assert_eq!(state.status, "projecting");
    assert!(state.failure_code.is_some());
    assert!(!source.is_index_current());
    assert_eq!(source.available_body_slots(), 1);
    let complete: bool =
        sqlx::query_scalar("SELECT projection_complete FROM vault_files WHERE path='Fault.md'")
            .fetch_one(&f.service.store.db().pool)
            .await
            .unwrap();
    assert!(!complete);
    sqlx::query("DROP TRIGGER fail_blocks ON blocks")
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    std::fs::write(f.root.path().join("Fault.md"), &old).unwrap();
    apply_commit_delta(
        &f.service.store,
        source,
        Some(first.clone()),
        f.delta(&reverted, Some(&first), false).await,
        false,
        false,
    )
    .await
    .unwrap();
    assert_eq!(source.indexed_commit(), Some(reverted.clone()));
    assert_eq!(
        f.service
            .get_vault_file(&admin(), &NoteId::new("Fault.md"))
            .await
            .unwrap()
            .content,
        old
    );
    assert_eq!(source.available_body_slots(), 1);
    let body = source.read("Fault.md").await.unwrap();
    assert_eq!(source.available_body_slots(), 0);
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(20),
            source.read("Fault.md")
        )
        .await
        .is_err()
    );
    drop(body);
    assert_eq!(source.available_body_slots(), 1);
    let mut bad = f.delta(&"4".repeat(40), Some(&reverted), true).await;
    bad.files[0].oid = "5".repeat(40);
    bad.changes[0].oid = Some("5".repeat(40));
    assert!(
        apply_commit_delta(
            &f.service.store,
            source,
            Some(reverted.clone()),
            bad,
            true,
            false
        )
        .await
        .is_err()
    );
    assert_eq!(source.indexed_commit(), Some(reverted));
    assert_eq!(source.available_body_slots(), 1);
    assert_eq!(
        audit,
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM access_log")
            .fetch_one(&f.service.store.db().pool)
            .await
            .unwrap()
    );
    f.assert_no_resident_text().await;
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_markdown_export_pages_all_policy_visible_files_and_weak_etags() {
    let f = Fixture::new().await;
    for i in 0..520 {
        std::fs::write(
            f.root.path().join(format!("Export-{i:03}.md")),
            format!("---\ntags: [exported]\n---\n# Export {i}\n"),
        )
        .unwrap();
    }
    f.project().await;
    let auth = admin();
    let export = f
        .service
        .export_markdown(&auth, &[])
        .await
        .expect("SQL-backed Markdown export");
    let export_etag = match export {
        MarkdownExportResponse::Archive(archive) => {
            assert_eq!(archive.metadata.exported_markdown_files, 520);
            assert_eq!(archive.metadata.unavailable_markdown_files, 0);
            archive.metadata.etag.clone()
        }
        MarkdownExportResponse::NotModified(_) => panic!("unconditional export returned 304"),
    };
    assert!(matches!(
        f.service
            .export_markdown(&auth, &[format!("W/{export_etag}")])
            .await
            .expect("conditional SQL-backed Markdown export"),
        MarkdownExportResponse::NotModified(_)
    ));
    f.assert_no_resident_text().await;
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_paged_totals_semantic_blocks_and_successful_cas_writes() {
    let f = Fixture::new().await;
    for i in 0..520 {
        std::fs::write(
            f.root.path().join(format!("Page-{i:03}.md")),
            format!(
                "---\ntags: [paged]\nrank: {i}\n---\n# Paged heading\n\n{}",
                "pagedlexical synthetic searchable sentence. ".repeat(8)
            ),
        )
        .unwrap();
    }
    f.project().await;
    let auth = admin();
    let query = f
        .service
        .query_notes(
            &auth,
            QueryNotesRequest {
                text_query: Some("pagedlexical".to_string()),
                search_mode: Some(SearchMode::Fulltext),
                sort_by: Some(NoteSortField::Title),
                sort_order: Some(SortOrder::Desc),
                limit: Some(2),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(query.total, 520);
    assert_eq!(query.notes.len(), 2);
    assert_eq!(query.notes[0].id, NoteId::new("Page-519.md"));
    drop(query);
    let base=f.service.query_base(&auth,QueryBaseRequest { base_query:"views:\n  - type: table\n    order: [file.name, rank]\n    sort:\n      - property: rank\n        direction: DESC\n".to_string(),limit:Some(2),..Default::default() }).await.unwrap();
    assert_eq!(base.total, 520);
    assert_eq!(base.returned, 2);
    f.service.store.settings.write().await.embedding_provider = "synthetic".to_string();
    let vector = pgvector::Vector::from(embed_text("semanticneedle", 64));
    sqlx::query("UPDATE blocks SET embedding=$1 WHERE note_id='Page-519.md'")
        .bind(vector.clone())
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    sqlx::query("UPDATE notes SET embedding=$1 WHERE id='Page-518.md'")
        .bind(vector)
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    let semantic = f
        .service
        .search(&auth, "semanticneedle", SearchMode::Semantic, 4)
        .await
        .unwrap();
    assert_eq!(semantic.results.len(), 2);
    assert!(
        semantic
            .results
            .iter()
            .any(|h| h.id == NoteId::new("Page-519.md")
                && h.matched_chunk_id.is_some()
                && h.matched_snippet.as_ref().is_some_and(|s| !s.is_empty()))
    );
    drop(semantic);
    let hybrid = f
        .service
        .search(&auth, "pagedlexical", SearchMode::Hybrid, 3)
        .await
        .unwrap();
    assert_eq!(hybrid.results.len(), 3);
    drop(hybrid);
    let created = f
        .service
        .create_vault_file(
            &auth,
            NewNoteRequest {
                title: "SQL Created".to_string(),
                content: "# SQL Created\n\nCreated body.\n".to_string(),
                template_id: None,
                file_type: NewNoteFileType::Md,
            },
        )
        .await
        .unwrap();
    f.project().await;
    let original = f.service.get_vault_file(&auth, &created.id).await.unwrap();
    assert!(original.content.contains("created_by: synthetic-admin"));
    assert!(original.content.contains("ai-created"));
    assert!(original.revision.starts_with("v1:sha256:"));
    let original_revision = original.revision.clone();
    drop(original);
    let missing_precondition: UpdateNoteRequest =
        serde_json::from_value(serde_json::json!({"content":"must not land"})).unwrap();
    assert!(matches!(
        f.service
            .edit_vault_file(&auth, &created.id, missing_precondition)
            .await,
        Err(ServiceError::Write(WriteError::PreconditionRequired))
    ));
    let update: UpdateNoteRequest = serde_json::from_value(serde_json::json!({
        "expected_revision": original_revision,
        "content_patch": [{"op":"append","text":"\nAppended exactly once.\n"}]
    }))
    .unwrap();
    let update_response = f
        .service
        .edit_vault_file(&auth, &created.id, update.clone())
        .await
        .unwrap();
    assert_ne!(update_response.revision, original_revision);
    f.project().await;
    let updated = f.service.get_vault_file(&auth, &created.id).await.unwrap();
    assert_eq!(updated.content.matches("Appended exactly once.").count(), 1);
    assert!(updated.content.contains("created_by: synthetic-admin"));
    drop(updated);
    let mut stale_update = update;
    stale_update.metadata = Some(serde_json::Value::String("invalid".to_string()));
    assert!(matches!(
        f.service
            .edit_vault_file(&auth, &created.id, stale_update)
            .await,
        Err(ServiceError::Write(WriteError::RevisionMismatch))
    ));
    let denied = std::collections::BTreeMap::from([(
        "admin".to_string(),
        AccessPolicy {
            read: vec![AccessRule::deny(AccessMatcher::allow_all())],
            ..Default::default()
        },
    )]);
    f.service.store.set_authorization_config(denied).await;
    std::fs::remove_file(f.root.path().join(created.id.as_str())).unwrap();
    assert!(matches!(
        f.service.get_vault_file(&auth, &created.id).await,
        Err(ServiceError::NotFound)
    ));
    assert!(f.service.filesystem.as_ref().unwrap().is_index_current());
    f.assert_no_resident_text().await;
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL"]
async fn postgres_default_budget_accepts_9mib_frontmatter_and_lexical_singletons() {
    let f = Fixture::new().await;
    let huge = "q".repeat(9 * 1024 * 1024);
    std::fs::write(
        f.root.path().join("Large.md"),
        format!("---\npayload: {huge}\nrank: 7\n---\n# Large\n\nquartz\n"),
    )
    .unwrap();
    std::fs::write(
        f.root.path().join("Lexical.md"),
        format!("# Lexical\n\n{}", "word ".repeat(1_900_000)),
    )
    .unwrap();
    drop(huge);
    f.project().await;
    let m = &f.service.store.projection_metrics;
    assert!(m.singleton_bytes.load(Ordering::Relaxed) > 9 * 1024 * 1024);
    assert!(m.singleton_operations.load(Ordering::Relaxed) >= 2);
    assert!(m.normal_bytes.load(Ordering::Relaxed) <= 8 * 1024 * 1024);
    assert!(m.normal_rows.load(Ordering::Relaxed) <= 128);
    assert_eq!(f.service.store.projection_singleton.available_permits(), 1);
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        1
    );
    let page = f.service.store.metadata_page("").await.unwrap();
    assert!(page.iter().all(|n| n.frontmatter.to_string().len() < 100
        && n.content.is_empty()
        && n.search_text.is_empty()));
    let q = f
        .service
        .query_notes(
            &admin(),
            QueryNotesRequest {
                has_frontmatter: vec!["payload".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(q.total, 1);
    let base = f
        .service
        .query_base(
            &admin(),
            QueryBaseRequest {
                base_query: "views:\n  - type: table\n    order: [file.name, rank]\n".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(base.total, 2);
    let raw = f
        .service
        .get_vault_file(&admin(), &NoteId::new("Large.md"))
        .await
        .unwrap();
    assert!(raw.content.len() > 9 * 1024 * 1024);
    drop(raw);
    f.assert_no_resident_text().await;
    let derived: i64 = sqlx::query_scalar(
        "SELECT octet_length(lexical_plaintext)::bigint FROM notes WHERE id='Lexical.md'",
    )
    .fetch_one(&f.service.store.db().pool)
    .await
    .unwrap();
    assert!(derived > 8 * 1024 * 1024);
    eprintln!(
        "default highwaters: normal rows={}, encoded bytes={}, singleton bytes={}, operations={}",
        m.normal_rows.load(Ordering::Relaxed),
        m.normal_bytes.load(Ordering::Relaxed),
        m.singleton_bytes.load(Ordering::Relaxed),
        m.singleton_operations.load(Ordering::Relaxed)
    );
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL"]
async fn postgres_tiny_batches_fanout_failure_restart_revert_and_upgrade() {
    use crate::filesystem::apply_commit_delta;
    if let Ok(database) = std::env::var("OBTS_CORE_RESTART_DATABASE") {
        assert!(database.starts_with("bounded_"));
        let root = std::env::var("OBTS_CORE_RESTART_ROOT").unwrap();
        let options = std::env::var("OBTS_SYNTHETIC_POSTGRES_URL")
            .unwrap()
            .parse::<sqlx::postgres::PgConnectOptions>()
            .unwrap()
            .database(&database);
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .unwrap();
        let persistence = Arc::new(PostgresPersistence { pool });
        let source = Arc::new(
            FilesystemSource::new_with_persistence_and_budgets(
                &root,
                persistence.clone(),
                64 * 1024 * 1024,
                1,
            )
            .await
            .unwrap(),
        );
        let store = VaultStore::new_with_persistence(20, persistence)
            .with_filesystem(source.clone())
            .with_projection_budgets(3, 256);
        let file = source.read("Fault.md").await.unwrap();
        let oid = file.oid.clone();
        drop(file);
        let base = source.indexed_commit();
        assert_eq!(base, Some("1".repeat(40)));
        let delta = crate::headless::HeadlessIndexDelta {
            head: Some("2".repeat(40)),
            base: base.clone(),
            mode: "incremental".into(),
            files: vec![crate::headless::HeadlessIndexFile {
                path: "Fault.md".into(),
                oid: oid.clone(),
            }],
            changes: vec![crate::headless::HeadlessIndexChange {
                path: "Fault.md".into(),
                kind: "modify".into(),
                oid: Some(oid),
            }],
        };
        apply_commit_delta(&store, &source, base, delta, true, false)
            .await
            .unwrap();
        assert_eq!(source.indexed_commit(), Some("2".repeat(40)));
        store.db().pool.close().await;
        return;
    }

    let f = Fixture::with_budgets(3, 256).await;
    let source = f.service.filesystem.as_ref().unwrap();
    let old = "# Fault\n\nold quartz";
    std::fs::write(f.root.path().join("Fault.md"), old).unwrap();
    let first = "1".repeat(40);
    apply_commit_delta(
        &f.service.store,
        source,
        None,
        f.delta(&first, None, false).await,
        true,
        false,
    )
    .await
    .unwrap();
    f.service
        .store
        .log_access("admin", "synthetic", &serde_json::json!({}), &[], 0)
        .await;
    let audit: i64 = sqlx::query_scalar("SELECT count(*) FROM access_log")
        .fetch_one(&f.service.store.db().pool)
        .await
        .unwrap();
    let tags = (0..70)
        .map(|i| format!("tag{i:03}"))
        .collect::<Vec<_>>()
        .join(", ");
    let links = (0..70)
        .map(|i| format!("[[Target{i:03}.md]]"))
        .collect::<Vec<_>>()
        .join(" ");
    std::fs::write(
        f.root.path().join("Fault.md"),
        format!(
            "---\ntags: [{tags}]\n---\n# Fault\n\n{links}\n{}",
            "body paragraph. ".repeat(60)
        ),
    )
    .unwrap();
    sqlx::raw_sql("CREATE FUNCTION fail_links() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target_id='Target035.md' THEN RAISE EXCEPTION 'synthetic link failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_links BEFORE INSERT ON links FOR EACH ROW EXECUTE FUNCTION fail_links();").execute(&f.service.store.db().pool).await.unwrap();
    let second = "2".repeat(40);
    assert!(
        apply_commit_delta(
            &f.service.store,
            source,
            Some(first.clone()),
            f.delta(&second, Some(&first), true).await,
            false,
            false
        )
        .await
        .is_err()
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM links WHERE source_id='Fault.md'")
        .fetch_one(&f.service.store.db().pool)
        .await
        .unwrap();
    assert!(count > 0 && count < 70);
    assert_eq!(source.indexed_commit(), Some(first.clone()));
    assert_eq!(source.available_body_slots(), 1);
    assert_eq!(f.service.store.projection_singleton.available_permits(), 1);
    assert_eq!(
        f.service.store.sql_revisions().await.unwrap()["Fault.md"],
        ""
    );
    sqlx::query("DROP TRIGGER fail_links ON links")
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    let executable = std::env::current_exe().unwrap();
    let database = f.database.clone();
    let root = f.root.path().to_path_buf();
    let child=tokio::task::spawn_blocking(move || std::process::Command::new(executable)
        .args(["--exact","store::sql::tests::postgres_tiny_batches_fanout_failure_restart_revert_and_upgrade","--ignored","--nocapture"])
        .env("OBTS_CORE_RESTART_DATABASE",database).env("OBTS_CORE_RESTART_ROOT",root)
        .status().unwrap()).await.unwrap();
    assert!(child.success());
    assert_eq!(
        f.service
            .store
            .db()
            .load_obts_projection_state()
            .await
            .unwrap()
            .unwrap()
            .indexed_commit,
        Some(second.clone())
    );
    // A fresh subprocess has replayed the interrupted target without parent memory.

    let restart_source = Arc::new(
        FilesystemSource::new_with_persistence_and_budgets(
            f.root.path(),
            f.service.store.persistence.as_ref().unwrap().clone(),
            64 * 1024 * 1024,
            1,
        )
        .await
        .unwrap(),
    );
    let restart_store =
        VaultStore::new_with_persistence(20, f.service.store.persistence.as_ref().unwrap().clone())
            .with_filesystem(restart_source.clone())
            .with_projection_budgets(3, 256);
    apply_commit_delta(
        &restart_store,
        &restart_source,
        Some(second.clone()),
        f.delta(&second, Some(&second), false).await,
        true,
        false,
    )
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM links WHERE source_id='Fault.md'")
        .fetch_one(&f.service.store.db().pool)
        .await
        .unwrap();
    assert_eq!(count, 70);
    let m = &restart_store.projection_metrics;
    assert_eq!(m.normal_rows.load(Ordering::Relaxed), 3);
    assert!(m.normal_bytes.load(Ordering::Relaxed) <= 256);
    assert!(m.singleton_operations.load(Ordering::Relaxed) > 0);
    eprintln!(
        "tiny highwaters: normal rows={}, encoded bytes={}, singleton bytes={}",
        m.normal_rows.load(Ordering::Relaxed),
        m.normal_bytes.load(Ordering::Relaxed),
        m.singleton_bytes.load(Ordering::Relaxed)
    );
    sqlx::raw_sql("CREATE FUNCTION omit_tag() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tag='tag035' THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER omit_tag BEFORE INSERT ON tags FOR EACH ROW EXECUTE FUNCTION omit_tag();").execute(&f.service.store.db().pool).await.unwrap();
    assert!(
        apply_commit_delta(
            &restart_store,
            &restart_source,
            Some(second.clone()),
            f.delta(&second, Some(&second), false).await,
            true,
            false
        )
        .await
        .is_err()
    );
    assert_eq!(restart_source.indexed_commit(), Some(second.clone()));
    assert_eq!(restart_store.sql_revisions().await.unwrap()["Fault.md"], "");
    sqlx::query("DROP TRIGGER omit_tag ON tags")
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    std::fs::write(f.root.path().join("Fault.md"), old).unwrap();
    let third = "3".repeat(40);
    apply_commit_delta(
        &restart_store,
        &restart_source,
        Some(second.clone()),
        f.delta(&third, Some(&second), true).await,
        true,
        false,
    )
    .await
    .unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT (SELECT count(*) FROM links)+(SELECT count(*) FROM tags)")
            .fetch_one(&f.service.store.db().pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    // Recreate the pre-0020 schema with a complete same-commit projection, then run the real migration.
    sqlx::raw_sql("ALTER TABLE notes DROP COLUMN lexical_title,DROP COLUMN lexical_plaintext,DROP COLUMN policy_owner,DROP COLUMN policy_title_ascii,DROP COLUMN projection_hub,DROP COLUMN body_bytes; ALTER TABLE tags DROP COLUMN policy_tag; ALTER TABLE vault_files ALTER COLUMN projected_row_count TYPE INT; UPDATE vault_files SET projection_complete=TRUE,projected_row_count=0; DELETE FROM _sqlx_migrations WHERE version=20;")
        .execute(&f.service.store.db().pool).await.unwrap();
    f.service.store.db().migrate().await.unwrap();
    assert_eq!(restart_store.sql_revisions().await.unwrap()["Fault.md"], "");
    let state = f
        .service
        .store
        .db()
        .load_obts_projection_state()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state.indexed_commit, Some(third.clone()));
    apply_commit_delta(
        &restart_store,
        &restart_source,
        Some(third.clone()),
        f.delta(&third, Some(&third), false).await,
        true,
        false,
    )
    .await
    .unwrap();
    assert!(!restart_store.sql_revisions().await.unwrap()["Fault.md"].is_empty());
    assert_eq!(
        audit,
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM access_log")
            .fetch_one(&f.service.store.db().pool)
            .await
            .unwrap()
    );
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL"]
async fn postgres_lexical_order_recent_and_acl_base_differential() {
    let f = Fixture::new().await;
    let legacy = VaultStore::new(20);
    legacy
        .set_authorization_config(f.service.store.authorization_config().await)
        .await;
    let docs = [
        ("Array.md", "---\n[status]\n---\n# Array\n\nbody"),
        (
            "quartz.md",
            "# quartz\n\nUniquequartz quartz QUARTZ [[Private.md]] [[Z.md]] [[A.md]]",
        ),
        ("Z.md", "# Z\n\nuniquequartz İΣΣ ß"),
        ("A.md", "# A\n\nuniquequartz İΣΣ ß"),
        ("alpha.md", "# alpha\n\nquartzquartz"),
        (
            "Private.md",
            "---\ntags: [private]\n---\n# Private\n\nquartz",
        ),
    ];
    for (path, raw) in docs {
        std::fs::write(f.root.path().join(path), raw).unwrap();
    }
    f.project().await;
    for (path, _) in docs {
        let file = f
            .service
            .filesystem
            .as_ref()
            .unwrap()
            .read(path)
            .await
            .unwrap();
        let persisted = f
            .service
            .store
            .sql_metadata(&NoteId::new(path))
            .await
            .unwrap()
            .unwrap();
        legacy
            .project_filesystem_file(RecoveredVaultFileState {
                path: file.path,
                content: file.content,
                file_type: NewNoteFileType::Md,
                couchdb_rev: file.revision,
                created_at: persisted.created_at,
                updated_at: persisted.updated_at,
            })
            .await
            .unwrap();
    }
    for query in ["quartz", "İΣΣ", "ß"] {
        for field in [
            NoteSortField::Relevance,
            NoteSortField::Title,
            NoteSortField::UpdatedAt,
        ] {
            for order in [SortOrder::Asc, SortOrder::Desc] {
                let request = QueryNotesRequest {
                    text_query: Some(query.into()),
                    search_mode: Some(SearchMode::Fulltext),
                    sort_by: Some(field),
                    sort_order: Some(order),
                    ..Default::default()
                };
                let actual = f
                    .service
                    .query_notes(&reader(), request.clone())
                    .await
                    .unwrap();
                let expected = legacy.query_notes_for_policy(&reader(), request).await;
                assert_eq!(
                    actual
                        .notes
                        .iter()
                        .map(|n| (&n.id, n.search_score))
                        .collect::<Vec<_>>(),
                    expected
                        .notes
                        .iter()
                        .map(|n| (&n.id, n.search_score))
                        .collect::<Vec<_>>(),
                    "{query} {field:?} {order:?}"
                );
            }
        }
    }
    let request = QueryNotesRequest {
        sort_by: Some(NoteSortField::Title),
        ..Default::default()
    };
    assert_eq!(
        f.service
            .query_notes(&reader(), request.clone())
            .await
            .unwrap()
            .notes
            .iter()
            .map(|n| &n.id)
            .collect::<Vec<_>>(),
        legacy
            .query_notes_for_policy(&reader(), request)
            .await
            .notes
            .iter()
            .map(|n| &n.id)
            .collect::<Vec<_>>()
    );
    let timestamp = f
        .service
        .store
        .sql_metadata(&NoteId::new("A.md"))
        .await
        .unwrap()
        .unwrap()
        .updated_at;
    let actual = f
        .service
        .recent_notes(&reader(), Some(timestamp), None, 100)
        .await
        .unwrap();
    let expected = legacy
        .recent_notes_for_policy(&reader(), Some(timestamp), None, 100)
        .await
        .unwrap();
    assert_eq!(
        actual.notes.iter().map(|n| &n.id).collect::<Vec<_>>(),
        expected.notes.iter().map(|n| &n.id).collect::<Vec<_>>()
    );
    assert_eq!(
        f.service
            .get_note(&reader(), &NoteId::new("quartz.md"))
            .await
            .unwrap()
            .links,
        vec![NoteId::new("Z.md"), NoteId::new("A.md")]
    );
    let base=QueryBaseRequest { base_query:"filters:\n  and:\n    - 'file.hasLink(\"Private\")'\nviews:\n  - type: table\n    order: [file.name, file.links]\n".into(),..Default::default() };
    assert_eq!(
        f.service.query_base(&reader(), base).await.unwrap().total,
        0
    );
    let base = QueryBaseRequest {
        base_query: "views:\n  - type: table\n    order: [file.name, file.links]\n".into(),
        ..Default::default()
    };
    assert!(
        !serde_json::to_string(&f.service.query_base(&reader(), base).await.unwrap())
            .unwrap()
            .contains("Private.md")
    );
    assert_eq!(
        f.service
            .query_notes(
                &reader(),
                QueryNotesRequest {
                    has_frontmatter: vec!["status".into()],
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .total,
        0
    );
    std::fs::remove_file(f.root.path().join("quartz.md")).unwrap();
    assert!(
        f.service
            .query_notes(
                &reader(),
                QueryNotesRequest {
                    text_query: Some("quartz".into()),
                    search_mode: Some(SearchMode::Fulltext),
                    sort_by: Some(NoteSortField::Title),
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
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
#[ignore = "requires synthetic PostgreSQL"]
async fn postgres_complete_graph_counts_late_context_hub_and_single_slot_response() {
    let f = Fixture::new().await;
    let links = (0..505)
        .map(|i| format!("[[Node{i:03}.md]]"))
        .collect::<Vec<_>>()
        .join(" ");
    std::fs::write(
        f.root.path().join("Center.md"),
        format!("# Center\n\n{links}"),
    )
    .unwrap();
    for i in 0..505 {
        std::fs::write(
            f.root.path().join(format!("Node{i:03}.md")),
            format!("# Node{i:03}\n\n[[Center.md]] useful body."),
        )
        .unwrap();
    }
    std::fs::write(
        f.root.path().join("Hub.md"),
        "---\ntype: moc\n---\n# Hub\n\n[[Z.md]] [[A.md]]",
    )
    .unwrap();
    for name in ["Z", "A"] {
        std::fs::write(
            f.root.path().join(format!("{name}.md")),
            format!("# {name}\n\nbody"),
        )
        .unwrap();
    }
    f.project().await;
    f.service.store.settings.write().await.hub_note_threshold = 1000;
    f.service.store.settings.write().await.hub_note_fanout = 1;
    let center = NoteId::new("Center.md");
    let note = f.service.get_note(&admin(), &center).await.unwrap();
    assert_eq!(note.links.len(), 505);
    assert_eq!(note.backlinks.len(), 505);
    drop(note);
    let query = f
        .service
        .query_notes(
            &admin(),
            QueryNotesRequest {
                title_exact: Some("Center".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(query.notes[0].link_count, 505);
    assert_eq!(query.notes[0].backlink_count, 505);
    assert_eq!(
        f.service
            .backlinks(&admin(), &center)
            .await
            .unwrap()
            .backlinks
            .len(),
        505
    );
    let graph = f
        .service
        .neighbors(&admin(), &center, 1, NeighborDirection::Both)
        .await
        .unwrap();
    assert_eq!(graph.nodes.len(), 505);
    assert_eq!(graph.edges.len(), 1010);
    let req = |seeds, max_tokens| AssembleContextRequest {
        seeds,
        seed_query: None,
        max_depth: Some(1),
        max_tokens: Some(max_tokens),
        include_graph_summary: None,
        format: None,
    };
    let context = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        f.service
            .assemble_context(&admin(), req(vec![NoteId::new("Hub.md")], 1000)),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(context.notes.iter().any(|n| n.id == NoteId::new("Z.md")));
    assert!(!context.notes.iter().any(|n| n.id == NoteId::new("A.md")));
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        0
    );
    assert!(
        serde_json::to_value(&context)
            .unwrap()
            .get("_body_lease")
            .is_none()
    );
    drop(context);
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        1
    );
    f.service.store.settings.write().await.embedding_provider = "synthetic".into();
    let emb = embed_text("late candidate", 64);
    let negative = pgvector::Vector::from(emb.iter().map(|v| -*v).collect::<Vec<_>>());
    sqlx::query("UPDATE notes SET embedding=$1 WHERE id LIKE 'Node%' AND id<>'Node504.md'")
        .bind(negative)
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    sqlx::query("UPDATE notes SET embedding=$1 WHERE id>='Node000.md' AND id<='Node007.md'")
        .bind(pgvector::Vector::from(emb.clone()))
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    let mut late = emb.clone();
    let index = emb.iter().position(|v| v.abs() > 0.01).unwrap();
    let next = (index + 1) % emb.len();
    late[index] = -emb[next];
    late[next] = emb[index];
    for i in 0..late.len() {
        late[i] = 0.8 * emb[i] + 0.2 * late[i];
    }
    sqlx::query("UPDATE notes SET embedding=$1 WHERE id='Node504.md'")
        .bind(pgvector::Vector::from(late))
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    let semantic = f
        .service
        .search(&admin(), "late candidate", SearchMode::Semantic, 500)
        .await
        .unwrap();
    assert!(semantic.results.iter().any(|hit| hit.score < 0.0));
    drop(semantic);
    let mut request = req(vec![center], 115);
    request.seed_query = Some("late candidate".into());
    let context = f.service.assemble_context(&admin(), request).await.unwrap();
    assert!(
        context
            .notes
            .iter()
            .any(|n| n.id == NoteId::new("Node504.md"))
    );
    assert!(
        context
            .notes
            .iter()
            .filter(|n| matches!(n.role, crate::context::ContextRole::Seed))
            .all(|n| n.id != NoteId::new("Node504.md"))
    );
    drop(context);
    let context = f
        .service
        .assemble_context(
            &admin(),
            req(vec![NoteId::new("Z.md"), NoteId::new("A.md")], 1000),
        )
        .await
        .unwrap();
    assert_eq!(
        context.notes.iter().filter(|n| n.content.is_some()).count(),
        2
    );
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        0
    );
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(30),
            f.service
                .assemble_context(&admin(), req(vec![NoteId::new("A.md")], 1000))
        )
        .await
        .is_err()
    );
    drop(context);
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        1
    );
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .input_highwater
            .load(Ordering::SeqCst),
        1
    );
    std::fs::remove_file(f.root.path().join("Z.md")).unwrap();
    assert!(
        f.service
            .assemble_context(
                &admin(),
                req(vec![NoteId::new("A.md"), NoteId::new("Z.md")], 1000)
            )
            .await
            .is_err()
    );
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
#[ignore = "requires synthetic PostgreSQL"]
async fn postgres_cancel_singleton_drains_owned_body_before_replay() {
    let f = Fixture::with_budgets(2, 256).await;
    std::fs::write(
        f.root.path().join("Cancel.md"),
        format!(
            "---\npayload: {}\n---\n# Cancel\n\nbody",
            "synthetic ".repeat(200)
        ),
    )
    .unwrap();
    sqlx::raw_sql("CREATE FUNCTION slow_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$; CREATE TRIGGER slow_note BEFORE INSERT ON notes FOR EACH ROW EXECUTE FUNCTION slow_note();").execute(&f.service.store.db().pool).await.unwrap();
    let store = f.service.store.clone();
    let source = f.service.filesystem.as_ref().unwrap().clone();
    let task = tokio::spawn(async move { synchronize_snapshot(&store, &source).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while f.service.store.projection_singleton.available_permits() != 0 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    task.abort();
    let _ = task.await;
    assert_eq!(
        f.service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots(),
        0
    );
    assert_eq!(f.service.store.projection_singleton.available_permits(), 0);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while f
            .service
            .filesystem
            .as_ref()
            .unwrap()
            .available_body_slots()
            != 1
        {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(f.service.store.projection_singleton.available_permits(), 1);
    assert!(!f.service.filesystem.as_ref().unwrap().is_index_current());
    sqlx::query("DROP TRIGGER slow_note ON notes")
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    f.project().await;
    assert!(f.service.filesystem.as_ref().unwrap().is_index_current());
    *f.service.store.forced_projection_failure.write().await =
        Some(PersistenceFailureKind::DatabaseUnavailable);
    let cancel_id = NoteId::new("Cancel.md");
    let expected_revision = f
        .service
        .get_vault_file(&admin(), &cancel_id)
        .await
        .unwrap()
        .revision;
    let edited = f
        .service
        .edit_vault_file(
            &admin(),
            &cancel_id,
            serde_json::from_value(serde_json::json!({
                "content":"# durable local edit",
                "expected_revision": expected_revision,
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(edited.local_projection, "pending");
    assert_eq!(edited.status, "accepted");
    assert!(
        std::fs::read_to_string(f.root.path().join("Cancel.md"))
            .unwrap()
            .contains("durable local edit")
    );
    assert!(!f.service.filesystem.as_ref().unwrap().is_index_current());
    *f.service.store.forced_projection_failure.write().await = None;
    f.project().await;
    std::fs::remove_file(f.root.path().join("Cancel.md")).unwrap();
    f.project().await;
    assert!(f.service.store.sql_revisions().await.unwrap().is_empty());
    f.cleanup().await;
}

impl Fixture {
    async fn legacy_for_paths(&self, paths: &[&str]) -> VaultStore {
        let legacy = VaultStore::new(20);
        legacy
            .set_authorization_config(self.service.store.authorization_config().await)
            .await;
        for path in paths {
            let file = self
                .service
                .filesystem
                .as_ref()
                .unwrap()
                .read(path)
                .await
                .unwrap();
            legacy
                .project_filesystem_file(RecoveredVaultFileState {
                    path: file.path,
                    content: file.content,
                    file_type: NewNoteFileType::Md,
                    couchdb_rev: file.revision,
                    created_at: file.created_at,
                    updated_at: file.updated_at,
                })
                .await
                .unwrap();
        }
        legacy
    }
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL"]
async fn postgres_review_cancel_before_invalidation_blocks_noop_revert_publication() {
    use crate::filesystem::apply_commit_delta;
    let f = Fixture::new().await;
    let source = f.service.filesystem.as_ref().unwrap();
    let old = "---\ntags: [original]\n---\n# Fault\n\nOriginal body [[Old.md]]";
    std::fs::write(f.root.path().join("Fault.md"), old).unwrap();
    let first = "1".repeat(40);
    let initial = f.delta(&first, None, false).await;
    let old_oid = initial.files[0].oid.clone();
    apply_commit_delta(&f.service.store, source, None, initial, true, false)
        .await
        .unwrap();
    f.service
        .store
        .log_access("admin", "synthetic", &serde_json::json!({}), &[], 0)
        .await;
    let audit: i64 = sqlx::query_scalar("SELECT count(*) FROM access_log")
        .fetch_one(&f.service.store.db().pool)
        .await
        .unwrap();
    assert!(audit > 0);
    let old_revision = f.service.store.sql_revisions().await.unwrap()["Fault.md"].clone();
    let mut lock = f.service.store.db().pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    sqlx::query("SELECT path FROM vault_files WHERE path='Fault.md' FOR UPDATE")
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    std::fs::write(
        f.root.path().join("Fault.md"),
        "---\ntags: [abandoned]\n---\n# Changed\n\nAbandoned body [[Wrong.md]]",
    )
    .unwrap();
    let second = "2".repeat(40);
    let delta = f.delta(&second, Some(&first), true).await;
    let task_store = f.service.store.clone();
    let task_source = source.clone();
    let base = first.clone();
    let abandoned = tokio::spawn(async move {
        apply_commit_delta(&task_store, &task_source, Some(base), delta, false, false).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND $2=ANY(pg_blocking_pids(pid)))")
                .bind(&f.database).bind(blocker).fetch_one(&f.service.store.db().pool).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    abandoned.abort();
    assert!(abandoned.await.unwrap_err().is_cancelled());
    assert_eq!(source.available_body_slots(), 0);
    std::fs::write(f.root.path().join("Fault.md"), old).unwrap();
    let third = "3".repeat(40);
    let revert = crate::headless::HeadlessIndexDelta {
        head: Some(third.clone()),
        base: Some(first.clone()),
        mode: "incremental".into(),
        files: vec![crate::headless::HeadlessIndexFile {
            path: "Fault.md".into(),
            oid: old_oid,
        }],
        changes: Vec::new(),
    };
    let task_store = f.service.store.clone();
    let task_source = source.clone();
    let base = first.clone();
    let replay = tokio::spawn(async move {
        apply_commit_delta(&task_store, &task_source, Some(base), revert, false, false).await
    });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let early_finished = replay.is_finished();
    let early_ready = source.is_index_current();
    let early_cursor = f
        .service
        .store
        .db()
        .load_obts_projection_state()
        .await
        .unwrap()
        .unwrap()
        .indexed_commit;
    if early_finished || early_ready || early_cursor != Some(first.clone()) {
        lock.rollback().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), replay)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while source.available_body_slots() != 1 {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        f.cleanup().await;
        panic!(
            "replay published before abandoned work drained: finished={early_finished}, ready={early_ready}, cursor={early_cursor:?}"
        );
    }
    assert!(!replay.is_finished());
    assert!(!source.is_index_current());
    assert_eq!(early_cursor, Some(first.clone()));
    lock.rollback().await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), replay)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while source.available_body_slots() != 1 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let final_note = f
        .service
        .store
        .sql_metadata(&NoteId::new("Fault.md"))
        .await
        .unwrap()
        .unwrap();
    let final_cursor = source.indexed_commit();
    let final_targets: Vec<String> =
        sqlx::query_scalar("SELECT target_id FROM links WHERE source_id='Fault.md'")
            .fetch_all(&f.service.store.db().pool)
            .await
            .unwrap();
    let audit_after: i64 = sqlx::query_scalar("SELECT count(*) FROM access_log")
        .fetch_one(&f.service.store.db().pool)
        .await
        .unwrap();
    let final_ready = source.is_index_current();
    let final_inventory = f.service.store.sql_revisions().await.unwrap();
    f.cleanup().await;

    assert_eq!(final_cursor, Some(third));
    assert!(final_ready);
    assert_eq!(final_note.couchdb_rev, old_revision);
    assert_eq!(
        final_inventory,
        HashMap::from([("Fault.md".to_string(), old_revision)])
    );
    assert_eq!(final_note.tags, vec!["original"]);
    assert_eq!(final_targets, vec!["Old.md"]);
    assert_eq!(audit_after, audit);
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL"]
async fn postgres_review_context_uses_single_connection_pool() {
    let f = Fixture::with_pool_limit(128, 8 * 1024 * 1024, 1).await;
    for (path, raw) in [
        (
            "Hub.md",
            "---\ntype: moc\n---\n# Hub\n\n[[Z.md]] [[A.md]] [[Private.md]]",
        ),
        ("Z.md", "# Z\n\nVisible Z body"),
        ("A.md", "# A\n\nVisible A body"),
        (
            "Private.md",
            "---\ntags: [private]\n---\n# Private\n\nSecret body",
        ),
    ] {
        std::fs::write(f.root.path().join(path), raw).unwrap();
    }
    f.project().await;
    f.service.store.settings.write().await.hub_note_fanout = 1;
    f.service.store.settings.write().await.embedding_provider = "synthetic".into();
    sqlx::query("UPDATE notes SET embedding=$1")
        .bind(pgvector::Vector::from(embed_text("connection", 64)))
        .execute(&f.service.store.db().pool)
        .await
        .unwrap();
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        f.service.assemble_context(
            &reader(),
            AssembleContextRequest {
                seeds: vec![NoteId::new("Hub.md"), NoteId::new("A.md")],
                seed_query: Some("connection".into()),
                max_depth: Some(1),
                max_tokens: Some(1000),
                include_graph_summary: Some(true),
                format: None,
            },
        ),
    )
    .await;
    let success = match response {
        Ok(Ok(context)) => {
            context.notes.len() == 3
                && context
                    .notes
                    .iter()
                    .all(|n| n.id != NoteId::new("Private.md"))
                && context.notes.iter().filter(|n| n.content.is_some()).count() == 2
        }
        _ => false,
    };
    let slots = f
        .service
        .filesystem
        .as_ref()
        .unwrap()
        .available_body_slots();
    f.cleanup().await;
    assert!(
        success,
        "nonempty scoped context must finish with max_connections=1"
    );
    assert_eq!(slots, 1);
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL"]
async fn postgres_review_base_bare_builtin_names_are_properties() {
    let f = Fixture::new().await;
    for (path, value) in [("Match.md", "2026-01-01"), ("Other.md", "2025-01-01")] {
        std::fs::write(
            f.root.path().join(path),
            format!(
                "---\ndate: '{value}'\ntoday: '{value}'\nnow: '{value}'\n---\n# {path}\n\nbody"
            ),
        )
        .unwrap();
    }
    f.project().await;
    let legacy = f.legacy_for_paths(&["Match.md", "Other.md"]).await;
    let mut comparisons = Vec::new();
    for expression in [
        "date == \"2026-01-01\"",
        "today == \"2026-01-01\"",
        "now == \"2026-01-01\"",
        "date(\"2026-01-01\") == date(\"2026-01-01\")",
        "date(date) == date(\"2026-01-01\")",
        "today() <= now()",
    ] {
        let request = QueryBaseRequest {
            base_query: format!(
                "filters: '{expression}'\nviews:\n  - type: table\n    order: [file.name]\n"
            ),
            ..Default::default()
        };
        let expected = legacy
            .query_base_for_policy(&reader(), request.clone())
            .await
            .unwrap();
        let actual = f.service.query_base(&reader(), request).await.unwrap();
        comparisons.push((
            expression,
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap(),
        ));
    }
    f.cleanup().await;
    for (expression, actual, expected) in comparisons {
        assert_eq!(actual, expected, "{expression}");
    }
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL"]
async fn postgres_review_endpoint_specific_backlink_and_diamond_order() {
    let f = Fixture::new().await;
    for (path, raw) in [
        (
            "Center.md",
            "# Center\n\n[[Z.md]] then [[A.md]]".to_string(),
        ),
        (
            "A.md",
            format!("# A\n\n{} from-A [[Target.md]]", "padding ".repeat(50)),
        ),
        ("Z.md", "from-Z [[Target.md]]\n\n# Z".to_string()),
        ("Target.md", "# Target\n\nbody".to_string()),
    ] {
        std::fs::write(f.root.path().join(path), raw).unwrap();
    }
    f.project().await;
    let legacy = f
        .legacy_for_paths(&["Center.md", "A.md", "Z.md", "Target.md"])
        .await;
    let target = NoteId::new("Target.md");
    let center = NoteId::new("Center.md");
    let expected_backlinks = legacy
        .backlinks_for_policy(&admin(), &target)
        .await
        .unwrap();
    let actual_backlinks = f.service.backlinks(&admin(), &target).await.unwrap();
    let expected_graph = legacy
        .neighbors_for_policy(&admin(), &center, 2, NeighborDirection::Outgoing)
        .await
        .unwrap();
    let actual_graph = f
        .service
        .neighbors(&admin(), &center, 2, NeighborDirection::Outgoing)
        .await
        .unwrap();
    let note = f.service.get_note(&admin(), &center).await.unwrap();
    let positional_refs = note.links.clone();
    drop(note);
    let target_note = f.service.get_note(&admin(), &target).await.unwrap();
    let positional_backrefs = target_note.backlinks.clone();
    drop(target_note);
    let backward_ids = actual_backlinks
        .backlinks
        .iter()
        .map(|n| n.id.clone())
        .collect::<Vec<_>>();
    let expected_ids = expected_backlinks
        .backlinks
        .iter()
        .map(|n| n.id.clone())
        .collect::<Vec<_>>();
    let actual_parent = actual_graph
        .nodes
        .iter()
        .find(|n| n.id == target)
        .unwrap()
        .link_context
        .clone();
    let expected_parent = expected_graph
        .nodes
        .iter()
        .find(|n| n.id == target)
        .unwrap()
        .link_context
        .clone();
    f.cleanup().await;
    assert_eq!(
        positional_refs,
        vec![NoteId::new("Z.md"), NoteId::new("A.md")]
    );
    assert_eq!(
        positional_backrefs,
        vec![NoteId::new("Z.md"), NoteId::new("A.md")]
    );
    assert_eq!(
        (backward_ids, actual_parent),
        (expected_ids, expected_parent)
    );
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_worker_schema_reset_fences_already_empty_note() {
    let f = Fixture::with_pool_limit(128, 8 * 1024 * 1024, 1).await;
    std::fs::write(
        f.root.path().join("Private.md"),
        "---\ntags: [private]\n---\n# Private\n\nSynthetic body.\n",
    )
    .unwrap();
    f.project().await;
    let db = f.service.store.db();
    let before: i64 = sqlx::query_scalar("SELECT embedding_epoch FROM notes WHERE id='Private.md'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    db.ensure_embedding_schema("replacement-same-dimension", 64, 16, 64)
        .await
        .unwrap();
    let after: i64 = sqlx::query_scalar("SELECT embedding_epoch FROM notes WHERE id='Private.md'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_ne!(
        before, after,
        "pending rows must invalidate old provider tokens"
    );
    f.assert_no_resident_text().await;
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires synthetic PostgreSQL; run explicitly with --ignored"]
async fn postgres_worker_projection_invalidates_block_source_generation() {
    let f = Fixture::with_pool_limit(128, 8 * 1024 * 1024, 1).await;
    std::fs::write(
        f.root.path().join("Private.md"),
        "# Private\n\nSynthetic body.\n",
    )
    .unwrap();
    f.project().await;
    let db = f.service.store.db();
    let before: i64 = sqlx::query_scalar("SELECT derived_epoch FROM blocks LIMIT 1")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    std::fs::write(
        f.root.path().join("Private.md"),
        "---\ntags: [private]\n---\n# Private\n\nSynthetic body.\n",
    )
    .unwrap();
    f.project().await;
    let after: i64 = sqlx::query_scalar("SELECT derived_epoch FROM blocks LIMIT 1")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_ne!(
        before, after,
        "same block hash cannot hide a parent replacement"
    );
    f.cleanup().await;
}

mod embedding;
