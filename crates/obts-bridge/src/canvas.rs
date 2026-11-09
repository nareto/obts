//! JSON Canvas (`.canvas`) files: structural validation and the policy
//! metadata (tags and owner) stored at `metadata.frontmatter`.
//!
//! Validation matches the server's canvas merge validator so a canvas written
//! through the bridge can later be merged with device edits. Unknown keys are
//! allowed anywhere, as in the JSON Canvas format.

use std::collections::HashSet;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::authorization::{add_unique_tag, owner_from_frontmatter, set_owner_metadata};
use crate::markdown::extract_frontmatter_tags;

const METADATA_KEY: &str = "metadata";
const FRONTMATTER_KEY: &str = "frontmatter";

/// Tags and owner a canvas carries for authorization.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CanvasPolicyMetadata {
    pub tags: Vec<String>,
    pub owner: Option<String>,
}

/// Parses and validates canvas content, returning the parsed document.
pub fn parse_valid_canvas(content: &str) -> Result<Value, String> {
    let document: Value = serde_json::from_str(content)
        .map_err(|error| format!("canvas content is not valid JSON: {error}"))?;
    let Some(object) = document.as_object() else {
        return Err("canvas content must be a JSON object".to_string());
    };
    let (Some(nodes), Some(edges)) = (
        object.get("nodes").and_then(Value::as_array),
        object.get("edges").and_then(Value::as_array),
    ) else {
        return Err("canvas content must contain nodes and edges arrays".to_string());
    };

    let mut node_ids = HashSet::new();
    for node in nodes {
        let Some(node) = node.as_object() else {
            return Err("canvas nodes must be objects".to_string());
        };
        let (Some(id), Some(_)) = (
            node.get("id").and_then(Value::as_str),
            node.get("type").and_then(Value::as_str),
        ) else {
            return Err("canvas nodes must contain string id and type fields".to_string());
        };
        for field in ["x", "y", "width", "height"] {
            if !node.get(field).is_some_and(Value::is_number) {
                return Err(format!("canvas nodes must contain numeric {field} fields"));
            }
        }
        if !node_ids.insert(id) {
            return Err(format!("canvas node id '{id}' is not unique"));
        }
    }

    let mut edge_ids = HashSet::new();
    for edge in edges {
        let Some(edge) = edge.as_object() else {
            return Err("canvas edges must be objects".to_string());
        };
        let Some(id) = edge.get("id").and_then(Value::as_str) else {
            return Err("canvas edges must contain a string id field".to_string());
        };
        if !edge_ids.insert(id) {
            return Err(format!("canvas edge id '{id}' is not unique"));
        }
        let endpoint = |field: &str| edge.get(field).and_then(Value::as_str);
        let (Some(from_node), Some(_), Some(to_node), Some(_)) = (
            endpoint("fromNode"),
            endpoint("fromSide"),
            endpoint("toNode"),
            endpoint("toSide"),
        ) else {
            return Err(format!(
                "canvas edge '{id}' must contain string fromNode, fromSide, toNode and toSide fields"
            ));
        };
        if !node_ids.contains(from_node) || !node_ids.contains(to_node) {
            return Err(format!("canvas edge '{id}' must reference existing nodes"));
        }
    }

    if let Some(metadata) = object.get(METADATA_KEY) {
        let Some(metadata) = metadata.as_object() else {
            return Err("canvas metadata must be an object".to_string());
        };
        if metadata
            .get(FRONTMATTER_KEY)
            .is_some_and(|frontmatter| !frontmatter.is_object())
        {
            return Err("canvas metadata.frontmatter must be an object".to_string());
        }
    }

    Ok(document)
}

/// Policy metadata of canvas content. Content that is not a valid canvas
/// carries no tags and no owner.
pub fn canvas_policy_metadata(content: &str) -> CanvasPolicyMetadata {
    parse_valid_canvas(content)
        .map(|document| policy_metadata_of(&document))
        .unwrap_or_default()
}

fn policy_metadata_of(document: &Value) -> CanvasPolicyMetadata {
    let Some(frontmatter) = document
        .get(METADATA_KEY)
        .and_then(|metadata| metadata.get(FRONTMATTER_KEY))
    else {
        return CanvasPolicyMetadata::default();
    };
    let mut tags = extract_frontmatter_tags(frontmatter);
    tags.sort();
    tags.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    CanvasPolicyMetadata {
        tags,
        owner: owner_from_frontmatter(frontmatter).map(str::to_string),
    }
}

