-- ============================================================================
-- Notifications — FAANG-grade notification center
-- Deduplication via group_key, soft delete, priority, cursor pagination
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(30) NOT NULL,   -- friend_request, world_mention, message, system, call, security_alert
  title       VARCHAR(200) NOT NULL,
  body        TEXT,
  data        JSONB DEFAULT '{}',     -- sender_id, message_id, count, etc.
  priority    SMALLINT DEFAULT 0,     -- 0=normal, 1=high, 2=urgent
  read        BOOLEAN DEFAULT FALSE,
  group_key   VARCHAR(100),           -- dedup key: e.g. "world_mention:<userId>:<5min_bucket>"
  deleted_at  TIMESTAMPTZ,            -- soft delete (NULL = active)
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Cursor pagination: user's notifications newest first
CREATE INDEX IF NOT EXISTS idx_notif_user_created
  ON notifications(user_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Unread count fast path
CREATE INDEX IF NOT EXISTS idx_notif_user_unread
  ON notifications(user_id)
  WHERE read = FALSE AND deleted_at IS NULL;

-- Dedup lookups by group_key
CREATE INDEX IF NOT EXISTS idx_notif_group_key
  ON notifications(group_key, created_at DESC)
  WHERE group_key IS NOT NULL AND deleted_at IS NULL;

-- Cleanup: find soft-deleted or expired rows
CREATE INDEX IF NOT EXISTS idx_notif_deleted
  ON notifications(deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ─── Row Level Security ─────────────────────────────────────────────────────
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access notifications" ON notifications;
CREATE POLICY "Service role full access notifications" ON notifications
  FOR ALL USING (auth.role() = 'service_role');
