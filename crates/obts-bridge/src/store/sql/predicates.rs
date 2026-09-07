use super::*;
use crate::authorization::{AccessMatcher, normalize_tag};
use sqlx::{Postgres, QueryBuilder};

fn path_match(q: &mut QueryBuilder<'_, Postgres>, prefix: &str) {
    let prefix = prefix.trim().trim_start_matches('/');
    if prefix.is_empty() {
        q.push("TRUE");
        return;
    }
    q.push("(ltrim(n.path,'/')=").push_bind(prefix.to_string());
    q.push(" OR starts_with(ltrim(n.path,'/'),")
        .push_bind(if prefix.ends_with('/') {
            prefix.to_string()
        } else {
            format!("{prefix}/")
        })
        .push("))");
}
fn matcher(
    q: &mut QueryBuilder<'_, Postgres>,
    m: &AccessMatcher,
    auth: &AuthContext,
    now: DateTime<Utc>,
) {
    if m.default.unwrap_or(false) {
        q.push("TRUE");
        return;
    }
    q.push("(TRUE");
    if let Some(prefix) = &m.path_prefix {
        q.push(" AND ");
        path_match(q, prefix);
    }
    if !m.path_prefixes.is_empty() {
        q.push(" AND (FALSE");
        for prefix in &m.path_prefixes {
            q.push(" OR ");
            path_match(q, prefix);
        }
        q.push(")");
    }
    for tag in &m.tags_all {
        q.push(" AND EXISTS(SELECT 1 FROM tags t WHERE t.note_id=n.id AND t.policy_tag=")
            .push_bind(normalize_tag(tag).to_ascii_lowercase())
            .push(")");
    }
    for (tags, negate) in [(&m.tags_any, false), (&m.tags_none, true)] {
        if !tags.is_empty() {
            q.push(if negate {
                " AND NOT EXISTS("
            } else {
                " AND EXISTS("
            });
            q.push("SELECT 1 FROM tags t WHERE t.note_id=n.id AND t.policy_tag=ANY(")
                .push_bind(
                    tags.iter()
                        .map(|t| normalize_tag(t).to_ascii_lowercase())
                        .collect::<Vec<_>>(),
                )
                .push("))");
        }
    }
    for (column, op, value) in [
        ("created_at", ">=", m.created_after),
        ("created_at", "<=", m.created_before),
        ("updated_at", ">=", m.updated_after),
        ("updated_at", "<=", m.updated_before),
    ] {
        if let Some(value) = value {
            q.push(format!(" AND n.{column}{op}")).push_bind(value);
        }
    }
    for (column, seconds) in [
        ("created_at", m.created_within_seconds),
        ("updated_at", m.updated_within_seconds),
    ] {
        if let Some(seconds) = seconds {
            q.push(format!(" AND n.{column}>="))
                .push_bind(now - Duration::seconds(seconds.max(0)));
        }
    }
    if let Some(owner) = m.owner {
        q.push(if owner {
            " AND (n.policy_owner IS NOT DISTINCT FROM "
        } else {
            " AND (n.policy_owner IS DISTINCT FROM "
        })
        .push_bind(auth.principal.clone())
        .push(")");
    }
    q.push(")");
}

pub(super) fn policy(
    q: &mut QueryBuilder<'_, Postgres>,
    config: &AuthorizationConfig,
    auth: &AuthContext,
    now: DateTime<Utc>,
) -> bool {
    let Some(policy) = config.get(auth.context.as_str()) else {
        q.push("FALSE");
        return false;
    };
    let fallback = policy
        .read
        .iter()
        .any(|r| r.matcher().is_some_and(|m| m.title_regex.is_some()));
    q.push("((FALSE");
    for r in &policy.read {
        if r.is_allow() {
            if let Some(m) = r.matcher() {
                q.push(" OR ");
                matcher(q, m, auth, now);
            }
        }
    }
    q.push(")");
    for r in &policy.read {
        if r.is_deny() {
            if let Some(m) = r.matcher() {
                if m.title_regex.is_none() {
                    q.push(" AND NOT COALESCE(");
                    matcher(q, m, auth, now);
                    q.push(",FALSE)");
                }
            }
        }
    }
    q.push(")");
    fallback
}

