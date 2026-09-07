use super::projection::Parameters;
use super::*;

#[derive(Clone, Debug)]
pub(crate) struct EmbeddingNoteToken {
    pub id: String,
    pub revision: String,
    pub epoch: i64,
    pub pending_note: bool,
    pub schema_epoch: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct EmbeddingBlockToken {
    pub id: String,
    pub index: usize,
    pub epoch: i64,
    pub derived_epoch: i64,
    pub source_revision: String,
    pub hash: String,
}

async fn lock_current_schema(
    connection: &mut sqlx::PgConnection,
    epoch: i64,
) -> Result<bool, ServiceError> {
    let current: Option<i32> =
        sqlx::query_scalar("SELECT id FROM embedding_schema WHERE id=1 AND epoch=$1 FOR SHARE")
            .bind(epoch)
            .fetch_optional(connection)
            .await
            .map_err(unavailable)?;
    Ok(current.is_some())
}

impl VaultStore {
    pub(crate) async fn embedding_candidates(
        &self,
        after: &str,
        limit: usize,
        failures: usize,
        blocks: bool,
        model: &str,
        dimensions: usize,
    ) -> Result<Vec<EmbeddingNoteToken>, ServiceError> {
        let rows = sqlx::query("SELECT n.id,n.couchdb_rev,n.embedding_epoch,e.epoch AS schema_epoch,(n.embedding IS NULL AND n.embedding_failures<$3) AS pending_note FROM notes n JOIN vault_files f ON f.path=n.path JOIN embedding_schema e ON e.id=1 WHERE e.model=$5 AND e.dimensions=$6 AND f.projection_complete AND n.id COLLATE \"C\">$1 AND ((n.embedding IS NULL AND n.embedding_failures<$3) OR ($4 AND EXISTS(SELECT 1 FROM blocks b WHERE b.note_id=n.id AND b.embedding IS NULL AND b.embedding_failures<$3))) ORDER BY n.id COLLATE \"C\" LIMIT $2")
            .bind(after).bind(limit.clamp(1,128) as i64).bind(failures.min(i32::MAX as usize) as i32).bind(blocks).bind(model).bind(dimensions.min(i32::MAX as usize) as i32)
            .fetch_all(&self.db().pool).await.map_err(unavailable)?;
        rows.into_iter()
            .map(|r| {
                Ok(EmbeddingNoteToken {
                    id: r.try_get("id")?,
                    revision: r.try_get("couchdb_rev")?,
                    epoch: r.try_get("embedding_epoch")?,
                    pending_note: r.try_get("pending_note")?,
                    schema_epoch: r.try_get("schema_epoch")?,
                })
            })
            .collect::<Result<_, sqlx::Error>>()
            .map_err(unavailable)
    }

    pub(crate) async fn embedding_source(
        &self,
        token: &EmbeddingNoteToken,
    ) -> Result<Option<(String, String)>, ServiceError> {
        sqlx::query_as(
            "SELECT path,title FROM notes WHERE id=$1 AND couchdb_rev=$2 AND embedding_epoch=$3",
        )
        .bind(&token.id)
        .bind(&token.revision)
        .bind(token.epoch)
        .fetch_optional(&self.db().pool)
        .await
        .map_err(unavailable)
    }

    pub(crate) async fn embedding_blocks(
        &self,
        note: &EmbeddingNoteToken,
        after: i64,
        failures: usize,
    ) -> Result<Vec<EmbeddingBlockToken>, ServiceError> {
        let rows=sqlx::query("SELECT b.id,b.block_index,b.embedding_epoch,b.derived_epoch,b.source_revision,b.content_hash FROM blocks b JOIN notes n ON n.id=b.note_id WHERE n.id=$1 AND n.couchdb_rev=$2 AND n.embedding_epoch=$3 AND b.source_revision=$2 AND b.block_index>$4 AND b.embedding IS NULL AND b.embedding_failures<$5 ORDER BY b.block_index LIMIT 128")
            .bind(&note.id).bind(&note.revision).bind(note.epoch).bind(after).bind(failures.min(i32::MAX as usize) as i32)
            .fetch_all(&self.db().pool).await.map_err(unavailable)?;
        rows.into_iter()
            .map(|r| {
                Ok(EmbeddingBlockToken {
                    id: r.try_get("id")?,
                    index: r.try_get::<i32, _>("block_index")? as usize,
                    epoch: r.try_get("embedding_epoch")?,
                    derived_epoch: r.try_get("derived_epoch")?,
                    source_revision: r.try_get("source_revision")?,
                    hash: r.try_get("content_hash")?,
                })
            })
            .collect::<Result<_, sqlx::Error>>()
            .map_err(unavailable)
    }

