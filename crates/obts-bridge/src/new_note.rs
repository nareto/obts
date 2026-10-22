use chrono::{DateTime, Local, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use slug::slugify;
use thiserror::Error;

use crate::authorization::{add_unique_tag, set_owner_metadata};
use crate::config::NewNoteConfig;
use crate::markdown::{extract_frontmatter_tags, parse_frontmatter};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewNotePathSettings {
    pub base_path: String,
    pub path_template: String,
    pub date_format: String,
    pub max_title_slug_length: usize,
    pub max_title_length: usize,
}

impl Default for NewNotePathSettings {
    fn default() -> Self {
        Self {
            base_path: "11New".to_string(),
            path_template: "{base}/{date}-{slug}.md".to_string(),
            date_format: "%Y-%m-%d".to_string(),
            max_title_slug_length: 60,
            max_title_length: 200,
        }
    }
}

impl From<&NewNoteConfig> for NewNotePathSettings {
    fn from(value: &NewNoteConfig) -> Self {
        Self {
            base_path: value.base_path.clone(),
            path_template: value.path_template.clone(),
            date_format: value.date_format.clone(),
            max_title_slug_length: value.max_title_slug_length,
            max_title_length: value.max_title_length,
        }
    }
}

/// A generated create path plus whether a configured length limit shortened
/// a title-derived placeholder that the path template actually uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedNewNotePath {
    pub path: String,
    pub title_truncated: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum NewNoteFileType {
    #[default]
    Md,
    Base,
}

impl NewNoteFileType {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Md => "md",
            Self::Base => "base",
        }
    }

    pub fn is_markdown(self) -> bool {
        matches!(self, Self::Md)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewNoteRequest {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub template_id: Option<String>,
    #[serde(default)]
    pub file_type: NewNoteFileType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateNoteRequest {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub content_patch: Option<Vec<ContentPatchOperation>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub metadata: Option<Value>,
    #[serde(default)]
    pub expected_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContentPatchOperation {
    Replace { old: String, new: String },
    Delete { old: String },
    InsertBefore { anchor: String, text: String },
    InsertAfter { anchor: String, text: String },
    Append { text: String },
    Prepend { text: String },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PersistenceFailureKind {
    DatabaseUnavailable,
    InsufficientStorage,
    TransactionConflict,
    Unknown,
}

impl PersistenceFailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DatabaseUnavailable => "database_unavailable",
            Self::InsufficientStorage => "insufficient_storage",
            Self::TransactionConflict => "transaction_conflict",
            Self::Unknown => "unknown",
        }
    }

    pub fn caller_retryable(self) -> bool {
        matches!(self, Self::DatabaseUnavailable | Self::TransactionConflict)
    }
}

#[derive(Debug, Error)]
pub enum WriteError {
    #[error("path '{path}' is not allowed under configured new note path")]
    PathNotAllowed { path: String },
    #[error("title cannot be empty")]
    EmptyTitle,
    #[error("note already exists: {path}")]
    AlreadyExists { path: String },
    #[error("note not found: {path}")]
    NotFound { path: String },
    #[error("invalid create: {reason}")]
    InvalidCreate { reason: String },
    #[error("template not found or not visible: {path}")]
    TemplateNotFound { path: String },
    #[error("update requires the revision returned by the corresponding read")]
    PreconditionRequired,
    #[error("the vault file changed after it was read")]
    RevisionMismatch,
    #[error("invalid update: {reason}")]
    InvalidUpdate { reason: String },
    #[error("{operation} denied for '{path}': {reason}")]
    PolicyDenied {
        operation: &'static str,
        path: String,
        reason: String,
    },
    #[error("persistence failed")]
    Persistence { kind: PersistenceFailureKind },
}

pub(crate) fn frontmatter_timestamp(now: DateTime<Utc>) -> String {
    now.with_timezone(&Local)
        .to_rfc3339_opts(SecondsFormat::Secs, false)
}

impl NewNoteRequest {
    pub fn generate_path(&self) -> String {
        self.generate_path_at(Utc::now())
    }

    pub fn generate_path_at(&self, now: DateTime<Utc>) -> String {
        self.generate_path_with_settings_at(now, &NewNotePathSettings::default())
    }

    pub fn generate_path_with_settings(&self, settings: &NewNotePathSettings) -> String {
        self.generate_path_with_settings_at(Utc::now(), settings)
    }

    pub fn generate_path_with_settings_at(
        &self,
        now: DateTime<Utc>,
        settings: &NewNotePathSettings,
    ) -> String {
        self.generate_path_details_with_settings_at(now, settings)
            .path
    }

    /// Whether the configured limits shorten the title-derived part of the
    /// generated path. The date does not affect truncation.
    pub fn title_truncated_with_settings(&self, settings: &NewNotePathSettings) -> bool {
        self.generate_path_details_with_settings_at(Utc::now(), settings)
            .title_truncated
    }

    pub fn generate_path_details_with_settings_at(
        &self,
        now: DateTime<Utc>,
        settings: &NewNotePathSettings,
    ) -> GeneratedNewNotePath {
        let base = normalize_base_path(&settings.base_path);
        let template = normalized_template(&settings.path_template);
        let date_format = if settings.date_format.trim().is_empty() {
            "%Y-%m-%d"
        } else {
            settings.date_format.as_str()
        };
        let date = now.format(date_format).to_string();
        let (slug, slug_cut) = slug_with_limit(&self.title, settings.max_title_slug_length);
        let (title, title_cut) = title_segment_with_limit(&self.title, settings.max_title_length);
        let uses_title = template.contains("{title}");
        let uses_slug = template.contains("{slug}");
        let mut title_truncated = (uses_title && title_cut) || (uses_slug && slug_cut);

        let mut rendered = template
            .replace("{base}", &base)
            .replace("{date}", &date)
            .replace("{title}", &title)
            .replace("{slug}", &slug);
        rendered = rendered.replace('\\', "/");
        let mut rendered = rendered.trim().trim_start_matches('/').to_string();

        if rendered.is_empty() {
            rendered = format!("{base}/{date}-{slug}");
            title_truncated = slug_cut;
        }
        GeneratedNewNotePath {
            path: with_file_type_extension(&rendered, self.file_type),
            title_truncated,
        }
    }

    pub fn validate_write(&self) -> Result<String, WriteError> {
        self.validate_write_at(Utc::now())
    }

    pub fn validate_write_at(&self, now: DateTime<Utc>) -> Result<String, WriteError> {
        self.validate_write_with_settings_at(now, &NewNotePathSettings::default())
    }

    pub fn validate_write_with_settings(
        &self,
        settings: &NewNotePathSettings,
    ) -> Result<String, WriteError> {
        self.validate_write_with_settings_at(Utc::now(), settings)
    }

    pub fn validate_write_with_settings_at(
        &self,
        now: DateTime<Utc>,
        settings: &NewNotePathSettings,
    ) -> Result<String, WriteError> {
        if self.title.trim().is_empty() {
            return Err(WriteError::EmptyTitle);
        }

        let path = self.generate_path_with_settings_at(now, settings);
        let configured_prefix = format!("{}/", normalize_base_path(&settings.base_path));
        let allowed =
            path.starts_with(&configured_prefix) && is_safe_new_file_path(&path, self.file_type);

        if !allowed {
            return Err(WriteError::PathNotAllowed { path });
        }

        Ok(path)
    }

    pub fn apply_markdown_create_metadata(
        &mut self,
        created_at: DateTime<Utc>,
        add_tags: &[String],
        owner_principal: Option<&str>,
    ) -> Result<(), WriteError> {
        if !self.file_type.is_markdown() {
            return Ok(());
        }

        let (frontmatter, body) = parse_frontmatter(&self.content);
        if !frontmatter.is_object() {
            return Err(WriteError::InvalidCreate {
                reason: "markdown frontmatter must be a YAML mapping".to_string(),
            });
        }

        let mut frontmatter = frontmatter;
        let Some(map) = frontmatter.as_object_mut() else {
            return Err(WriteError::InvalidCreate {
                reason: "markdown frontmatter must be a YAML mapping".to_string(),
            });
        };
        map.insert(
            "created".to_string(),
            Value::String(frontmatter_timestamp(created_at)),
        );

        if !add_tags.is_empty() {
            add_tags_to_frontmatter(&mut frontmatter, add_tags);
        }
        if let Some(principal) = owner_principal {
            set_owner_metadata(&mut frontmatter, principal);
        }

        self.content = markdown_with_frontmatter(&frontmatter, &body)?;
        Ok(())
    }
}

impl UpdateNoteRequest {
    /// Rebuild the full markdown from the existing note's frontmatter and body,
    /// applying any overrides from this update request.
    pub fn rebuild_markdown(
        &self,
        existing_frontmatter: &Value,
        existing_body: &str,
        existing_tags: &[String],
        now: DateTime<Utc>,
    ) -> Result<String, WriteError> {
        if self.content.is_some() && self.content_patch.is_some() {
            return Err(WriteError::InvalidUpdate {
                reason: "content and content_patch are mutually exclusive".to_string(),
            });
        }

        let mut fm = existing_frontmatter
            .as_object()
            .cloned()
            .unwrap_or_default();

        // Update the `updated` timestamp in frontmatter.
        fm.insert(
            "updated".to_string(),
            Value::String(frontmatter_timestamp(now)),
        );

        // Apply tag override if provided.
        if let Some(tags) = &self.tags {
            fm.insert(
                "tags".to_string(),
                Value::Array(tags.iter().map(|t| Value::String(t.clone())).collect()),
            );
        }

        // Apply metadata overrides if provided.
        if let Some(metadata) = &self.metadata
            && let Some(metadata_obj) = metadata.as_object()
        {
            for (k, v) in metadata_obj {
                if matches!(k.as_str(), "tags" | "updated") {
                    continue;
                }
                fm.insert(k.clone(), v.clone());
            }
        }

        // Rebuild YAML frontmatter as serde_yaml::Mapping to preserve key order.
        let yaml_mapping: serde_yaml::Mapping = fm
            .iter()
            .filter_map(|(k, v)| {
                let yaml_val = serde_yaml::to_value(v).ok()?;
                Some((serde_yaml::Value::String(k.clone()), yaml_val))
            })
            .collect();

        let yaml = serde_yaml::to_string(&yaml_mapping).unwrap_or_default();
        let yaml = yaml.strip_prefix("---\n").unwrap_or(&yaml);

        let body = match (&self.content, &self.content_patch) {
            (Some(content), None) => content.clone(),
            (None, Some(patch)) => apply_content_patch(existing_body, patch)?,
            (None, None) => existing_body.to_string(),
            (Some(_), Some(_)) => unreachable!("mutual exclusion checked above"),
        };
        let body = body.trim();

        // If tags were not explicitly overridden, keep the existing tags in frontmatter
        // (they're already there from the existing frontmatter we started with).
        // If the existing frontmatter had no tags but the note had parsed tags,
        // preserve them.
        if self.tags.is_none() && !existing_tags.is_empty() && !fm.contains_key("tags") {
            // This case shouldn't happen since existing_frontmatter should have tags,
            // but as a safety net we leave the frontmatter as-is.
        }

        Ok(format!("---\n{}---\n\n{}\n", yaml, body))
    }
}

pub(crate) fn apply_content_patch(
    existing_body: &str,
    patch: &[ContentPatchOperation],
) -> Result<String, WriteError> {
    if patch.is_empty() {
        return Err(invalid_patch(
            "content_patch must contain at least one operation",
        ));
    }

    let mut body = existing_body.to_string();
    for (index, operation) in patch.iter().enumerate() {
        apply_content_patch_operation(&mut body, operation)
            .map_err(|reason| invalid_patch(format!("operation {index}: {reason}")))?;
    }

    Ok(body)
}

fn apply_content_patch_operation(
    body: &mut String,
    operation: &ContentPatchOperation,
) -> Result<(), String> {
    match operation {
        ContentPatchOperation::Replace { old, new } => {
            let range = unique_match_range(body, old, "old")?;
            body.replace_range(range, new);
        }
        ContentPatchOperation::Delete { old } => {
            let range = unique_match_range(body, old, "old")?;
            body.replace_range(range, "");
        }
        ContentPatchOperation::InsertBefore { anchor, text } => {
            let range = unique_match_range(body, anchor, "anchor")?;
            body.insert_str(range.start, text);
        }
        ContentPatchOperation::InsertAfter { anchor, text } => {
            let range = unique_match_range(body, anchor, "anchor")?;
            body.insert_str(range.end, text);
        }
        ContentPatchOperation::Append { text } => body.push_str(text),
        ContentPatchOperation::Prepend { text } => body.insert_str(0, text),
    }

    Ok(())
}

fn unique_match_range(
    body: &str,
    needle: &str,
    field_name: &str,
) -> Result<std::ops::Range<usize>, String> {
    if needle.is_empty() {
        return Err(format!("{field_name} must not be empty"));
    }

    let mut matches = body.match_indices(needle);
    let Some((start, _)) = matches.next() else {
        return Err(format!("{field_name} text was not found"));
    };
    if matches.next().is_some() {
        return Err(format!("{field_name} text matched more than once"));
    }

    Ok(start..start + needle.len())
}

fn invalid_patch(reason: impl Into<String>) -> WriteError {
    WriteError::InvalidUpdate {
        reason: format!("content_patch: {}", reason.into()),
    }
}

fn markdown_with_frontmatter(frontmatter: &Value, body: &str) -> Result<String, WriteError> {
    let Some(frontmatter_obj) = frontmatter.as_object() else {
        return Err(WriteError::InvalidCreate {
            reason: "markdown frontmatter must be a YAML mapping".to_string(),
        });
    };
    let yaml_mapping: serde_yaml::Mapping = frontmatter_obj
        .iter()
        .filter_map(|(k, v)| {
            let yaml_value = serde_yaml::to_value(v).ok()?;
            Some((serde_yaml::Value::String(k.clone()), yaml_value))
        })
        .collect();
    let yaml = serde_yaml::to_string(&yaml_mapping).unwrap_or_default();
    let yaml = yaml.strip_prefix("---\n").unwrap_or(&yaml);
    let mut markdown = format!("---\n{}---\n\n{}", yaml, body);
    if !markdown.ends_with('\n') {
        markdown.push('\n');
    }
    Ok(markdown)
}

fn add_tags_to_frontmatter(frontmatter: &mut Value, tags: &[String]) {
    let mut merged_tags = extract_frontmatter_tags(frontmatter);
    for tag in tags {
        add_unique_tag(&mut merged_tags, tag);
    }
    merged_tags.sort();
    merged_tags.dedup_by(|a, b| a.eq_ignore_ascii_case(b));

    if let Some(map) = frontmatter.as_object_mut() {
        map.insert(
            "tags".to_string(),
            Value::Array(merged_tags.into_iter().map(Value::String).collect()),
        );
    }
}

/// Cuts an over-limit `value` to at most `max_len` bytes, preferring the last
/// `separator` boundary. Falls back to a UTF-8 character boundary when the
/// value has no separator or the boundary would discard more than half of the
/// budget (an overlong single word).
fn cut_at_word_boundary(value: &str, max_len: usize, separator: char) -> &str {
    let mut end = max_len.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    let hard = &value[..end];
    if value[end..].starts_with(separator) {
        return hard;
    }
    match hard.rfind(separator) {
        Some(pos) if pos >= max_len / 2 => &hard[..pos],
        _ => hard,
    }
}

fn slug_with_limit(title: &str, max_len: usize) -> (String, bool) {
    let slug = slugify(title);
    if slug.is_empty() {
        return ("note".to_string(), false);
    }

    let max_len = max_len.max(1);
    if slug.len() <= max_len {
        return (slug, false);
    }

    let cut = cut_at_word_boundary(&slug, max_len, '-').trim_end_matches('-');
    if cut.is_empty() {
        ("note".to_string(), true)
    } else {
        (cut.to_string(), true)
    }
}

fn title_segment_with_limit(title: &str, max_len: usize) -> (String, bool) {
    let mut segment = String::new();
    let mut previous_was_space = false;
    for ch in title.trim().chars() {
        let ch = if is_unsafe_path_char(ch) || ch == '/' || ch == '\\' || ch.is_whitespace() {
            ' '
        } else {
            ch
        };

        if ch == ' ' {
            if !segment.is_empty() && !previous_was_space {
                segment.push(ch);
            }
            previous_was_space = true;
        } else {
            segment.push(ch);
            previous_was_space = false;
        }
    }

    segment = trim_filename_segment(segment);
    if segment.is_empty() || is_reserved_windows_filename(&segment) {
        segment = "Untitled".to_string();
    }

    let (segment, truncated) = truncate_filename_segment(&segment, max_len);
    if segment.is_empty() || is_reserved_windows_filename(&segment) {
        (truncate_filename_segment("Untitled", max_len).0, truncated)
    } else {
        (segment, truncated)
    }
}

fn truncate_filename_segment(segment: &str, max_len: usize) -> (String, bool) {
    let max_len = max_len.max(1);
    if segment.len() <= max_len {
        return (segment.to_string(), false);
    }

    let cut = cut_at_word_boundary(segment, max_len, ' ')
        .trim_end_matches([' ', '.', ',', ';', '-', '\u{2013}', '\u{2014}']);
    let cut = trim_filename_segment(cut.to_string());
    if cut.is_empty() {
        ("Untitled".chars().take(max_len).collect(), true)
    } else {
        (cut, true)
    }
}

/// The note title Obsidian shows for a created file: its name without folder
/// and without the file-type extension.
pub fn created_file_title(path: &str, file_type: NewNoteFileType) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let suffix = format!(".{}", file_type.extension());
    name.strip_suffix(&suffix).unwrap_or(name).to_string()
}

