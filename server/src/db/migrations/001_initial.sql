-- ============================================================================
-- Video Calling App — PostgreSQL Schema (Supabase)
-- FAANG-grade: proper indexing, constraints, and query optimization
-- ============================================================================

-- Enable trigram extension for fuzzy name search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  password_hash VARCHAR(255) NOT NULL,
  email_verified BOOLEAN DEFAULT FALSE,
  avatar_seed VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fast email lookup (login)
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
-- Trigram index for fuzzy name search
CREATE INDEX IF NOT EXISTS idx_users_name_trgm ON users USING gin(name gin_trgm_ops);
-- Filter verified users for user list
CREATE INDEX IF NOT EXISTS idx_users_verified ON users(email_verified) WHERE email_verified = TRUE;

-- ─── Verification Codes ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS verification_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code VARCHAR(6) NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vcode_user ON verification_codes(user_id);

-- ─── Refresh Tokens (Device-Bound, Single-Use Rotation) ────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,
  device_id VARCHAR(255),
  ip_address INET,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_hash ON refresh_tokens(token_hash);

-- ─── Call Quality Telemetry ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id UUID REFERENCES users(id),
  callee_id UUID REFERENCES users(id),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_ms INTEGER,
  end_reason VARCHAR(50), -- 'normal', 'timeout', 'network_failure', 'rejected'
  avg_packet_loss REAL,
  avg_jitter REAL,
  avg_rtt REAL,
  avg_audio_bitrate INTEGER,
  avg_video_bitrate INTEGER,
  mode_switches INTEGER DEFAULT 0,
  used_sfu BOOLEAN DEFAULT FALSE,
  used_turn BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_caller ON call_logs(caller_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON call_logs(callee_id);
CREATE INDEX IF NOT EXISTS idx_calls_time ON call_logs(started_at DESC);

-- ─── Abuse Tracking ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS abuse_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address INET NOT NULL,
  user_id UUID,
  action VARCHAR(50) NOT NULL, -- 'failed_login', 'call_spam', 'brute_force'
  blocked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_abuse_ip ON abuse_log(ip_address);
CREATE INDEX IF NOT EXISTS idx_abuse_time ON abuse_log(created_at DESC);

-- ─── Row Level Security (Supabase) ──────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE abuse_log ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS — only backend uses service role
-- These policies allow authenticated read of public user data
DROP POLICY IF EXISTS "Users can view verified users" ON users;
CREATE POLICY "Users can view verified users" ON users
  FOR SELECT USING (email_verified = TRUE);

DROP POLICY IF EXISTS "Service role full access users" ON users;
CREATE POLICY "Service role full access users" ON users
  FOR ALL USING (auth.role() = 'service_role');
