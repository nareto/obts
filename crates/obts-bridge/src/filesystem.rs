use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime};

use chrono::{DateTime, Utc};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tracing::{info, warn};

use crate::headless::{HeadlessClient, HeadlessFilesystemGuard};
use crate::model::NoteId;
use crate::new_note::NewNoteFileType;
use crate::persistence::{ObtsProjectionState, PostgresPersistence};
use crate::store::{
    FilesystemProjectionStatus, LocalProjectionOutcome, RecoveredVaultFileState, VaultStore,
};

#[derive(Clone, Debug)]
pub struct FilesystemSource {
    root: Arc<PathBuf>,
    watermark: Arc<RwLock<FilesystemWatermark>>,
    persistence: Option<Arc<PostgresPersistence>>,
    max_text_bytes: u64,
}

#[derive(Clone, Debug, Default)]
struct FilesystemWatermark {
    observed: String,
    indexed: String,
    generation: u64,
    observed_generation: u64,
    indexed_generation: u64,
    indexed_files: BTreeMap<String, AttestedFile>,
    projection_status: FilesystemProjectionStatus,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AttestedFile {
    oid: String,
    revision: String,
    bytes: u64,
}

#[derive(Clone, Debug)]
pub struct FilesystemFile {
    pub path: String,
    pub content: String,
    pub revision: String,
    pub oid: String,
    identity: FileIdentity,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    len: u64,
    modified: Option<SystemTime>,
}

impl FilesystemSource {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, FilesystemError> {
        Self::new_with_max_text_bytes(root, 512 * 1024 * 1024)
    }

    pub fn new_with_max_text_bytes(
        root: impl AsRef<Path>,
        max_text_bytes: u64,
    ) -> Result<Self, FilesystemError> {
        Self::build(root, None, max_text_bytes)
    }

    pub async fn new_with_persistence(
        root: impl AsRef<Path>,
        persistence: Arc<PostgresPersistence>,
        max_text_bytes: u64,
    ) -> Result<Self, FilesystemError> {
        let source = Self::build(root, Some(persistence), max_text_bytes)?;
        if let Some(state) = source
            .persistence
            .as_ref()
            .expect("projection persistence")
            .load_obts_projection_state()
            .await
            .map_err(|error| FilesystemError::Projection(error.to_string()))?
            && let Some(indexed_commit) = state.indexed_commit
        {
            source
                .watermark
                .write()
                .expect("filesystem watermark lock")
                .indexed = indexed_commit;
        }
        Ok(source)
    }

    fn build(
        root: impl AsRef<Path>,
        persistence: Option<Arc<PostgresPersistence>>,
        max_text_bytes: u64,
    ) -> Result<Self, FilesystemError> {
        fs::create_dir_all(root.as_ref())?;
        let root = root.as_ref().canonicalize()?;
        Ok(Self {
            root: Arc::new(root),
            watermark: Arc::new(RwLock::new(FilesystemWatermark::default())),
            persistence,
            max_text_bytes,
        })
    }

    pub fn root(&self) -> &Path {
        self.root.as_path()
    }

    pub async fn scan(&self) -> Result<BTreeMap<String, FilesystemFile>, FilesystemError> {
        let generation = self
            .watermark
            .read()
            .expect("filesystem watermark lock")
            .generation;
        let before = self.supported_metadata().await?;
        self.ensure_runtime_size(before.values().map(|identity| identity.len))?;
        let mut files = BTreeMap::new();
        for (path, identity) in &before {
            let file = self.read(path).await?;
            if file.identity != *identity {
                return Err(FilesystemError::ProjectionChanged);
            }
            files.insert(path.clone(), file);
        }
        if self.supported_metadata().await? != before {
            return Err(FilesystemError::ProjectionChanged);
        }
        let observed = snapshot_revision(&files);
        let mut watermark = self.watermark.write().expect("filesystem watermark lock");
        if watermark.generation == generation {
            watermark.observed = observed;
            watermark.observed_generation = generation;
        } else {
            watermark.observed = "dirty".to_string();
        }
        Ok(files)
    }

    async fn supported_metadata(&self) -> Result<BTreeMap<String, FileIdentity>, FilesystemError> {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || list_root_metadata(root.as_path()))
            .await
            .map_err(|error| FilesystemError::Task(error.to_string()))?
    }

    pub(crate) async fn ensure_projected_write_size(
        &self,
        path: &str,
        replacement_bytes: u64,
    ) -> Result<(), FilesystemError> {
        let path = normalize_relative_path(path)?;
        let metadata = self.supported_metadata().await?;
        let current_bytes = metadata
            .get(&path)
            .map(|identity| identity.len)
            .unwrap_or(0);
        let total = metadata
            .values()
            .try_fold(0_u64, |total, identity| total.checked_add(identity.len))
            .and_then(|total| total.checked_sub(current_bytes))
            .and_then(|total| total.checked_add(replacement_bytes))
            .ok_or(FilesystemError::ProjectionLimitExceeded {
                limit: self.max_text_bytes,
            })?;
        self.ensure_runtime_size([total])
    }

    pub(crate) fn ensure_runtime_size<I>(&self, sizes: I) -> Result<(), FilesystemError>
    where
        I: IntoIterator<Item = u64>,
    {
        let total = sizes.into_iter().try_fold(0_u64, u64::checked_add).ok_or(
            FilesystemError::ProjectionLimitExceeded {
                limit: self.max_text_bytes,
            },
        )?;
        if total > self.max_text_bytes {
            return Err(FilesystemError::ProjectionLimitExceeded {
                limit: self.max_text_bytes,
            });
        }
        Ok(())
    }

    pub fn is_index_current(&self) -> bool {
        let watermark = self.watermark.read().expect("filesystem watermark lock");
        !watermark.observed.is_empty()
            && watermark.observed == watermark.indexed
            && watermark.observed_generation == watermark.generation
            && watermark.indexed_generation == watermark.generation
    }

    pub fn revisions(&self) -> (String, String) {
        let watermark = self.watermark.read().expect("filesystem watermark lock");
        (watermark.observed.clone(), watermark.indexed.clone())
    }

    pub fn indexed_commit(&self) -> Option<String> {
        let indexed = self
            .watermark
            .read()
            .expect("filesystem watermark lock")
            .indexed
            .clone();
        (!indexed.is_empty()).then_some(indexed)
    }

    pub async fn purge_persisted_raw_content(&self) -> Result<(), FilesystemError> {
        if let Some(persistence) = self.persistence.as_ref() {
            persistence
                .purge_raw_projection_content()
                .await
                .map_err(|error| FilesystemError::Projection(error.to_string()))?;
        }
        Ok(())
    }

