use std::collections::HashMap;
use std::sync::{Arc, Weak};

use chrono::Utc;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::authorization::AuthContext;
use crate::base_query::{QueryBaseRequest, QueryBaseResponse};
use crate::context::{AssembleContextRequest, AssembleContextResponse};
use crate::filesystem::{FilesystemError, FilesystemSource};
use crate::headless::{HeadlessClient, HeadlessError, HeadlessFilesystemGuard};
use crate::model::{Note, NoteId, VaultFile};
use crate::new_note::{NewNoteFileType, NewNoteRequest, UpdateNoteRequest, WriteError};
use crate::search::{SearchMode, SearchResponse};
use crate::store::{
    BacklinksResponse, LocalProjectionOutcome, NeighborDirection, NeighborsResponse,
    NewNoteResponse, NoteTimeFilter, NoteVisibility, PathResponse, PreparedVaultWrite,
    QueryNotesRequest, RecentNotesResponse, StatusResponse, TagsResponse, UpdateNoteResponse,
    VaultFileVisibility, VaultStore,
};

#[derive(Clone, Debug)]
pub struct VaultBridgeService {
    pub store: VaultStore,
    pub filesystem: Option<Arc<FilesystemSource>>,
    pub headless: Option<HeadlessClient>,
    vault_file_repair_locks: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
}

