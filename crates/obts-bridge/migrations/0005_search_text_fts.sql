ALTER TABLE notes
    ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT '';

UPDATE notes
SET search_text = COALESCE(content, '')
WHERE search_text = '';

DROP INDEX IF EXISTS idx_notes_fts;

CREATE INDEX IF NOT EXISTS idx_notes_fts
    ON notes USING gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(search_text, '')));