    pub async fn reset_commit_projection(&self) -> Result<(), FilesystemError> {
        {
            let mut watermark = self.watermark.write().expect("filesystem watermark lock");
            watermark.generation = watermark.generation.wrapping_add(1);
            watermark.observed = "dirty".to_string();
            watermark.indexed.clear();
            watermark.observed_generation = watermark.generation;
            watermark.indexed_generation = 0;
            watermark.indexed_files.clear();
        }
        self.persist_projection_state(ObtsProjectionState {
            indexed_commit: None,
            target_commit: None,
            status: "uninitialized".to_string(),
            failure_code: None,
            updated_at: Utc::now(),
        })
        .await
    }

    async fn begin_commit_projection(&self, target: &str) -> Result<u64, FilesystemError> {
        let (generation, indexed_commit) = {
            let mut watermark = self.watermark.write().expect("filesystem watermark lock");
            watermark.generation = watermark.generation.wrapping_add(1);
            watermark.observed = target.to_string();
            watermark.observed_generation = watermark.generation;
            (
                watermark.generation,
                (!watermark.indexed.is_empty()).then(|| watermark.indexed.clone()),
            )
        };
        self.persist_projection_state(ObtsProjectionState {
            indexed_commit,
            target_commit: Some(target.to_string()),
            status: "projecting".to_string(),
            failure_code: None,
            updated_at: Utc::now(),
        })
        .await?;
        Ok(generation)
    }

    async fn complete_commit_projection(
        &self,
        target: &str,
        generation: u64,
        indexed_files: BTreeMap<String, AttestedFile>,
    ) -> Result<(), FilesystemError> {
        let previous = {
            let watermark = self.watermark.read().expect("filesystem watermark lock");
            if watermark.generation != generation
                || watermark.observed_generation != generation
                || watermark.observed != target
            {
                return Err(FilesystemError::ProjectionChanged);
            }
            (!watermark.indexed.is_empty()).then(|| watermark.indexed.clone())
        };
        self.persist_projection_state(ObtsProjectionState {
            indexed_commit: Some(target.to_string()),
            target_commit: None,
            status: "current".to_string(),
            failure_code: None,
            updated_at: Utc::now(),
        })
        .await?;
        let projection_changed = {
            let mut watermark = self.watermark.write().expect("filesystem watermark lock");
            if watermark.generation != generation
                || watermark.observed_generation != generation
                || watermark.observed != target
            {
                true
            } else {
                watermark.indexed = target.to_string();
                watermark.indexed_generation = generation;
                watermark.indexed_files = indexed_files;
                false
            }
        };
        if projection_changed {
            self.persist_projection_state(ObtsProjectionState {
                indexed_commit: previous,
                target_commit: Some(target.to_string()),
                status: "projecting".to_string(),
                failure_code: Some("projection_changed".to_string()),
                updated_at: Utc::now(),
            })
            .await?;
            return Err(FilesystemError::ProjectionChanged);
        }
        Ok(())
    }

    async fn record_projection_failure(&self, target: &str, error: &FilesystemError) {
        let state = ObtsProjectionState {
            indexed_commit: self.indexed_commit(),
            target_commit: Some(target.to_string()),
            status: "projecting".to_string(),
            failure_code: Some(error.code().to_string()),
            updated_at: Utc::now(),
        };
        if let Err(persistence_error) = self.persist_projection_state(state).await {
            warn!(error = %persistence_error, "failed to persist projection failure state");
        }
    }

    async fn persist_projection_state(
        &self,
        state: ObtsProjectionState,
    ) -> Result<(), FilesystemError> {
        if let Some(persistence) = self.persistence.as_ref() {
            persistence
                .save_obts_projection_state(&state)
                .await
                .map_err(|error| FilesystemError::Projection(error.to_string()))?;
        }
        Ok(())
    }

    fn mark_indexed(&self, files: &BTreeMap<String, FilesystemFile>) {
        let indexed = snapshot_revision(files);
        let mut watermark = self.watermark.write().expect("filesystem watermark lock");
        if watermark.observed == indexed && watermark.observed_generation == watermark.generation {
            watermark.indexed = indexed;
            watermark.indexed_generation = watermark.generation;
            watermark.indexed_files = files
                .iter()
                .map(|(path, file)| {
                    (
                        path.clone(),
                        AttestedFile {
                            oid: file.oid.clone(),
                            revision: file.revision.clone(),
                            bytes: file.identity.len,
                        },
                    )
                })
                .collect();
        }
    }

    fn indexed_manifest(&self) -> BTreeMap<String, AttestedFile> {
        self.watermark
            .read()
            .expect("filesystem watermark lock")
            .indexed_files
            .clone()
    }

    pub fn projection_status(&self) -> FilesystemProjectionStatus {
        self.watermark
            .read()
            .expect("filesystem watermark lock")
            .projection_status
            .clone()
    }

    fn record_projection_result(&self, full_audit: bool, result: &Result<usize, FilesystemError>) {
        let now = Utc::now();
        let mut watermark = self.watermark.write().expect("filesystem watermark lock");
        let status = &mut watermark.projection_status;
        status.attempts_total = status.attempts_total.saturating_add(1);
        match result {
            Ok(_) => {
                status.consecutive_failures = 0;
                status.last_success_at = Some(now);
                status.last_failure_code = None;
                if full_audit {
                    status.full_audits_total = status.full_audits_total.saturating_add(1);
                    status.last_full_audit_at = Some(now);
                }
            }
            Err(error) => {
                status.failures_total = status.failures_total.saturating_add(1);
                status.consecutive_failures = status.consecutive_failures.saturating_add(1);
                status.last_failure_at = Some(now);
                status.last_failure_code = Some(error.code().to_string());
            }
        }
    }