fn trim_filename_segment(segment: String) -> String {
    segment
        .trim_matches(|ch: char| ch == ' ' || ch == '.')
        .to_string()
}

fn with_file_type_extension(path: &str, file_type: NewNoteFileType) -> String {
    let extension = format!(".{}", file_type.extension());
    let lower = path.to_ascii_lowercase();
    for existing_extension in [".md", ".base"] {
        if lower.ends_with(existing_extension) {
            return format!(
                "{}{}",
                &path[..path.len() - existing_extension.len()],
                extension
            );
        }
    }
    format!("{path}{extension}")
}

fn is_safe_new_file_path(path: &str, file_type: NewNoteFileType) -> bool {
    if path.starts_with('/')
        || !path
            .to_ascii_lowercase()
            .ends_with(&format!(".{}", file_type.extension()))
    {
        return false;
    }

    path.split('/').all(is_safe_path_segment)
}

fn is_safe_path_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && !segment.chars().any(is_unsafe_path_char)
        && !segment.ends_with(' ')
        && !segment.ends_with('.')
        && !is_reserved_windows_filename(segment)
}

fn is_unsafe_path_char(ch: char) -> bool {
    ch.is_control() || matches!(ch, ':' | '"' | '?' | '<' | '>' | '|' | '*' | '#')
}

