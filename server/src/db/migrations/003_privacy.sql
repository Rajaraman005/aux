-- ============================================================================
-- Privacy & Friend Requests — Enterprise-Grade Schema
-- Adds private account support, secret names, and friend request system
-- ============================================================================

-- ─── Privacy columns on users ───────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS secret_name VARCHAR(100);

-- Unique partial index: secret_name must be unique among non-null values
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_secret_name
  ON users(secret_name)
  WHERE secret_name IS NOT NULL;

-- Fast lookup for privacy filtering
CREATE INDEX IF NOT EXISTS idx_users_private
  ON users(is_private)
  WHERE is_private = TRUE;

-- ─── Friend Requests ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friend_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_friend_request UNIQUE(sender_id, receiver_id),
  CONSTRAINT no_self_request CHECK (sender_id != receiver_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_req_receiver
  ON friend_requests(receiver_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_friend_req_sender
  ON friend_requests(sender_id);

CREATE INDEX IF NOT EXISTS idx_friend_req_status
  ON friend_requests(status);

-- Composite index for fast "are they friends?" lookups
CREATE INDEX IF NOT EXISTS idx_friend_req_accepted_pair
  ON friend_requests(sender_id, receiver_id)
  WHERE status = 'accepted';

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE friend_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access friend_requests" ON friend_requests;
CREATE POLICY "Service role full access friend_requests" ON friend_requests
  FOR ALL USING (auth.role() = 'service_role');
