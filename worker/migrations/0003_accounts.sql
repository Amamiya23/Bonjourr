CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    login_name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    created_at TEXT NOT NULL,
    disabled_at TEXT
);
CREATE TABLE account_settings (id INTEGER PRIMARY KEY CHECK (id = 1), registration_open INTEGER NOT NULL DEFAULT 0);
INSERT INTO account_settings (id) VALUES (1);
ALTER TABLE devices ADD COLUMN account_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE devices ADD COLUMN expires_at INTEGER;
CREATE INDEX devices_account ON devices (account_id, revoked_at);
CREATE TABLE auth_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE account_state (account_id TEXT PRIMARY KEY, initialized INTEGER NOT NULL DEFAULT 0);
INSERT INTO account_state SELECT 'legacy', initialized FROM cloud_state;
CREATE TABLE account_records (
    account_id TEXT NOT NULL, key TEXT NOT NULL, json TEXT, revision INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, device_id TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, key)
);
INSERT INTO account_records SELECT 'legacy', key, json, revision, deleted, device_id, updated_at FROM records;
CREATE TABLE account_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, key TEXT NOT NULL,
    json TEXT, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, device_id TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO account_history SELECT id, 'legacy', key, json, revision, deleted, device_id, created_at FROM history;
CREATE INDEX account_history_key ON account_history (account_id, key, revision);
CREATE TRIGGER account_records_insert AFTER INSERT ON account_records BEGIN
    INSERT INTO account_history (account_id, key, json, revision, deleted, device_id, created_at)
    VALUES (NEW.account_id, NEW.key, NEW.json, NEW.revision, NEW.deleted, NEW.device_id, NEW.updated_at);
END;
CREATE TRIGGER account_records_update AFTER UPDATE ON account_records BEGIN
    INSERT INTO account_history (account_id, key, json, revision, deleted, device_id, created_at)
    VALUES (NEW.account_id, NEW.key, NEW.json, NEW.revision, NEW.deleted, NEW.device_id, NEW.updated_at);
END;
CREATE TABLE account_write_guard (account_id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK (valid = 1));
CREATE TABLE account_deletion_guard (
    account_id TEXT PRIMARY KEY, had_links INTEGER NOT NULL,
    allowed INTEGER NOT NULL CONSTRAINT prevent_empty_cloud CHECK (allowed = 1)
);
CREATE TABLE account_mutations (
    account_id TEXT NOT NULL, id TEXT NOT NULL, device_id TEXT NOT NULL, hash TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (account_id, id)
);
INSERT INTO account_mutations SELECT 'legacy', id, device_id, hash, created_at FROM mutations;
CREATE TABLE account_backup_config (account_id TEXT PRIMARY KEY, encrypted TEXT NOT NULL);
INSERT INTO account_backup_config SELECT 'legacy', encrypted FROM backup_config;
CREATE TABLE account_backup_runs (
    account_id TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL,
    filename TEXT, error TEXT, PRIMARY KEY (account_id, id)
);
INSERT INTO account_backup_runs SELECT 'legacy', id, created_at, status, filename, error FROM backup_runs;
CREATE UNIQUE INDEX account_one_backup ON account_backup_runs (account_id) WHERE status = 'running';

-- Mirror old-worker writes during the deployment; retain old tables for recovery.
CREATE TRIGGER legacy_state_update AFTER UPDATE ON cloud_state BEGIN
    UPDATE account_state SET initialized = NEW.initialized WHERE account_id = 'legacy';
END;
CREATE TRIGGER legacy_records_insert AFTER INSERT ON records BEGIN
    INSERT INTO account_records VALUES ('legacy', NEW.key, NEW.json, NEW.revision, NEW.deleted, NEW.device_id, NEW.updated_at)
    ON CONFLICT (account_id, key) DO UPDATE SET json = excluded.json, revision = excluded.revision,
        deleted = excluded.deleted, device_id = excluded.device_id, updated_at = excluded.updated_at;
END;
CREATE TRIGGER legacy_records_update AFTER UPDATE ON records BEGIN
    INSERT INTO account_records VALUES ('legacy', NEW.key, NEW.json, NEW.revision, NEW.deleted, NEW.device_id, NEW.updated_at)
    ON CONFLICT (account_id, key) DO UPDATE SET json = excluded.json, revision = excluded.revision,
        deleted = excluded.deleted, device_id = excluded.device_id, updated_at = excluded.updated_at;
END;
CREATE TRIGGER legacy_mutations_insert AFTER INSERT ON mutations BEGIN
    INSERT OR IGNORE INTO account_mutations VALUES ('legacy', NEW.id, NEW.device_id, NEW.hash, NEW.created_at);
END;
CREATE TRIGGER legacy_backup_insert AFTER INSERT ON backup_config BEGIN
    INSERT OR REPLACE INTO account_backup_config VALUES ('legacy', NEW.encrypted);
END;
CREATE TRIGGER legacy_backup_update AFTER UPDATE ON backup_config BEGIN
    INSERT OR REPLACE INTO account_backup_config VALUES ('legacy', NEW.encrypted);
END;
CREATE TRIGGER legacy_backup_delete AFTER DELETE ON backup_config BEGIN
    DELETE FROM account_backup_config WHERE account_id = 'legacy';
END;
CREATE TRIGGER legacy_backup_run_insert AFTER INSERT ON backup_runs BEGIN
    INSERT OR REPLACE INTO account_backup_runs VALUES ('legacy', NEW.id, NEW.created_at, NEW.status, NEW.filename, NEW.error);
END;
CREATE TRIGGER legacy_backup_run_update AFTER UPDATE ON backup_runs BEGIN
    INSERT OR REPLACE INTO account_backup_runs VALUES ('legacy', NEW.id, NEW.created_at, NEW.status, NEW.filename, NEW.error);
END;
