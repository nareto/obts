pub(crate) mod embedding;
mod predicates;
pub(super) mod projection;
use super::*;
use crate::filesystem::FilesystemFile;
use crate::service::ServiceError;
use sqlx::{Row, postgres::PgRow};

const PAGE: i64 = 128;

fn unavailable(_: impl std::fmt::Display) -> ServiceError {
    ServiceError::IndexCatchingUp
}

fn metadata(row: &PgRow) -> Result<StoredNote, sqlx::Error> {
    Ok(StoredNote {
        id: NoteId::new(row.try_get::<String, _>("id")?),
        path: row.try_get("path")?,
        title: row.try_get("title")?,
        heading_title: row.try_get("heading_title")?,
        content: String::new(),
        search_text: String::new(),
        summary: row.try_get("summary")?,
        frontmatter: row.try_get("frontmatter")?,
        tags: row.try_get("tags")?,
        couchdb_rev: row.try_get("couchdb_rev")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        indexed_at: row.try_get("indexed_at")?,
        embedding: row
            .try_get::<Option<pgvector::Vector>, _>("embedding")?
            .map(|v| v.to_vec()),
    })
}

const METADATA: &str = "SELECT n.id, n.path, n.title, n.heading_title, n.summary, n.frontmatter,
 n.couchdb_rev, n.created_at, n.updated_at, n.indexed_at, n.embedding,
 ARRAY(SELECT tag FROM tags WHERE note_id=n.id ORDER BY tag) AS tags FROM notes n";

fn compact_metadata() -> String {
    METADATA.replace(
        "n.frontmatter",
        "jsonb_build_object('created_by',n.policy_owner) AS frontmatter",
    )
}

fn policy_metadata() -> String {
    compact_metadata()
        .replace("n.summary", "''::text AS summary")
        .replace("n.heading_title", "NULL::text AS heading_title")
        .replace("n.embedding", "NULL::vector AS embedding")
}

impl VaultStore {
    fn db(&self) -> &PostgresPersistence {
        self.persistence.as_ref().expect("SQL backend")
    }

    pub(crate) async fn sql_metadata(
        &self,
        id: &NoteId,
    ) -> Result<Option<StoredNote>, ServiceError> {
        let row = sqlx::query(&format!("{METADATA} WHERE n.id=$1"))
            .bind(id.as_str())
            .fetch_optional(&self.db().pool)
            .await
            .map_err(unavailable)?;
        row.as_ref().map(metadata).transpose().map_err(unavailable)
    }

    #[cfg(test)]
    async fn metadata_page(&self, after: &str) -> Result<Vec<StoredNote>, ServiceError> {
        sqlx::query(&format!(
            "{} WHERE n.id COLLATE \"C\">$1 ORDER BY n.id COLLATE \"C\" LIMIT $2",
            policy_metadata()
        ))
        .bind(after)
        .bind(PAGE)
        .fetch_all(&self.db().pool)
        .await
        .map_err(unavailable)?
        .iter()
        .map(metadata)
        .collect::<Result<_, _>>()
        .map_err(unavailable)
    }

    pub(crate) async fn sql_authorized(
        &self,
        auth: &AuthContext,
        id: &NoteId,
    ) -> Result<StoredNote, ServiceError> {
        let mut connection = self.db().pool.acquire().await.map_err(unavailable)?;
        self.sql_authorized_on(&mut connection, auth, id).await
    }

    async fn sql_authorized_on(
        &self,
        connection: &mut sqlx::PgConnection,
        auth: &AuthContext,
        id: &NoteId,
    ) -> Result<StoredNote, ServiceError> {
        let row = sqlx::query(&format!("{} WHERE n.id=$1", policy_metadata()))
            .bind(id.as_str())
            .fetch_optional(&mut *connection)
            .await
            .map_err(unavailable)?
            .ok_or(ServiceError::NotFound)?;
        let note = metadata(&row).map_err(unavailable)?;
        let config = self.authorization_config().await;
        if !policy_allows(
            &config,
            auth,
            "read",
            &policy_note_from_stored(&note),
            Utc::now(),
        ) {
            return Err(ServiceError::NotFound);
        }
        Ok(note)
    }

    pub(crate) async fn sql_body(
        &self,
        path: &str,
        revision: &str,
    ) -> Result<FilesystemFile, ServiceError> {
        self.source
            .as_ref()
            .expect("SQL filesystem")
            .read_attested(path, revision)
            .await
            .map_err(unavailable)
    }

    pub(crate) async fn sql_get_note(
        &self,
        auth: &AuthContext,
        id: &NoteId,
    ) -> Result<Note, ServiceError> {
        self.sql_authorized(auth, id).await?;
        let note = self.sql_metadata(id).await?.ok_or(ServiceError::NotFound)?;
        let links = self
            .sql_adjacent(auth, id, NeighborDirection::Outgoing)
            .await?;
        let backlinks = self
            .sql_adjacent(auth, id, NeighborDirection::Incoming)
            .await?;
        let file = self.sql_body(&note.path, &note.couchdb_rev).await?;
        let (_, content) = parse_frontmatter(&file.content);
        Ok(Note {
            _body_lease: file.lease.clone(),
            id: note.id,
            path: note.path,
            title: note.title,
            heading_title: note.heading_title,
            content,
            summary: note.summary,
            frontmatter: note.frontmatter,
            links: links.into_iter().map(|(n, _)| n).collect(),
            backlinks: backlinks.into_iter().map(|(n, _)| n).collect(),
            tags: note.tags,
            updated_at: note.updated_at,
        })
    }

    pub(crate) async fn sql_get_title(
        &self,
        auth: &AuthContext,
        title: &str,
    ) -> Result<Note, ServiceError> {
        let response = self
            .sql_query_notes(
                auth,
                QueryNotesRequest {
                    title_exact: Some(title.trim().to_string()),
                    sort_by: Some(NoteSortField::UpdatedAt),
                    limit: Some(1),
                    ..Default::default()
                },
            )
            .await?;
        let note = response.notes.first().ok_or(ServiceError::NotFound)?;
        self.sql_get_note(auth, &note.id).await
    }