/// Validates new canvas content and records creation metadata in
/// `metadata.frontmatter`: the creation timestamp, policy-added tags and the
/// owning principal. The document is re-serialized in Obsidian's canvas layout
/// with object keys sorted.
pub fn apply_canvas_create_metadata(
    content: &str,
    created: String,
    add_tags: &[String],
    owner_principal: Option<&str>,
) -> Result<String, String> {
    let mut document = parse_valid_canvas(content)?;
    let frontmatter = frontmatter_mut(&mut document);
    frontmatter
        .as_object_mut()
        .expect("canvas frontmatter is an object")
        .insert("created".to_string(), Value::String(created));
    if !add_tags.is_empty() {
        let mut tags = extract_frontmatter_tags(frontmatter);
        for tag in add_tags {
            add_unique_tag(&mut tags, tag);
        }
        tags.sort();
        tags.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        frontmatter
            .as_object_mut()
            .expect("canvas frontmatter is an object")
            .insert(
                "tags".to_string(),
                Value::Array(tags.into_iter().map(Value::String).collect()),
            );
    }
    if let Some(principal) = owner_principal {
        set_owner_metadata(frontmatter, principal);
    }
    Ok(serialize_canvas(&document))
}

fn frontmatter_mut(document: &mut Value) -> &mut Value {
    let metadata = document
        .as_object_mut()
        .expect("validated canvas is an object")
        .entry(METADATA_KEY)
        .or_insert_with(|| Value::Object(Map::new()));
    metadata
        .as_object_mut()
        .expect("validated canvas metadata is an object")
        .entry(FRONTMATTER_KEY)
        .or_insert_with(|| Value::Object(Map::new()))
}

/// Checks a raw canvas edit against the edited file's policy metadata: the
/// owner must stay unchanged and every protected tag the file carries must
/// remain. Edits are stored verbatim, so these are rejected rather than
/// silently restored.
pub fn validate_canvas_edit(
    content: &str,
    existing: &CanvasPolicyMetadata,
    preserve_tags: &[String],
) -> Result<(), String> {
    let candidate = policy_metadata_of(&parse_valid_canvas(content)?);
    if candidate.owner != existing.owner {
        return Err(match &existing.owner {
            Some(owner) => {
                format!("canvas edits must keep metadata.frontmatter.created_by set to '{owner}'")
            }
            None => "canvas edits cannot set metadata.frontmatter.created_by".to_string(),
        });
    }
    let has_tag = |tags: &[String], tag: &str| {
        let tag = crate::authorization::normalize_tag(tag);
        tags.iter().any(|candidate| {
            crate::authorization::normalize_tag(candidate).eq_ignore_ascii_case(&tag)
        })
    };
    for tag in preserve_tags {
        if has_tag(&existing.tags, tag) && !has_tag(&candidate.tags, tag) {
            return Err(format!(
                "canvas edits must keep tag '{tag}' in metadata.frontmatter.tags"
            ));
        }
    }
    Ok(())
}

/// Obsidian's canvas layout: tab-indented objects, arrays of objects with one
/// compact element per line, other arrays and scalars inline, no trailing
/// newline.
fn serialize_canvas(document: &Value) -> String {
    let mut out = String::new();
    write_canvas_value(&mut out, document, 0);
    out
}

fn write_canvas_value(out: &mut String, value: &Value, depth: usize) {
    let newline = |out: &mut String, depth: usize| {
        out.push('\n');
        out.extend(std::iter::repeat_n('\t', depth));
    };
    match value {
        Value::Object(map) if !map.is_empty() => {
            out.push('{');
            for (index, (key, value)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                out.push_str(&compact_json(&Value::String(key.clone())));
                out.push(':');
                write_canvas_value(out, value, depth + 1);
            }
            newline(out, depth);
            out.push('}');
        }
        Value::Array(items) if items.iter().any(|item| item.is_object() || item.is_array()) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                out.push_str(&compact_json(item));
            }
            newline(out, depth);
            out.push(']');
        }
        other => out.push_str(&compact_json(other)),
    }
}

