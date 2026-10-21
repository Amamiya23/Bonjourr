CREATE TABLE deletion_guard (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    had_links INTEGER NOT NULL,
    allowed INTEGER NOT NULL CONSTRAINT prevent_empty_cloud CHECK (allowed = 1)
);
