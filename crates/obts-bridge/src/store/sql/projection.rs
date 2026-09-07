use super::*;
use sqlx::{
    Arguments, Encode, Postgres, Type,
    postgres::{PgArgumentBuffer, PgArguments},
};

#[derive(Debug, Default)]
pub(crate) struct ProjectionMetrics {
    pub normal_rows: AtomicU64,
    pub normal_bytes: AtomicU64,
    pub singleton_bytes: AtomicU64,
    pub singleton_operations: AtomicU64,
}

#[derive(Default)]
pub(super) struct Parameters {
    pub(super) arguments: PgArguments,
    pub(super) bytes: usize,
}
impl Parameters {
    pub(super) fn bind<'q, T: Encode<'q, Postgres> + Type<Postgres> + Clone + 'q>(
        mut self,
        value: T,
    ) -> Result<Self, sqlx::Error> {
        let mut encoded = PgArgumentBuffer::default();
        let _ = value
            .encode_by_ref(&mut encoded)
            .map_err(sqlx::Error::Encode)?;
        self.bytes += 4 + encoded.len();
        drop(encoded);
        self.arguments.add(value).map_err(sqlx::Error::Encode)?;
        Ok(self)
    }
}

struct Writer<'a> {
    store: &'a VaultStore,
    tx: Option<sqlx::Transaction<'static, Postgres>>,
    rows: usize,
    bytes: usize,
}
impl<'a> Writer<'a> {
    fn new(store: &'a VaultStore) -> Self {
        Self {
            store,
            tx: None,
            rows: 0,
            bytes: 0,
        }
    }
    async fn flush(&mut self) -> Result<(), sqlx::Error> {
        if let Some(tx) = self.tx.take() {
            tx.commit().await?;
        }
        self.rows = 0;
        self.bytes = 0;
        Ok(())
    }
    async fn abort(&mut self) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.rollback().await;
        }
    }
    async fn row(&mut self, sql: &str, parameters: Parameters) -> Result<u64, sqlx::Error> {
        if parameters.bytes > self.store.projection_batch_bytes {
            self.flush().await?;
            let _permit = self
                .store
                .projection_singleton
                .clone()
                .acquire_owned()
                .await
                .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
            self.store
                .projection_metrics
                .singleton_bytes
                .fetch_max(parameters.bytes as u64, Ordering::Relaxed);
            self.store
                .projection_metrics
                .singleton_operations
                .fetch_add(1, Ordering::Relaxed);
            let mut tx = self.store.db().pool.begin().await?;
            let result = sqlx::query_with(sql, parameters.arguments)
                .execute(&mut *tx)
                .await;
            return match result {
                Ok(result) => {
                    tx.commit().await?;
                    Ok(result.rows_affected())
                }
                Err(error) => {
                    let _ = tx.rollback().await;
                    Err(error)
                }
            };
        }
        if self.rows == self.store.projection_batch_rows
            || self.bytes + parameters.bytes > self.store.projection_batch_bytes
        {
            self.flush().await?;
        }
        if self.tx.is_none() {
            self.tx = Some(self.store.db().pool.begin().await?);
        }
        self.rows += 1;
        self.bytes += parameters.bytes;
        self.store
            .projection_metrics
            .normal_rows
            .fetch_max(self.rows as u64, Ordering::Relaxed);
        self.store
            .projection_metrics
            .normal_bytes
            .fetch_max(self.bytes as u64, Ordering::Relaxed);
        Ok(sqlx::query_with(sql, parameters.arguments)
            .execute(&mut **self.tx.as_mut().unwrap())
            .await?
            .rows_affected())
    }
    async fn cleanup(&mut self, path: &str, blocks_after: Option<i32>) -> Result<(), sqlx::Error> {
        self.flush().await?;
        for (table, key, owner) in [
            ("tags", "tag", "note_id"),
            ("links", "target_id", "source_id"),
            ("blocks", "id", "note_id"),
        ] {
            if blocks_after.is_some() && table != "blocks" {
                continue;
            }
            let mut after = String::new();
            loop {
                let rows: Vec<String> = sqlx::query_scalar(&format!("SELECT {key} FROM {table} WHERE {owner}=$1 AND {key} COLLATE \"C\">$2 AND ($3::int IS NULL OR block_index_placeholder >= $3) ORDER BY {key} COLLATE \"C\" LIMIT $4").replace("block_index_placeholder", if table == "blocks" { "block_index" } else { "0" }))
                    .bind(path).bind(&after).bind(blocks_after).bind(PAGE).fetch_all(&self.store.db().pool).await?;
                if rows.is_empty() {
                    break;
                }
                for key_value in rows {
                    self.row(
                        &format!("DELETE FROM {table} WHERE {owner}=$1 AND {key}=$2"),
                        Parameters::default().bind(path)?.bind(&key_value)?,
                    )
                    .await?;
                    after = key_value;
                }
                self.flush().await?;
            }
        }
        Ok(())
    }
}

