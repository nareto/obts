CREATE TABLE IF NOT EXISTS obts_projection_state (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    indexed_commit TEXT,
    target_commit TEXT,
    status TEXT NOT NULL CHECK (status IN ('uninitialized', 'projecting', 'current', 'blocked')),
    failure_code TEXT,
    updated_at TIMESTAMPTZ NOT NULL
);
