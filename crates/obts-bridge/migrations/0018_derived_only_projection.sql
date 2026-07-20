ALTER TABLE notes
    ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

UPDATE notes
SET search_vector = to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(search_text, ''))
WHERE search_vector IS NULL;

DROP INDEX IF EXISTS idx_notes_fts;
CREATE INDEX IF NOT EXISTS idx_notes_search_vector
    ON notes USING gin (search_vector);

-- Raw columns are retained for upgrade compatibility. The application clears
-- them only after the authoritative headless filesystem passes commit attestation.