pub(super) fn filters(q: &mut QueryBuilder<'_, Postgres>, r: &QueryNotesRequest) {
    if let Some(since) = r.time_filter.updated_strictly_after {
        q.push(" AND n.updated_at>").push_bind(since);
    }
    for (column, op, value) in [
        ("created_at", ">=", r.time_filter.created_after),
        ("created_at", "<=", r.time_filter.created_before),
        ("updated_at", ">=", r.time_filter.updated_after),
        ("updated_at", "<=", r.time_filter.updated_before),
    ] {
        if let Some(value) = value {
            q.push(format!(" AND n.{column}{op}")).push_bind(value);
        }
    }
    for tag in &r.tags_all {
        q.push(" AND EXISTS(SELECT 1 FROM tags t WHERE t.note_id=n.id AND t.tag=")
            .push_bind(tag.clone())
            .push(")");
    }
    for (tags, negate) in [(&r.tags_any, false), (&r.tags_none, true)] {
        if !tags.is_empty() {
            q.push(if negate {
                " AND NOT EXISTS("
            } else {
                " AND EXISTS("
            })
            .push("SELECT 1 FROM tags t WHERE t.note_id=n.id AND t.tag=ANY(")
            .push_bind(tags.clone())
            .push("))");
        }
    }
    for (keys, negate) in [(&r.has_frontmatter, false), (&r.missing_frontmatter, true)] {
        for key in keys {
            q.push(if negate {
                " AND NOT (jsonb_typeof(n.frontmatter)='object' AND n.frontmatter ? "
            } else {
                " AND (jsonb_typeof(n.frontmatter)='object' AND n.frontmatter ? "
            })
            .push_bind(key.clone())
            .push(")");
        }
    }
    if let Some(prefix) = &r.path_prefix {
        q.push(" AND starts_with(n.path,")
            .push_bind(prefix.clone())
            .push(")");
    }
    if let Some(title) = &r.title_exact {
        q.push(" AND n.policy_title_ascii=")
            .push_bind(title.trim().to_ascii_lowercase());
        if title.trim().is_empty() {
            q.push(" AND FALSE");
        }
    }
}

impl VaultStore {
    pub(super) async fn sql_scope(
        &self,
        auth: &AuthContext,
        tx: &mut sqlx::Transaction<'_, Postgres>,
        filter: Option<&QueryNotesRequest>,
    ) -> Result<(), ServiceError> {
        let config = self.authorization_config().await;
        let now = Utc::now();
        let mut q = QueryBuilder::new(
            "CREATE TEMP TABLE bridge_scope ON COMMIT DROP AS SELECT n.id FROM notes n WHERE ",
        );
        let fallback = policy(&mut q, &config, auth, now);
        if let Some(filter) = filter {
            filters(&mut q, filter);
        }
        q.build().execute(&mut **tx).await.map_err(unavailable)?;
        sqlx::query("CREATE UNIQUE INDEX ON bridge_scope(id)")
            .execute(&mut **tx)
            .await
            .map_err(unavailable)?;
        if fallback {
            let mut after = String::new();
            loop {
                let rows = sqlx::query(&format!("{} WHERE n.id IN(SELECT id FROM bridge_scope) AND n.id COLLATE \"C\">$1 ORDER BY n.id COLLATE \"C\" LIMIT $2", policy_metadata()))
                    .bind(&after).bind(PAGE).fetch_all(&mut **tx).await.map_err(unavailable)?;
                if rows.is_empty() {
                    break;
                }
                for row in rows {
                    let note = metadata(&row).map_err(unavailable)?;
                    after = note.id.to_string();
                    if !policy_allows(&config, auth, "read", &policy_note_from_stored(&note), now) {
                        sqlx::query("DELETE FROM bridge_scope WHERE id=$1")
                            .bind(note.id.as_str())
                            .execute(&mut **tx)
                            .await
                            .map_err(unavailable)?;
                    }
                }
            }
        }
        Ok(())
    }
}