    pub async fn read(&self, path: &str) -> Result<FilesystemFile, FilesystemError> {
        let target = self.safe_target(path)?;
        let path = normalize_relative_path(path)?;
        let max_text_bytes = self.max_text_bytes;
        tokio::task::spawn_blocking(move || {
            let before = fs::metadata(&target).map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    FilesystemError::NotFound
                } else {
                    FilesystemError::Io(error)
                }
            })?;
            if before.len() > max_text_bytes {
                return Err(FilesystemError::ProjectionLimitExceeded {
                    limit: max_text_bytes,
                });
            }
            let file = fs::File::open(&target).map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    FilesystemError::NotFound
                } else {
                    FilesystemError::Io(error)
                }
            })?;
            let mut bytes = Vec::new();
            file.take(max_text_bytes.saturating_add(1))
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > max_text_bytes {
                return Err(FilesystemError::ProjectionLimitExceeded {
                    limit: max_text_bytes,
                });
            }
            let after = fs::metadata(&target)?;
            if before.len() != after.len()
                || before.modified().ok() != after.modified().ok()
                || after.len() != bytes.len() as u64
            {
                return Err(FilesystemError::ProjectionChanged);
            }
            let revision = content_revision(&bytes);
            let oid = git_blob_oid(&bytes);
            let content =
                String::from_utf8(bytes).map_err(|_| FilesystemError::InvalidUtf8(path.clone()))?;
            Ok(FilesystemFile {
                path,
                content,
                revision,
                oid,
                identity: FileIdentity {
                    len: after.len(),
                    modified: after.modified().ok(),
                },
                created_at: system_time(after.created().ok()),
                updated_at: system_time(after.modified().ok()).unwrap_or_else(Utc::now),
            })
        })
        .await
        .map_err(|error| FilesystemError::Task(error.to_string()))?
    }

    async fn file_identity(&self, path: &str) -> Result<FileIdentity, FilesystemError> {
        let target = self.safe_target(path)?;
        tokio::task::spawn_blocking(move || {
            let metadata = fs::metadata(&target).map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    FilesystemError::NotFound
                } else {
                    FilesystemError::Io(error)
                }
            })?;
            Ok(FileIdentity {
                len: metadata.len(),
                modified: metadata.modified().ok(),
            })
        })
        .await
        .map_err(|error| FilesystemError::Task(error.to_string()))?
    }

    pub async fn create(&self, path: &str, content: &str) -> Result<String, FilesystemError> {
        self.ensure_runtime_size([content.len() as u64])?;
        let target = self.safe_target(path)?;
        let content = content.to_owned();
        let revision = content_revision(content.as_bytes());
        tokio::task::spawn_blocking(move || atomic_write(&target, &content, true))
            .await
            .map_err(|error| FilesystemError::Task(error.to_string()))??;
        self.mark_dirty();
        Ok(revision)
    }

    pub async fn update(
        &self,
        path: &str,
        content: &str,
        expected_revision: Option<&str>,
    ) -> Result<String, FilesystemError> {
        self.ensure_runtime_size([content.len() as u64])?;
        let target = self.safe_target(path)?;
        let content = content.to_owned();
        let revision = content_revision(content.as_bytes());
        let expected_revision = expected_revision.map(ToOwned::to_owned);
        let max_text_bytes = self.max_text_bytes;
        tokio::task::spawn_blocking(move || {
            let metadata = fs::metadata(&target).map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    FilesystemError::NotFound
                } else {
                    FilesystemError::Io(error)
                }
            })?;
            if metadata.len() > max_text_bytes {
                return Err(FilesystemError::ProjectionLimitExceeded {
                    limit: max_text_bytes,
                });
            }
            let file = fs::File::open(&target)?;
            let mut current = Vec::new();
            file.take(max_text_bytes.saturating_add(1))
                .read_to_end(&mut current)?;
            if current.len() as u64 > max_text_bytes {
                return Err(FilesystemError::ProjectionLimitExceeded {
                    limit: max_text_bytes,
                });
            }
            let actual = content_revision(&current);
            if let Some(expected) = expected_revision
                && expected != actual
            {
                return Err(FilesystemError::Changed { expected, actual });
            }
            atomic_write(&target, &content, false)
        })
        .await
        .map_err(|error| FilesystemError::Task(error.to_string()))??;
        self.mark_dirty();
        Ok(revision)
    }

    pub fn mark_dirty(&self) {
        let mut watermark = self.watermark.write().expect("filesystem watermark lock");
        watermark.generation = watermark.generation.wrapping_add(1);
        watermark.observed = "dirty".to_string();
    }

    async fn path_exists(&self, path: &str) -> Result<bool, FilesystemError> {
        let path = normalize_relative_path(path)?;
        let target = self.root.join(path);
        tokio::task::spawn_blocking(move || match fs::symlink_metadata(target) {
            Ok(metadata) => Ok(metadata.is_file()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(FilesystemError::Io(error)),
        })
        .await
        .map_err(|error| FilesystemError::Task(error.to_string()))?
    }

    fn safe_target(&self, relative: &str) -> Result<PathBuf, FilesystemError> {
        let normalized = normalize_relative_path(relative)?;
        if !is_supported_path(&normalized) || is_excluded_path(&normalized) {
            return Err(FilesystemError::UnsupportedPath(normalized));
        }
        let target = self.root.join(&normalized);
        let parent = target.parent().ok_or(FilesystemError::PathEscape)?;
        fs::create_dir_all(parent)?;
        let canonical_parent = parent.canonicalize()?;
        if !canonical_parent.starts_with(self.root.as_path()) {
            return Err(FilesystemError::PathEscape);
        }
        if fs::symlink_metadata(&target)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(FilesystemError::Symlink);
        }
        Ok(target)
    }
}

pub async fn hydrate_runtime_snapshot(
    store: &VaultStore,
    source: &FilesystemSource,
) -> Result<usize, FilesystemError> {
    let expected_metadata = source.supported_metadata().await?;
    source.ensure_runtime_size(expected_metadata.values().map(|identity| identity.len))?;
    let mut prepared = Vec::with_capacity(expected_metadata.len());
    for (path, identity) in &expected_metadata {
        let file = source.read(path).await?;
        if file.identity != *identity {
            return Err(FilesystemError::ProjectionChanged);
        }
        prepared.push(
            store
                .prepare_runtime_filesystem_file(recovered_file(file))
                .await,
        );
    }
    if source.supported_metadata().await? != expected_metadata {
        return Err(FilesystemError::ProjectionChanged);
    }
    let count = prepared.len();
    store.replace_runtime_filesystem_snapshot(prepared).await;
    Ok(count)
}

pub async fn synchronize_commit_projection(
    store: &VaultStore,
    source: &FilesystemSource,
    guard: &mut HeadlessFilesystemGuard<'_>,
    client: &HeadlessClient,
    full_audit: bool,
    hydrate_runtime: bool,
) -> Result<usize, FilesystemError> {
    let result = async {
        let indexed_commit = source.indexed_commit();
        let delta = guard
            .read_index_delta(client, indexed_commit.as_deref())
            .await
            .map_err(|error| FilesystemError::Headless(error.to_string()))?;
        let changed = apply_commit_delta(
            store,
            source,
            indexed_commit,
            delta,
            full_audit,
            hydrate_runtime,
        )
        .await?;
        Ok(changed)
    }
    .await;
    source.record_projection_result(full_audit, &result);
    result
}