    pub(crate) async fn sql_get_file(
        &self,
        auth: &AuthContext,
        id: &NoteId,
    ) -> Result<VaultFile, ServiceError> {
        let row = sqlx::query(
            "SELECT couchdb_rev, created_at, updated_at FROM vault_files WHERE path=$1",
        )
        .bind(id.as_str())
        .fetch_optional(&self.db().pool)
        .await
        .map_err(unavailable)?
        .ok_or(ServiceError::NotFound)?;
        let revision: String = row.try_get("couchdb_rev").map_err(unavailable)?;
        let created_at = row.try_get("created_at").map_err(unavailable)?;
        let updated_at = row.try_get("updated_at").map_err(unavailable)?;
        if is_markdown_note_path(id.as_str()) {
            self.sql_authorized(auth, id).await?;
        } else {
            let policy = PolicyNote {
                path: id.to_string(),
                title: title_from_note_id(id.as_str()),
                tags: Vec::new(),
                created_at,
                updated_at,
                owner: None,
            };
            if !policy_allows(
                &self.authorization_config().await,
                auth,
                "read",
                &policy,
                Utc::now(),
            ) {
                return Err(ServiceError::NotFound);
            }
        }
        let file = self.sql_body(id.as_str(), &revision).await?;
        Ok(VaultFile {
            _body_lease: file.lease.clone(),
            id: id.clone(),
            path: file.path.clone(),
            file_type: if is_markdown_note_path(id.as_str()) {
                NewNoteFileType::Md
            } else {
                NewNoteFileType::Base
            },
            content_sha256: hex::encode(Sha256::digest(file.content.as_bytes())),
            size_bytes: file.content.len(),
            content: file.content.clone(),
            created_at,
            updated_at,
        })
    }

    pub(crate) async fn sql_revisions(
        &self,
    ) -> Result<HashMap<String, String>, crate::persistence::PersistenceError> {
        let mut result = HashMap::new();
        let mut after = String::new();
        loop {
            let rows = sqlx::query("SELECT path, CASE WHEN projection_complete AND (path NOT LIKE '%.md' OR (EXISTS (SELECT 1 FROM notes WHERE notes.id=vault_files.path AND notes.couchdb_rev=vault_files.couchdb_rev AND lexical_plaintext IS NOT NULL AND lexical_title IS NOT NULL) AND projected_row_count=3+(SELECT count(*) FROM tags WHERE note_id=vault_files.path)+(SELECT count(*) FROM links WHERE source_id=vault_files.path)+(SELECT count(*) FROM blocks WHERE note_id=vault_files.path))) THEN couchdb_rev ELSE '' END AS couchdb_rev FROM vault_files WHERE path>$1 ORDER BY path LIMIT $2")
                .bind(&after).bind(PAGE).fetch_all(&self.db().pool).await?;
            if rows.is_empty() {
                break;
            }
            for row in rows {
                let path: String = row.try_get("path")?;
                after = path.clone();
                result.insert(path, row.try_get("couchdb_rev")?);
            }
        }
        Ok(result)
    }

