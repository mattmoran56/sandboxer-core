-- Applied after migrations, on every boot.
--
-- Fixed ids and INSERT OR IGNORE, so re-applying them is a no-op rather than a
-- growing pile of duplicates: db-init runs this every time the sandbox starts.
INSERT OR IGNORE INTO notes (id, body, created_at) VALUES
  (1, 'First note, from the fixtures.', '2026-01-01 09:00:00'),
  (2, 'This row proves the migration ran against the sandbox''s own database.', '2026-01-01 09:01:00');