async fn apply_commit_delta(
    store: &VaultStore,
    source: &FilesystemSource,
    indexed_commit: Option<String>,
    delta: crate::headless::HeadlessIndexDelta,
    full_audit: bool,
    hydrate_runtime: bool,
) -> Result<usize, FilesystemError> {
    let Some(target_commit) = delta.head.clone() else {
        source.mark_dirty();
        return Err(FilesystemError::Headless(
            "headless client has no materialized local head".to_string(),
        ));
    };
    validate_commit_id(&target_commit)?;
    if delta.mode != "incremental" && delta.mode != "rebuild" {
        return Err(FilesystemError::InvalidDelta(format!(
            "unsupported projection mode {}",
            delta.mode
        )));
    }
    if delta.mode == "incremental" && delta.base != indexed_commit {
        return Err(FilesystemError::InvalidDelta(
            "incremental projection base does not match the durable cursor".to_string(),
        ));
    }
    let mut target_manifest = BTreeMap::new();
    for file in &delta.files {
        let path = normalize_relative_path(&file.path)?;
        if !is_supported_path(&path) || is_excluded_path(&path) {
            continue;
        }
        validate_commit_id(&file.oid)?;
        if target_manifest
            .insert(path.clone(), file.oid.clone())
            .is_some()
        {
            return Err(FilesystemError::InvalidDelta(format!(
                "duplicate target path {path}"
            )));
        }
    }

    let generation = source.begin_commit_projection(&target_commit).await?;
    let result = async {
        let runtime_hydration = hydrate_runtime || source.indexed_manifest().is_empty();
        let force_full = full_audit || runtime_hydration || delta.mode == "rebuild";
        let (changed, indexed_files) = if force_full {
            reconcile_full_snapshot(store, source, &target_manifest, runtime_hydration).await?
        } else {
            reconcile_incremental_snapshot(store, source, &target_manifest, &delta.changes).await?
        };
        source.purge_persisted_raw_content().await?;
        source
            .complete_commit_projection(&target_commit, generation, indexed_files)
            .await?;
        Ok(changed)
    }
    .await;
    if let Err(error) = &result {
        source
            .record_projection_failure(&target_commit, error)
            .await;
    }
    result
}

async fn reconcile_full_snapshot(
    store: &VaultStore,
    source: &FilesystemSource,
    target_manifest: &BTreeMap<String, String>,
    hydrate_runtime: bool,
) -> Result<(usize, BTreeMap<String, AttestedFile>), FilesystemError> {
    let expected_metadata = source.supported_metadata().await?;
    source.ensure_runtime_size(expected_metadata.values().map(|identity| identity.len))?;
    if expected_metadata.keys().ne(target_manifest.keys()) {
        return Err(FilesystemError::CommitSnapshotMismatch);
    }
    let mut projected = store.indexed_vault_file_revisions().await;
    let mut prepared = Vec::with_capacity(if hydrate_runtime {
        expected_metadata.len()
    } else {
        0
    });
    let mut indexed_files = BTreeMap::new();
    let mut changed = 0usize;
    for (path, identity) in &expected_metadata {
        let expected_oid = target_manifest
            .get(path)
            .expect("validated target path must have an oid");
        let file = source.read(path).await?;
        if file.identity != *identity {
            return Err(FilesystemError::ProjectionChanged);
        }
        verify_file_oid(&file, expected_oid)?;
        let revision = file.revision.clone();
        indexed_files.insert(
            path.clone(),
            AttestedFile {
                oid: expected_oid.clone(),
                revision: revision.clone(),
                bytes: file.identity.len,
            },
        );
        if projected.get(path) != Some(&revision) {
            project_file(store, file.clone()).await?;
            projected.insert(path.clone(), revision);
            changed += 1;
        }
        if hydrate_runtime {
            prepared.push(
                store
                    .prepare_runtime_filesystem_file(recovered_file(file))
                    .await,
            );
        }
    }
    if source.supported_metadata().await? != expected_metadata {
        return Err(FilesystemError::ProjectionChanged);
    }
    let extras = projected
        .keys()
        .filter(|path| !indexed_files.contains_key(*path))
        .cloned()
        .collect::<Vec<_>>();
    for path in extras {
        store
            .delete_filesystem_file(&NoteId::new(path))
            .await
            .map_err(|error| FilesystemError::Projection(error.to_string()))?;
        changed += 1;
    }
    if hydrate_runtime {
        store.replace_runtime_filesystem_snapshot(prepared).await;
    }
    Ok((changed, indexed_files))
}

enum PlannedProjectionChange {
    Delete(String),
    Upsert {
        path: String,
        oid: String,
        identity: FileIdentity,
    },
}