fn compact_json(value: &Value) -> String {
    let mut bytes = Vec::new();
    value
        .serialize(&mut serde_json::Serializer::new(&mut bytes))
        .expect("JSON values serialize");
    String::from_utf8(bytes).expect("serde_json writes UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn canvas(extra: Value) -> String {
        let mut document = json!({
            "nodes": [
                {"id": "a1", "type": "text", "text": "A", "x": 0, "y": 0, "width": 200, "height": 60},
                {"id": "b2", "type": "text", "text": "B", "x": 300, "y": 0, "width": 200, "height": 60}
            ],
            "edges": [
                {"id": "e1", "fromNode": "a1", "fromSide": "right", "toNode": "b2", "toSide": "left"}
            ]
        });
        if let (Some(target), Some(extra)) = (document.as_object_mut(), extra.as_object()) {
            target.extend(extra.clone());
        }
        document.to_string()
    }

    #[test]
    fn accepts_canvas_with_unknown_keys() {
        assert!(parse_valid_canvas(&canvas(json!({"x_unknown": {"kept": true}}))).is_ok());
        assert!(parse_valid_canvas(r#"{"nodes":[],"edges":[]}"#).is_ok());
    }

    #[test]
    fn rejects_structurally_invalid_canvas() {
        for (content, expected) in [
            ("not json", "not valid JSON"),
            ("[]", "JSON object"),
            (r#"{"nodes":[]}"#, "nodes and edges arrays"),
            (
                r#"{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1}],"edges":[]}"#,
                "numeric height",
            ),
            (
                r#"{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1},{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1}],"edges":[]}"#,
                "not unique",
            ),
            (
                r#"{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1}],"edges":[{"id":"e","fromNode":"a","toNode":"a"}]}"#,
                "fromSide",
            ),
            (
                r#"{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1}],"edges":[{"id":"e","fromNode":"a","fromSide":"top","toNode":"z","toSide":"top"}]}"#,
                "existing nodes",
            ),
            (
                r#"{"nodes":[],"edges":[],"metadata":{"frontmatter":[]}}"#,
                "frontmatter must be an object",
            ),
        ] {
            let error = parse_valid_canvas(content).expect_err(content);
            assert!(error.contains(expected), "{content}: {error}");
        }
    }

    #[test]
    fn create_metadata_records_tags_owner_and_keeps_canvas_content() {
        let content = canvas(json!({
            "metadata": {"version": "1.0-1.0", "frontmatter": {"tags": ["map"]}},
            "x_unknown": 1
        }));
        let created = apply_canvas_create_metadata(
            &content,
            "2026-01-02T03:04:05+00:00".to_string(),
            &["ai-created".to_string()],
            Some("mcp_token:example_agent"),
        )
        .expect("valid canvas");

        assert!(created.contains("\n\t\"nodes\":[\n\t\t{\"height\":60,\"id\":\"a1\""));
        assert!(created.contains("\"tags\":[\"ai-created\",\"map\"]"));
        assert!(created.ends_with("\n}"));
        let document: Value = serde_json::from_str(&created).unwrap();
        assert_eq!(document["x_unknown"], json!(1));
        assert_eq!(document["metadata"]["version"], json!("1.0-1.0"));
        assert_eq!(document["edges"][0]["toSide"], json!("left"));
        assert_eq!(
            document["metadata"]["frontmatter"]["created"],
            json!("2026-01-02T03:04:05+00:00")
        );
        assert_eq!(
            canvas_policy_metadata(&created),
            CanvasPolicyMetadata {
                tags: vec!["ai-created".to_string(), "map".to_string()],
                owner: Some("mcp_token:example_agent".to_string()),
            }
        );
    }

    #[test]
    fn policy_metadata_of_invalid_or_unannotated_canvas_is_empty() {
        assert_eq!(canvas_policy_metadata("{"), CanvasPolicyMetadata::default());
        assert_eq!(
            canvas_policy_metadata(&canvas(json!({}))),
            CanvasPolicyMetadata::default()
        );
    }

    #[test]
    fn edit_must_keep_owner_and_protected_tags() {
        let existing = CanvasPolicyMetadata {
            tags: vec!["ai-created".to_string(), "map".to_string()],
            owner: Some("mcp_token:example_agent".to_string()),
        };
        let preserve = ["ai-created".to_string()];
        let edited = |frontmatter: Value| canvas(json!({"metadata": {"frontmatter": frontmatter}}));

        validate_canvas_edit(
            &edited(json!({"tags": ["#ai-created"], "created_by": "mcp_token:example_agent"})),
            &existing,
            &preserve,
        )
        .expect("dropping an unprotected tag is allowed");

        let error = validate_canvas_edit(
            &edited(json!({"tags": ["map"], "created_by": "mcp_token:example_agent"})),
            &existing,
            &preserve,
        )
        .unwrap_err();
        assert!(error.contains("keep tag 'ai-created'"), "{error}");

        let error = validate_canvas_edit(
            &edited(json!({"tags": ["ai-created"], "created_by": "mcp_token:other"})),
            &existing,
            &preserve,
        )
        .unwrap_err();
        assert!(error.contains("created_by"), "{error}");

        let error = validate_canvas_edit(
            &edited(json!({"created_by": "mcp_token:example_agent"})),
            &CanvasPolicyMetadata::default(),
            &preserve,
        )
        .unwrap_err();
        assert!(error.contains("cannot set"), "{error}");
    }
}