    pub(crate) async fn complete_embedding(
        &self,
        note: &EmbeddingNoteToken,
        block: Option<&EmbeddingBlockToken>,
        vector: Option<Vec<f32>>,
    ) -> Result<u64, ServiceError> {
        let success = vector.is_some();
        let vector = vector.map(pgvector::Vector::from);
        let params = Parameters::default()
            .bind(&note.id)
            .and_then(|p| p.bind(&note.revision))
            .and_then(|p| p.bind(note.epoch))
            .and_then(|p| p.bind(vector))
            .and_then(|p| p.bind(success))
            .map_err(unavailable)?;
        let (sql, params) = if let Some(block) = block {
            (
                "UPDATE blocks SET embedding=CASE WHEN $5 THEN $4 ELSE embedding END,embedding_failures=CASE WHEN $5 THEN 0 ELSE embedding_failures+1 END,embedding_failed_at=CASE WHEN $5 THEN NULL ELSE now() END,last_embedding_error=CASE WHEN $5 THEN NULL ELSE 'provider request failed' END WHERE note_id=$1 AND source_revision=$2 AND $3::bigint IS NOT NULL AND id=$6 AND embedding_epoch=$7 AND derived_epoch=$8 AND content_hash=$9 AND source_revision=$10",
                params
                    .bind(&block.id)
                    .and_then(|p| p.bind(block.epoch))
                    .and_then(|p| p.bind(block.derived_epoch))
                    .and_then(|p| p.bind(&block.hash))
                    .and_then(|p| p.bind(&block.source_revision))
                    .map_err(unavailable)?,
            )
        } else {
            (
                "UPDATE notes SET embedding=CASE WHEN $5 THEN $4 ELSE embedding END,embedding_failures=CASE WHEN $5 THEN 0 ELSE embedding_failures+1 END,embedding_failed_at=CASE WHEN $5 THEN NULL ELSE now() END WHERE id=$1 AND couchdb_rev=$2 AND embedding_epoch=$3",
                params,
            )
        };
        let _singleton = if params.bytes > self.projection_batch_bytes {
            Some(
                self.projection_singleton
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(unavailable)?,
            )
        } else {
            None
        };
        if _singleton.is_some() {
            self.projection_metrics
                .singleton_bytes
                .fetch_max(params.bytes as u64, Ordering::Relaxed);
            self.projection_metrics
                .singleton_operations
                .fetch_add(1, Ordering::Relaxed);
        } else {
            self.projection_metrics
                .normal_rows
                .fetch_max(1, Ordering::Relaxed);
            self.projection_metrics
                .normal_bytes
                .fetch_max(params.bytes as u64, Ordering::Relaxed);
        }
        struct OwnedParameters {
            parameters: Parameters,
            _singleton: Option<tokio::sync::OwnedSemaphorePermit>,
        }
        let owned = OwnedParameters {
            parameters: params,
            _singleton,
        };
        let mut tx = self.db().pool.begin().await.map_err(unavailable)?;
        if !lock_current_schema(&mut tx, note.schema_epoch).await? {
            tx.rollback().await.map_err(unavailable)?;
            return Ok(0);
        }
        let matches: Option<String> = sqlx::query_scalar(
            "SELECT id FROM notes WHERE id=$1 AND couchdb_rev=$2 AND embedding_epoch=$3 FOR UPDATE",
        )
        .bind(&note.id)
        .bind(&note.revision)
        .bind(note.epoch)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if matches.is_none() {
            tx.rollback().await.map_err(unavailable)?;
            return Ok(0);
        }
        let result = sqlx::query_with(sql, owned.parameters.arguments)
            .execute(&mut *tx)
            .await;
        match result {
            Ok(r) => {
                tx.commit().await.map_err(unavailable)?;
                Ok(r.rows_affected())
            }
            Err(e) => {
                let _ = tx.rollback().await;
                Err(unavailable(e))
            }
        }
    }

    pub(crate) async fn invalidate_embedding_projection(
        &self,
        note: &EmbeddingNoteToken,
    ) -> Result<(), ServiceError> {
        let mut tx = self.db().pool.begin().await.map_err(unavailable)?;
        if !lock_current_schema(&mut tx, note.schema_epoch).await? {
            tx.rollback().await.map_err(unavailable)?;
            return Ok(());
        }
        let current: Option<String> = sqlx::query_scalar(
            "SELECT id FROM notes WHERE id=$1 AND couchdb_rev=$2 AND embedding_epoch=$3 FOR UPDATE",
        )
        .bind(&note.id)
        .bind(&note.revision)
        .bind(note.epoch)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if current.is_some() {
            sqlx::query(
                "UPDATE vault_files SET projection_complete=FALSE WHERE path=$1 AND couchdb_rev=$2",
            )
            .bind(&note.id)
            .bind(&note.revision)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(())
    }

    pub(crate) async fn embedding_block_settings(&self) -> (usize, usize, usize) {
        let s = self.settings.read().await;
        (
            s.block_min_chars,
            s.block_chunk_bytes,
            s.block_chunk_overlap_sentences,
        )
    }
}
