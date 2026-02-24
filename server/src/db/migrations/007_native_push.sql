-- ============================================================================
-- Native Push Notification Infrastructure — FCM/APNs
-- Replaces Expo push tokens with native device tracking
-- Adds notification preferences per user per type
-- ============================================================================

-- ─── user_devices: multi-device native push token storage ───────────────────
-- Each user can have multiple active devices, each with its own FCM token.
-- Replaces the legacy push_tokens table.
CREATE TABLE IF NOT EXISTS user_devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     VARCHAR(255) NOT NULL,              -- unique hardware/install id
  platform      VARCHAR(10) NOT NULL DEFAULT 'android',  -- 'android' | 'ios'
  push_token    TEXT,                               -- FCM registration token or APNs device token
  token_type    VARCHAR(10) NOT NULL DEFAULT 'fcm', -- 'fcm' | 'apns'
  app_version   VARCHAR(20),                        -- e.g. '1.0.1'
  os_version    VARCHAR(20),                        -- e.g. 'Android 14'
  device_name   VARCHAR(100),                       -- e.g. 'Pixel 8 Pro'
  is_active     BOOLEAN DEFAULT TRUE,               -- set FALSE on logout, TRUE on login
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, device_id)                        -- one entry per user+device pair
);

-- Active devices for a user (multi-device push fan-out)
CREATE INDEX IF NOT EXISTS idx_devices_user_active
  ON user_devices(user_id)
  WHERE is_active = TRUE;

-- Token lookup for cleanup on invalid/expired tokens
CREATE INDEX IF NOT EXISTS idx_devices_push_token
  ON user_devices(push_token)
  WHERE push_token IS NOT NULL;

-- Stale device cleanup (devices not seen in 90+ days)
CREATE INDEX IF NOT EXISTS idx_devices_last_seen
  ON user_devices(last_seen_at);


-- ─── notification_preferences: per-user, per-type notification settings ─────
-- Controls which notification types a user wants to receive and how.
CREATE TABLE IF NOT EXISTS notification_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(30) NOT NULL,             -- 'message', 'call', 'missed_call', 'friend_request', 'world_mention', 'system'
  push_enabled    BOOLEAN DEFAULT TRUE,             -- receive push notifications
  in_app_enabled  BOOLEAN DEFAULT TRUE,             -- show in-app banners
  sound_enabled   BOOLEAN DEFAULT TRUE,             -- play notification sound
  vibrate_enabled BOOLEAN DEFAULT TRUE,             -- vibrate on notification
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, type)                             -- one preference per user per type
);

-- Fast preference lookup by user
CREATE INDEX IF NOT EXISTS idx_prefs_user
  ON notification_preferences(user_id);


-- ─── Row Level Security ─────────────────────────────────────────────────────
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access user_devices" ON user_devices;
CREATE POLICY "Service role full access user_devices" ON user_devices
  FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role full access notification_preferences" ON notification_preferences;
CREATE POLICY "Service role full access notification_preferences" ON notification_preferences
  FOR ALL USING (auth.role() = 'service_role');
