use std::collections::HashMap;
use std::sync::{Arc, Weak};

use chrono::Utc;
use once_cell::sync::Lazy;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::{Mutex, Semaphore};
use tracing::{info, warn};

use crate::authorization::AuthContext;
use crate::base_query::{QueryBaseRequest, QueryBaseResponse};
use crate::context::{AssembleContextRequest, AssembleContextResponse};
use crate::filesystem::{FilesystemError, FilesystemSource};
use crate::headless::{HeadlessClient, HeadlessError, HeadlessFilesystemGuard};
use crate::model::{Note, NoteId, VaultFile};
use crate::new_note::{
    NewNoteFileType, NewNoteRequest, PersistenceFailureKind, UpdateNoteRequest, WriteError,
};
use crate::search::{SearchMode, SearchResponse};
use crate::store::{
    BacklinksResponse, LocalProjectionOutcome, NeighborDirection, NeighborsResponse,
    NewNoteResponse, NoteTimeFilter, NoteVisibility, PathResponse, PreparedVaultWrite,
    QueryNotesRequest, RecentNotesResponse, StatusResponse, TagsResponse, UpdateNoteResponse,
    VaultFileVisibility, VaultStore, whole_file_revision,
};
use crate::vault_export::{
    MarkdownExportError, MarkdownExportResponse, export_markdown as build_markdown_export,
};

static MARKDOWN_EXPORT_SEMAPHORE: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(1)));

#[derive(Clone, Debug)]
pub struct VaultBridgeService {
    pub store: VaultStore,
    pub filesystem: Option<Arc<FilesystemSource>>,
    pub headless: Option<HeadlessClient>,
    vault_write_lock: Arc<Mutex<()>>,
    vault_file_repair_locks: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
}

