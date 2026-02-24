-- ============================================================================
-- Migration 008: Media Messages Support
-- Adds media columns to messages and world_messages tables.
-- Supports photos, videos, and mixed (text + media) messages.
-- ============================================================================

-- ─── Messages Table — Add media columns ──────────────────────────────────────
ALTER TABLE messages ALTER COLUMN content DROP NOT NULL;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_url        TEXT,
  ADD COLUMN IF NOT EXISTS media_type       VARCHAR(20),  -- 'image' | 'video'
  ADD COLUMN IF NOT EXISTS media_thumbnail  TEXT,
  ADD COLUMN IF NOT EXISTS media_width      INTEGER,
  ADD COLUMN IF NOT EXISTS media_height     INTEGER,
  ADD COLUMN IF NOT EXISTS media_duration   REAL,         -- video duration in seconds
  ADD COLUMN IF NOT EXISTS media_size       BIGINT,       -- file size in bytes
  ADD COLUMN IF NOT EXISTS media_mime_type  VARCHAR(50);  -- original MIME type

-- Ensure at least content or media is present
ALTER TABLE messages
  ADD CONSTRAINT messages_content_or_media
  CHECK (content IS NOT NULL OR media_url IS NOT NULL);

-- Index for filtering media messages (gallery view)
CREATE INDEX IF NOT EXISTS idx_messages_media
  ON messages(conversation_id, created_at DESC)
  WHERE media_url IS NOT NULL;

-- ─── World Messages Table — Add media columns ───────────────────────────────
ALTER TABLE world_messages ALTER COLUMN content DROP NOT NULL;

ALTER TABLE world_messages
  ADD COLUMN IF NOT EXISTS media_url        TEXT,
  ADD COLUMN IF NOT EXISTS media_type       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS media_thumbnail  TEXT,
  ADD COLUMN IF NOT EXISTS media_width      INTEGER,
  ADD COLUMN IF NOT EXISTS media_height     INTEGER,
  ADD COLUMN IF NOT EXISTS media_duration   REAL,
  ADD COLUMN IF NOT EXISTS media_size       BIGINT,
  ADD COLUMN IF NOT EXISTS media_mime_type  VARCHAR(50);

ALTER TABLE world_messages
  ADD CONSTRAINT world_messages_content_or_media
  CHECK (content IS NOT NULL OR media_url IS NOT NULL);