impl VaultBridgeService {
    pub fn new_for_tests(store: VaultStore) -> Self {
        Self {
            store,
            filesystem: None,
            headless: None,
            vault_file_repair_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn new_with_filesystem(
        store: VaultStore,
        filesystem: Arc<FilesystemSource>,
        headless: Option<HeadlessClient>,
    ) -> Self {
        Self {
            store,
            filesystem: Some(filesystem),
            headless,
            vault_file_repair_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn ensure_index_current(&self) -> Result<(), ServiceError> {
        if self
            .headless
            .as_ref()
            .is_some_and(|client| !client.is_paired())
        {
            return Err(ServiceError::HeadlessNotPaired);
        }
        if self
            .filesystem
            .as_ref()
            .is_some_and(|filesystem| !filesystem.is_index_current())
        {
            return Err(ServiceError::IndexCatchingUp);
        }
        Ok(())
    }

    pub async fn get_note(
        &self,
        auth: &AuthContext,
        note_id: &NoteId,
    ) -> Result<Note, ServiceError> {
        if let Some(note) = self.store.get_note_for_policy(auth, note_id).await {
            return Ok(note);
        }

        let visibility = self.store.note_visibility_for_policy(auth, note_id).await;
        log_note_lookup_miss(auth, "id", note_id.as_str(), visibility);
        Err(ServiceError::NotFound)
    }

    pub async fn get_note_by_title(
        &self,
        auth: &AuthContext,
        title: &str,
    ) -> Result<Note, ServiceError> {
        if let Some(note) = self.store.get_note_by_title_for_policy(auth, title).await {
            return Ok(note);
        }

        let visibility = self.store.title_visibility_for_policy(auth, title).await;
        log_note_lookup_miss(auth, "title", title, visibility);
        Err(ServiceError::NotFound)
    }

    pub async fn search(
        &self,
        auth: &AuthContext,
        query: &str,
        mode: SearchMode,
        limit: usize,
    ) -> SearchResponse {
        self.store.search_for_policy(auth, query, mode, limit).await
    }

    pub async fn recent_notes(
        &self,
        auth: &AuthContext,
        since: Option<chrono::DateTime<Utc>>,
        last_n_days: Option<i64>,
        limit: usize,
    ) -> Result<RecentNotesResponse, ServiceError> {
        self.store
            .recent_notes_for_policy(auth, since, last_n_days, limit)
            .await
            .map_err(|error| ServiceError::BadRequest(error.to_string()))
    }

    pub async fn query_notes(
        &self,
        auth: &AuthContext,
        request: QueryNotesRequest,
    ) -> RecentNotesResponse {
        self.store.query_notes_for_policy(auth, request).await
    }

    pub async fn query_base(
        &self,
        auth: &AuthContext,
        request: QueryBaseRequest,
    ) -> Result<QueryBaseResponse, ServiceError> {
        self.store
            .query_base_for_policy(auth, request)
            .await
            .map_err(|error| ServiceError::BadRequest(error.to_string()))
    }

    pub async fn neighbors(
        &self,
        auth: &AuthContext,
        note_id: &NoteId,
        depth: usize,
        direction: NeighborDirection,
    ) -> Result<NeighborsResponse, ServiceError> {
        self.store
            .neighbors_for_policy(auth, note_id, depth, direction)
            .await
            .ok_or(ServiceError::NotFound)
    }

    pub async fn backlinks(
        &self,
        auth: &AuthContext,
        note_id: &NoteId,
    ) -> Result<BacklinksResponse, ServiceError> {
        self.store
            .backlinks_for_policy(auth, note_id)
            .await
            .ok_or(ServiceError::NotFound)
    }

    pub async fn shortest_path(
        &self,
        auth: &AuthContext,
        from: &NoteId,
        to: &NoteId,
    ) -> PathResponse {
        self.store.shortest_path_for_policy(auth, from, to).await
    }

    pub async fn assemble_context(
        &self,
        auth: &AuthContext,
        request: AssembleContextRequest,
    ) -> AssembleContextResponse {
        self.store.assemble_context_for_policy(auth, request).await
    }

    pub async fn list_tags(&self, auth: &AuthContext, filter: NoteTimeFilter) -> TagsResponse {
        self.store.tags_for_policy(auth, filter).await
    }

    pub async fn headless_command(
        &self,
        auth: &AuthContext,
        command: &str,
        arguments: Value,
    ) -> Result<Value, ServiceError> {
        if auth.context.as_str() != "admin" {
            return Err(ServiceError::Forbidden);
        }
        if command == "reset-index-projection" {
            self.filesystem
                .as_ref()
                .ok_or_else(|| {
                    ServiceError::BadRequest("filesystem source is disabled".to_string())
                })?
                .reset_commit_projection()
                .await
                .map_err(ServiceError::FilesystemWrite)?;
            return Ok(serde_json::json!({ "status": "index_projection_reset" }));
        }
        if !matches!(
            command,
            "read-state"
                | "read-queue"
                | "read-pending-onboarding"
                | "start-onboarding"
                | "poll-onboarding"
                | "analyze-onboarding"
                | "finish-onboarding"
                | "cancel-onboarding"
                | "sync-once"
                | "poll-remote-events"
                | "replace-local-with-server"
                | "rebuild-from-server-main"
                | "rename-device"
                | "unpair-device"
                | "reset-local-pairing"
        ) {
            return Err(ServiceError::BadRequest(
                "unsupported headless administration command".to_string(),
            ));
        }
        self.headless
            .as_ref()
            .ok_or_else(|| ServiceError::BadRequest("headless client is disabled".to_string()))?
            .request(command, arguments)
            .await
            .map_err(ServiceError::Headless)
    }

    pub async fn create_note(
        &self,
        auth: &AuthContext,
        request: NewNoteRequest,
    ) -> Result<NewNoteResponse, ServiceError> {
        let now = Utc::now();
        let path = self
            .store
            .validate_new_note_write_at(&request, now)
            .await
            .map_err(ServiceError::Write)?;
        let request = self
            .store
            .prepare_create_note_request(auth, request, &path, now)
            .await
            .map_err(ServiceError::Write)?;

        let write = self
            .store
            .prepare_create_vault_write_at(request, now)
            .await
            .map_err(ServiceError::Write)?;
        let response_id = NoteId::new(write.path.clone());
        let file_type = write.file_type;
        let indexed_as_note = write.note.is_some();
        let operation_id = write.operation_id.clone();
        let filesystem = self
            .filesystem
            .as_ref()
            .ok_or_else(|| ServiceError::BadRequest("filesystem source is disabled".to_string()))?;
        let headless_guard = if let Some(headless) = self.headless.as_ref() {
            Some(
                headless
                    .lock_filesystem()
                    .await
                    .map_err(ServiceError::Headless)?,
            )
        } else {
            None
        };
        let revision = filesystem
            .create(&write.path, &write.content)
            .await
            .map_err(ServiceError::FilesystemWrite)?;
        self.notify_headless_write_locked(headless_guard, &write.path)
            .await;
        let projection = self.finalize_prepared_write(write, &revision).await?;
        Ok(NewNoteResponse {
            id: response_id,
            status: projection.response_status("created"),
            file_type,
            indexed_as_note,
            local_projection: projection.state(),
            operation_id,
        })
    }

    pub async fn update_note(
        &self,
        auth: &AuthContext,
        note_id: &NoteId,
        request: UpdateNoteRequest,
    ) -> Result<UpdateNoteResponse, ServiceError> {
        let write_lock = self.vault_file_repair_lock(note_id.as_str()).await;
        let _write_guard = write_lock.lock().await;
        self.refresh_vault_file_for_write(auth, note_id).await?;
        let now = Utc::now();
        let request = self
            .store
            .prepare_update_note_request(auth, note_id, request, now)
            .await
            .map_err(ServiceError::Write)?;
        let write = self
            .store
            .prepare_update_note_write_at(note_id, &request, now)
            .await
            .map_err(ServiceError::Write)?;
        let operation_id = write.operation_id.clone();
        let filesystem = self
            .filesystem
            .as_ref()
            .ok_or_else(|| ServiceError::BadRequest("filesystem source is disabled".to_string()))?;
        let headless_guard = if let Some(headless) = self.headless.as_ref() {
            Some(
                headless
                    .lock_filesystem()
                    .await
                    .map_err(ServiceError::Headless)?,
            )
        } else {
            None
        };
        let revision = filesystem
            .update(
                &write.path,
                &write.content,
                write.expected_couchdb_rev.as_deref(),
            )
            .await
            .map_err(ServiceError::FilesystemWrite)?;
        self.notify_headless_write_locked(headless_guard, &write.path)
            .await;
        let projection = self.finalize_prepared_write(write, &revision).await?;
        Ok(UpdateNoteResponse {
            id: note_id.clone(),
            status: projection.response_status("updated"),
            local_projection: projection.state(),
            operation_id,
        })
    }

    pub async fn status(&self) -> StatusResponse {
        let mut status = self.store.status().await;
        if let Some(headless) = self.headless.as_ref() {
            status.dependencies.obts_client = if headless.is_paired() {
                "healthy"
            } else {
                status.status = "degraded";
                "not_paired"
            };
        }
        if let Some(filesystem) = self.filesystem.as_ref() {
            status.dependencies.headless_vault = if filesystem.is_index_current() {
                "healthy"
            } else {
                status.status = "degraded";
                "index_catching_up"
            };
        }
        status
    }

    pub async fn get_vault_file(
        &self,
        auth: &AuthContext,
        file_id: &NoteId,
    ) -> Result<VaultFile, ServiceError> {
        self.ensure_vault_file_available(auth, file_id).await
    }

    pub async fn create_vault_file(
        &self,
        auth: &AuthContext,
        request: NewNoteRequest,
    ) -> Result<NewNoteResponse, ServiceError> {
        let now = Utc::now();
        let path = self
            .store
            .validate_new_note_write_at(&request, now)
            .await
            .map_err(ServiceError::Write)?;
        let request = self
            .store
            .prepare_create_note_request(auth, request, &path, now)
            .await
            .map_err(ServiceError::Write)?;

        let write = self
            .store
            .prepare_create_vault_write_at(request, now)
            .await
            .map_err(ServiceError::Write)?;
        let response_id = NoteId::new(write.path.clone());
        let file_type = write.file_type;
        let indexed_as_note = write.note.is_some();
        let operation_id = write.operation_id.clone();
        let filesystem = self
            .filesystem
            .as_ref()
            .ok_or_else(|| ServiceError::BadRequest("filesystem source is disabled".to_string()))?;
        let headless_guard = if let Some(headless) = self.headless.as_ref() {
            Some(
                headless
                    .lock_filesystem()
                    .await
                    .map_err(ServiceError::Headless)?,
            )
        } else {
            None
        };
        let revision = filesystem
            .create(&write.path, &write.content)
            .await
            .map_err(ServiceError::FilesystemWrite)?;
        self.notify_headless_write_locked(headless_guard, &write.path)
            .await;
        let projection = self.finalize_prepared_write(write, &revision).await?;
        Ok(NewNoteResponse {
            id: response_id,
            status: projection.response_status("created"),
            file_type,
            indexed_as_note,
            local_projection: projection.state(),
            operation_id,
        })
    }

    pub async fn edit_vault_file(
        &self,
        auth: &AuthContext,
        file_id: &NoteId,
        request: UpdateNoteRequest,
    ) -> Result<UpdateNoteResponse, ServiceError> {
        let write_lock = self.vault_file_repair_lock(file_id.as_str()).await;
        let _write_guard = write_lock.lock().await;
        self.refresh_vault_file_for_write(auth, file_id).await?;
        let now = Utc::now();
        let write = self
            .store
            .prepare_edit_vault_file_write(auth, file_id, request, now)
            .await
            .map_err(ServiceError::Write)?;
        let operation_id = write.operation_id.clone();
        let filesystem = self
            .filesystem
            .as_ref()
            .ok_or_else(|| ServiceError::BadRequest("filesystem source is disabled".to_string()))?;
        let headless_guard = if let Some(headless) = self.headless.as_ref() {
            Some(
                headless
                    .lock_filesystem()
                    .await
                    .map_err(ServiceError::Headless)?,
            )
        } else {
            None
        };
        let revision = filesystem
            .update(
                &write.path,
                &write.content,
                write.expected_couchdb_rev.as_deref(),
            )
            .await
            .map_err(ServiceError::FilesystemWrite)?;
        self.notify_headless_write_locked(headless_guard, &write.path)
            .await;
        let projection = self.finalize_prepared_write(write, &revision).await?;
        Ok(UpdateNoteResponse {
            id: file_id.clone(),
            status: projection.response_status("updated"),
            local_projection: projection.state(),
            operation_id,
        })
    }

    async fn notify_headless_write_locked(
        &self,
        guard: Option<HeadlessFilesystemGuard<'_>>,
        path: &str,
    ) {
        let Some(headless) = self.headless.as_ref() else {
            return;
        };
        let result = if let Some(guard) = guard {
            guard.notify_local_change(headless, path).await
        } else {
            headless.notify_local_change(path).await
        };
        if let Err(error) = result {
            warn!(error = %error, path_hash = %lookup_fingerprint("vault_file", path), "file is durable locally but headless synchronization did not complete");
        }
    }

    async fn finalize_prepared_write(
        &self,
        write: PreparedVaultWrite,
        revision: &str,
    ) -> Result<LocalProjectionOutcome, ServiceError> {
        self.store
            .project_source_committed_vault_write(write, revision)
            .await
            .map_err(ServiceError::Write)
    }

    async fn ensure_vault_file_available(
        &self,
        auth: &AuthContext,
        file_id: &NoteId,
    ) -> Result<VaultFile, ServiceError> {
        if let Some(file) = self.store.get_vault_file_for_policy(auth, file_id).await {
            if let Some(filesystem) = self.filesystem.as_ref() {
                let _headless_guard = if let Some(headless) = self.headless.as_ref() {
                    Some(
                        headless
                            .lock_filesystem()
                            .await
                            .map_err(ServiceError::Headless)?,
                    )
                } else {
                    None
                };
                let current = match filesystem.read(file_id.as_str()).await {
                    Ok(current) => current,
                    Err(FilesystemError::NotFound) => {
                        filesystem.mark_dirty();
                        return Err(ServiceError::IndexCatchingUp);
                    }
                    Err(error) => return Err(ServiceError::FilesystemWrite(error)),
                };
                let current_sha256 = hex::encode(Sha256::digest(current.content.as_bytes()));
                if current_sha256 != file.content_sha256 {
                    filesystem.mark_dirty();
                    return Err(ServiceError::IndexCatchingUp);
                }
                return Ok(VaultFile {
                    id: file_id.clone(),
                    path: current.path.clone(),
                    file_type: if current.path.ends_with(".md") {
                        NewNoteFileType::Md
                    } else {
                        NewNoteFileType::Base
                    },
                    size_bytes: current.content.len(),
                    content_sha256: current_sha256,
                    content: current.content,
                    created_at: current.created_at,
                    updated_at: current.updated_at,
                });
            }
            return Ok(file);
        }
        let visibility = self
            .store
            .vault_file_visibility_for_policy(auth, file_id)
            .await;
        if visibility != VaultFileVisibility::MissingRawWithIndexedNote
            || self
                .store
                .get_note_for_policy(auth, file_id)
                .await
                .is_none()
        {
            log_vault_file_lookup_miss(auth, file_id.as_str(), visibility);
            return Err(ServiceError::NotFound);
        }
        log_vault_file_lookup_miss(auth, file_id.as_str(), visibility);
        Err(ServiceError::NotFound)
    }

    async fn refresh_vault_file_for_write(
        &self,
        auth: &AuthContext,
        file_id: &NoteId,
    ) -> Result<VaultFile, ServiceError> {
        let local_file = self.store.get_vault_file_for_policy(auth, file_id).await;
        let indexed_note = self.store.get_note_for_policy(auth, file_id).await;
        if local_file.is_none() && indexed_note.is_none() {
            let visibility = self
                .store
                .vault_file_visibility_for_policy(auth, file_id)
                .await;
            log_vault_file_lookup_miss(auth, file_id.as_str(), visibility);
            return Err(ServiceError::NotFound);
        }
        local_file.ok_or(ServiceError::NotFound)
    }

    async fn vault_file_repair_lock(&self, path: &str) -> Arc<Mutex<()>> {
        let mut locks = self.vault_file_repair_locks.lock().await;
        if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
            return lock;
        }
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = Arc::new(Mutex::new(()));
        locks.insert(path.to_string(), Arc::downgrade(&lock));
        lock
    }
}

fn log_note_lookup_miss(
    auth: &AuthContext,
    lookup_kind: &'static str,
    lookup_value: &str,
    visibility: NoteVisibility,
) {
    info!(
        context = auth.context.as_str(),
        principal = auth.principal.as_str(),
        lookup_kind,
        lookup_hash = lookup_fingerprint(lookup_kind, lookup_value).as_str(),
        visibility = note_visibility_label(visibility),
        "note lookup returned not found"
    );
}

fn note_visibility_label(visibility: NoteVisibility) -> &'static str {
    match visibility {
        NoteVisibility::Missing => "missing_index_row",
        NoteVisibility::Accessible => "accessible",
        NoteVisibility::Filtered => "filtered_by_policy",
    }
}

fn lookup_fingerprint(kind: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update(b":");
    hasher.update(value.trim().as_bytes());
    let digest = hex::encode(hasher.finalize());
    digest.chars().take(16).collect()
}

fn log_vault_file_lookup_miss(
    auth: &AuthContext,
    lookup_value: &str,
    visibility: VaultFileVisibility,
) {
    let visibility = match visibility {
        VaultFileVisibility::Missing => "missing_file",
        VaultFileVisibility::MissingRawWithIndexedNote => "missing_raw_with_indexed_note",
        VaultFileVisibility::MissingIndexWithRawMarkdown => "missing_index_with_raw_markdown",
        VaultFileVisibility::Accessible => "accessible",
        VaultFileVisibility::Filtered => "filtered_by_policy",
    };
    info!(
        context = auth.context.as_str(),
        principal = auth.principal.as_str(),
        lookup_hash = lookup_fingerprint("vault_file", lookup_value).as_str(),
        visibility,
        "vault file lookup returned not found"
    );
}

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("not found")]
    NotFound,
    #[error("forbidden")]
    Forbidden,
    #[error("headless OBTS client is not paired")]
    HeadlessNotPaired,
    #[error("vault index is catching up to the current local head")]
    IndexCatchingUp,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error(transparent)]
    Write(#[from] WriteError),
    #[error("failed to write the headless vault filesystem: {0}")]
    FilesystemWrite(FilesystemError),
    #[error("headless client operation failed: {0}")]
    Headless(HeadlessError),
}

