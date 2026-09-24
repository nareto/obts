use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use sha1::{Digest, Sha1};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

pub const MAX_ROOT_IGNORE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum RootIgnoreError {
    #[error("root .gitignore is unreadable")]
    Io(#[from] std::io::Error),
    #[error("root .gitignore must be a regular file")]
    NonRegular,
    #[error("root .gitignore exceeds the byte limit")]
    TooLarge,
    #[error("root .gitignore must be valid UTF-8")]
    InvalidEncoding(#[from] std::str::Utf8Error),
    #[error("root .gitignore cannot contain NUL bytes")]
    Nul,
    #[error("root .gitignore has an invalid rule")]
    InvalidRule(#[from] ignore::Error),
    #[error("root .gitignore changed while reading")]
    Changed,
    #[error("expected a relative canonical vault path")]
    InvalidPath,
}

#[derive(Debug)]
pub struct RootIgnorePolicy {
    pub blob_oid: Option<String>,
    matcher: Gitignore,
}

impl RootIgnorePolicy {
    pub fn read(vault_root: &Path) -> Result<Self, RootIgnoreError> {
        let path = vault_root.join(".gitignore");
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Self::from_bytes(None);
            }
            Err(error) => return Err(error.into()),
            Ok(metadata) if !metadata.file_type().is_file() => {
                return Err(RootIgnoreError::NonRegular);
            }
            Ok(_) => {}
        }
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)?;
        let opened = file.metadata()?;
        let listed = fs::symlink_metadata(&path)?;
        if !opened.is_file()
            || !listed.is_file()
            || opened.dev() != listed.dev()
            || opened.ino() != listed.ino()
        {
            return Err(RootIgnoreError::NonRegular);
        }
        if opened.len() > MAX_ROOT_IGNORE_BYTES as u64 {
            return Err(RootIgnoreError::TooLarge);
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(MAX_ROOT_IGNORE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        let current = fs::symlink_metadata(&path).map_err(|_| RootIgnoreError::Changed)?;
        if !current.is_file()
            || current.dev() != opened.dev()
            || current.ino() != opened.ino()
            || current.len() != opened.len()
            || current.mtime() != opened.mtime()
            || current.mtime_nsec() != opened.mtime_nsec()
            || current.ctime() != opened.ctime()
            || current.ctime_nsec() != opened.ctime_nsec()
        {
            return Err(RootIgnoreError::Changed);
        }
        if after.len() != opened.len()
            || after.mtime() != opened.mtime()
            || after.mtime_nsec() != opened.mtime_nsec()
            || after.ctime() != opened.ctime()
            || after.ctime_nsec() != opened.ctime_nsec()
            || bytes.len() as u64 != opened.len()
        {
            return Err(RootIgnoreError::Changed);
        }
        Self::from_bytes(Some(&bytes))
    }

    pub fn from_bytes(bytes: Option<&[u8]>) -> Result<Self, RootIgnoreError> {
        let mut builder = GitignoreBuilder::new("");
        let blob_oid = if let Some(bytes) = bytes {
            if bytes.len() > MAX_ROOT_IGNORE_BYTES {
                return Err(RootIgnoreError::TooLarge);
            }
            let text = std::str::from_utf8(bytes)?;
            if text.contains('\0') {
                return Err(RootIgnoreError::Nul);
            }
            let rules = text.strip_prefix('\u{feff}').unwrap_or(text);
            for line in rules.lines() {
                builder.add_line(None, line)?;
            }
            let mut hasher = Sha1::new();
            hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
            hasher.update(bytes);
            Some(format!("{:x}", hasher.finalize()))
        } else {
            None
        };
        Ok(Self {
            blob_oid,
            matcher: builder.build()?,
        })
    }

    pub fn ignores(&self, path: &str, is_directory: bool) -> Result<bool, RootIgnoreError> {
        if path.is_empty()
            || path.starts_with('/')
            || path.ends_with('/')
            || path.contains(['\\', '\0'])
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(RootIgnoreError::InvalidPath);
        }
        let normalized: String = path.nfc().collect();
        if normalized == ".gitignore" {
            return Ok(false);
        }
        let mut prefix = String::new();
        let mut parts = normalized.split('/').peekable();
        while let Some(part) = parts.next() {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let is_dir = parts.peek().is_some() || is_directory;
            if self.matcher.matched(&prefix, is_dir).is_ignore() {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