async fn reconcile_incremental_snapshot(
    store: &VaultStore,
    source: &FilesystemSource,
    target_manifest: &BTreeMap<String, String>,
    changes: &[crate::headless::HeadlessIndexChange],
) -> Result<(usize, BTreeMap<String, AttestedFile>), FilesystemError> {
    let mut indexed_files = source.indexed_manifest();
    let mut prospective_oids = indexed_files
        .iter()
        .map(|(path, file)| (path.clone(), file.oid.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut prospective_bytes = indexed_files
        .values()
        .fold(0u64, |total, file| total.saturating_add(file.bytes));
    let mut planned = Vec::new();
    let mut seen = HashSet::new();

    // Validate the complete target size before reading or mutating runtime content.
    for change in changes {
        let path = normalize_relative_path(&change.path)?;
        if !is_supported_path(&path) || is_excluded_path(&path) {
            continue;
        }
        if !seen.insert(path.clone()) {
            return Err(FilesystemError::InvalidDelta(format!(
                "duplicate change path {path}"
            )));
        }
        match change.kind.as_str() {
            "delete" => {
                if target_manifest.contains_key(&path) || source.path_exists(&path).await? {
                    return Err(FilesystemError::CommitSnapshotMismatch);
                }
                if let Some(previous) = indexed_files.get(&path) {
                    prospective_bytes = prospective_bytes.saturating_sub(previous.bytes);
                }
                prospective_oids.remove(&path);
                planned.push(PlannedProjectionChange::Delete(path));
            }
            "add" | "modify" => {
                let expected_oid = change.oid.as_deref().ok_or_else(|| {
                    FilesystemError::InvalidDelta(format!(
                        "{} is missing its target oid",
                        change.path
                    ))
                })?;
                validate_commit_id(expected_oid)?;
                if target_manifest.get(&path).map(String::as_str) != Some(expected_oid) {
                    return Err(FilesystemError::InvalidDelta(format!(
                        "{} does not match the target manifest",
                        change.path
                    )));
                }
                let identity = source.file_identity(&path).await?;
                if let Some(previous) = indexed_files.get(&path) {
                    prospective_bytes = prospective_bytes.saturating_sub(previous.bytes);
                }
                prospective_bytes = prospective_bytes.saturating_add(identity.len);
                prospective_oids.insert(path.clone(), expected_oid.to_string());
                planned.push(PlannedProjectionChange::Upsert {
                    path,
                    oid: expected_oid.to_string(),
                    identity,
                });
            }
            other => {
                return Err(FilesystemError::InvalidDelta(format!(
                    "unsupported change kind {other}"
                )));
            }
        }
    }
    source.ensure_runtime_size([prospective_bytes])?;
    if prospective_oids != *target_manifest {
        return Err(FilesystemError::CommitSnapshotMismatch);
    }

    let mut projected = store.indexed_vault_file_revisions().await;
    let mut changed = 0usize;
    for change in planned {
        match change {
            PlannedProjectionChange::Delete(path) => {
                if source.path_exists(&path).await? {
                    return Err(FilesystemError::ProjectionChanged);
                }
                indexed_files.remove(&path);
                if projected.remove(&path).is_some() {
                    store
                        .delete_filesystem_file(&NoteId::new(path))
                        .await
                        .map_err(|error| FilesystemError::Projection(error.to_string()))?;
                    changed += 1;
                }
            }
            PlannedProjectionChange::Upsert {
                path,
                oid,
                identity,
            } => {
                let file = source.read(&path).await?;
                if file.identity != identity {
                    return Err(FilesystemError::ProjectionChanged);
                }
                verify_file_oid(&file, &oid)?;
                let revision = file.revision.clone();
                indexed_files.insert(
                    path.clone(),
                    AttestedFile {
                        oid,
                        revision: revision.clone(),
                        bytes: file.identity.len,
                    },
                );
                if projected.get(&path) != Some(&revision) {
                    project_file(store, file).await?;
                    projected.insert(path, revision);
                    changed += 1;
                }
            }
        }
    }

    // A prior attempt may have updated the derived store without advancing the cursor.
    for (path, expected) in &indexed_files {
        if projected.get(path) == Some(&expected.revision) {
            continue;
        }
        let file = source.read(path).await?;
        verify_file_oid(&file, &expected.oid)?;
        if file.revision != expected.revision {
            return Err(FilesystemError::CommitSnapshotMismatch);
        }
        project_file(store, file).await?;
        projected.insert(path.clone(), expected.revision.clone());
        changed += 1;
    }
    let extras = projected
        .keys()
        .filter(|path| !indexed_files.contains_key(*path))
        .cloned()
        .collect::<Vec<_>>();
    for path in extras {
        store
            .delete_filesystem_file(&NoteId::new(path.clone()))
            .await
            .map_err(|error| FilesystemError::Projection(error.to_string()))?;
        projected.remove(&path);
        changed += 1;
    }
    Ok((changed, indexed_files))
}

async fn project_file(store: &VaultStore, file: FilesystemFile) -> Result<(), FilesystemError> {
    let outcome = store
        .project_filesystem_file(recovered_file(file))
        .await
        .map_err(|error| FilesystemError::Projection(error.to_string()))?;
    if matches!(outcome, LocalProjectionOutcome::Applied) {
        Ok(())
    } else {
        Err(FilesystemError::ProjectionPending)
    }
}

fn recovered_file(file: FilesystemFile) -> RecoveredVaultFileState {
    RecoveredVaultFileState {
        path: file.path.clone(),
        content: file.content,
        file_type: if file.path.ends_with(".md") {
            NewNoteFileType::Md
        } else {
            NewNoteFileType::Base
        },
        couchdb_rev: file.revision,
        created_at: file.created_at,
        updated_at: file.updated_at,
    }
}

fn verify_file_oid(file: &FilesystemFile, expected: &str) -> Result<(), FilesystemError> {
    if file.oid == expected {
        Ok(())
    } else {
        Err(FilesystemError::CommitContentMismatch {
            path: file.path.clone(),
            expected: expected.to_string(),
            actual: file.oid.clone(),
        })
    }
}

pub async fn synchronize_snapshot(
    store: &VaultStore,
    source: &FilesystemSource,
) -> Result<usize, FilesystemError> {
    let files = source.scan().await?;
    let indexed = store.indexed_vault_file_revisions().await;
    let mut changed = 0usize;

    for file in files.values() {
        if indexed.get(&file.path) == Some(&file.revision) {
            continue;
        }
        let outcome = store
            .project_filesystem_file(RecoveredVaultFileState {
                path: file.path.clone(),
                content: file.content.clone(),
                file_type: if file.path.ends_with(".md") {
                    NewNoteFileType::Md
                } else {
                    NewNoteFileType::Base
                },
                couchdb_rev: file.revision.clone(),
                created_at: file.created_at,
                updated_at: file.updated_at,
            })
            .await
            .map_err(|error| FilesystemError::Projection(error.to_string()))?;
        if !matches!(outcome, LocalProjectionOutcome::Applied) {
            return Err(FilesystemError::ProjectionPending);
        }
        changed += 1;
    }

    let paths = files.keys().cloned().collect::<HashSet<_>>();
    for path in indexed.keys().filter(|path| !paths.contains(*path)) {
        store
            .delete_filesystem_file(&NoteId::new(path.clone()))
            .await
            .map_err(|error| FilesystemError::Projection(error.to_string()))?;
        changed += 1;
    }

    source.mark_indexed(&files);
    Ok(changed)
}

pub fn spawn_filesystem_worker(
    store: VaultStore,
    source: Arc<FilesystemSource>,
    headless: Option<HeadlessClient>,
    interval: Duration,
    audit_interval: Duration,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut last_full_audit = Instant::now();
        let mut projection_failures = 0_u32;
        let mut next_projection_attempt = Instant::now();
        loop {
            if let Some(headless) = headless.as_ref() {
                let full_audit = last_full_audit.elapsed() >= audit_interval;
                if projection_required(&source, full_audit)
                    && Instant::now() >= next_projection_attempt
                {
                    match headless.lock_filesystem().await {
                        Ok(mut guard) => {
                            let result = synchronize_commit_projection(
                                &store, &source, &mut guard, headless, full_audit, false,
                            )
                            .await;
                            if result.is_ok() {
                                projection_failures = 0;
                                next_projection_attempt = Instant::now();
                                if full_audit {
                                    last_full_audit = Instant::now();
                                }
                            } else {
                                projection_failures = projection_failures.saturating_add(1);
                                next_projection_attempt = Instant::now()
                                    + projection_retry_delay(interval, projection_failures);
                            }
                            log_projection_result(result);
                        }
                        Err(error) => {
                            warn!(error = %error, "filesystem projection deferred; headless client unavailable")
                        }
                    }
                }
            } else {
                log_projection_result(synchronize_snapshot(&store, &source).await);
            }
            sleep(interval).await;
        }
    })
}