#[cfg(test)]
mod obts_tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use chrono::Utc;
    use tempfile::tempdir;

    use super::{ServiceError, VaultBridgeService};
    use crate::authorization::{AccessPolicy, AuthContext, ContextName};
    use crate::config::AppConfig;
    use crate::filesystem::FilesystemSource;
    use crate::model::NoteId;
    use crate::new_note::NewNoteFileType;
    use crate::runtime_config::RuntimeConfigState;
    use crate::store::{RecoveredVaultFileState, VaultStore};

    #[tokio::test]
    async fn filesystem_backed_reads_fail_closed_when_visible_content_drifts() {
        let store = VaultStore::new(10);
        store
            .set_authorization_config(BTreeMap::from([(
                "admin".to_string(),
                AccessPolicy::admin(),
            )]))
            .await;
        let root = tempdir().expect("vault root");
        let source = Arc::new(FilesystemSource::new(root.path()).expect("filesystem source"));
        let path = "11New/service-test.md";
        let content = "# Service test\n\nOriginal.\n";
        let revision = source
            .create(path, content)
            .await
            .expect("create source file");
        store
            .project_filesystem_file(RecoveredVaultFileState {
                path: path.to_string(),
                content: content.to_string(),
                file_type: NewNoteFileType::Md,
                couchdb_rev: revision.clone(),
                created_at: Some(Utc::now()),
                updated_at: Utc::now(),
            })
            .await
            .expect("project source file");
        let service = VaultBridgeService::new_with_filesystem(store, source.clone(), None);
        let admin = AuthContext::new(ContextName::new("admin"), "test:admin".to_string());
        let file = service
            .get_vault_file(&admin, &NoteId::new(path))
            .await
            .expect("filesystem-backed read");
        assert_eq!(file.content, content);

        source
            .update(path, "# Drifted\n", Some(&revision))
            .await
            .expect("external drift");
        assert!(matches!(
            service.get_vault_file(&admin, &NoteId::new(path)).await,
            Err(ServiceError::IndexCatchingUp)
        ));
    }

    #[tokio::test]
    async fn filesystem_backed_reads_fail_closed_when_indexed_file_disappears() {
        let store = VaultStore::new(10);
        store
            .set_authorization_config(BTreeMap::from([(
                "admin".to_string(),
                AccessPolicy::admin(),
            )]))
            .await;
        let root = tempdir().expect("vault root");
        let source = Arc::new(FilesystemSource::new(root.path()).expect("filesystem source"));
        let path = "11New/deleted-during-read.md";
        let content = "# Delete race\n";
        let revision = source
            .create(path, content)
            .await
            .expect("create source file");
        store
            .project_filesystem_file(RecoveredVaultFileState {
                path: path.to_string(),
                content: content.to_string(),
                file_type: NewNoteFileType::Md,
                couchdb_rev: revision,
                created_at: Some(Utc::now()),
                updated_at: Utc::now(),
            })
            .await
            .expect("project source file");
        let service = VaultBridgeService::new_with_filesystem(store, source.clone(), None);
        tokio::fs::remove_file(root.path().join(path))
            .await
            .expect("remove source file");
        let admin = AuthContext::new(ContextName::new("admin"), "test:admin".to_string());
        assert!(matches!(
            service.get_vault_file(&admin, &NoteId::new(path)).await,
            Err(ServiceError::IndexCatchingUp)
        ));
    }

    #[tokio::test]
    async fn only_admin_can_reset_the_derived_projection_cursor() {
        let config = AppConfig::default();
        let runtime_config = RuntimeConfigState::for_tests(&config);
        let store = VaultStore::new_with_auth_config(10, runtime_config.auth_config());
        let root = tempdir().expect("vault root");
        let source = Arc::new(FilesystemSource::new(root.path()).expect("filesystem source"));
        let service = VaultBridgeService::new_with_filesystem(store, source, None);
        let non_admin =
            AuthContext::new(ContextName::new("non_personal"), "test:agent".to_string());
        assert!(matches!(
            service
                .headless_command(
                    &non_admin,
                    "reset-index-projection",
                    serde_json::Value::Null
                )
                .await,
            Err(ServiceError::Forbidden)
        ));
        let admin = AuthContext::new(ContextName::new("admin"), "test:admin".to_string());
        assert_eq!(
            service
                .headless_command(&admin, "reset-index-projection", serde_json::Value::Null)
                .await
                .expect("reset projection"),
            serde_json::json!({ "status": "index_projection_reset" })
        );
    }
}
