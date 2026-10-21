CREATE TABLE cloud_state (id INTEGER PRIMARY KEY CHECK (id = 1), initialized INTEGER NOT NULL DEFAULT 0);
INSERT INTO cloud_state (id) VALUES (1);
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    owner INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    revoked_at TEXT
);
CREATE TABLE pairing_codes (
    hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    owner INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE records (
    key TEXT PRIMARY KEY,
    json TEXT,
    revision INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    device_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    json TEXT,
    revision INTEGER NOT NULL,
    deleted INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX history_key ON history (key, revision);
CREATE TRIGGER records_insert_history AFTER INSERT ON records BEGIN
    INSERT INTO history (key, json, revision, deleted, device_id, created_at)
    VALUES (NEW.key, NEW.json, NEW.revision, NEW.deleted, NEW.device_id, NEW.updated_at);
END;
CREATE TRIGGER records_update_history AFTER UPDATE ON records BEGIN
    INSERT INTO history (key, json, revision, deleted, device_id, created_at)
    VALUES (NEW.key, NEW.json, NEW.revision, NEW.deleted, NEW.device_id, NEW.updated_at);
END;
CREATE TABLE write_guard (id INTEGER PRIMARY KEY CHECK (id = 1), valid INTEGER NOT NULL CHECK (valid = 1));
CREATE TABLE mutations (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE backup_config (id INTEGER PRIMARY KEY CHECK (id = 1), encrypted TEXT NOT NULL);
CREATE TABLE backup_runs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    filename TEXT,
    error TEXT
);
CREATE UNIQUE INDEX one_backup_running ON backup_runs (status) WHERE status = 'running';
