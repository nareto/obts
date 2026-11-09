-- Authorization metadata of non-Markdown vault files. Canvas files carry tags
-- and an owner in metadata.frontmatter; foreground policy reads these columns
-- before hydrating the file body. Markdown policy stays on notes/tags.
ALTER TABLE vault_files ADD COLUMN policy_tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE vault_files ADD COLUMN policy_owner TEXT;