fn projection_required(source: &FilesystemSource, full_audit: bool) -> bool {
    full_audit || !source.is_index_current()
}

fn projection_retry_delay(interval: Duration, failures: u32) -> Duration {
    let exponent = failures.saturating_sub(1).min(8);
    Duration::from_secs(
        interval
            .as_secs()
            .max(1)
            .saturating_mul(2_u64.saturating_pow(exponent))
            .min(300),
    )
}

fn log_projection_result(result: Result<usize, FilesystemError>) {
    match result {
        Ok(changed) if changed > 0 => info!(changed, "filesystem projection updated"),
        Ok(_) => {}
        Err(error) => {
            warn!(error = %error, "filesystem projection failed; retaining previous index")
        }
    }
}

fn list_root_metadata(root: &Path) -> Result<BTreeMap<String, FileIdentity>, FilesystemError> {
    let mut files = BTreeMap::new();
    walk_metadata(root, root, &mut files)?;
    Ok(files)
}

fn walk_metadata(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, FileIdentity>,
) -> Result<(), FilesystemError> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let relative = path_to_slashes(
            path.strip_prefix(root)
                .map_err(|_| FilesystemError::PathEscape)?,
        )?;
        if is_excluded_path(&relative) {
            continue;
        }
        if file_type.is_dir() {
            walk_metadata(root, &path, files)?;
        } else if file_type.is_file() && is_supported_path(&relative) {
            let metadata = entry.metadata()?;
            files.insert(
                relative,
                FileIdentity {
                    len: metadata.len(),
                    modified: metadata.modified().ok(),
                },
            );
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, content: &str, create_new: bool) -> Result<(), FilesystemError> {
    if create_new && path.exists() {
        return Err(FilesystemError::AlreadyExists);
    }
    let parent = path.parent().ok_or(FilesystemError::PathEscape)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(FilesystemError::PathEscape)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(&format!(".{file_name}.obts-bridge-tmp-"))
        .tempfile_in(parent)?;
    temporary.write_all(content.as_bytes())?;
    temporary.as_file().sync_all()?;
    if create_new {
        if let Err(error) = fs::hard_link(temporary.path(), path) {
            return if error.kind() == io::ErrorKind::AlreadyExists {
                Err(FilesystemError::AlreadyExists)
            } else {
                Err(FilesystemError::Io(error))
            };
        }
    } else {
        temporary
            .persist(path)
            .map_err(|error| FilesystemError::Io(error.error))?;
    }
    OpenOptions::new().read(true).open(parent)?.sync_all()?;
    Ok(())
}

fn content_revision(content: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(content)))
}

fn git_blob_oid(content: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", content.len()).as_bytes());
    hasher.update(content);
    hex::encode(hasher.finalize())
}

fn snapshot_revision(files: &BTreeMap<String, FilesystemFile>) -> String {
    let mut hasher = Sha256::new();
    for file in files.values() {
        hasher.update(file.path.as_bytes());
        hasher.update(b"\0");
        hasher.update(file.revision.as_bytes());
        hasher.update(b"\n");
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn validate_commit_id(commit: &str) -> Result<(), FilesystemError> {
    if commit.len() == 40 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(FilesystemError::InvalidDelta(
            "headless projection returned an invalid commit ID".to_string(),
        ))
    }
}

fn normalize_relative_path(path: &str) -> Result<String, FilesystemError> {
    let path = Path::new(path);
    if path.is_absolute() {
        return Err(FilesystemError::PathEscape);
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                parts.push(part.to_str().ok_or(FilesystemError::NonUtf8Path)?)
            }
            _ => return Err(FilesystemError::PathEscape),
        }
    }
    if parts.is_empty() {
        return Err(FilesystemError::PathEscape);
    }
    Ok(parts.join("/"))
}

fn path_to_slashes(path: &Path) -> Result<String, FilesystemError> {
    let mut parts = Vec::new();
    for component in path.components() {
        if let Component::Normal(part) = component {
            parts.push(part.to_str().ok_or(FilesystemError::NonUtf8Path)?);
        }
    }
    Ok(parts.join("/"))
}

fn is_supported_path(path: &str) -> bool {
    path.ends_with(".md") || path.ends_with(".base")
}

fn is_excluded_path(path: &str) -> bool {
    path == ".obts"
        || path.starts_with(".obts/")
        || path == ".git"
        || path.starts_with(".git/")
        || path == ".obsidian/cache"
        || path.starts_with(".obsidian/cache/")
        || path == ".obsidian/workspace.json"
        || path == ".obsidian/workspace-mobile.json"
        || path == ".obsidian/plugins/obts"
        || path.starts_with(".obsidian/plugins/obts/")
}

fn system_time(value: Option<SystemTime>) -> Option<DateTime<Utc>> {
    value.map(DateTime::<Utc>::from)
}

#[derive(Debug, Error)]
pub enum FilesystemError {
    #[error("filesystem I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("filesystem worker failed: {0}")]
    Task(String),
    #[error("vault path escapes the configured root")]
    PathEscape,
    #[error("vault path contains non-UTF-8 components")]
    NonUtf8Path,
    #[error("symlinks are not valid bridge write targets")]
    Symlink,
    #[error("unsupported vault path: {0}")]
    UnsupportedPath(String),
    #[error("vault file already exists")]
    AlreadyExists,
    #[error("vault file does not exist")]
    NotFound,
    #[error("vault file changed (expected {expected}, found {actual})")]
    Changed { expected: String, actual: String },
    #[error("vault file is not UTF-8 text: {0}")]
    InvalidUtf8(String),
    #[error("failed to project filesystem state: {0}")]
    Projection(String),
    #[error("headless projection failed: {0}")]
    Headless(String),
    #[error("invalid headless projection delta: {0}")]
    InvalidDelta(String),
    #[error("projection changed while indexing")]
    ProjectionChanged,
    #[error("supported vault text exceeds the configured runtime limit of {limit} bytes")]
    ProjectionLimitExceeded { limit: u64 },
    #[error("projection persistence is pending")]
    ProjectionPending,
    #[error("visible vault snapshot does not match the projected commit")]
    CommitSnapshotMismatch,
    #[error(
        "visible file {path} does not match commit content (expected {expected}, found {actual})"
    )]
    CommitContentMismatch {
        path: String,
        expected: String,
        actual: String,
    },
}

