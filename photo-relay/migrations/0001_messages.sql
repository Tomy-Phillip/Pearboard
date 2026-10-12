-- One row per photo sent from the upload page. Times are ms since the epoch.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,           -- 32 hex chars
  text TEXT NOT NULL,            -- caption, may be empty, at most 200 chars
  author TEXT NOT NULL,          -- first name shown on the TV
  photo_key TEXT NOT NULL,       -- R2 key, "photos/<id>"
  content_type TEXT NOT NULL,    -- image/jpeg | image/png | image/webp
  created_at INTEGER NOT NULL,
  seen_at INTEGER                -- NULL until passed on the TV
);
CREATE INDEX messages_unseen ON messages (seen_at, created_at);
