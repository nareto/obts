CREATE SEQUENCE bridge_embedding_generation;
ALTER TABLE embedding_schema ADD COLUMN epoch bigint NOT NULL DEFAULT nextval('bridge_embedding_generation');
ALTER TABLE notes ADD COLUMN embedding_epoch bigint NOT NULL DEFAULT nextval('bridge_embedding_generation');
ALTER TABLE blocks ADD COLUMN embedding_epoch bigint NOT NULL DEFAULT nextval('bridge_embedding_generation');
ALTER TABLE blocks ADD COLUMN derived_epoch bigint NOT NULL DEFAULT nextval('bridge_embedding_generation');
ALTER TABLE blocks ADD COLUMN source_revision text NOT NULL DEFAULT '';

CREATE FUNCTION bridge_note_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.couchdb_rev IS DISTINCT FROM OLD.couchdb_rev THEN
        NEW.embedding_epoch := nextval('bridge_embedding_generation');
        NEW.embedding := NULL;
        NEW.embedding_failures := 0;
        NEW.embedding_failed_at := NULL;
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER bridge_note_generation BEFORE UPDATE ON notes
FOR EACH ROW EXECUTE FUNCTION bridge_note_generation();

CREATE FUNCTION bridge_block_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.content_hash IS DISTINCT FROM OLD.content_hash
       OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
       OR NEW.breadcrumb IS DISTINCT FROM OLD.breadcrumb
       OR NEW.derived_epoch IS DISTINCT FROM OLD.derived_epoch THEN
        NEW.derived_epoch := nextval('bridge_embedding_generation');
        NEW.embedding := NULL;
        NEW.embedding_failures := 0;
        NEW.embedding_failed_at := NULL;
        NEW.last_embedding_error := NULL;
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER bridge_block_generation BEFORE UPDATE ON blocks
FOR EACH ROW EXECUTE FUNCTION bridge_block_generation();

UPDATE blocks b SET source_revision=n.couchdb_rev FROM notes n WHERE n.id=b.note_id;
UPDATE vault_files SET projection_complete=FALSE, projected_row_count=0;