    async fn sql_adjacent(
        &self,
        auth: &AuthContext,
        id: &NoteId,
        direction: NeighborDirection,
    ) -> Result<Vec<(NoteId, String)>, ServiceError> {
        let mut tx = self.db().pool.begin().await.map_err(unavailable)?;
        self.sql_scope(auth, &mut tx, None).await?;
        let result = self.sql_adjacent_in_scope(&mut tx, id, direction).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    async fn sql_adjacent_in_scope(
        &self,
        connection: &mut sqlx::PgConnection,
        id: &NoteId,
        direction: NeighborDirection,
    ) -> Result<Vec<(NoteId, String)>, ServiceError> {
        let condition = match direction {
            NeighborDirection::Outgoing => "source_id=$1",
            NeighborDirection::Incoming => "target_id=$1",
            NeighborDirection::Both => "(source_id=$1 OR target_id=$1)",
        };
        let mut result = Vec::new();
        let mut offset = 0i64;
        loop {
            let rows: Vec<String> = sqlx::query_scalar(&format!("SELECT id FROM (SELECT CASE WHEN source_id=$1 THEN target_id ELSE source_id END AS id,position FROM links WHERE {condition} AND CASE WHEN source_id=$1 THEN target_id ELSE source_id END IN(SELECT id FROM bridge_scope)) adjacent ORDER BY position,id COLLATE \"C\" LIMIT $2 OFFSET $3"))
                .bind(id.as_str()).bind(PAGE).bind(offset).fetch_all(&mut *connection).await.map_err(unavailable)?;
            if rows.is_empty() {
                break;
            }
            offset += rows.len() as i64;
            result.extend(rows.into_iter().map(|id| (NoteId::new(id), String::new())));
        }
        Ok(result)
    }

    async fn sql_adjacent_count(
        &self,
        auth: &AuthContext,
        id: &NoteId,
        outgoing: bool,
    ) -> Result<usize, ServiceError> {
        let mut tx = self.db().pool.begin().await.map_err(unavailable)?;
        self.sql_scope(auth, &mut tx, None).await?;
        let (owner, target) = if outgoing {
            ("source_id", "target_id")
        } else {
            ("target_id", "source_id")
        };
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM links WHERE {owner}=$1 AND {target} IN(SELECT id FROM bridge_scope)"))
            .bind(id.as_str()).fetch_one(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(count as usize)
    }

    async fn sql_summary(
        &self,
        auth: &AuthContext,
        note: StoredNote,
    ) -> Result<RecentNoteSummary, ServiceError> {
        let link_count = self.sql_adjacent_count(auth, &note.id, true).await?;
        let backlink_count = self.sql_adjacent_count(auth, &note.id, false).await?;
        Ok(RecentNoteSummary {
            id: note.id,
            title: note.title,
            heading_title: note.heading_title,
            summary: note.summary,
            tags: note.tags,
            updated_at: note.updated_at,
            link_count,
            backlink_count,
            search_score: None,
            search_match_type: None,
            search_snippet: None,
            matched_chunk_id: None,
            matched_heading_path: None,
            matched_snippet: None,
        })
    }

    pub(crate) async fn sql_query_notes(
        &self,
        auth: &AuthContext,
        request: QueryNotesRequest,
    ) -> Result<RecentNotesResponse, ServiceError> {
        let limit = request.limit.unwrap_or(20).min(MAX_NOTE_LIST_LIMIT);
        if let Some(query) = request
            .text_query
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty())
        {
            let mode = request.search_mode.unwrap_or_default();
            let (ranked, total) = self.sql_rank(auth, query, mode, Some(&request)).await?;
            let mut notes = Vec::new();
            let mut body_lease = None;
            for (id, score, kind) in ranked.into_iter().take(limit) {
                self.sql_authorized(auth, &id).await?;
                let row = sqlx::query(&format!("{} WHERE n.id=$1", compact_metadata()))
                    .bind(id.as_str())
                    .fetch_one(&self.db().pool)
                    .await
                    .map_err(unavailable)?;
                let note = metadata(&row).map_err(unavailable)?;
                let file = self
                    .source
                    .as_ref()
                    .expect("source")
                    .read_attested_with_lease(&note.path, &note.couchdb_rev, body_lease.clone())
                    .await
                    .map_err(unavailable)?;
                body_lease = file.lease.clone();
                let (_, content) = parse_frontmatter(&file.content);
                let mut summary = self.sql_summary(auth, note).await?;
                summary.search_score = Some(score);
                summary.search_match_type = Some(kind);
                summary.search_snippet = Some(snippet_for(&content, query));
                if let Some(chunk) = self.sql_best_chunk(&id, &content, query, mode).await? {
                    summary.matched_chunk_id = Some(chunk.block_id);
                    summary.matched_heading_path =
                        (!chunk.heading_path.is_empty()).then_some(chunk.heading_path);
                    summary.matched_snippet = Some(chunk.snippet);
                }
                notes.push(summary);
            }
            let mut response = RecentNotesResponse::new(notes, total as usize, 0);
            response._body_lease = body_lease;
            return Ok(response);
        }
        let mut tx = self.db().pool.begin().await.map_err(unavailable)?;
        self.sql_scope(auth, &mut tx, Some(&request)).await?;
        let total: i64 = sqlx::query_scalar("SELECT count(*) FROM bridge_scope")
            .fetch_one(&mut *tx)
            .await
            .map_err(unavailable)?;
        let field = effective_query_sort_field(request.sort_by, false);
        let order = effective_sort_order(field, request.sort_order);
        let column = match field {
            NoteSortField::Title => "n.title COLLATE \"C\"",
            NoteSortField::CreatedAt => "n.created_at",
            _ => "n.updated_at",
        };
        let direction = if matches!(order, SortOrder::Desc) {
            "DESC"
        } else {
            "ASC"
        };
        let rows = sqlx::query(&format!("{} WHERE n.id IN(SELECT id FROM bridge_scope) ORDER BY {column} {direction} NULLS LAST,n.id COLLATE \"C\" LIMIT $1",compact_metadata()))
            .bind(limit as i64).fetch_all(&mut *tx).await.map_err(unavailable)?;
        let selected = rows
            .iter()
            .map(metadata)
            .collect::<Result<Vec<_>, _>>()
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        let mut notes = Vec::new();
        for note in selected {
            notes.push(self.sql_summary(auth, note).await?);
        }
        Ok(RecentNotesResponse::new(notes, total as usize, 0))
    }

    async fn sql_rank(
        &self,
        auth: &AuthContext,
        query: &str,
        mode: SearchMode,
        filter: Option<&QueryNotesRequest>,
    ) -> Result<(Vec<(NoteId, f32, MatchType)>, usize), ServiceError> {
        let embedding =
            if !matches!(mode, SearchMode::Fulltext) && self.semantic_embeddings_enabled().await {
                if let Some(dimensions) = self
                    .db()
                    .embedding_dimensions()
                    .await
                    .map_err(unavailable)?
                {
                    self.query_embedding_for_search(query, dimensions).await
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            };
        let mut tx = self.db().pool.begin().await.map_err(unavailable)?;
        sqlx::query("CREATE TEMP TABLE bridge_candidates (id TEXT PRIMARY KEY, lexical REAL, semantic REAL) ON COMMIT DROP").execute(&mut *tx).await.map_err(unavailable)?;
        self.sql_scope(auth, &mut tx, filter).await?;
        let lexical = if filter.is_some() {
            "(2*((length(n.lexical_title)-length(replace(n.lexical_title,$2,'')))/length($2))::real + ((length(n.lexical_plaintext)-length(replace(n.lexical_plaintext,$2,'')))/length($2))::real)"
        } else {
            "ts_rank_cd(n.search_vector,plainto_tsquery('simple',$2))"
        };
        let lexical_match = if filter.is_some() {
            "(strpos(n.lexical_title,$2)>0 OR strpos(n.lexical_plaintext,$2)>0)"
        } else {
            "n.search_vector @@ plainto_tsquery('simple',$2)"
        };
        let query_text = if filter.is_some() {
            query.to_lowercase()
        } else {
            query.to_string()
        };
        sqlx::query(&format!("INSERT INTO bridge_candidates SELECT n.id, CASE WHEN $3 AND {lexical_match} THEN {lexical} ELSE NULL END, CASE WHEN $4 THEN GREATEST((1-(n.embedding <=> $1))::real,(SELECT max((1-(b.embedding <=> $1))::real) FROM blocks b WHERE b.note_id=n.id AND b.embedding IS NOT NULL)) ELSE NULL END FROM notes n JOIN bridge_scope a ON a.id=n.id WHERE ($3 AND {lexical_match}) OR ($4 AND (n.embedding IS NOT NULL OR EXISTS(SELECT 1 FROM blocks b WHERE b.note_id=n.id AND b.embedding IS NOT NULL)))"))
            .bind((!embedding.is_empty()).then(|| pgvector::Vector::from(embedding.clone())))
            .bind(query_text).bind(!matches!(mode,SearchMode::Semantic)).bind(!matches!(mode,SearchMode::Fulltext) && !embedding.is_empty())
            .execute(&mut *tx).await.map_err(unavailable)?;
        let total: i64 = sqlx::query_scalar("SELECT count(*) FROM bridge_candidates")
            .fetch_one(&mut *tx)
            .await
            .map_err(unavailable)?;
        let score = match mode {
            SearchMode::Fulltext => "c.lexical",
            SearchMode::Semantic => "c.semantic",
            SearchMode::Hybrid => "(COALESCE(1.0/(60+l.rank),0)+COALESCE(1.0/(60+s.rank),0))::real",
        };
        let field = effective_query_sort_field(filter.and_then(|f| f.sort_by), true);
        let order = effective_sort_order(field, filter.and_then(|f| f.sort_order));
        let column = match field {
            NoteSortField::Title => "n.title COLLATE \"C\"",
            NoteSortField::CreatedAt => "n.created_at",
            NoteSortField::UpdatedAt => "n.updated_at",
            NoteSortField::Relevance => "score",
        };
        let direction = if matches!(order, SortOrder::Desc) {
            "DESC"
        } else {
            "ASC"
        };
        let id_direction =
            if matches!(field, NoteSortField::Relevance) && matches!(order, SortOrder::Asc) {
                "DESC"
            } else {
                "ASC"
            };
        let rows=sqlx::query(&format!("WITH l AS (SELECT id,row_number() OVER (ORDER BY lexical DESC,id COLLATE \"C\") AS rank FROM bridge_candidates WHERE lexical IS NOT NULL),
            s AS (SELECT id,row_number() OVER (ORDER BY semantic DESC,id COLLATE \"C\") AS rank FROM bridge_candidates WHERE semantic IS NOT NULL)
            SELECT c.id,{score} AS score,c.lexical IS NOT NULL AS lexical,c.semantic IS NOT NULL AS semantic FROM bridge_candidates c
            LEFT JOIN l ON l.id=c.id LEFT JOIN s ON s.id=c.id JOIN notes n ON n.id=c.id ORDER BY {column} {direction} NULLS LAST,c.id COLLATE \"C\" {id_direction} LIMIT $1"))
            .bind(MAX_NOTE_LIST_LIMIT as i64).fetch_all(&mut *tx).await.map_err(unavailable)?;
        let mut hits = Vec::new();
        for row in rows {
            let lexical: bool = row.try_get("lexical").map_err(unavailable)?;
            let semantic: bool = row.try_get("semantic").map_err(unavailable)?;
            hits.push((
                NoteId::new(row.try_get::<String, _>("id").map_err(unavailable)?),
                row.try_get("score").map_err(unavailable)?,
                match (lexical, semantic) {
                    (true, true) => MatchType::Both,
                    (false, true) => MatchType::Semantic,
                    _ => MatchType::Fulltext,
                },
            ));
        }
        tx.commit().await.map_err(unavailable)?;
        Ok((hits, total as usize))
    }

    async fn sql_best_chunk(
        &self,
        id: &NoteId,
        content: &str,
        query: &str,
        mode: SearchMode,
    ) -> Result<Option<ChunkMatchMetadata>, ServiceError> {
        if matches!(mode, SearchMode::Fulltext) || !self.semantic_embeddings_enabled().await {
            return Ok(None);
        }
        let Some(dimensions) = self
            .db()
            .embedding_dimensions()
            .await
            .map_err(unavailable)?
        else {
            return Ok(None);
        };
        let embedding = self.query_embedding_for_search(query, dimensions).await;
        let row=sqlx::query("SELECT id,block_index,heading_path,content_hash FROM blocks WHERE note_id=$1 AND embedding IS NOT NULL ORDER BY embedding <=> $2,id LIMIT 1")
            .bind(id.as_str()).bind(pgvector::Vector::from(embedding)).fetch_optional(&self.db().pool).await.map_err(unavailable)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let index: i32 = row.try_get("block_index").map_err(unavailable)?;
        let hash: String = row.try_get("content_hash").map_err(unavailable)?;
        let settings = self.settings.read().await.clone();
        let block = split_into_semantic_blocks(
            content,
            settings.block_min_chars,
            settings.block_chunk_bytes,
            settings.block_chunk_overlap_sentences,
        )
        .into_iter()
        .find(|b| b.block_index == index as usize)
        .ok_or(ServiceError::IndexCatchingUp)?;
        if hex::encode(Sha256::digest(block.content.as_bytes())) != hash {
            self.source.as_ref().expect("source").mark_dirty();
            return Err(ServiceError::IndexCatchingUp);
        }
        Ok(Some(ChunkMatchMetadata {
            block_id: row.try_get("id").map_err(unavailable)?,
            heading_path: row.try_get("heading_path").map_err(unavailable)?,
            snippet: snippet_for(&block.content, query),
        }))
    }

    pub(crate) async fn sql_search(
        &self,
        auth: &AuthContext,
        query: &str,
        mode: SearchMode,
        limit: usize,
    ) -> Result<SearchResponse, ServiceError> {
        let (ranked, _) = self.sql_rank(auth, query, mode, None).await?;
        let mut results = Vec::new();
        let mut body_lease = None;
        for (id, score, match_type) in ranked.into_iter().take(limit.min(MAX_NOTE_LIST_LIMIT)) {
            let note = self.sql_authorized(auth, &id).await?;
            let file = self
                .source
                .as_ref()
                .expect("source")
                .read_attested_with_lease(&note.path, &note.couchdb_rev, body_lease.clone())
                .await
                .map_err(unavailable)?;
            body_lease = file.lease.clone();
            let (_, content) = parse_frontmatter(&file.content);
            let chunk = self.sql_best_chunk(&id, &content, query, mode).await?;
            results.push(
                UnscopedSearchHit {
                    id,
                    title: note.title,
                    snippet: snippet_for(&content, query),
                    score,
                    match_type,
                    matched_chunk_id: chunk.as_ref().map(|c| c.block_id.clone()),
                    matched_heading_path: chunk
                        .as_ref()
                        .filter(|c| !c.heading_path.is_empty())
                        .map(|c| c.heading_path.clone()),
                    matched_snippet: chunk.map(|c| c.snippet),
                }
                .into_hit(),
            );
        }
        let mut response = SearchResponse::new(results, 0);
        response._body_lease = body_lease;
        Ok(response)
    }

    pub(crate) async fn sql_tags(
        &self,
        auth: &AuthContext,
        filter: NoteTimeFilter,
    ) -> Result<TagsResponse, ServiceError> {
        let mut tx = self.db().pool.begin().await.map_err(unavailable)?;
        self.sql_scope(
            auth,
            &mut tx,
            Some(&QueryNotesRequest {
                time_filter: filter,
                ..Default::default()
            }),
        )
        .await?;
        let rows=sqlx::query("SELECT t.tag,count(*) AS count FROM tags t JOIN bridge_scope s ON s.id=t.note_id GROUP BY t.tag ORDER BY count DESC,t.tag COLLATE \"C\"")
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        let tags = rows
            .iter()
            .map(|row| {
                Ok(TagCount {
                    tag: row.try_get("tag")?,
                    count: row.try_get::<i64, _>("count")? as usize,
                })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(TagsResponse { tags })
    }

    async fn sql_link_targets(&self, id: &NoteId) -> Result<Vec<String>, ServiceError> {
        let mut targets = Vec::new();
        let mut after = String::new();
        loop {
            let page:Vec<String>=sqlx::query_scalar("SELECT target_id FROM links WHERE source_id=$1 AND target_id>$2 ORDER BY target_id LIMIT $3")
                .bind(id.as_str()).bind(&after).bind(PAGE).fetch_all(&self.db().pool).await.map_err(unavailable)?;
            if page.is_empty() {
                break;
            }
            after = page.last().expect("page").clone();
            targets.extend(page);
        }
        Ok(targets)
    }

    async fn sql_link_context(
        &self,
        auth: &AuthContext,
        from: &NoteId,
        to: &NoteId,
    ) -> Result<String, ServiceError> {
        let source = self.sql_authorized(auth, from).await?;
        self.sql_authorized(auth, to).await?;
        let file = self.sql_body(&source.path, &source.couchdb_rev).await?;
        let max = self.settings.read().await.max_link_context_chars;
        Ok(parse_markdown(&file.content, max)
            .links
            .into_iter()
            .find(|link| link.target == to.as_str())
            .map(|link| link.context)
            .unwrap_or_default())
    }

    async fn sql_is_hub(&self, note: &StoredNote) -> Result<bool, ServiceError> {
        let mut connection = self.db().pool.acquire().await.map_err(unavailable)?;
        self.sql_is_hub_on(&mut connection, note).await
    }

    async fn sql_is_hub_on(
        &self,
        connection: &mut sqlx::PgConnection,
        note: &StoredNote,
    ) -> Result<bool, ServiceError> {
        let settings = self.settings.read().await.clone();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM links WHERE source_id=$1")
            .bind(note.id.as_str())
            .fetch_one(&mut *connection)
            .await
            .map_err(unavailable)?;
        Ok(count as usize > settings.hub_note_threshold
            || settings
                .hub_note_folders
                .iter()
                .any(|prefix| note.path.starts_with(prefix))
            || sqlx::query_scalar::<_, bool>("SELECT projection_hub FROM notes WHERE id=$1")
                .bind(note.id.as_str())
                .fetch_one(&mut *connection)
                .await
                .map_err(unavailable)?)
    }

    pub(crate) async fn sql_neighbors(
        &self,
        auth: &AuthContext,
        center: &NoteId,
        depth: usize,
        direction: NeighborDirection,
    ) -> Result<NeighborsResponse, ServiceError> {
        self.sql_authorized(auth, center).await?;
        let mut seen = HashSet::from([center.clone()]);
        let mut queue = VecDeque::from([(center.clone(), 0)]);
        let mut nodes = Vec::new();
        while let Some((id, distance)) = queue.pop_front() {
            if distance >= depth.clamp(1, MAX_GRAPH_TRAVERSAL_DEPTH) {
                continue;
            }
            let directions = match direction {
                NeighborDirection::Outgoing => vec![NeighborDirection::Outgoing],
                NeighborDirection::Incoming => vec![NeighborDirection::Incoming],
                NeighborDirection::Both => {
                    vec![NeighborDirection::Outgoing, NeighborDirection::Incoming]
                }
            };
            for traversal in directions {
                let mut adjacent = self.sql_adjacent(auth, &id, traversal).await?;
                adjacent.sort_by(|a, b| a.0.cmp(&b.0));
                for (next, _) in adjacent {
                    let note = self.sql_authorized(auth, &next).await?;
                    if seen.insert(note.id.clone()) {
                        let (from, to) = if matches!(traversal, NeighborDirection::Incoming) {
                            (&note.id, &id)
                        } else {
                            (&id, &note.id)
                        };
                        let context = self.sql_link_context(auth, from, to).await?;
                        let is_hub = self.sql_is_hub(&note).await?;
                        queue.push_back((note.id.clone(), distance + 1));
                        nodes.push(NeighborNode {
                            id: note.id,
                            title: note.title,
                            depth: distance + 1,
                            link_context: context,
                            is_hub,
                            direction: traversal,
                        });
                    }
                }
            }
        }
        nodes.sort_by(|a, b| a.depth.cmp(&b.depth).then_with(|| a.id.cmp(&b.id)));
        let mut edges = Vec::new();
        for id in &seen {
            for (note, _) in self
                .sql_adjacent(auth, id, NeighborDirection::Outgoing)
                .await?
            {
                if seen.contains(&note) {
                    edges.push(NeighborEdge {
                        from: id.clone(),
                        to: note,
                    });
                }
            }
        }
        edges.sort_by(|a, b| a.from.cmp(&b.from).then_with(|| a.to.cmp(&b.to)));
        Ok(NeighborsResponse {
            center: center.clone(),
            direction,
            nodes,
            edges,
        })
    }

    pub(crate) async fn sql_backlinks(
        &self,
        auth: &AuthContext,
        target: &NoteId,
    ) -> Result<BacklinksResponse, ServiceError> {
        self.sql_authorized(auth, target).await?;
        let mut backlinks = Vec::new();
        for (note, _) in self
            .sql_adjacent(auth, target, NeighborDirection::Incoming)
            .await?
        {
            let note = self.sql_authorized(auth, &note).await?;
            let context = self.sql_link_context(auth, &note.id, target).await?;
            backlinks.push(BacklinkEntry {
                id: note.id,
                title: note.title,
                context,
            });
        }
        backlinks.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(BacklinksResponse {
            target: target.clone(),
            backlinks,
        })
    }

    pub(crate) async fn sql_path(
        &self,
        auth: &AuthContext,
        from: &NoteId,
        to: &NoteId,
    ) -> Result<PathResponse, ServiceError> {
        let mut response = PathResponse {
            from: from.clone(),
            to: to.clone(),
            path: None,
            length: None,
        };
        for id in [from, to] {
            match self.sql_authorized(auth, id).await {
                Ok(_) => (),
                Err(ServiceError::NotFound) => return Ok(response),
                Err(e) => return Err(e),
            }
        }
        let mut parents = HashMap::from([(from.clone(), None::<NoteId>)]);
        let mut queue = VecDeque::from([from.clone()]);
        while let Some(id) = queue.pop_front() {
            if id == *to {
                let mut path = vec![id.clone()];
                let mut cursor = &id;
                while let Some(Some(parent)) = parents.get(cursor) {
                    path.push(parent.clone());
                    cursor = parent;
                }
                path.reverse();
                response.length = Some(path.len().saturating_sub(1));
                response.path = Some(path);
                break;
            }
            for target in self.sql_link_targets(&id).await? {
                let next = NoteId::new(target);
                if parents.contains_key(&next) {
                    continue;
                }
                match self.sql_authorized(auth, &next).await {
                    Ok(_) => {
                        parents.insert(next.clone(), Some(id.clone()));
                        queue.push_back(next);
                    }
                    Err(ServiceError::NotFound) => (),
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(response)
    }
}

impl VaultStore {
    pub(crate) async fn sql_base(
        &self,
        auth: &AuthContext,
        request: QueryBaseRequest,
    ) -> Result<QueryBaseResponse, ServiceError> {
        let bad = |e: BaseQueryError| ServiceError::BadRequest(e.to_string());
        let now = Utc::now();
        let mut accumulator =
            crate::base_query::BaseQueryAccumulator::new(request, MAX_NOTE_LIST_LIMIT, now)
                .map_err(bad)?;
        let keys = accumulator.projection_keys();
        let needs_links = accumulator.needs_links();
        let mut tx = self.db().pool.begin().await.map_err(unavailable)?;
        self.sql_scope(auth, &mut tx, None).await?;
        let mut selection = sqlx::QueryBuilder::new(
            "CREATE TEMP TABLE bridge_base ON COMMIT DROP AS SELECT n.id FROM notes n WHERE n.id IN(SELECT id FROM bridge_scope)",
        );
        accumulator.push_sql_filter(&mut selection);
        selection
            .build()
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        let mut order = sqlx::QueryBuilder::new(
            "CREATE TEMP TABLE bridge_base_order ON COMMIT DROP AS SELECT n.id,row_number() OVER(ORDER BY ",
        );
        let numeric = accumulator.numeric_sort();
        let mut sortable = numeric.is_some();
        if let Some(sort) = &numeric {
            for (path, _) in sort {
                let valid: bool = sqlx::query_scalar("SELECT COALESCE(bool_and(COALESCE(jsonb_typeof(n.frontmatter #> $1)='number',FALSE)),TRUE) FROM notes n JOIN bridge_base b ON b.id=n.id")
                    .bind(path).fetch_one(&mut *tx).await.map_err(unavailable)?;
                sortable &= valid;
            }
        }
        if sortable {
            accumulator.set_presorted();
            for (path, descending) in numeric.unwrap_or_default() {
                order
                    .push("(n.frontmatter #> ")
                    .push_bind(path)
                    .push(")::double precision ")
                    .push(if descending { "DESC," } else { "ASC," });
            }
        }
        order.push("n.path COLLATE \"C\") AS ordinal FROM notes n JOIN bridge_base b ON b.id=n.id");
        order.build().execute(&mut *tx).await.map_err(unavailable)?;
        let mut after = 0i64;
        loop {
            let projection = METADATA.replace("SELECT n.id", "SELECT b.ordinal,n.id").replace("n.summary", "''::text AS summary").replace("n.heading_title", "NULL::text AS heading_title").replace("n.embedding", "NULL::vector AS embedding").replace("n.frontmatter", "CASE WHEN $3::text[] IS NULL THEN n.frontmatter ELSE (SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(CASE WHEN jsonb_typeof(n.frontmatter)='object' THEN n.frontmatter ELSE '{}'::jsonb END) WHERE key=ANY($3)) END AS frontmatter");
            let rows = sqlx::query(&format!("{projection} JOIN bridge_base_order b ON b.id=n.id WHERE b.ordinal>$1 ORDER BY b.ordinal LIMIT $2"))
                .bind(&after).bind(PAGE).bind(&keys).fetch_all(&mut *tx).await.map_err(unavailable)?;
            if rows.is_empty() {
                break;
            }
            for row in rows {
                let note = metadata(&row).map_err(unavailable)?;
                after = row.try_get("ordinal").map_err(unavailable)?;
                let links: Vec<String> = if needs_links {
                    sqlx::query_scalar("SELECT target_id FROM links WHERE source_id=$1 AND target_id IN(SELECT id FROM bridge_scope) ORDER BY position,target_id COLLATE \"C\"")
                    .bind(note.id.as_str()).fetch_all(&mut *tx).await.map_err(unavailable)?
                } else {
                    Vec::new()
                };
                accumulator
                    .push(BaseQueryCandidate {
                        id: note.id,
                        path: note.path,
                        title: note.title,
                        frontmatter: note.frontmatter,
                        tags: note.tags,
                        created_at: note.created_at,
                        updated_at: note.updated_at,
                        links,
                    })
                    .map_err(bad)?;
            }
        }
        tx.commit().await.map_err(unavailable)?;
        accumulator.finish().map_err(bad)
    }

    async fn sql_note_similarity_on(
        &self,
        connection: &mut sqlx::PgConnection,
        id: &NoteId,
        query: Option<&[f32]>,
    ) -> Result<f32, ServiceError> {
        let Some(query) = query else {
            return Ok(0.0);
        };
        sqlx::query_scalar("SELECT COALESCE((1-(embedding <=> $2))::real,0) FROM notes WHERE id=$1")
            .bind(id.as_str())
            .bind(pgvector::Vector::from(query.to_vec()))
            .fetch_one(&mut *connection)
            .await
            .map_err(unavailable)
    }

    pub(crate) async fn sql_context(
        &self,
        auth: &AuthContext,
        request: AssembleContextRequest,
    ) -> Result<AssembleContextResponse, ServiceError> {
        use crate::context::{
            ContextFormat, ContextNote, ContextRole, betweenness_centrality_for_links,
            build_flat_context, build_graph_summary,
        };
        let settings = self.settings.read().await.clone();
        let depth = request
            .max_depth
            .unwrap_or(settings.context_default_max_depth)
            .clamp(1, MAX_GRAPH_TRAVERSAL_DEPTH);
        let budget = request
            .max_tokens
            .unwrap_or(settings.context_default_max_tokens)
            .min(settings.context_max_max_tokens.max(1));
        let mut seeds = request.seeds.into_iter().collect::<HashSet<_>>();
        if let Some(query) = request.seed_query.as_deref() {
            seeds.extend(
                self.sql_rank(auth, query, SearchMode::Semantic, None)
                    .await?
                    .0
                    .into_iter()
                    .take(8)
                    .map(|(id, _, _)| id),
            );
        }
        let query_embedding = if let Some(query) = request.seed_query.as_deref() {
            if self.semantic_embeddings_enabled().await {
                if let Some(dimensions) = self
                    .db()
                    .embedding_dimensions()
                    .await
                    .map_err(unavailable)?
                {
                    self.query_embedding_for_search(query, dimensions).await
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
        let query_ref = (!query_embedding.is_empty()).then_some(query_embedding.as_slice());
        let mut body_lease = self
            .source
            .as_ref()
            .expect("source")
            .acquire_body_lease()
            .await
            .map_err(unavailable)?;
        let mut tx = self.db().pool.begin().await.map_err(unavailable)?;
        self.sql_scope(auth, &mut tx, None).await?;
        sqlx::query("CREATE TEMP TABLE bridge_context(id TEXT PRIMARY KEY,depth INT,seed BOOLEAN,hub BOOLEAN,semantic REAL,centrality REAL DEFAULT 0,links_to TEXT[],linked_from TEXT[]) ON COMMIT DROP").execute(&mut *tx).await.map_err(unavailable)?;
        let mut topology = HashMap::new();
        let mut seen = HashSet::new();
        let mut queue = VecDeque::new();
        for seed in &seeds {
            queue.push_back((seed.clone(), 0));
        }
        while let Some((id, distance)) = queue.pop_front() {
            if !seen.insert(id.clone()) {
                continue;
            }
            let note = match self.sql_authorized_on(&mut tx, auth, &id).await {
                Ok(note) => note,
                Err(ServiceError::NotFound) => continue,
                Err(e) => return Err(e),
            };
            let mut links_to = self
                .sql_adjacent_in_scope(&mut tx, &id, NeighborDirection::Outgoing)
                .await?
                .into_iter()
                .map(|(n, _)| n)
                .collect::<Vec<_>>();
            let mut linked_from = self
                .sql_adjacent_in_scope(&mut tx, &id, NeighborDirection::Incoming)
                .await?
                .into_iter()
                .map(|(n, _)| n)
                .collect::<Vec<_>>();
            let is_hub = self.sql_is_hub_on(&mut tx, &note).await?;
            linked_from.sort();
            if is_hub && links_to.len() > settings.hub_note_fanout.max(1) {
                let mut scored = Vec::new();
                for id in links_to {
                    let neighbor = self.sql_authorized_on(&mut tx, auth, &id).await?;
                    let score = self
                        .sql_note_similarity_on(&mut tx, &neighbor.id, query_ref)
                        .await?;
                    scored.push((id, score));
                }
                scored.sort_by(|a, b| b.1.total_cmp(&a.1));
                links_to = scored
                    .into_iter()
                    .take(settings.hub_note_fanout.max(1))
                    .map(|(id, _)| id)
                    .collect();
            } else {
                links_to.sort();
            }
            if distance < depth {
                for next in &links_to {
                    if !seen.contains(next) {
                        queue.push_back((next.clone(), distance + 1));
                    }
                }
            }
            let semantic = self.sql_note_similarity_on(&mut tx, &id, query_ref).await?;
            sqlx::query("INSERT INTO bridge_context(id,depth,seed,hub,semantic,links_to,linked_from) VALUES($1,$2,$3,$4,$5,$6,$7)")
                .bind(id.as_str()).bind(distance as i32).bind(seeds.contains(&id)).bind(is_hub).bind(semantic)
                .bind(links_to.iter().map(ToString::to_string).collect::<Vec<_>>()).bind(linked_from.iter().map(ToString::to_string).collect::<Vec<_>>())
                .execute(&mut *tx).await.map_err(unavailable)?;
            topology.insert(id, links_to);
        }
        let total = topology.len();
        for (id, score) in betweenness_centrality_for_links(topology) {
            sqlx::query("UPDATE bridge_context SET centrality=$2 WHERE id=$1")
                .bind(id.as_str())
                .bind(score)
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
        }
        sqlx::query("CREATE TEMP TABLE bridge_context_order ON COMMIT DROP AS SELECT id,row_number() OVER(ORDER BY seed DESC,(1::real/(1+depth)::real*0.5::real+semantic*0.3::real+centrality*0.2::real+CASE WHEN hub THEN 0.05::real ELSE 0::real END) DESC,depth,id COLLATE \"C\") AS ordinal FROM bridge_context").execute(&mut *tx).await.map_err(unavailable)?;
        let mut notes = Vec::new();
        let mut used = 0;
        let mut included = 0;
        let mut summarized = 0;
        let mut after = 0i64;
        loop {
            let page = sqlx::query("SELECT c.id,c.depth,c.seed,c.hub,r.ordinal,n.body_bytes,octet_length(n.summary)::bigint AS summary_bytes FROM bridge_context c JOIN bridge_context_order r ON r.id=c.id JOIN notes n ON n.id=c.id WHERE r.ordinal>$1 ORDER BY r.ordinal LIMIT $2")
                .bind(after).bind(PAGE).fetch_all(&mut *tx).await.map_err(unavailable)?;
            if page.is_empty() {
                break;
            }
            for row in page {
                after = row.try_get("ordinal").map_err(unavailable)?;
                let mut candidate = ContextCandidate {
                    id: NoteId::new(row.try_get::<String, _>("id").map_err(unavailable)?),
                    title: String::new(),
                    content: String::new(),
                    summary: String::new(),
                    links_to: Vec::new(),
                    linked_from: Vec::new(),
                    embedding: None,
                    depth: row.try_get::<i32, _>("depth").map_err(unavailable)? as usize,
                    is_seed: row.try_get("seed").map_err(unavailable)?,
                    is_hub: row.try_get("hub").map_err(unavailable)?,
                };
                let note = self.sql_authorized_on(&mut tx, auth, &candidate.id).await?;
                let full_tokens = (row.try_get::<i64, _>("body_bytes").map_err(unavailable)?
                    as usize)
                    .div_ceil(4);
                let summary_tokens = (row
                    .try_get::<i64, _>("summary_bytes")
                    .map_err(unavailable)? as usize)
                    .div_ceil(4);
                let summary = candidate.is_hub || used + full_tokens > budget;
                if summary
                    && used + summary_tokens > budget
                    && !(candidate.is_seed && notes.is_empty())
                {
                    continue;
                }
                let mut content = String::new();
                let summary_text = if summary {
                    sqlx::query_scalar::<_, String>("SELECT summary FROM notes WHERE id=$1")
                        .bind(note.id.as_str())
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(unavailable)?
                } else {
                    let file = self
                        .source
                        .as_ref()
                        .expect("source")
                        .read_attested_with_lease(&note.path, &note.couchdb_rev, body_lease.clone())
                        .await
                        .map_err(unavailable)?;
                    body_lease = file.lease.clone();
                    content = parse_frontmatter(&file.content).1;
                    drop(file);
                    String::new()
                };
                used += if summary { summary_tokens } else { full_tokens };
                if summary {
                    summarized += 1;
                } else {
                    included += 1;
                }
                if !summary {
                    let links =
                        sqlx::query("SELECT links_to,linked_from FROM bridge_context WHERE id=$1")
                            .bind(candidate.id.as_str())
                            .fetch_one(&mut *tx)
                            .await
                            .map_err(unavailable)?;
                    candidate.links_to = links
                        .try_get::<Vec<String>, _>("links_to")
                        .map_err(unavailable)?
                        .into_iter()
                        .map(NoteId::new)
                        .collect();
                    candidate.linked_from = links
                        .try_get::<Vec<String>, _>("linked_from")
                        .map_err(unavailable)?
                        .into_iter()
                        .map(NoteId::new)
                        .collect();
                }
                notes.push(ContextNote {
                    id: candidate.id,
                    title: note.title,
                    content: (!summary).then_some(content),
                    summary: summary.then_some(summary_text),
                    role: if candidate.is_seed {
                        ContextRole::Seed
                    } else if summary {
                        ContextRole::Peripheral
                    } else {
                        ContextRole::Context
                    },
                    depth: Some(candidate.depth),
                    links_to: (!summary).then_some(candidate.links_to),
                    linked_from: (!summary).then_some(candidate.linked_from),
                    is_hub: Some(candidate.is_hub),
                });
            }
        }
        tx.commit().await.map_err(unavailable)?;
        let graph_summary = request
            .include_graph_summary
            .unwrap_or(true)
            .then(|| build_graph_summary(&notes));
        let flat_context = (request.format.unwrap_or_default() == ContextFormat::Flat)
            .then(|| build_flat_context(graph_summary.as_deref(), &notes));
        Ok(AssembleContextResponse {
            _body_lease: body_lease,
            graph_summary,
            flat_context,
            notes_excluded: total - notes.len(),
            notes,
            token_estimate: used,
            notes_included: included,
            notes_summarized: summarized,
        })
    }
}

impl VaultStore {
    pub(crate) async fn sql_status_metrics(
        &self,
        status: &mut StatusResponse,
    ) -> Result<(), ServiceError> {
        let row=sqlx::query("SELECT (SELECT count(*) FROM notes) AS notes,(SELECT count(*) FROM links) AS links,(SELECT count(DISTINCT tag) FROM tags) AS tags,
            (SELECT count(*) FROM notes n WHERE NOT EXISTS (SELECT 1 FROM vault_files f WHERE f.path=n.path)) AS missing,
            (SELECT count(*) FROM vault_files f WHERE path LIKE '%.md' AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.path=f.path)) AS unindexed")
            .fetch_one(&self.db().pool).await.map_err(unavailable)?;
        status.index.total_notes = row.try_get::<i64, _>("notes").map_err(unavailable)? as usize;
        status.index.total_links = row.try_get::<i64, _>("links").map_err(unavailable)? as usize;
        status.index.total_tags = row.try_get::<i64, _>("tags").map_err(unavailable)? as usize;
        status.index.missing_vault_files_for_notes =
            row.try_get::<i64, _>("missing").map_err(unavailable)? as usize;
        status.index.unindexed_markdown_vault_files =
            row.try_get::<i64, _>("unindexed").map_err(unavailable)? as usize;
        let config = self.authorization_config().await;
        status.context_stats.clear();
        for context in config.keys() {
            let auth = AuthContext::new(
                ContextName::new(context.clone()),
                format!("status:{context}"),
            );
            let mut tx = self.db().pool.begin().await.map_err(unavailable)?;
            self.sql_scope(&auth, &mut tx, None).await?;
            let accessible: i64 = sqlx::query_scalar("SELECT count(*) FROM bridge_scope")
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?;
            tx.commit().await.map_err(unavailable)?;
            status.context_stats.insert(
                context.clone(),
                ContextStats {
                    accessible_notes: accessible as usize,
                    filtered_notes: status.index.total_notes.saturating_sub(accessible as usize),
                },
            );
        }
        Ok(())
    }

    pub(crate) async fn sql_prepare_write(
        &self,
        auth: &AuthContext,
        id: &NoteId,
        mut request: UpdateNoteRequest,
        raw: bool,
    ) -> Result<PreparedVaultWrite, ServiceError> {
        let now = Utc::now();
        let path = id.to_string();
        let row = sqlx::query(
            "SELECT couchdb_rev, created_at, updated_at FROM vault_files WHERE path=$1",
        )
        .bind(&path)
        .fetch_optional(&self.db().pool)
        .await
        .map_err(unavailable)?
        .ok_or(ServiceError::NotFound)?;
        let revision: String = row.try_get("couchdb_rev").map_err(unavailable)?;
        let created_at = row.try_get("created_at").map_err(unavailable)?;
        let updated_at = row.try_get("updated_at").map_err(unavailable)?;
        let file_type = file_type_from_path(&path);
        let note = if file_type.is_markdown() {
            {
                self.sql_authorized(auth, id).await?;
                self.sql_metadata(id).await?
            }
        } else {
            None
        };
        let policy = note
            .as_ref()
            .map(policy_note_from_stored)
            .unwrap_or_else(|| PolicyNote {
                path: path.clone(),
                title: title_from_note_id(&path),
                tags: Vec::new(),
                created_at,
                updated_at,
                owner: None,
            });
        let config = self.authorization_config().await;
        if !policy_allows(&config, auth, "read", &policy, now) {
            return Err(ServiceError::NotFound);
        }
        let decision =
            policy_decision_for(&config, auth, "edit", &policy, now).ok_or_else(|| {
                ServiceError::Write(WriteError::PolicyDenied {
                    operation: "edit",
                    path: path.clone(),
                    reason: "no matching edit rule in the effective authorization policy"
                        .to_string(),
                })
            })?;
        let file = self.sql_body(&path, &revision).await?;
        let mut write = if raw {
            self.prepare_edit_from_parts(
                auth,
                request,
                now,
                path,
                file_type,
                file.content.clone(),
                created_at,
                note.map(|n| n.frontmatter),
                policy,
                revision,
            )
            .await?
        } else {
            let note = note.ok_or(ServiceError::NotFound)?;
            if let Some(metadata) = request.metadata.as_mut() {
                let object = metadata
                    .as_object_mut()
                    .ok_or_else(|| WriteError::InvalidUpdate {
                        reason: "metadata must be an object".to_string(),
                    })?;
                for key in ["created", "created_by", "tags", "updated"] {
                    object.remove(key);
                }
            }
            if let Some(tags) = request.tags.as_mut() {
                for tag in decision.preserve_tags {
                    if note.tags.iter().any(|t| {
                        crate::authorization::normalize_tag(t)
                            .eq_ignore_ascii_case(&crate::authorization::normalize_tag(&tag))
                    }) {
                        add_unique_tag(tags, &tag);
                    }
                }
                tags.sort();
                tags.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
            }
            if let Some(expected) = request.expected_sha256.as_deref() {
                let expected = expected.strip_prefix("sha256:").unwrap_or(expected);
                let actual = hex::encode(Sha256::digest(file.content.as_bytes()));
                if expected != actual {
                    return Err(WriteError::ContentChanged {
                        expected: expected.to_string(),
                        actual,
                    }
                    .into());
                }
            }
            let (_, body) = parse_frontmatter(&file.content);
            let content = request.rebuild_markdown(&note.frontmatter, &body, &note.tags, now)?;
            let max_context = self.settings.read().await.max_link_context_chars;
            let input =
                note_input_from_raw_markdown(&path, &content, "", created_at, now, max_context);
            PreparedVaultWrite {
                body_lease: None,
                operation_id: write_operation_id(&path, &content, now),
                path,
                content,
                file_type,
                created_at,
                updated_at: now,
                note: Some(input),
                mark_created: false,
                expected_couchdb_rev: Some(revision),
            }
        };
        write.body_lease = file.lease.clone();
        Ok(write)
    }
}

#[cfg(test)]
mod tests;
