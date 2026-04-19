-- ═══════════════════════════════════════════════════════════════════════════
-- World Video Chat — Database Migration
-- Tables: world_video_reports, world_video_blocks, world_video_sessions,
--         world_video_tos_accepted
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Session Logs ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS world_video_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user1_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user2_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (
    status IN ('completed', 'timed_out', 'skipped', 'reported', 'disconnected', 'moderation_flag')
  ),
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wvs_user1 ON world_video_sessions(user1_id);
CREATE INDEX IF NOT EXISTS idx_wvs_user2 ON world_video_sessions(user2_id);
CREATE INDEX IF NOT EXISTS idx_wvs_created ON world_video_sessions(created_at);

-- ─── Reports ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS world_video_reports (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL,
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (
    reason IN ('inappropriate', 'harassment', 'spam', 'underage', 'violence', 'other')
  ),
  metadata JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'reviewed', 'actioned', 'dismissed')
  ),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wvr_reported ON world_video_reports(reported_id);
CREATE INDEX IF NOT EXISTS idx_wvr_status ON world_video_reports(status);
CREATE INDEX IF NOT EXISTS idx_wvr_reporter ON world_video_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_wvr_created ON world_video_reports(created_at);

-- ─── Mutual Blocklist ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS world_video_blocks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(user_id, blocked_user_id)
);

CREATE INDEX IF NOT EXISTS idx_wvb_user ON world_video_blocks(user_id);
CREATE INDEX IF NOT EXISTS idx_wvb_blocked ON world_video_blocks(blocked_user_id);

-- ─── Terms of Service Acknowledgment ─────────────────────────────────────────
-- Gate: users must accept ToS before first World Video entry.
-- Re-gate on version update (e.g., new ToS published).
CREATE TABLE IF NOT EXISTS world_video_tos_accepted (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  accepted_at TIMESTAMPTZ DEFAULT NOW(),
  version TEXT NOT NULL DEFAULT '1.0'
);

-- ─── Row Level Security ─────────────────────────────────────────────────────
ALTER TABLE world_video_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_video_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_video_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_video_tos_accepted ENABLE ROW LEVEL SECURITY;

-- Users can view and create their own blocks
CREATE POLICY "Users can view own blocks"
  ON world_video_blocks FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can create own blocks"
  ON world_video_blocks FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own blocks"
  ON world_video_blocks FOR UPDATE
  USING (user_id = auth.uid());

-- Users can view and accept their own TOS
CREATE POLICY "Users can view own TOS"
  ON world_video_tos_accepted FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can accept TOS"
  ON world_video_tos_accepted FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own TOS"
  ON world_video_tos_accepted FOR UPDATE
  USING (user_id = auth.uid());