impl VaultBridgeService {
    #[cfg(test)]
    pub fn new_for_tests(store: VaultStore) -> Self {
        Self {
            store,
            filesystem: None,
            headless: None,
            vault_write_lock: Arc::new(Mutex::new(())),
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
            vault_write_lock: Arc::new(Mutex::new(())),
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

    async fn sql_read_guard(
        &self,
    ) -> Result<
        (
            tokio::sync::MutexGuard<'_, ()>,
            Option<HeadlessFilesystemGuard<'_>>,
            tokio::sync::RwLockReadGuard<'_, ()>,
        ),
        ServiceError,
    > {
        let lock = self.vault_write_lock.lock().await;
        let headless = if let Some(client) = &self.headless {
            Some(
                client
                    .lock_filesystem()
                    .await
                    .map_err(ServiceError::Headless)?,
            )
        } else {
            None
        };
        let projection = self
            .filesystem
            .as_ref()
            .expect("SQL filesystem")
            .projection_lock
            .read()
            .await;
        self.ensure_index_current()?;
        Ok((lock, headless, projection))
    }

    pub(crate) async fn capture_embedding_source(
        &self,
        token: &crate::store::EmbeddingNoteToken,
    ) -> Result<Option<(crate::filesystem::FilesystemFile, String)>, ServiceError> {
        let _guard = self.sql_read_guard().await?;
        let Some((path, title)) = self.store.embedding_source(token).await? else {
            return Ok(None);
        };
        let file = self
            .filesystem
            .as_ref()
            .expect("worker filesystem")
            .read_attested(&path, &token.revision)
            .await
            .map_err(|_| ServiceError::IndexCatchingUp)?;
        Ok(Some((file, title)))
    }

    pub async fn get_note(
        &self,
        auth: &AuthContext,
        note_id: &NoteId,
    ) -> Result<Note, ServiceError> {
        if self.store.uses_sql_backend() {
            let _guard = self.sql_read_guard().await?;
            return self.store.sql_get_note(auth, note_id).await;
        }
        if let Some(note) = self.store.get_note_for_policy(auth, note_id).await {
            return Ok(note);
        }

        let visibility = self.store.note_visibility_for_policy(auth, note_id).await;
        log_note_lookup_miss(auth, "id", note_id.as_str(), visibility);
        if visibility == NoteVisibility::Accessible {
            Err(ServiceError::IndexCatchingUp)
        } else {
            Err(ServiceError::NotFound)
        }
    }

    pub async fn get_note_by_title(
        &self,
        auth: &AuthContext,
        title: &str,
    ) -> Result<Note, ServiceError> {
        if self.store.uses_sql_backend() {
            let _guard = self.sql_read_guard().await?;
            return self.store.sql_get_title(auth, title).await;
        }
        if let Some(note) = self.store.get_note_by_title_for_policy(auth, title).await {
            return Ok(note);
        }

        let visibility = self.store.title_visibility_for_policy(auth, title).await;
        log_note_lookup_miss(auth, "title", title, visibility);
        if visibility == NoteVisibility::Accessible {
            Err(ServiceError::IndexCatchingUp)
        } else {
            Err(ServiceError::NotFound)
        }
    }

    pub async fn search(
        &self,
        auth: &AuthContext,
        query: &str,
        mode: SearchMode,
        limit: usize,
    ) -> Result<SearchResponse, ServiceError> {
        if self.store.uses_sql_backend() {
            let _guard = self.sql_read_guard().await?;
            return self.store.sql_search(auth, query, mode, limit).await;
        }
        Ok(self.store.search_for_policy(auth, query, mode, limit).await)
    }

    pub async fn recent_notes(
        &self,
        auth: &AuthContext,
        since: Option<chrono::DateTime<Utc>>,
        last_n_days: Option<i64>,
        limit: usize,
    ) -> Result<RecentNotesResponse, ServiceError> {
        if self.store.uses_sql_backend() {
            let threshold = if let Some(since) = since {
                since
            } else if let Some(days) = last_n_days {
                if days <= 0 {
                    return Err(ServiceError::BadRequest(
                        "last_n_days must be positive".to_string(),
                    ));
                }
                Utc::now() - chrono::Duration::days(days)
            } else {
                return Err(ServiceError::BadRequest(
                    "one of since or last_n_days is required".to_string(),
                ));
            };
            let _guard = self.sql_read_guard().await?;
            return self
                .store
                .sql_query_notes(
                    auth,
                    QueryNotesRequest {
                        time_filter: NoteTimeFilter {
                            updated_strictly_after: Some(threshold),
                            ..Default::default()
                        },
                        limit: Some(limit),
                        ..Default::default()
                    },
                )
                .await;
        }
        self.store
            .recent_notes_for_policy(auth, since, last_n_days, limit)
            .await
            .map_err(|error| ServiceError::BadRequest(error.to_string()))
    }

    pub async fn query_notes(
        &self,
        auth: &AuthContext,
        request: QueryNotesRequest,
    ) -> Result<RecentNotesResponse, ServiceError> {
        if self.store.uses_sql_backend() {
            let _guard = self.sql_read_guard().await?;
            return self.store.sql_query_notes(auth, request).await;
        }
        Ok(self.store.query_notes_for_policy(auth, request).await)
    }

    pub async fn query_base(
        &self,
        auth: &AuthContext,
        request: QueryBaseRequest,
    ) -> Result<QueryBaseResponse, ServiceError> {
        if self.store.uses_sql_backend() {
            let _guard = self.sql_read_guard().await?;
            return self.store.sql_base(auth, request).await;
        }
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
        if self.store.uses_sql_backend() {
            let _guard = self.sql_read_guard().await?;
            return self
                .store
                .sql_neighbors(auth, note_id, depth, direction)
                .await;
        }
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
        if self.store.uses_sql_backend() {
            let _guard = self.sql_read_guard().await?;
            return self.store.sql_backlinks(auth, note_id).await;
        }
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
    ) -> Result<PathResponse, ServiceError> {
        if self.store.uses_sql_backend() {
            let _guard = self.sql_read_guard().await?;
            return self.store.sql_path(auth, from, to).await;
        }
        Ok(self.store.shortest_path_for_policy(auth, from, to).await)
    }

    pub async fn assemble_context(
        &self,
        auth: &AuthContext,
        request: AssembleContextRequest,
    ) -> Result<AssembleContextResponse, ServiceError> {
        if self.store.uses_sql_backend() {
            let _guard = self.sql_read_guard().await?;
            return self.store.sql_context(auth, request).await;
        }
        Ok(self.store.assemble_context_for_policy(auth, request).await)
    }

    pub async fn list_tags(
        &self,
        auth: &AuthContext,
        filter: NoteTimeFilter,
    ) -> Result<TagsResponse, ServiceError> {
        if self.store.uses_sql_backend() {
            let _guard = self.sql_read_guard().await?;
            return self.store.sql_tags(auth, filter).await;
        }
        Ok(self.store.tags_for_policy(auth, filter).await)
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
        let _vault_write_guard = self.vault_write_lock.lock().await;
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
        let response_revision = whole_file_revision(&write.content);
        let filesystem = self
            .filesystem
            .as_ref()
            .ok_or_else(|| ServiceError::BadRequest("filesystem source is disabled".to_string()))?;
        let mut headless_guard = if let Some(headless) = self.headless.as_ref() {
            Some(
                headless
                    .lock_filesystem()
                    .await
                    .map_err(ServiceError::Headless)?,
            )
        } else {
            None
        };
        let _projection_guard = filesystem.projection_lock.write().await;
        self.ensure_projected_write_within_limit(filesystem, &write.path, write.content.len())
            .await?;
        let revision = filesystem
            .create(&write.path, &write.content)
            .await
            .map_err(ServiceError::FilesystemWrite)?;
        self.notify_headless_write_locked(headless_guard.as_mut(), &write.path)
            .await;
        let projection = self.finalize_prepared_write(write, &revision).await?;
        drop(headless_guard);
        Ok(NewNoteResponse {
            id: response_id,
            revision: response_revision,
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
        if self.store.uses_sql_backend() {
            return self.sql_update(auth, note_id, request, false).await;
        }
        let write_lock = self.vault_file_repair_lock(note_id.as_str()).await;
        let _write_guard = write_lock.lock().await;
        let _vault_write_guard = self.vault_write_lock.lock().await;
        let filesystem = self.filesystem.as_ref().expect("filesystem source");
        let indexed = matches!(filesystem.is_path_ignored(note_id.as_str()), Ok(false))
            && match self.refresh_vault_file_for_write(auth, note_id).await {
                Ok(_) => true,
                Err(ServiceError::NotFound) => false,
                Err(error) => return Err(error),
            };
        let write = if indexed {
            let now = Utc::now();
            let request = self
                .store
                .prepare_update_note_request(auth, note_id, request, now)
                .await
                .map_err(ServiceError::Write)?;
            self.store
                .prepare_update_note_write_at(note_id, &request, now)
                .await
                .map_err(ServiceError::Write)?
        } else {
            let file = filesystem
                .read(note_id.as_str())
                .await
                .map_err(ServiceError::FilesystemWrite)?;
            self.store
                .prepare_source_update(auth, note_id, request, false, &file)
                .await?
        };
        let operation_id = write.operation_id.clone();
        let response_revision = whole_file_revision(&write.content);
        let filesystem = self
            .filesystem
            .as_ref()
            .ok_or_else(|| ServiceError::BadRequest("filesystem source is disabled".to_string()))?;
        let mut headless_guard = if let Some(headless) = self.headless.as_ref() {
            Some(
                headless
                    .lock_filesystem()
                    .await
                    .map_err(ServiceError::Headless)?,
            )
        } else {
            None
        };
        let _projection_guard = filesystem.projection_lock.write().await;
        self.ensure_projected_write_within_limit(filesystem, &write.path, write.content.len())
            .await?;
        let revision = filesystem
            .update(
                &write.path,
                &write.content,
                write.expected_couchdb_rev.as_deref(),
            )
            .await
            .map_err(ServiceError::FilesystemWrite)?;
        self.notify_headless_write_locked(headless_guard.as_mut(), &write.path)
            .await;
        let projection = self.finalize_prepared_write(write, &revision).await?;
        drop(headless_guard);
        Ok(UpdateNoteResponse {
            id: note_id.clone(),
            revision: response_revision,
            status: projection.response_status("updated"),
            local_projection: projection.state(),
            operation_id,
        })
    }

    pub async fn status(&self) -> StatusResponse {
        let mut status = self.store.status().await;
        if let Some(headless) = self.headless.as_ref() {
            status.headless_process = headless.runtime_status();
            status.dependencies.obts_client = if status.headless_process.up && headless.is_paired()
            {
                "healthy"
            } else {
                status.status = "degraded";
                if status.headless_process.circuit_open {
                    "circuit_open"
                } else {
                    "not_paired"
                }
            };
        }
        if let Some(filesystem) = self.filesystem.as_ref() {
            status.filesystem_projection = filesystem.projection_status();
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

    pub(crate) async fn export_markdown(
        &self,
        auth: &AuthContext,
        if_none_match: &[String],
    ) -> Result<MarkdownExportResponse, MarkdownExportError> {
        let permit = MARKDOWN_EXPORT_SEMAPHORE
            .clone()
            .try_acquire_owned()
            .map_err(|_| MarkdownExportError::Busy)?;
        let source = self.filesystem.clone().ok_or_else(|| {
            MarkdownExportError::Projection("filesystem source is disabled".to_string())
        })?;
        let store = self.store.clone();
        let headless = self.headless.clone();
        let auth = auth.clone();
        let if_none_match = if_none_match.to_vec();
        tokio::spawn(async move {
            let _headless_guard = if let Some(headless) = headless.as_ref() {
                Some(
                    headless
                        .lock_filesystem()
                        .await
                        .map_err(|error| MarkdownExportError::Projection(error.to_string()))?,
                )
            } else {
                None
            };
            let _projection_guard = source.projection_lock.read().await;
            if !source.is_index_current() {
                return Err(MarkdownExportError::IndexCatchingUp);
            }
            build_markdown_export(&store, &source, &auth, &if_none_match, permit).await
        })
        .await
        .map_err(|error| MarkdownExportError::Task(error.to_string()))?
    }

    pub async fn create_vault_file(
        &self,
        auth: &AuthContext,
        request: NewNoteRequest,
    ) -> Result<NewNoteResponse, ServiceError> {
        let _vault_write_guard = self.vault_write_lock.lock().await;
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
        let response_revision = whole_file_revision(&write.content);
        let filesystem = self
            .filesystem
            .as_ref()
            .ok_or_else(|| ServiceError::BadRequest("filesystem source is disabled".to_string()))?;
        let mut headless_guard = if let Some(headless) = self.headless.as_ref() {
            Some(
                headless
                    .lock_filesystem()
                    .await
                    .map_err(ServiceError::Headless)?,
            )
        } else {
            None
        };
        let _projection_guard = filesystem.projection_lock.write().await;
        self.ensure_projected_write_within_limit(filesystem, &write.path, write.content.len())
            .await?;
        let revision = filesystem
            .create(&write.path, &write.content)
            .await
            .map_err(ServiceError::FilesystemWrite)?;
        self.notify_headless_write_locked(headless_guard.as_mut(), &write.path)
            .await;
        let projection = self.finalize_prepared_write(write, &revision).await?;
        drop(headless_guard);
        Ok(NewNoteResponse {
            id: response_id,
            revision: response_revision,
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
        if self.store.uses_sql_backend() {
            return self.sql_update(auth, file_id, request, true).await;
        }
        let write_lock = self.vault_file_repair_lock(file_id.as_str()).await;
        let _write_guard = write_lock.lock().await;
        let _vault_write_guard = self.vault_write_lock.lock().await;
        let filesystem = self.filesystem.as_ref().expect("filesystem source");
        let indexed = matches!(filesystem.is_path_ignored(file_id.as_str()), Ok(false))
            && match self.refresh_vault_file_for_write(auth, file_id).await {
                Ok(_) => true,
                Err(ServiceError::NotFound) => false,
                Err(error) => return Err(error),
            };
        let write = if indexed {
            self.store
                .prepare_edit_vault_file_write(auth, file_id, request, Utc::now())
                .await
                .map_err(ServiceError::Write)?
        } else {
            let file = filesystem
                .read(file_id.as_str())
                .await
                .map_err(ServiceError::FilesystemWrite)?;
            self.store
                .prepare_source_update(auth, file_id, request, true, &file)
                .await?
        };
        let operation_id = write.operation_id.clone();
        let response_revision = whole_file_revision(&write.content);
        let filesystem = self
            .filesystem
            .as_ref()
            .ok_or_else(|| ServiceError::BadRequest("filesystem source is disabled".to_string()))?;
        let mut headless_guard = if let Some(headless) = self.headless.as_ref() {
            Some(
                headless
                    .lock_filesystem()
                    .await
                    .map_err(ServiceError::Headless)?,
            )
        } else {
            None
        };
        let _projection_guard = filesystem.projection_lock.write().await;
        self.ensure_projected_write_within_limit(filesystem, &write.path, write.content.len())
            .await?;
        let revision = filesystem
            .update(
                &write.path,
                &write.content,
                write.expected_couchdb_rev.as_deref(),
            )
            .await
            .map_err(ServiceError::FilesystemWrite)?;
        self.notify_headless_write_locked(headless_guard.as_mut(), &write.path)
            .await;
        let projection = self.finalize_prepared_write(write, &revision).await?;
        drop(headless_guard);
        Ok(UpdateNoteResponse {
            id: file_id.clone(),
            revision: response_revision,
            status: projection.response_status("updated"),
            local_projection: projection.state(),
            operation_id,
        })
    }

    async fn sql_update(
        &self,
        auth: &AuthContext,
        id: &NoteId,
        request: UpdateNoteRequest,
        raw: bool,
    ) -> Result<UpdateNoteResponse, ServiceError> {
        let _write_guard = self.vault_write_lock.lock().await;
        let mut headless_guard = if let Some(client) = &self.headless {
            Some(
                client
                    .lock_filesystem()
                    .await
                    .map_err(ServiceError::Headless)?,
            )
        } else {
            None
        };
        let _projection = self
            .filesystem
            .as_ref()
            .expect("SQL filesystem")
            .projection_lock
            .write()
            .await;
        let source = self.filesystem.as_ref().expect("SQL filesystem");
        let indexed = matches!(source.is_path_ignored(id.as_str()), Ok(false));
        let write = if indexed {
            self.ensure_index_current()?;
            match self
                .store
                .sql_prepare_write(auth, id, request.clone(), raw)
                .await
            {
                Ok(write) => write,
                Err(ServiceError::NotFound) => {
                    let file = source
                        .read(id.as_str())
                        .await
                        .map_err(ServiceError::FilesystemWrite)?;
                    self.store
                        .prepare_source_update(auth, id, request, raw, &file)
                        .await?
                }
                Err(error) => return Err(error),
            }
        } else {
            let file = source
                .read(id.as_str())
                .await
                .map_err(ServiceError::FilesystemWrite)?;
            self.store
                .prepare_source_update(auth, id, request, raw, &file)
                .await?
        };
        let operation_id = write.operation_id.clone();
        let response_revision = whole_file_revision(&write.content);
        self.ensure_projected_write_within_limit(source, &write.path, write.content.len())
            .await?;
        let revision = source
            .update(
                &write.path,
                &write.content,
                write.expected_couchdb_rev.as_deref(),
            )
            .await
            .map_err(ServiceError::FilesystemWrite)?;
        self.notify_headless_write_locked(headless_guard.as_mut(), &write.path)
            .await;
        let projection = self.finalize_prepared_write(write, &revision).await?;
        Ok(UpdateNoteResponse {
            id: id.clone(),
            revision: response_revision,
            status: projection.response_status("updated"),
            local_projection: projection.state(),
            operation_id,
        })
    }

    async fn ensure_projected_write_within_limit(
        &self,
        filesystem: &FilesystemSource,
        path: &str,
        replacement_bytes: usize,
    ) -> Result<(), ServiceError> {
        filesystem
            .ensure_projected_write_size(path, replacement_bytes as u64)
            .await
            .map_err(ServiceError::FilesystemWrite)
    }

    async fn notify_headless_write_locked(
        &self,
        guard: Option<&mut HeadlessFilesystemGuard<'_>>,
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
        mut write: PreparedVaultWrite,
        revision: &str,
    ) -> Result<LocalProjectionOutcome, ServiceError> {
        let source = self.filesystem.as_ref().expect("source");
        match source.is_path_ignored(&write.path) {
            Ok(true) => {
                let path = write.path;
                let result = self
                    .store
                    .delete_filesystem_file(&NoteId::new(path.clone()))
                    .await;
                return match result {
                    Ok(()) => {
                        self.store.clear_local_projection_pending(&path).await;
                        Ok(LocalProjectionOutcome::Applied)
                    }
                    Err(error) => {
                        let kind = match error {
                            WriteError::Persistence { kind } => kind,
                            _ => PersistenceFailureKind::Unknown,
                        };
                        Ok(self
                            .store
                            .mark_local_projection_pending(path, revision, kind)
                            .await)
                    }
                };
            }
            Err(error) => {
                warn!(error = %error, path_hash = %lookup_fingerprint("vault_file", &write.path), "local write committed, projection policy unavailable");
                return Ok(self
                    .store
                    .mark_local_projection_pending(
                        write.path,
                        revision,
                        PersistenceFailureKind::Unknown,
                    )
                    .await);
            }
            Ok(false) => {}
        }
        if self.store.uses_sql_backend() && write.body_lease.is_none() {
            let file = self
                .filesystem
                .as_ref()
                .expect("source")
                .read(&write.path)
                .await
                .map_err(ServiceError::FilesystemWrite)?;
            if file.revision != revision {
                return Err(ServiceError::IndexCatchingUp);
            }
            write.body_lease = file.lease.clone();
        }
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
        if let Some(source) = self.filesystem.as_ref()
            && !matches!(source.is_path_ignored(file_id.as_str()), Ok(false))
        {
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
            let _projection_guard = source.projection_lock.read().await;
            let file = source.read(file_id.as_str()).await.map_err(|error| {
                if matches!(error, FilesystemError::NotFound) {
                    ServiceError::NotFound
                } else {
                    ServiceError::FilesystemWrite(error)
                }
            })?;
            if !self.store.source_file_readable(auth, &file).await {
                return Err(ServiceError::NotFound);
            }
            let content_sha256 = hex::encode(Sha256::digest(file.content.as_bytes()));
            return Ok(VaultFile {
                _body_lease: file.lease.clone(),
                id: file_id.clone(),
                revision: whole_file_revision(&file.content),
                path: file.path.clone(),
                file_type: if file.path.ends_with(".md") {
                    NewNoteFileType::Md
                } else {
                    NewNoteFileType::Base
                },
                size_bytes: file.content.len(),
                content_sha256,
                content: file.content,
                created_at: file.created_at,
                updated_at: file.updated_at,
            });
        }
        if self.store.uses_sql_backend() {
            let _guard = self.sql_read_guard().await?;
            return self.store.sql_get_file(auth, file_id).await;
        }
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
                    _body_lease: current.lease.clone(),
                    id: file_id.clone(),
                    revision: whole_file_revision(&current.content),
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
    use crate::authorization::{AccessMatcher, AccessPolicy, AccessRule, AuthContext, ContextName};
    use crate::config::AppConfig;
    use crate::filesystem::FilesystemSource;
    use crate::model::NoteId;
    use crate::new_note::{NewNoteFileType, NewNoteRequest, UpdateNoteRequest, WriteError};
    use crate::runtime_config::RuntimeConfigState;
    use crate::store::{RecoveredVaultFileState, VaultStore};

    #[tokio::test]
    async fn ignored_note_and_vault_file_writes_remain_local() {
        let store = VaultStore::new(10);
        store
            .set_authorization_config(BTreeMap::from([
                ("admin".into(), AccessPolicy::admin()),
                (
                    "reader".into(),
                    AccessPolicy {
                        read: vec![
                            AccessRule::deny(AccessMatcher {
                                tags_any: vec!["private".into()],
                                ..Default::default()
                            }),
                            AccessRule::allow(AccessMatcher::allow_all()),
                        ],
                        ..Default::default()
                    },
                ),
            ]))
            .await;
        let root = tempdir().unwrap();
        let source = Arc::new(FilesystemSource::new(root.path()).unwrap());
        for (path, content, file_type) in [
            ("Note.md", "# Note\n", NewNoteFileType::Md),
            ("Data.base", "views: []\n", NewNoteFileType::Base),
        ] {
            let revision = source.create(path, content).await.unwrap();
            store
                .project_filesystem_file(RecoveredVaultFileState {
                    path: path.into(),
                    content: content.into(),
                    file_type,
                    couchdb_rev: revision,
                    created_at: Some(Utc::now()),
                    updated_at: Utc::now(),
                })
                .await
                .unwrap();
        }
        let service = VaultBridgeService::new_with_filesystem(store.clone(), source.clone(), None);
        let auth = AuthContext::new(ContextName::new("admin"), "test:admin".into());
        std::fs::write(root.path().join(".gitignore"), "*.md\n*.base\n").unwrap();
        let new_request = |file_type| NewNoteRequest {
            title: "new".into(),
            content: if file_type == NewNoteFileType::Base {
                "views: []\n"
            } else {
                "new"
            }
            .into(),
            template_id: None,
            file_type,
        };
        let note = service
            .create_note(&auth, new_request(NewNoteFileType::Md))
            .await
            .unwrap();
        let file = service
            .create_vault_file(&auth, new_request(NewNoteFileType::Base))
            .await
            .unwrap();
        assert!(
            std::fs::read_to_string(root.path().join(note.id.as_str()))
                .unwrap()
                .ends_with("\nnew\n")
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join(file.id.as_str())).unwrap(),
            "views: []\n"
        );
        assert!(store.get_note_for_policy(&auth, &note.id).await.is_none());
        let note_before = std::fs::read_to_string(root.path().join(note.id.as_str())).unwrap();
        let note_read = service.get_vault_file(&auth, &note.id).await.unwrap();
        assert_eq!(
            note_read.revision,
            crate::store::whole_file_revision(&note_before)
        );
        let reader = AuthContext::new(ContextName::new("reader"), "test:reader".into());
        source
            .create("Private.md", "---\ntags:\n- private\n---\n\nprivate body\n")
            .await
            .unwrap();
        assert!(matches!(
            service
                .get_vault_file(&reader, &NoteId::new("Private.md"))
                .await,
            Err(ServiceError::NotFound)
        ));
        assert!(
            service
                .get_vault_file(&auth, &NoteId::new("Private.md"))
                .await
                .is_ok()
        );
        assert!(matches!(
            service
                .update_note(
                    &reader,
                    &note.id,
                    UpdateNoteRequest {
                        content: Some("forbidden".into()),
                        content_patch: None,
                        tags: None,
                        metadata: None,
                        expected_revision: Some(crate::store::whole_file_revision(&note_before)),
                    }
                )
                .await,
            Err(ServiceError::Write(WriteError::PolicyDenied { .. }))
        ));
        assert_eq!(
            std::fs::read_to_string(root.path().join(note.id.as_str())).unwrap(),
            note_before
        );
        service
            .update_note(
                &auth,
                &note.id,
                UpdateNoteRequest {
                    content: Some("local edit".into()),
                    content_patch: None,
                    tags: None,
                    metadata: None,
                    expected_revision: Some(crate::store::whole_file_revision(&note_before)),
                },
            )
            .await
            .unwrap();
        let base_before = std::fs::read_to_string(root.path().join(file.id.as_str())).unwrap();
        service
            .edit_vault_file(
                &auth,
                &file.id,
                UpdateNoteRequest {
                    content: Some("views: []\nfilters: []\n".into()),
                    content_patch: None,
                    tags: None,
                    metadata: None,
                    expected_revision: Some(crate::store::whole_file_revision(&base_before)),
                },
            )
            .await
            .unwrap();
        assert!(
            std::fs::read_to_string(root.path().join(note.id.as_str()))
                .unwrap()
                .ends_with("\nlocal edit\n")
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join(file.id.as_str())).unwrap(),
            "views: []\nfilters: []\n"
        );
        assert!(store.get_note_for_policy(&auth, &note.id).await.is_none());
        assert!(
            store
                .get_vault_file_for_policy(&auth, &file.id)
                .await
                .is_none()
        );
        std::fs::write(root.path().join(".gitignore"), [0xff]).unwrap();
        let note_revision =
            crate::store::whole_file_revision(&source.read("Note.md").await.unwrap().content);
        let edit = UpdateNoteRequest {
            content: Some("changed".into()),
            content_patch: None,
            tags: None,
            metadata: None,
            expected_revision: Some(note_revision),
        };
        let accepted = service
            .update_note(&auth, &NoteId::new("Note.md"), edit)
            .await
            .unwrap();
        assert_eq!(accepted.local_projection, "pending");
        assert_eq!(store.status().await.write_projection.pending, 1);
        assert!(
            std::fs::read_to_string(root.path().join("Note.md"))
                .unwrap()
                .ends_with("\nchanged\n")
        );
        std::fs::write(root.path().join(".gitignore"), "*.md\n*.base\n").unwrap();
        crate::filesystem::synchronize_snapshot(&store, &source)
            .await
            .unwrap();
        assert_eq!(store.status().await.write_projection.pending, 0);
        assert!(
            store
                .get_note_for_policy(&auth, &NoteId::new("Note.md"))
                .await
                .is_none()
        );
    }

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
    async fn existing_file_edits_require_and_advance_whole_file_revisions() {
        let store = VaultStore::new(10);
        store
            .set_authorization_config(BTreeMap::from([(
                "admin".to_string(),
                AccessPolicy::admin(),
            )]))
            .await;
        let root = tempdir().expect("vault root");
        let source = Arc::new(FilesystemSource::new(root.path()).expect("filesystem source"));
        let path = "Revision.md";
        let original_content = "# Original\n";
        let source_revision = source
            .create(path, original_content)
            .await
            .expect("create source file");
        store
            .project_filesystem_file(RecoveredVaultFileState {
                path: path.to_string(),
                content: original_content.to_string(),
                file_type: NewNoteFileType::Md,
                couchdb_rev: source_revision,
                created_at: Some(Utc::now()),
                updated_at: Utc::now(),
            })
            .await
            .expect("project source file");
        let service = VaultBridgeService::new_with_filesystem(store, source.clone(), None);
        let admin = AuthContext::new(ContextName::new("admin"), "test:admin".to_string());
        let id = NoteId::new(path);
        let original = service
            .get_vault_file(&admin, &id)
            .await
            .expect("read original file");
        assert!(original.revision.starts_with("v1:sha256:"));

        let missing = UpdateNoteRequest {
            content: Some("# Missing precondition\n".to_string()),
            content_patch: None,
            tags: None,
            metadata: None,
            expected_revision: None,
        };
        assert!(matches!(
            service.edit_vault_file(&admin, &id, missing).await,
            Err(ServiceError::Write(WriteError::PreconditionRequired))
        ));

        let stale_revision = original.revision;
        let response = service
            .edit_vault_file(
                &admin,
                &id,
                UpdateNoteRequest {
                    content: Some("# Updated\n".to_string()),
                    content_patch: None,
                    tags: None,
                    metadata: None,
                    expected_revision: Some(stale_revision.clone()),
                },
            )
            .await
            .expect("update with current revision");
        assert_ne!(response.revision, stale_revision);

        assert!(matches!(
            service
                .update_note(
                    &admin,
                    &id,
                    UpdateNoteRequest {
                        content: Some("# Stale overwrite\n".to_string()),
                        content_patch: None,
                        tags: None,
                        metadata: Some(serde_json::Value::String("invalid".to_string())),
                        expected_revision: Some(stale_revision),
                    },
                )
                .await,
            Err(ServiceError::Write(WriteError::RevisionMismatch))
        ));
        let source_file = source.read(path).await.expect("read committed source");
        assert!(source_file.content.contains("# Updated\n"));
        assert!(!source_file.content.contains("Stale overwrite"));
        let projected = service
            .store
            .get_vault_file_for_policy(&admin, &id)
            .await
            .expect("read projected source");
        assert_eq!(projected.content, source_file.content);
        assert_eq!(projected.revision, response.revision);
    }

    #[tokio::test]
    async fn source_committed_writes_enforce_the_per_file_runtime_limit() {
        let store = VaultStore::new(10);
        store
            .project_filesystem_file(RecoveredVaultFileState {
                path: "First.md".to_string(),
                content: "1234".to_string(),
                file_type: NewNoteFileType::Md,
                couchdb_rev: "1-a".to_string(),
                created_at: Some(Utc::now()),
                updated_at: Utc::now(),
            })
            .await
            .expect("project first file");
        let root = tempdir().expect("vault root");
        let source = Arc::new(
            FilesystemSource::new_with_max_text_bytes(root.path(), 5).expect("filesystem source"),
        );
        source
            .create("First.md", "1234")
            .await
            .expect("create first source file");
        let service = VaultBridgeService::new_with_filesystem(store, source.clone(), None);

        service
            .ensure_projected_write_within_limit(&source, "Second.md", 2)
            .await
            .expect("a second file is independent of the corpus total");
        assert!(matches!(
            service
                .ensure_projected_write_within_limit(&source, "First.md", 6)
                .await,
            Err(ServiceError::FilesystemWrite(
                crate::filesystem::FilesystemError::ProjectionLimitExceeded { limit: 5 }
            ))
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
