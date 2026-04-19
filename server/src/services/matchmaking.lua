-- ═══════════════════════════════════════════════════════════════════════════
-- Atomic Matchmaking Script for World Video Chat
--
-- Executed atomically on Redis (single-threaded = no race conditions).
-- Two concurrent pods CANNOT interleave — one executes at a time.
--
-- KEYS[1] = world:queue
-- ARGV[1] = current timestamp (seconds)
--
-- Returns: {sessionId, user1, user2, token1, token2} on success
-- Returns: nil on failure (not enough users, stale, or blocked)
-- ═══════════════════════════════════════════════════════════════════════════

-- Step 1: Peek at queue — need at least 2 users
local queueLen = redis.call('LLEN', 'world:queue')
if queueLen < 2 then
  return nil
end

-- Step 2: Read first two users without popping (peek for validation)
local users = redis.call('LRANGE', 'world:queue', 0, 1)
if #users < 2 then
  return nil
end
local user1 = users[1]
local user2 = users[2]

-- Step 3: Check skip key (blocklist deadlock prevention)
-- If we recently tried matching these two and they were blocked,
-- skip for 60s to prevent infinite retry loops.
-- Check both orderings since either user could be first in queue.
local skipKey1 = 'world:match:skip:' .. user1 .. ':' .. user2
local skipKey2 = 'world:match:skip:' .. user2 .. ':' .. user1
local skipped1 = redis.call('GET', skipKey1)
local skipped2 = redis.call('GET', skipKey2)
if skipped1 or skipped2 then
  -- Shuffle user1 to back of queue to try different combinations
  redis.call('LPOP', 'world:queue')
  redis.call('RPUSH', 'world:queue', user1)
  return nil
end

-- Step 4: Validate both users are still queued (not matched/disconnected)
local state1 = redis.call('HGET', 'world:user:' .. user1, 'status')
local state2 = redis.call('HGET', 'world:user:' .. user2, 'status')

if state1 ~= 'queued' then
  -- user1 is stale — remove from queue so we don't retry them
  redis.call('LREM', 'world:queue', 1, user1)
  return nil
end

if state2 ~= 'queued' then
  -- user2 is stale — remove from queue, user1 stays
  redis.call('LREM', 'world:queue', 1, user2)
  return nil
end

-- Step 5: Check mutual blocklist (bidirectional)
local blocked1 = redis.call('SISMEMBER', 'world:blocklist:' .. user1, user2)
local blocked2 = redis.call('SISMEMBER', 'world:blocklist:' .. user2, user1)
if blocked1 == 1 or blocked2 == 1 then
  -- Blocked — set skip key to prevent infinite retry loop (60s TTL)
  redis.call('SETEX', skipKey1, 60, '1')

  -- Shuffle user1 to back of queue to try different combinations
  redis.call('LPOP', 'world:queue')
  redis.call('RPUSH', 'world:queue', user1)
  return nil
end

-- Step 6: Atomic match — pop both users from queue
redis.call('LPOP', 'world:queue')  -- pop user1
redis.call('LPOP', 'world:queue')  -- pop user2 (was user2, now at index 0)

-- Step 7: Create session
local sessionId = redis.call('INCR', 'world:session:counter')
local sessionKey = 'world:session:' .. sessionId
local now = ARGV[1]

redis.call('HMSET', sessionKey,
  'user1', user1,
  'user2', user2,
  'startedAt', now,
  'expiresAt', now + 180,
  'status', 'matched'
)
redis.call('EXPIRE', sessionKey, 210)

-- Step 8: Create ephemeral tokens (scoped to this session)
local tokenCounter1 = redis.call('INCR', 'world:token:counter')
local tokenCounter2 = redis.call('INCR', 'world:token:counter')
local token1 = 'eph_' .. tokenCounter1 .. '_' .. sessionId
local token2 = 'eph_' .. tokenCounter2 .. '_' .. sessionId

-- Step 9: Update user states with ephemeral tokens and roles
redis.call('HMSET', 'world:user:' .. user1,
  'status', 'matched',
  'sessionId', sessionId,
  'matchedWith', user2,
  'role', 'caller',
  'ephemeralToken', token1,
  'peerToken', token2
)
redis.call('HMSET', 'world:user:' .. user2,
  'status', 'matched',
  'sessionId', sessionId,
  'matchedWith', user1,
  'role', 'callee',
  'ephemeralToken', token2,
  'peerToken', token1
)

-- Step 10: Store token → userId mapping (for report lookups and signaling)
redis.call('SET', 'world:token:' .. token1, user1, 'EX', 210)
redis.call('SET', 'world:token:' .. token2, user2, 'EX', 210)

-- Return match result
return {sessionId, user1, user2, token1, token2}