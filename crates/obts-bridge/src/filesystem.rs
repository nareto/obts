use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tracing::{info, warn};

use crate::headless::HeadlessClient;
use crate::model::NoteId;
use crate::new_note::NewNoteFileType;
use crate::store::{RecoveredVaultFileState, VaultStore};

#[derive(Clone, Debug)]
pub struct FilesystemSource {
    root: Arc<PathBuf>,
    watermark: Arc<RwLock<FilesystemWatermark>>,
}

#[derive(Clone, Debug, Default)]
struct FilesystemWatermark {
    observed: String,
    indexed: String,
    generation: u64,
    observed_generation: u64,
    indexed_generation: u64,
}

#[derive(Clone, Debug)]
pub struct FilesystemFile {
    pub path: String,
    pub content: String,
    pub revision: String,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

impl FilesystemSource {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, FilesystemError> {
        fs::create_dir_all(root.as_ref())?;
        let root = root.as_ref().canonicalize()?;
        Ok(Self {
            root: Arc::new(root),
            watermark: Arc::new(RwLock::new(FilesystemWatermark::default())),
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
        let root = self.root.clone();
        let files = tokio::task::spawn_blocking(move || scan_root(root.as_path()))
            .await
            .map_err(|error| FilesystemError::Task(error.to_string()))??;
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

    fn mark_indexed(&self, files: &BTreeMap<String, FilesystemFile>) {
        let indexed = snapshot_revision(files);
        let mut watermark = self.watermark.write().expect("filesystem watermark lock");
        if watermark.observed == indexed && watermark.observed_generation == watermark.generation {
            watermark.indexed = indexed;
            watermark.indexed_generation = watermark.generation;
        }
    }

    pub async fn read(&self, path: &str) -> Result<FilesystemFile, FilesystemError> {
        let target = self.safe_target(path)?;
        let path = normalize_relative_path(path)?;
        tokio::task::spawn_blocking(move || {
            let bytes = fs::read(&target).map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    FilesystemError::NotFound
                } else {
                    FilesystemError::Io(error)
                }
            })?;
            let content = String::from_utf8(bytes.clone())
                .map_err(|_| FilesystemError::InvalidUtf8(path.clone()))?;
            let metadata = fs::metadata(&target)?;
            Ok(FilesystemFile {
                path,
                content,
                revision: content_revision(&bytes),
                created_at: system_time(metadata.created().ok()),
                updated_at: system_time(metadata.modified().ok()).unwrap_or_else(Utc::now),
            })
        })
        .await
        .map_err(|error| FilesystemError::Task(error.to_string()))?
    }

    pub async fn create(&self, path: &str, content: &str) -> Result<String, FilesystemError> {
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
        let target = self.safe_target(path)?;
        let content = content.to_owned();
        let revision = content_revision(content.as_bytes());
        let expected_revision = expected_revision.map(ToOwned::to_owned);
        tokio::task::spawn_blocking(move || {
            let current = fs::read(&target).map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    FilesystemError::NotFound
                } else {
                    FilesystemError::Io(error)
                }
            })?;
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
        store
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
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if let Some(headless) = headless.as_ref() {
                match headless.lock_filesystem().await {
                    Ok(_guard) => log_projection_result(synchronize_snapshot(&store, &source).await),
                    Err(error) => warn!(error = %error, "filesystem projection deferred; headless client unavailable"),
                }
            } else {
                log_projection_result(synchronize_snapshot(&store, &source).await);
            }
            sleep(interval).await;
        }
    })
}

fn log_projection_result(result: Result<usize, FilesystemError>) {
    match result {
        Ok(changed) if changed > 0 => info!(changed, "filesystem projection updated"),
        Ok(_) => {}
        Err(error) => warn!(error = %error, "filesystem projection failed; retaining previous index"),
    }
}

fn scan_root(root: &Path) -> Result<BTreeMap<String, FilesystemFile>, FilesystemError> {
    let mut files = BTreeMap::new();
    walk(root, root, &mut files)?;
    Ok(files)
}

fn walk(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, FilesystemFile>,
) -> Result<(), FilesystemError> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let metadata = entry.file_type()?;
        if metadata.is_symlink() {
            continue;
        }
        let path = entry.path();
        let relative = path.strip_prefix(root).map_err(|_| FilesystemError::PathEscape)?;
        let relative = path_to_slashes(relative)?;
        if is_excluded_path(&relative) {
            continue;
        }
        if metadata.is_dir() {
            walk(root, &path, files)?;
            continue;
        }
        if !metadata.is_file() || !is_supported_path(&relative) {
            continue;
        }
        let bytes = fs::read(&path)?;
        let content = String::from_utf8(bytes.clone()).map_err(|_| FilesystemError::InvalidUtf8(relative.clone()))?;
        let metadata = entry.metadata()?;
        let updated_at = system_time(metadata.modified().ok()).unwrap_or_else(Utc::now);
        let created_at = system_time(metadata.created().ok());
        files.insert(
            relative.clone(),
            FilesystemFile {
                path: relative,
                content,
                revision: content_revision(&bytes),
                created_at,
                updated_at,
            },
        );
    }
    Ok(())
}

fn atomic_write(path: &Path, content: &str, create_new: bool) -> Result<(), FilesystemError> {
    if create_new && path.exists() {
        return Err(FilesystemError::AlreadyExists);
    }
    let parent = path.parent().ok_or(FilesystemError::PathEscape)?;
    let file_name = path.file_name().and_then(|name| name.to_str()).ok_or(FilesystemError::PathEscape)?;
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

fn normalize_relative_path(path: &str) -> Result<String, FilesystemError> {
    let path = Path::new(path);
    if path.is_absolute() {
        return Err(FilesystemError::PathEscape);
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str().ok_or(FilesystemError::NonUtf8Path)?),
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
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{FilesystemError, FilesystemSource};

    #[tokio::test]
    async fn writes_and_reads_supported_vault_files_with_revision_checks() {
        let root = tempdir().expect("tempdir");
        let source = FilesystemSource::new(root.path()).expect("source");

        let first = source.create("Notes/test.md", "# First\n").await.expect("create");
        let file = source.read("Notes/test.md").await.expect("read");
        assert_eq!(file.content, "# First\n");
        assert_eq!(file.revision, first);

        let second = source
            .update("Notes/test.md", "# Second\n", Some(&first))
            .await
            .expect("update");
        assert_ne!(first, second);
        assert!(matches!(
            source.update("Notes/test.md", "# Third\n", Some(&first)).await,
            Err(FilesystemError::Changed { .. })
        ));
        assert_eq!(source.read("Notes/test.md").await.expect("read").content, "# Second\n");
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
    async fn rejects_path_traversal_and_symlink_write_targets() {
        let root = tempdir().expect("tempdir");
        let outside = tempdir().expect("outside");
        let source = FilesystemSource::new(root.path()).expect("source");
        assert!(matches!(source.create("../outside.md", "x").await, Err(FilesystemError::PathEscape)));

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path().join("note.md"), root.path().join("link.md")).expect("symlink");
            assert!(matches!(source.update("link.md", "x", None).await, Err(FilesystemError::Symlink)));
        }
    }
}
