ALTER TABLE notes ADD COLUMN heading_title TEXT;
ALTER TABLE vault_files ADD COLUMN projection_complete BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vault_files ADD COLUMN projected_row_count INTEGER NOT NULL DEFAULT 0;