impl VaultStore {
    pub(crate) async fn sql_project_write(
        &self,
        mut write: PreparedVaultWrite,
        revision: String,
        _coordination: &tokio::sync::OwnedMutexGuard<()>,
    ) -> Result<LocalProjectionOutcome, WriteError> {
        let mut writer = Writer::new(self);
        let result: Result<(), sqlx::Error> = async {
            #[cfg(test)]
            if self.forced_projection_failure.read().await.is_some() { return Err(sqlx::Error::Protocol("injected projection failure".into())); }
            writer.row("INSERT INTO vault_files(path,content,couchdb_rev,created_at,updated_at,indexed_at,projection_complete,projected_row_count) VALUES($1,'',$2,$3,$4,$4,FALSE,0) ON CONFLICT(path) DO UPDATE SET content='',couchdb_rev=$2,created_at=$3,updated_at=$4,indexed_at=$4,projection_complete=FALSE,projected_row_count=0",
                Parameters::default().bind(&write.path)?.bind(&revision)?.bind(write.created_at)?.bind(write.updated_at)?).await?;
            writer.flush().await?;
            // Invalidating the file commits before any independently committed derived rows.
            let mut expected = 1i64;
            if let Some(mut input) = write.note.take() {
                input.couchdb_rev = revision.clone();
                let prepared = prepare_note_upsert(input, write.updated_at);
                let note = &prepared.note;
                writer.row("INSERT INTO notes(id,path,title,heading_title,content,search_text,summary,frontmatter,couchdb_rev,created_at,updated_at,indexed_at,policy_owner,policy_title_ascii,projection_hub,body_bytes) VALUES($1,$2,$3,$4,'','',$5,$6,$7,$8,$9,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET path=$2,title=$3,heading_title=$4,content='',search_text='',summary=$5,frontmatter=$6,embedding=CASE WHEN notes.couchdb_rev=$7 THEN notes.embedding ELSE NULL END,couchdb_rev=$7,created_at=$8,updated_at=$9,indexed_at=$9,policy_owner=$10,policy_title_ascii=$11,projection_hub=$12,body_bytes=$13",
                    Parameters::default().bind(note.id.as_str())?.bind(&note.path)?.bind(&note.title)?.bind(&note.heading_title)?.bind(&note.summary)?.bind(&note.frontmatter)?.bind(&revision)?.bind(note.created_at)?.bind(note.updated_at)?.bind(owner_from_frontmatter(&note.frontmatter).map(str::to_string))?.bind(note.title.to_ascii_lowercase())?.bind(frontmatter_marks_hub(&note.frontmatter))?.bind(note.content.len() as i64)?).await?;
                let lexical_title = title_from_note_id(note.id.as_str()).to_lowercase();
                let lexical_plaintext = note.search_text.to_lowercase();
                let search_source = format!("{}\n{}", note.title, note.search_text);
                let mut end = search_source.len().min(crate::persistence::MAX_INDEXED_SEARCH_TEXT_BYTES);
                while !search_source.is_char_boundary(end) { end -= 1; }
                writer.row("UPDATE notes SET lexical_title=$2,lexical_plaintext=$3,search_vector=to_tsvector('simple',$4) WHERE id=$1",
                    Parameters::default().bind(note.id.as_str())?.bind(&lexical_title)?.bind(&lexical_plaintext)?.bind(&search_source[..end])?).await?;
                drop((lexical_title, lexical_plaintext, search_source));
                writer.flush().await?;
                // Replay replaces tag/link sets and preserves unchanged block embeddings.
                for (table, key, owner) in [("tags", "tag", "note_id"), ("links", "target_id", "source_id")] {
                    let mut after = String::new();
                    loop {
                        let keys: Vec<String> = sqlx::query_scalar(&format!("SELECT {key} FROM {table} WHERE {owner}=$1 AND {key} COLLATE \"C\">$2 ORDER BY {key} COLLATE \"C\" LIMIT $3"))
                            .bind(note.id.as_str()).bind(&after).bind(PAGE).fetch_all(&self.db().pool).await?;
                        if keys.is_empty() { break; }
                        for key_value in keys {
                            writer.row(&format!("DELETE FROM {table} WHERE {owner}=$1 AND {key}=$2"), Parameters::default().bind(note.id.as_str())?.bind(&key_value)?).await?;
                            after = key_value;
                        }
                        writer.flush().await?;
                    }
                }
                let mut tags = HashSet::new();
                for tag in &note.tags {
                    if tags.insert(tag) {
                        writer.row("INSERT INTO tags(note_id,tag,policy_tag) VALUES($1,$2,$3)", Parameters::default().bind(note.id.as_str())?.bind(tag)?.bind(crate::authorization::normalize_tag(tag).to_ascii_lowercase())?).await?;
                    }
                }
                let mut targets = HashSet::new();
                for link in &prepared.links {
                    targets.insert(&link.target_id);
                    writer.row("INSERT INTO links(source_id,target_id,context_text,position) VALUES($1,$2,'',$3) ON CONFLICT(source_id,target_id) DO UPDATE SET context_text='',position=$3",
                        Parameters::default().bind(note.id.as_str())?.bind(link.target_id.as_str())?.bind(link.position.min(i32::MAX as usize) as i32)?).await?;
                }
                let settings = self.settings.read().await.clone();
                let blocks = crate::markdown::semantic_blocks(&note.content, settings.block_min_chars, settings.block_chunk_bytes, settings.block_chunk_overlap_sentences);
                let mut block_count=0usize;
                for block in blocks {
                    block_count+=1;
                    let heading = block.heading_path.iter().map(|h| format!("{} {}", "#".repeat(h.level as usize), h.text)).collect::<Vec<_>>().join(" > ");
                    let breadcrumb = breadcrumb_prefix(&note.path, &note.title, &block.heading_path);
                    writer.row("INSERT INTO blocks(id,note_id,block_index,heading_path,breadcrumb,content,content_hash,source_revision) VALUES($1,$2,$3,$4,$5,'',$6,$7) ON CONFLICT(id) DO UPDATE SET source_revision=$7,heading_path=$4,breadcrumb=$5,content='',content_hash=$6,embedding=CASE WHEN blocks.content_hash=$6 THEN blocks.embedding ELSE NULL END,embedding_failures=CASE WHEN blocks.content_hash=$6 THEN blocks.embedding_failures ELSE 0 END,embedding_failed_at=CASE WHEN blocks.content_hash=$6 THEN blocks.embedding_failed_at ELSE NULL END,last_embedding_error=CASE WHEN blocks.content_hash=$6 THEN blocks.last_embedding_error ELSE NULL END,updated_at=now()",
                        Parameters::default().bind(format!("{}##{}",note.id,block.block_index))?.bind(note.id.as_str())?.bind(block.block_index as i32)?.bind(heading)?.bind(breadcrumb)?.bind(hex::encode(Sha256::digest(block.content.as_bytes())))?.bind(&revision)?).await?;
                }
                writer.cleanup(&write.path, Some(block_count as i32)).await?;
                expected += 2 + tags.len() as i64 + targets.len() as i64 + block_count as i64;
            }
            writer.flush().await?;
            let affected = writer.row("UPDATE vault_files SET projection_complete=TRUE,projected_row_count=$3 WHERE path=$1 AND couchdb_rev=$2 AND $3=1+(SELECT count(*)*2 FROM notes WHERE id=$1 AND couchdb_rev=$2 AND lexical_title IS NOT NULL AND lexical_plaintext IS NOT NULL)+(SELECT count(*) FROM tags WHERE note_id=$1)+(SELECT count(*) FROM links WHERE source_id=$1)+(SELECT count(*) FROM blocks WHERE note_id=$1)",
                Parameters::default().bind(&write.path)?.bind(&revision)?.bind(expected)?).await?;
            if affected != 1 { return Err(sqlx::Error::Protocol("incomplete projection row manifest".into())); }
            writer.flush().await?;
            Ok(())
        }.await;
        if result.is_err() {
            writer.abort().await;
        }
        result.map_err(|e| WriteError::Persistence {
            kind: crate::persistence::PersistenceError::Sqlx(e).failure_kind(),
        })?;
        Ok(LocalProjectionOutcome::Applied)
    }

    pub(crate) async fn sql_delete_projection(
        &self,
        path: &str,
        _coordination: &tokio::sync::OwnedMutexGuard<()>,
    ) -> Result<(), WriteError> {
        let mut writer = Writer::new(self);
        let result: Result<(), sqlx::Error> = async {
            writer
                .row(
                    "UPDATE vault_files SET projection_complete=FALSE WHERE path=$1",
                    Parameters::default().bind(path)?,
                )
                .await?;
            writer.cleanup(path, None).await?;
            writer
                .row(
                    "DELETE FROM notes WHERE id=$1",
                    Parameters::default().bind(path)?,
                )
                .await?;
            writer
                .row(
                    "DELETE FROM vault_files WHERE path=$1",
                    Parameters::default().bind(path)?,
                )
                .await?;
            writer.flush().await
        }
        .await;
        if result.is_err() {
            writer.abort().await;
        }
        result.map_err(|e| WriteError::Persistence {
            kind: crate::persistence::PersistenceError::Sqlx(e).failure_kind(),
        })
    }
}
