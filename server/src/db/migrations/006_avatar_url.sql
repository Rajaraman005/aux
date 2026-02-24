-- ============================================================================
-- Migration 006: Add avatar_url column for Cloudinary profile pictures
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Index for quick non-null avatar lookups (optional, for analytics)
CREATE INDEX IF NOT EXISTS idx_users_avatar_url ON users(avatar_url) WHERE avatar_url IS NOT NULL;