fn is_reserved_windows_filename(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .trim()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || stem
            .strip_prefix("COM")
            .is_some_and(|suffix| suffix.len() == 1 && suffix.chars().all(|ch| ch.is_ascii_digit()))
        || stem
            .strip_prefix("LPT")
            .is_some_and(|suffix| suffix.len() == 1 && suffix.chars().all(|ch| ch.is_ascii_digit()))
}

fn normalize_base_path(base_path: &str) -> String {
    let normalized = base_path
        .trim()
        .trim_matches('/')
        .replace('\\', "/")
        .trim()
        .to_string();
    if normalized.is_empty() {
        "11New".to_string()
    } else {
        normalized
    }
}

fn normalized_template(path_template: &str) -> String {
    let trimmed = path_template.trim();
    if trimmed.is_empty() {
        "{base}/{date}-{slug}.md".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Local, TimeZone, Utc};
    use serde_json::json;

    use super::{
        ContentPatchOperation, NewNoteFileType, NewNotePathSettings, NewNoteRequest,
        UpdateNoteRequest, WriteError, created_file_title, frontmatter_timestamp,
    };
    use crate::markdown::parse_frontmatter;

    fn request(title: &str) -> NewNoteRequest {
        NewNoteRequest {
            title: title.to_string(),
            content: String::new(),
            template_id: None,
            file_type: NewNoteFileType::Md,
        }
    }

    fn fixed_now() -> chrono::DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 2, 26, 12, 0, 0)
            .single()
            .expect("valid timestamp")
    }

    fn timestamp_fixtures() -> [DateTime<Utc>; 2] {
        [
            "2026-10-02T23:28:26.112472251+00:00",
            "2026-01-02T23:28:26.112472251+00:00",
        ]
        .map(|value| {
            DateTime::parse_from_rfc3339(value)
                .unwrap()
                .with_timezone(&Utc)
        })
    }

    #[test]
    fn frontmatter_timestamp_europe_rome_handles_dst() {
        // A subprocess isolates TZ from concurrently running tests without mutating the environment.
        if std::env::var("TZ").ok().as_deref() != Some("Europe/Rome") {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "new_note::tests::frontmatter_timestamp_europe_rome_handles_dst",
                    "--nocapture",
                ])
                .env("TZ", "Europe/Rome")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "Rome timezone regression failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        for (utc, expected) in [
            (
                "2026-10-02T23:28:26.112472251Z",
                "2026-10-03T01:28:26+02:00",
            ),
            (
                "2026-01-02T23:28:26.112472251Z",
                "2026-01-03T00:28:26+01:00",
            ),
            (
                "2026-03-29T00:59:59.999999999Z",
                "2026-03-29T01:59:59+01:00",
            ),
            ("2026-03-29T01:00:00Z", "2026-03-29T03:00:00+02:00"),
            (
                "2026-10-25T00:59:59.999999999Z",
                "2026-10-25T02:59:59+02:00",
            ),
            ("2026-10-25T01:00:00Z", "2026-10-25T02:00:00+01:00"),
        ] {
            let now = DateTime::parse_from_rfc3339(utc)
                .unwrap()
                .with_timezone(&Utc);
            assert_eq!(frontmatter_timestamp(now), expected);
        }
    }

    #[test]
    fn create_frontmatter_timestamp_uses_local_offset_and_whole_seconds() {
        for now in timestamp_fixtures() {
            let mut note = request("Test");
            note.content = "---\ncreated: old\ncustom: retained\n---\n\nBody".to_string();
            note.apply_markdown_create_metadata(now, &[], None).unwrap();

            let (frontmatter, body) = parse_frontmatter(&note.content);
            assert_eq!(
                frontmatter["created"],
                now.with_timezone(&Local)
                    .format("%Y-%m-%dT%H:%M:%S%:z")
                    .to_string()
            );
            assert_eq!(frontmatter["custom"], "retained");
            assert_eq!(body.trim(), "Body");
        }
    }

    #[test]
    fn update_frontmatter_timestamp_uses_local_offset_and_preserves_created() {
        let created = "2025-10-02T12:47:53.112472251+00:00";
        let existing = json!({"created": created, "custom": "retained"});
        let update = UpdateNoteRequest {
            content: None,
            content_patch: Some(vec![ContentPatchOperation::Append {
                text: "\nAdded".to_string(),
            }]),
            tags: None,
            metadata: Some(json!({"updated": "caller cannot override"})),
            expected_revision: None,
        };

        for now in timestamp_fixtures() {
            let content = update
                .rebuild_markdown(&existing, "Body", &[], now)
                .unwrap();
            let (frontmatter, body) = parse_frontmatter(&content);
            assert_eq!(
                frontmatter["updated"],
                now.with_timezone(&Local)
                    .format("%Y-%m-%dT%H:%M:%S%:z")
                    .to_string()
            );
            assert_eq!(frontmatter["created"], created);
            assert_eq!(frontmatter["custom"], "retained");
            assert_eq!(body.trim(), "Body\nAdded");
        }
    }

    #[test]
    fn slug_template_keeps_existing_lowercase_hyphenated_paths() {
        let settings = NewNotePathSettings {
            base_path: "00New".to_string(),
            path_template: "{base}/{date}-{slug}.md".to_string(),
            date_format: "%Y-%m-%d".to_string(),
            max_title_slug_length: 60,
            max_title_length: 200,
        };

        let path = request("Conversational Practical Essay Style Guide")
            .validate_write_with_settings_at(fixed_now(), &settings)
            .expect("valid slug path");

        assert_eq!(
            path,
            "00New/2026-02-26-conversational-practical-essay-style-guide.md"
        );
    }

    #[test]
    fn title_template_preserves_spaces_and_case() {
        let settings = NewNotePathSettings {
            base_path: "00New".to_string(),
            path_template: "{base}/{title}.md".to_string(),
            date_format: "%Y-%m-%d".to_string(),
            max_title_slug_length: 60,
            max_title_length: 200,
        };

        let path = request("Conversational Practical Essay Style Guide")
            .validate_write_with_settings_at(fixed_now(), &settings)
            .expect("valid display title path");

        assert_eq!(path, "00New/Conversational Practical Essay Style Guide.md");
    }

    #[test]
    fn title_template_replaces_path_unsafe_characters() {
        let settings = NewNotePathSettings {
            base_path: "00New".to_string(),
            path_template: "{base}/{title}.md".to_string(),
            date_format: "%Y-%m-%d".to_string(),
            max_title_slug_length: 60,
            max_title_length: 200,
        };

        let path = request(r#"C# Notes: "Agent"/Draft? <v1>"#)
            .validate_write_with_settings_at(fixed_now(), &settings)
            .expect("unsafe title characters should be sanitized");

        assert_eq!(path, "00New/C Notes Agent Draft v1.md");
    }

    #[test]
    fn base_file_type_replaces_configured_markdown_extension() {
        let settings = NewNotePathSettings {
            base_path: "00New".to_string(),
            path_template: "{base}/{title}.md".to_string(),
            date_format: "%Y-%m-%d".to_string(),
            max_title_slug_length: 60,
            max_title_length: 200,
        };

        let mut request = request("Project Dashboard");
        request.file_type = NewNoteFileType::Base;
        let path = request
            .validate_write_with_settings_at(fixed_now(), &settings)
            .expect("valid base path");

        assert_eq!(path, "00New/Project Dashboard.base");
    }

    const LONG_TITLE: &str =
        "Weekly review of reading notes - what I learned about distributed systems";

    fn title_settings(max_title_length: usize) -> NewNotePathSettings {
        NewNotePathSettings {
            base_path: "00New".to_string(),
            path_template: "{base}/{title}.md".to_string(),
            date_format: "%Y-%m-%d".to_string(),
            max_title_slug_length: 60,
            max_title_length,
        }
    }

    fn slug_settings(max_title_slug_length: usize, max_title_length: usize) -> NewNotePathSettings {
        NewNotePathSettings {
            path_template: "{base}/{date}-{slug}.md".to_string(),
            max_title_slug_length,
            ..title_settings(max_title_length)
        }
    }

    #[test]
    fn title_template_keeps_long_titles_whole_under_default_limit() {
        let generated = request(LONG_TITLE)
            .generate_path_details_with_settings_at(fixed_now(), &title_settings(200));

        assert_eq!(
            generated.path,
            "00New/Weekly review of reading notes - what I learned about distributed systems.md"
        );
        assert!(!generated.title_truncated);
    }

    #[test]
    fn title_template_cuts_at_word_boundary_and_reports_truncation() {
        let generated = request(LONG_TITLE)
            .generate_path_details_with_settings_at(fixed_now(), &title_settings(60));

        assert_eq!(
            generated.path,
            "00New/Weekly review of reading notes - what I learned about.md"
        );
        assert!(generated.title_truncated);
        assert!(request(LONG_TITLE).title_truncated_with_settings(&title_settings(60)));
    }

    #[test]
    fn title_cut_trims_trailing_separators() {
        let generated = request(LONG_TITLE)
            .generate_path_details_with_settings_at(fixed_now(), &title_settings(33));

        assert_eq!(generated.path, "00New/Weekly review of reading notes.md");
        assert!(generated.title_truncated);
    }

    #[test]
    fn title_cut_falls_back_to_char_boundary_for_overlong_words() {
        let generated = request("Supercalifragilisticexpialidocious")
            .generate_path_details_with_settings_at(fixed_now(), &title_settings(10));
        assert_eq!(generated.path, "00New/Supercalif.md");
        assert!(generated.title_truncated);

        let generated = request("A Supercalifragilisticexpialidocious")
            .generate_path_details_with_settings_at(fixed_now(), &title_settings(20));
        assert_eq!(generated.path, "00New/A Supercalifragilist.md");
        assert!(generated.title_truncated);
    }

    #[test]
    fn title_cut_never_splits_multibyte_characters() {
        let title = "é".repeat(150);
        let generated = request(&title)
            .generate_path_details_with_settings_at(fixed_now(), &title_settings(201));

        assert_eq!(generated.path, format!("00New/{}.md", "é".repeat(100)));
        assert!(generated.title_truncated);
    }

    #[test]
    fn slug_cut_ends_on_hyphen_boundary_and_reports_truncation() {
        let generated = request(
            "Weekly review of reading notes about distributed systems and consensus protocols",
        )
        .generate_path_details_with_settings_at(fixed_now(), &slug_settings(58, 200));

        assert_eq!(
            generated.path,
            "00New/2026-02-26-weekly-review-of-reading-notes-about-distributed-systems.md"
        );
        assert!(generated.title_truncated);
    }

    #[test]
    fn truncation_flag_only_counts_placeholders_the_template_uses() {
        // {title} would be cut at 10 bytes, but the slug template does not use it.
        let generated = request(LONG_TITLE)
            .generate_path_details_with_settings_at(fixed_now(), &slug_settings(200, 10));
        assert!(!generated.title_truncated);

        // Sanitization alone is not truncation.
        let generated = request(r#"C# Notes: "Agent"/Draft? <v1>"#)
            .generate_path_details_with_settings_at(fixed_now(), &title_settings(200));
        assert_eq!(generated.path, "00New/C Notes Agent Draft v1.md");
        assert!(!generated.title_truncated);
    }

    #[test]
    fn created_file_title_strips_folder_and_extension() {
        assert_eq!(
            created_file_title("00New/A b.md", NewNoteFileType::Md),
            "A b"
        );
        assert_eq!(
            created_file_title("11New/x.base", NewNoteFileType::Base),
            "x"
        );
    }

    #[test]
    fn mutation_requests_reject_unknown_fields() {
        assert!(
            serde_json::from_value::<NewNoteRequest>(serde_json::json!({
                "title": "Test",
                "content": "Body",
                "unexpected": true
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<UpdateNoteRequest>(serde_json::json!({
                "expected_revision": "v1:sha256:test",
                "expected_sha256": "legacy"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ContentPatchOperation>(serde_json::json!({
                "op": "append",
                "text": "Body",
                "unexpected": true
            }))
            .is_err()
        );
    }

    #[test]
    fn new_note_validation_rejects_template_path_traversal() {
        let settings = NewNotePathSettings {
            base_path: "00New".to_string(),
            path_template: "{base}/../{title}.md".to_string(),
            date_format: "%Y-%m-%d".to_string(),
            max_title_slug_length: 60,
            max_title_length: 200,
        };

        let error = request("Escaping Note")
            .validate_write_with_settings_at(fixed_now(), &settings)
            .expect_err("template traversal should be rejected");

        assert!(matches!(error, WriteError::PathNotAllowed { .. }));
    }
}
