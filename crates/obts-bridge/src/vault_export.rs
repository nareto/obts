use std::io::{self, Write};
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::{Body, Bytes};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use thiserror::Error;
use tokio::io::{AsyncRead, ReadBuf};
use tokio::sync::OwnedSemaphorePermit;
use tokio_stream::Stream;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime as ZipDateTime, ZipWriter};

use crate::authorization::AuthContext;
use crate::filesystem::{FilesystemError, FilesystemSource};
use crate::store::{VaultStore, whole_file_revision};

pub(crate) const MAX_MARKDOWN_EXPORT_FILES: usize = 10_000;
pub(crate) const MAX_MARKDOWN_EXPORT_BYTES: usize = 256 * 1024 * 1024;
const MARKDOWN_EXPORT_SCHEMA_VERSION: u32 = 2;
const MARKDOWN_EXPORT_ZIP_FORMAT_VERSION: u32 = 1;
const MARKDOWN_EXPORT_MEDIA_TYPE: &str = "text/markdown; charset=utf-8";
const POLICY_OMISSION_MARKER: &str = "omitted_without_disclosing_paths_or_counts";

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MarkdownExportManifest {
    schema_version: u32,
    export_revision: String,
    snapshot_at: DateTime<Utc>,
    include: Vec<&'static str>,
    exported_markdown_files: usize,
    files: Vec<MarkdownExportManifestFile>,
    fallbacks: MarkdownExportFallbacks,
    omissions: MarkdownExportOmissions,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MarkdownExportManifestFile {
    path: String,
    revision: String,
    media_type: &'static str,
    size_bytes: usize,
    sha256: String,
    updated_at: DateTime<Utc>,
    content_source: &'static str,
    projection_status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct MarkdownExportFallbacks {
    indexed_markdown_files: usize,
    raw_markdown_files_without_coherent_index: usize,
}

#[derive(Debug, Clone, Serialize)]
struct MarkdownExportOmissions {
    policy_filtered_markdown_files: &'static str,
    unavailable_markdown_files: usize,
}

#[derive(Debug)]
struct PreparedMarkdownFile {
    source_revision: String,
    manifest: MarkdownExportManifestFile,
}

#[derive(Debug, Clone)]
pub(crate) struct MarkdownExportMetadata {
    pub etag: String,
    pub export_revision: String,
    pub exported_markdown_files: usize,
    pub unavailable_markdown_files: usize,
}

#[derive(Debug)]
pub(crate) enum MarkdownExportResponse {
    NotModified(MarkdownExportMetadata),
    Archive(MarkdownExportArchive),
}

#[derive(Debug)]
pub(crate) struct MarkdownExportArchive {
    temp_file: NamedTempFile,
    _permit: OwnedSemaphorePermit,
    pub metadata: MarkdownExportMetadata,
}

impl MarkdownExportArchive {
    #[cfg(test)]
    fn temp_path(&self) -> std::path::PathBuf {
        self.temp_file.path().to_path_buf()
    }

    pub fn into_body(self) -> Result<(Body, u64), MarkdownExportError> {
        let size = self.temp_file.as_file().metadata()?.len();
        let reader = self.temp_file.reopen()?;
        let stream = MarkdownExportBodyStream {
            reader: tokio::fs::File::from_std(reader),
            finished: false,
            _archive: self,
        };
        Ok((Body::from_stream(stream), size))
    }
}

struct MarkdownExportBodyStream {
    reader: tokio::fs::File,
    finished: bool,
    _archive: MarkdownExportArchive,
}

impl Stream for MarkdownExportBodyStream {
    type Item = Result<Bytes, io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.finished {
            return Poll::Ready(None);
        }
        let mut buffer = [0_u8; 64 * 1024];
        let mut read_buffer = ReadBuf::new(&mut buffer);
        match Pin::new(&mut self.reader).poll_read(cx, &mut read_buffer) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => {
                self.finished = true;
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(Ok(())) if read_buffer.filled().is_empty() => {
                self.finished = true;
                Poll::Ready(None)
            }
            Poll::Ready(Ok(())) => {
                Poll::Ready(Some(Ok(Bytes::copy_from_slice(read_buffer.filled()))))
            }
        }
    }
}

#[derive(Debug, Error)]
pub(crate) enum MarkdownExportError {
    #[error("another Markdown export is already running")]
    Busy,
    #[error("Markdown export exceeds the limit of {max_files} files or {max_bytes} bytes")]
    LimitExceeded { max_files: usize, max_bytes: usize },
    #[error("vault index is not current")]
    IndexCatchingUp,
    #[error("duplicate export path: {0}")]
    DuplicatePath(String),
    #[error("invalid export path: {0}")]
    InvalidPath(String),
    #[error("the projected vault changed while the export was being built")]
    SnapshotChanged,
    #[error("could not serialize export manifest: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("could not write ZIP archive: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("export filesystem I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("export worker failed: {0}")]
    Task(String),
    #[error("vault filesystem unavailable: {0}")]
    Source(#[from] FilesystemError),
    #[error("vault projection unavailable: {0}")]
    Projection(String),
}

pub(crate) async fn export_markdown(
    store: &VaultStore,
    source: &FilesystemSource,
    auth: &AuthContext,
    if_none_match: &[String],
    permit: OwnedSemaphorePermit,
) -> Result<MarkdownExportResponse, MarkdownExportError> {
    let candidates = store
        .markdown_export_candidates(auth, MAX_MARKDOWN_EXPORT_FILES)
        .await
        .map_err(|error| MarkdownExportError::Projection(error.to_string()))?;
    if candidates.exceeds_limit {
        return Err(limit_exceeded());
    }

    let mut files = Vec::with_capacity(candidates.files.len());
    let mut total_bytes = 0usize;
    let mut unavailable_markdown_files = 0usize;
    let mut previous_path: Option<String> = None;
    let mut snapshot_at =
        DateTime::<Utc>::from_timestamp(0, 0).expect("the Unix epoch is a valid UTC timestamp");

    for candidate in candidates.files {
        validate_archive_path(&candidate.path)?;
        if previous_path.as_deref() == Some(candidate.path.as_str()) {
            return Err(MarkdownExportError::DuplicatePath(candidate.path));
        }
        previous_path = Some(candidate.path.clone());
        let file = match source
            .read_attested(&candidate.path, &candidate.source_revision)
            .await
        {
            Ok(file) => file,
            Err(error) if exact_body_unavailable(&error) => {
                unavailable_markdown_files = unavailable_markdown_files.saturating_add(1);
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        total_bytes = total_bytes
            .checked_add(file.content.len())
            .ok_or_else(limit_exceeded)?;
        if files.len() >= MAX_MARKDOWN_EXPORT_FILES || total_bytes > MAX_MARKDOWN_EXPORT_BYTES {
            return Err(limit_exceeded());
        }
        snapshot_at = snapshot_at.max(file.updated_at);
        files.push(PreparedMarkdownFile {
            source_revision: candidate.source_revision,
            manifest: MarkdownExportManifestFile {
                path: candidate.path,
                revision: whole_file_revision(&file.content),
                media_type: MARKDOWN_EXPORT_MEDIA_TYPE,
                size_bytes: file.content.len(),
                sha256: sha256_hex(file.content.as_bytes()),
                updated_at: file.updated_at,
                content_source: "raw",
                projection_status: "coherent",
            },
        });
    }

    let manifest_files = files
        .iter()
        .map(|file| file.manifest.clone())
        .collect::<Vec<_>>();
    let fallbacks = MarkdownExportFallbacks {
        indexed_markdown_files: 0,
        raw_markdown_files_without_coherent_index: 0,
    };
    let omissions = MarkdownExportOmissions {
        policy_filtered_markdown_files: POLICY_OMISSION_MARKER,
        unavailable_markdown_files,
    };
    let revision_input = serde_json::to_vec(&(
        MARKDOWN_EXPORT_ZIP_FORMAT_VERSION,
        MARKDOWN_EXPORT_SCHEMA_VERSION,
        snapshot_at,
        &manifest_files,
        &fallbacks,
        &omissions,
    ))?;
    let export_revision = format!("v1:sha256:{}", sha256_hex(&revision_input));
    let etag = format!("\"{export_revision}\"");
    let metadata = MarkdownExportMetadata {
        etag: etag.clone(),
        export_revision: export_revision.clone(),
        exported_markdown_files: files.len(),
        unavailable_markdown_files,
    };
    if if_none_match_matches(if_none_match, &etag) {
        for prepared in &files {
            drop(read_verified_file(source, prepared).await?);
        }
        return Ok(MarkdownExportResponse::NotModified(metadata));
    }

    let manifest = MarkdownExportManifest {
        schema_version: MARKDOWN_EXPORT_SCHEMA_VERSION,
        export_revision,
        snapshot_at,
        include: vec!["markdown"],
        exported_markdown_files: files.len(),
        files: manifest_files,
        fallbacks,
        omissions,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    let temp_file = secure_temp_file()?;
    let output = temp_file.reopen()?;
    let mut archive = tokio::task::spawn_blocking(move || {
        let mut archive = ZipWriter::new(output);
        archive.start_file("manifest.json", zip_options())?;
        archive.write_all(&manifest_bytes)?;
        Ok::<_, MarkdownExportError>(archive)
    })
    .await
    .map_err(|error| MarkdownExportError::Task(error.to_string()))??;

    for prepared in files {
        let file = read_verified_file(source, &prepared).await?;
        let path = prepared.manifest.path;
        archive = tokio::task::spawn_blocking(move || {
            archive.start_file(path, zip_options())?;
            archive.write_all(file.content.as_bytes())?;
            Ok::<_, MarkdownExportError>(archive)
        })
        .await
        .map_err(|error| MarkdownExportError::Task(error.to_string()))??;
    }

    tokio::task::spawn_blocking(move || archive.finish())
        .await
        .map_err(|error| MarkdownExportError::Task(error.to_string()))??;
    temp_file.as_file().sync_all()?;

    Ok(MarkdownExportResponse::Archive(MarkdownExportArchive {
        temp_file,
        _permit: permit,
        metadata,
    }))
}

async fn read_verified_file(
    source: &FilesystemSource,
    prepared: &PreparedMarkdownFile,
) -> Result<crate::filesystem::FilesystemFile, MarkdownExportError> {
    let file = source
        .read_attested(&prepared.manifest.path, &prepared.source_revision)
        .await
        .map_err(|_| MarkdownExportError::SnapshotChanged)?;
    if file.content.len() != prepared.manifest.size_bytes
        || sha256_hex(file.content.as_bytes()) != prepared.manifest.sha256
        || whole_file_revision(&file.content) != prepared.manifest.revision
        || file.updated_at != prepared.manifest.updated_at
    {
        return Err(MarkdownExportError::SnapshotChanged);
    }
    Ok(file)
}

fn secure_temp_file() -> Result<NamedTempFile, io::Error> {
    let file = NamedTempFile::new()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

fn exact_body_unavailable(error: &FilesystemError) -> bool {
    matches!(
        error,
        FilesystemError::NotFound
            | FilesystemError::InvalidUtf8(_)
            | FilesystemError::ProjectionChanged
            | FilesystemError::ProjectionLimitExceeded { .. }
            | FilesystemError::CommitSnapshotMismatch
            | FilesystemError::CommitContentMismatch { .. }
    )
}

fn validate_archive_path(path: &str) -> Result<(), MarkdownExportError> {
    let bytes = path.as_bytes();
    let has_windows_drive_prefix =
        bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let valid = !path.is_empty()
        && !path.starts_with('/')
        && !has_windows_drive_prefix
        && !path.contains('\\')
        && !path.contains('\0')
        && path.to_ascii_lowercase().ends_with(".md")
        && path
            .split('/')
            .all(|component| !component.is_empty() && component != "." && component != "..");
    if valid {
        Ok(())
    } else {
        Err(MarkdownExportError::InvalidPath(path.to_string()))
    }
}

fn if_none_match_matches(values: &[String], current_etag: &str) -> bool {
    values.iter().any(|value| {
        value.split(',').any(|candidate| {
            let candidate = candidate.trim();
            candidate == "*"
                || candidate == current_etag
                || candidate
                    .strip_prefix("W/")
                    .is_some_and(|weak| weak == current_etag)
        })
    })
}

fn zip_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .last_modified_time(fixed_zip_timestamp())
        .unix_permissions(0o644)
}

fn fixed_zip_timestamp() -> ZipDateTime {
    ZipDateTime::from_date_and_time(1980, 1, 1, 0, 0, 0).expect("the fixed ZIP timestamp is valid")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn limit_exceeded() -> MarkdownExportError {
    MarkdownExportError::LimitExceeded {
        max_files: MAX_MARKDOWN_EXPORT_FILES,
        max_bytes: MAX_MARKDOWN_EXPORT_BYTES,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::{Cursor, Read};
    use std::sync::Arc;

    use http_body_util::BodyExt;
    use tempfile::tempdir;
    use tokio::sync::Semaphore;
    use zip::ZipArchive;

    use super::{
        MarkdownExportResponse, export_markdown, if_none_match_matches, sha256_hex,
        validate_archive_path,
    };
    use crate::authorization::{AccessMatcher, AccessPolicy, AccessRule, AuthContext, ContextName};
    use crate::filesystem::FilesystemSource;
    use crate::new_note::NewNoteFileType;
    use crate::store::{RecoveredVaultFileState, VaultStore};

    #[test]
    fn weak_etags_match_the_current_export() {
        let current = "\"v1:sha256:abc\"";
        assert!(if_none_match_matches(&[format!("W/{current}")], current));
        assert!(if_none_match_matches(&["*".to_string()], current));
        assert!(!if_none_match_matches(
            &["\"v1:sha256:other\"".to_string()],
            current
        ));
    }

    #[test]
    fn archive_paths_are_markdown_only_and_relative() {
        assert!(validate_archive_path("Folder/Note.md").is_ok());
        for path in [
            "../escape.md",
            "/absolute.md",
            "C:/escape.md",
            "bad\\path.md",
            "Note.base",
        ] {
            assert!(validate_archive_path(path).is_err());
        }
    }

    #[tokio::test]
    async fn export_is_policy_filtered_ordered_best_effort_and_cacheable() {
        let root = tempdir().expect("vault root");
        let source = FilesystemSource::new(root.path()).expect("filesystem source");
        for (path, content) in [
            ("Visible/Z.md", "# Z\n"),
            ("Visible/A.md", "# A\n"),
            ("Visible/Missing.md", "# Missing\n"),
            ("Secret/Hidden.md", "# Hidden\n"),
        ] {
            source
                .create(path, content)
                .await
                .expect("create source file");
        }
        let snapshot = source.scan().await.expect("scan source");
        source.mark_indexed(&snapshot);

        let store = VaultStore::new(10);
        store
            .set_authorization_config(BTreeMap::from([(
                "agent".to_string(),
                AccessPolicy {
                    read: vec![AccessRule::allow(AccessMatcher {
                        path_prefix: Some("Visible".to_string()),
                        ..AccessMatcher::default()
                    })],
                    ..AccessPolicy::default()
                },
            )]))
            .await;
        for file in snapshot.values() {
            store
                .project_filesystem_file(RecoveredVaultFileState {
                    path: file.path.clone(),
                    content: file.content.clone(),
                    file_type: NewNoteFileType::Md,
                    couchdb_rev: file.revision.clone(),
                    created_at: file.created_at,
                    updated_at: file.updated_at,
                })
                .await
                .expect("project source file");
        }
        std::fs::remove_file(root.path().join("Visible/Missing.md")).expect("remove exact body");

        let auth = AuthContext::new(ContextName::new("agent"), "test:agent".to_string());
        let slots = Arc::new(Semaphore::new(1));
        let permit = slots.clone().try_acquire_owned().expect("export permit");
        let response = export_markdown(&store, &source, &auth, &[], permit)
            .await
            .expect("build export");
        let archive = match response {
            MarkdownExportResponse::Archive(archive) => archive,
            MarkdownExportResponse::NotModified(_) => panic!("first export must produce ZIP"),
        };
        let etag = archive.metadata.etag.clone();
        assert_eq!(archive.metadata.exported_markdown_files, 2);
        assert_eq!(archive.metadata.unavailable_markdown_files, 1);
        assert_eq!(slots.available_permits(), 0);
        assert!(slots.clone().try_acquire_owned().is_err());
        let archive_path = archive.temp_path();
        let (body, _) = archive.into_body().expect("stream archive");
        let bytes = body.collect().await.expect("read archive").to_bytes();
        assert_eq!(slots.available_permits(), 1);
        assert!(!archive_path.exists());

        let mut zip = ZipArchive::new(Cursor::new(bytes)).expect("open ZIP");
        assert_eq!(
            zip.by_index(0).expect("manifest entry").name(),
            "manifest.json"
        );
        let mut manifest_json = String::new();
        zip.by_name("manifest.json")
            .expect("manifest")
            .read_to_string(&mut manifest_json)
            .expect("read manifest");
        let manifest: serde_json::Value =
            serde_json::from_str(&manifest_json).expect("parse manifest");
        assert_eq!(manifest["schema_version"], 2);
        assert_eq!(manifest["exported_markdown_files"], 2);
        assert_eq!(manifest["omissions"]["unavailable_markdown_files"], 1);
        assert_eq!(
            manifest["omissions"]["policy_filtered_markdown_files"],
            "omitted_without_disclosing_paths_or_counts"
        );
        assert_eq!(manifest["files"][0]["path"], "Visible/A.md");
        assert_eq!(manifest["files"][1]["path"], "Visible/Z.md");
        assert!(!manifest_json.contains("Secret/Hidden.md"));
        assert_eq!(zip.len(), 3);
        for declared in manifest["files"].as_array().expect("manifest files") {
            let path = declared["path"].as_str().expect("manifest path");
            let mut content = Vec::new();
            zip.by_name(path)
                .expect("declared ZIP entry")
                .read_to_end(&mut content)
                .expect("read declared ZIP entry");
            assert_eq!(declared["size_bytes"], content.len());
            assert_eq!(declared["sha256"], sha256_hex(&content));
            assert_eq!(
                declared["revision"],
                crate::store::whole_file_revision(
                    std::str::from_utf8(&content).expect("UTF-8 Markdown")
                )
            );
        }

        let permit = slots
            .clone()
            .try_acquire_owned()
            .expect("second export permit");
        let cached = export_markdown(&store, &source, &auth, &[format!("W/{etag}")], permit)
            .await
            .expect("cached export");
        assert!(matches!(cached, MarkdownExportResponse::NotModified(_)));
        assert_eq!(slots.available_permits(), 1);

        let permit = slots
            .clone()
            .try_acquire_owned()
            .expect("disconnect export permit");
        let response = export_markdown(&store, &source, &auth, &[], permit)
            .await
            .expect("build disconnect export");
        let archive = match response {
            MarkdownExportResponse::Archive(archive) => archive,
            MarkdownExportResponse::NotModified(_) => {
                panic!("unconditional export must produce ZIP")
            }
        };
        let archive_path = archive.temp_path();
        let (body, _) = archive.into_body().expect("open disconnect stream");
        drop(body);
        assert_eq!(slots.available_permits(), 1);
        assert!(!archive_path.exists());
    }
}