impl FilesystemError {
    fn code(&self) -> &'static str {
        match self {
            Self::Headless(_) => "headless_error",
            Self::InvalidDelta(_) => "invalid_delta",
            Self::ProjectionChanged => "projection_changed",
            Self::ProjectionLimitExceeded { .. } => "projection_limit_exceeded",
            Self::ProjectionPending => "projection_pending",
            Self::CommitSnapshotMismatch => "commit_snapshot_mismatch",
            Self::CommitContentMismatch { .. } => "commit_content_mismatch",
            Self::Projection(_) => "projection_error",
            Self::Io(_) | Self::Task(_) => "filesystem_error",
            Self::PathEscape
            | Self::NonUtf8Path
            | Self::Symlink
            | Self::UnsupportedPath(_)
            | Self::AlreadyExists
            | Self::NotFound
            | Self::Changed { .. }
            | Self::InvalidUtf8(_) => "filesystem_state_error",
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use crate::headless::{HeadlessIndexChange, HeadlessIndexDelta, HeadlessIndexFile};
    use crate::store::VaultStore;

    use super::{
        FilesystemError, FilesystemSource, apply_commit_delta, git_blob_oid,
        hydrate_runtime_snapshot, project_file, projection_required, projection_retry_delay,
    };

    #[test]
    fn projection_failures_back_off_to_a_bounded_delay() {
        assert_eq!(
            projection_retry_delay(std::time::Duration::from_secs(2), 1).as_secs(),
            2
        );
        assert_eq!(
            projection_retry_delay(std::time::Duration::from_secs(2), 2).as_secs(),
            4
        );
        assert_eq!(
            projection_retry_delay(std::time::Duration::from_secs(2), 20).as_secs(),
            300
        );
    }

    #[tokio::test]
    async fn writes_and_reads_supported_vault_files_with_revision_checks() {
        let root = tempdir().expect("tempdir");
        let source = FilesystemSource::new(root.path()).expect("source");

        let first = source
            .create("Notes/test.md", "# First\n")
            .await
            .expect("create");
        let file = source.read("Notes/test.md").await.expect("read");
        assert_eq!(file.content, "# First\n");
        assert_eq!(file.revision, first);

        let second = source
            .update("Notes/test.md", "# Second\n", Some(&first))
            .await
            .expect("update");
        assert_ne!(first, second);
        assert!(matches!(
            source
                .update("Notes/test.md", "# Third\n", Some(&first))
                .await,
            Err(FilesystemError::Changed { .. })
        ));
        assert_eq!(
            source.read("Notes/test.md").await.expect("read").content,
            "# Second\n"
        );
    }

    #[tokio::test]
    async fn full_hydration_fails_closed_above_the_runtime_text_limit() {
        let root = tempdir().expect("tempdir");
        std::fs::write(root.path().join("note.md"), "12345").expect("note");
        let source = FilesystemSource::build(root.path(), None, 4).expect("source");
        let store = VaultStore::new(10);

        assert!(matches!(
            source.scan().await,
            Err(FilesystemError::ProjectionLimitExceeded { limit: 4 })
        ));
        assert!(matches!(
            hydrate_runtime_snapshot(&store, &source).await,
            Err(FilesystemError::ProjectionLimitExceeded { limit: 4 })
        ));
        assert!(matches!(
            source.update("note.md", "1234", None).await,
            Err(FilesystemError::ProjectionLimitExceeded { limit: 4 })
        ));
    }

    #[tokio::test]
    async fn scan_ignores_hidden_obts_state_and_non_text_files() {
        let root = tempdir().expect("tempdir");
        std::fs::create_dir_all(root.path().join(".obts")).expect("obts dir");
        std::fs::write(root.path().join(".obts/state.json"), "secret").expect("state");
        std::fs::write(root.path().join("image.png"), b"png").expect("image");
        std::fs::write(root.path().join("note.md"), "# Note\n").expect("note");
        let source = FilesystemSource::new(root.path()).expect("source");

        let files = source.scan().await.expect("scan");
        assert_eq!(files.keys().cloned().collect::<Vec<_>>(), vec!["note.md"]);
    }

    #[tokio::test]
    async fn dirty_generation_cannot_be_overwritten_by_an_older_scan() {
        let root = tempdir().expect("tempdir");
        std::fs::write(root.path().join("note.md"), "# Note\n").expect("note");
        let source = FilesystemSource::new(root.path()).expect("source");

        let stale_scan = source.scan().await.expect("scan");
        source.mark_dirty();
        source.mark_indexed(&stale_scan);
        assert!(!source.is_index_current());

        let current_scan = source.scan().await.expect("rescan");
        source.mark_indexed(&current_scan);
        assert!(source.is_index_current());
    }

    #[tokio::test]
    async fn applies_rebuild_and_incremental_commit_deltas() {
        let root = tempdir().expect("tempdir");
        let source = FilesystemSource::new(root.path()).expect("source");
        let store = VaultStore::new(10);
        let first_revision = source.create("First.md", "first\n").await.expect("first");
        let _removed_revision = source
            .create("Removed.base", "filters: []\n")
            .await
            .expect("removed");
        let first_commit = "1".repeat(40);
        let rebuilt = apply_commit_delta(
            &store,
            &source,
            None,
            HeadlessIndexDelta {
                head: Some(first_commit.clone()),
                base: None,
                mode: "rebuild".to_string(),
                files: vec![
                    HeadlessIndexFile {
                        path: "First.md".to_string(),
                        oid: git_blob_oid(b"first\n"),
                    },
                    HeadlessIndexFile {
                        path: "Removed.base".to_string(),
                        oid: git_blob_oid(b"filters: []\n"),
                    },
                ],
                changes: vec![
                    HeadlessIndexChange {
                        path: "First.md".to_string(),
                        kind: "add".to_string(),
                        oid: Some(git_blob_oid(b"first\n")),
                    },
                    HeadlessIndexChange {
                        path: "Removed.base".to_string(),
                        kind: "add".to_string(),
                        oid: Some(git_blob_oid(b"filters: []\n")),
                    },
                ],
            },
            false,
            false,
        )
        .await
        .expect("rebuild");
        assert_eq!(rebuilt, 2);
        assert_eq!(
            source.indexed_commit().as_deref(),
            Some(first_commit.as_str())
        );

        let second_revision = source
            .update("First.md", "second\n", Some(&first_revision))
            .await
            .expect("modify");
        fs::remove_file(root.path().join("Removed.base")).expect("remove");
        source.mark_dirty();
        let second_commit = "2".repeat(40);
        let updated = apply_commit_delta(
            &store,
            &source,
            Some(first_commit.clone()),
            HeadlessIndexDelta {
                head: Some(second_commit.clone()),
                base: Some(first_commit),
                mode: "incremental".to_string(),
                files: vec![HeadlessIndexFile {
                    path: "First.md".to_string(),
                    oid: git_blob_oid(b"second\n"),
                }],
                changes: vec![
                    HeadlessIndexChange {
                        path: "First.md".to_string(),
                        kind: "modify".to_string(),
                        oid: Some(git_blob_oid(b"second\n")),
                    },
                    HeadlessIndexChange {
                        path: "Removed.base".to_string(),
                        kind: "delete".to_string(),
                        oid: None,
                    },
                ],
            },
            false,
            false,
        )
        .await
        .expect("incremental");
        assert_eq!(updated, 2);
        assert_eq!(
            source.indexed_commit().as_deref(),
            Some(second_commit.as_str())
        );
        assert_eq!(
            store.indexed_vault_file_revisions().await,
            [("First.md".to_string(), second_revision)].into()
        );
        assert!(source.is_index_current());
    }

    #[tokio::test]
    async fn incremental_projection_checks_the_runtime_limit_before_mutation() {
        let root = tempdir().expect("tempdir");
        let source = FilesystemSource::build(root.path(), None, 8).expect("source");
        let store = VaultStore::new(10);
        let first_revision = source.create("First.md", "first\n").await.expect("first");
        let first_commit = "1".repeat(40);
        apply_commit_delta(
            &store,
            &source,
            None,
            HeadlessIndexDelta {
                head: Some(first_commit.clone()),
                base: None,
                mode: "rebuild".to_string(),
                files: vec![HeadlessIndexFile {
                    path: "First.md".to_string(),
                    oid: git_blob_oid(b"first\n"),
                }],
                changes: vec![HeadlessIndexChange {
                    path: "First.md".to_string(),
                    kind: "add".to_string(),
                    oid: Some(git_blob_oid(b"first\n")),
                }],
            },
            false,
            false,
        )
        .await
        .expect("initial projection");

        std::fs::write(root.path().join("First.md"), "too large").expect("large change");
        source.mark_dirty();
        let result = apply_commit_delta(
            &store,
            &source,
            Some(first_commit.clone()),
            HeadlessIndexDelta {
                head: Some("2".repeat(40)),
                base: Some(first_commit.clone()),
                mode: "incremental".to_string(),
                files: vec![HeadlessIndexFile {
                    path: "First.md".to_string(),
                    oid: git_blob_oid(b"too large"),
                }],
                changes: vec![HeadlessIndexChange {
                    path: "First.md".to_string(),
                    kind: "modify".to_string(),
                    oid: Some(git_blob_oid(b"too large")),
                }],
            },
            false,
            false,
        )
        .await;

        assert!(matches!(
            result,
            Err(FilesystemError::ProjectionLimitExceeded { limit: 8 })
        ));
        assert_eq!(
            source.indexed_commit().as_deref(),
            Some(first_commit.as_str())
        );
        assert_eq!(
            store.indexed_vault_file_revisions().await,
            [("First.md".to_string(), first_revision)].into()
        );
    }

    #[tokio::test]
    async fn partial_projection_retry_repairs_a_later_tree_revert() {
        let root = tempdir().expect("tempdir");
        let source = FilesystemSource::new(root.path()).expect("source");
        let store = VaultStore::new(10);
        let first_revision = source.create("First.md", "first\n").await.expect("first");
        let first_commit = "1".repeat(40);
        apply_commit_delta(
            &store,
            &source,
            None,
            HeadlessIndexDelta {
                head: Some(first_commit.clone()),
                base: None,
                mode: "rebuild".to_string(),
                files: vec![HeadlessIndexFile {
                    path: "First.md".to_string(),
                    oid: git_blob_oid(b"first\n"),
                }],
                changes: vec![HeadlessIndexChange {
                    path: "First.md".to_string(),
                    kind: "add".to_string(),
                    oid: Some(git_blob_oid(b"first\n")),
                }],
            },
            false,
            false,
        )
        .await
        .expect("initial projection");

        source
            .update("First.md", "partial\n", Some(&first_revision))
            .await
            .expect("partial content");
        project_file(&store, source.read("First.md").await.expect("partial file"))
            .await
            .expect("simulate partial derived write");
        source
            .update("First.md", "first\n", None)
            .await
            .expect("revert visible file");

        let repaired = apply_commit_delta(
            &store,
            &source,
            Some(first_commit.clone()),
            HeadlessIndexDelta {
                head: Some("2".repeat(40)),
                base: Some(first_commit),
                mode: "incremental".to_string(),
                files: vec![HeadlessIndexFile {
                    path: "First.md".to_string(),
                    oid: git_blob_oid(b"first\n"),
                }],
                changes: vec![],
            },
            false,
            false,
        )
        .await
        .expect("repair projection");

        assert_eq!(repaired, 1);
        assert_eq!(
            store.indexed_vault_file_revisions().await,
            [("First.md".to_string(), first_revision)].into()
        );
        assert!(!projection_required(&source, false));
        assert!(projection_required(&source, true));
    }

    #[tokio::test]
    async fn does_not_advance_commit_cursor_when_visible_content_mismatches() {
        let root = tempdir().expect("tempdir");
        let source = FilesystemSource::new(root.path()).expect("source");
        let store = VaultStore::new(10);
        source.create("First.md", "local\n").await.expect("create");
        let result = apply_commit_delta(
            &store,
            &source,
            None,
            HeadlessIndexDelta {
                head: Some("3".repeat(40)),
                base: None,
                mode: "rebuild".to_string(),
                files: vec![HeadlessIndexFile {
                    path: "First.md".to_string(),
                    oid: "d".repeat(40),
                }],
                changes: vec![HeadlessIndexChange {
                    path: "First.md".to_string(),
                    kind: "add".to_string(),
                    oid: Some("d".repeat(40)),
                }],
            },
            false,
            false,
        )
        .await;
        assert!(matches!(
            result,
            Err(FilesystemError::CommitContentMismatch { .. })
        ));
        assert_eq!(source.indexed_commit(), None);
        assert!(!source.is_index_current());
    }

    #[tokio::test]
    async fn rejects_path_traversal_and_symlink_write_targets() {
        let root = tempdir().expect("tempdir");
        let outside = tempdir().expect("outside");
        let source = FilesystemSource::new(root.path()).expect("source");
        assert!(matches!(
            source.create("../outside.md", "x").await,
            Err(FilesystemError::PathEscape)
        ));

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path().join("note.md"), root.path().join("link.md"))
                .expect("symlink");
            assert!(matches!(
                source.update("link.md", "x", None).await,
                Err(FilesystemError::Symlink)
            ));
        }
    }
}
