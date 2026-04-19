/**
 * FAANG-grade guaranteed delivery system for critical events.
 * Implements ACK/retry protocol with deduplication, idempotency, and pending event queue.
 */

const logger = require('./logger').default;
const metrics = require('./metrics');
const callSessionStore = require('./callSessionStore');

// In-memory fallback when Redis is unavailable (dev mode).
// Map<userId, Map<seqNum, { message, expiresAt }>>
const memoryPending = new Map();
// Map<userId, Set<seqNum>>
const memoryAcked = new Map();

function getPendingMap(userId) {
  let m = memoryPending.get(userId);
  if (!m) {
    m = new Map();
    memoryPending.set(userId, m);
  }
  return m;
}

function getAckedSet(userId) {
  let s = memoryAcked.get(userId);
  if (!s) {
    s = new Set();
    memoryAcked.set(userId, s);
  }
  return s;
}

// ─── Sequence Number Management ─────────────────────────────────────────────

/**
 * Get next sequence number for a user
 */
async function getNextSequence(userId) {
  const redis = callSessionStore.redis();
  if (!redis) return Date.now();

  try {
    const key = `seq:${userId}`;
    const seqNum = await redis.incr(key);
    // Set expiry to prevent unbounded growth
    await redis.expire(key, 86400); // 24 hours
    return seqNum;
  } catch (err) {
    logger.error('Failed to get sequence number', { userId, error: err.message });
    return Date.now(); // Fallback to timestamp
  }
}

// ─── Critical Event Sending with ACK/Retry ───────────────────────────────────

/**
 * Send critical event with guaranteed delivery
 */
async function sendCriticalEvent(userId, eventType, payload, options = {}) {
  const {
    retryCount = 3,
    retryDelay = 3000,
    timeout = 5000,
  } = options;

  const correlationId = logger.correlationId;
  const seqNum = await getNextSequence(userId);
  const startTime = Date.now();

  const message = {
    type: eventType,
    ...payload,
    _seq: seqNum,
    _ackRequired: true,
    _timestamp: Date.now(),
  };

  // Store for retry
  await storePendingEvent(userId, seqNum, message, timeout);

  try {
    // Send via presence system
    const presence = require('../signaling/presence');
    await presence.sendToUser(userId, message);

    metrics.criticalEventsSent(eventType);
    logger.info('Critical event sent', { correlationId, userId, eventType, seqNum });

    // Start retry timer
    startRetryTimer(userId, seqNum, message, retryCount, retryDelay);

    return { success: true, seqNum };
  } catch (err) {
    logger.error('Failed to send critical event', { correlationId, userId, eventType, error: err.message });
    metrics.redisErrors('send_critical', err.code);
    
    // Retry immediately
    await retryEvent(userId, seqNum, message, retryCount, retryDelay);
    
    return { success: false, seqNum, error: err.message };
  }
}

/**
 * Store pending event for retry
 */
async function storePendingEvent(userId, seqNum, message, ttl) {
  const redis = callSessionStore.redis();
  if (!redis) {
    const expiresAt = Date.now() + ttl;
    getPendingMap(userId).set(String(seqNum), { message, expiresAt });
    return;
  }

  try {
    const key = `pending:${userId}`;
    await redis.hset(key, seqNum, JSON.stringify(message));
    await redis.expire(key, ttl / 1000); // Convert to seconds
  } catch (err) {
    logger.error('Failed to store pending event', { userId, seqNum, error: err.message });
  }
}

/**
 * Start retry timer for critical event
 */
function startRetryTimer(userId, seqNum, message, retryCount, retryDelay) {
  let attempts = 0;

  const timer = setInterval(async () => {
    attempts++;
    
    // Check if already ACKed
    const acked = await isEventAcked(userId, seqNum);
    if (acked) {
      clearInterval(timer);
      return;
    }

    // Retry if under limit
    if (attempts <= retryCount) {
      logger.info(`Retrying critical event (attempt ${attempts})`, { userId, seqNum });
      await retryEvent(userId, seqNum, message, retryCount - attempts, retryDelay);
    } else {
      // Max retries reached - log and give up
      logger.error('Max retries reached for critical event', { userId, seqNum, attempts });
      clearInterval(timer);
      metrics.criticalEventsRetry(message.type);
      
      // Clean up pending event
      await removePendingEvent(userId, seqNum);
    }
  }, retryDelay);
}

/**
 * Retry sending event
 */
async function retryEvent(userId, seqNum, message, remainingRetries, delay) {
  const correlationId = logger.correlationId;

  try {
    const presence = require('../signaling/presence');
    await presence.sendToUser(userId, message);
    
    metrics.criticalEventsRetry(message.type);
    logger.info('Critical event retried', { correlationId, userId, seqNum, remainingRetries });
  } catch (err) {
    logger.error('Failed to retry critical event', { correlationId, userId, seqNum, error: err.message });
  }
}

/**
 * Handle ACK from client
 */
async function handleAck(userId, seqNum, eventType) {
  const correlationId = logger.correlationId;

  try {
    const redis = callSessionStore.redis();
    if (!redis) {
      getAckedSet(userId).add(String(seqNum));
      const pending = memoryPending.get(userId);
      if (pending) pending.delete(String(seqNum));
      metrics.criticalEventsAcked(eventType);
      logger.info('Critical event ACKed (memory)', { correlationId, userId, seqNum, eventType });
      return;
    }

    // Add to ACKed set
    const ackKey = `acked:${userId}`;
    await redis.sadd(ackKey, seqNum);
    await redis.expire(ackKey, 3600); // 1 hour

    // Remove from pending
    await removePendingEvent(userId, seqNum);

    metrics.criticalEventsAcked(eventType);
    logger.info('Critical event ACKed', { correlationId, userId, seqNum, eventType });

    // Clean up old ACKs (keep last 1000)
    await cleanupOldAcks(userId);
  } catch (err) {
    logger.error('Failed to handle ACK', { correlationId, userId, seqNum, error: err.message });
  }
}

/**
 * Check if event is ACKed
 */
async function isEventAcked(userId, seqNum) {
  const redis = callSessionStore.redis();
  if (!redis) return getAckedSet(userId).has(String(seqNum));

  try {
    const ackKey = `acked:${userId}`;
    return await redis.sismember(ackKey, seqNum) === 1;
  } catch (err) {
    return false;
  }
}

/**
 * Remove pending event
 */
async function removePendingEvent(userId, seqNum) {
  const redis = callSessionStore.redis();
  if (!redis) {
    const pending = memoryPending.get(userId);
    if (pending) pending.delete(String(seqNum));
    return;
  }

  try {
    const key = `pending:${userId}`;
    await redis.hdel(key, seqNum);
  } catch (err) {
    logger.error('Failed to remove pending event', { userId, seqNum, error: err.message });
  }
}

/**
 * Clean up old ACKs (keep last 1000)
 */
async function cleanupOldAcks(userId) {
  const redis = callSessionStore.redis();
  if (!redis) {
    const acked = getAckedSet(userId);
    if (acked.size > 1000) {
      const arr = Array.from(acked);
      for (let i = 0; i < arr.length - 1000; i++) acked.delete(arr[i]);
    }
    return;
  }

  try {
    const ackKey = `acked:${userId}`;
    const allAcked = await redis.smembers(ackKey);
    
    if (allAcked.length > 1000) {
      const toRemove = allAcked.slice(0, allAcked.length - 1000);
      await redis.srem(ackKey, ...toRemove);
      logger.info('Cleaned up old ACKs', { userId, count: toRemove.length });
    }
  } catch (err) {
    logger.error('Failed to cleanup old ACKs', { userId, error: err.message });
  }
}

/**
 * Flush pending events on reconnect
 */
async function flushPendingEvents(userId) {
  const correlationId = logger.correlationId;

  try {
    const redis = callSessionStore.redis();
    if (!redis) {
      const pending = memoryPending.get(userId);
      if (!pending || pending.size === 0) return 0;

      const presence = require('../signaling/presence');
      const now = Date.now();
      let sent = 0;

      for (const [seqNum, entry] of pending.entries()) {
        if (!entry || !entry.message) {
          pending.delete(seqNum);
          continue;
        }
        if (entry.expiresAt && now > entry.expiresAt) {
          pending.delete(seqNum);
          continue;
        }
        if (getAckedSet(userId).has(String(seqNum))) {
          pending.delete(seqNum);
          continue;
        }
        try {
          await presence.sendToUser(userId, entry.message);
          sent++;
          metrics.criticalEventsRetry(entry.message.type);
        } catch {}
      }

      if (sent > 0) logger.info(`Flushed ${sent} pending events (memory)`, { correlationId, userId });
      return sent;
    }

    const key = `pending:${userId}`;
    const pending = await redis.hgetall(key);

    const now = Date.now();
    const fresh = [];

    for (const [seq, msg] of Object.entries(pending)) {
      const message = JSON.parse(msg);
      
      // Drop messages older than 30 seconds
      if (now - message._timestamp < 30000) {
        fresh.push(message);
      } else {
        // Remove stale
        await removePendingEvent(userId, seq);
      }
    }

    logger.info(`Flushing ${fresh.length} pending events`, { correlationId, userId });

    const presence = require('../signaling/presence');
    for (const message of fresh) {
      try {
        await presence.sendToUser(userId, message);
        metrics.criticalEventsRetry(message.type);
      } catch (err) {
        logger.error('Failed to flush pending event', { correlationId, userId, seq: message._seq, error: err.message });
      }
    }

    return fresh.length;
  } catch (err) {
    logger.error('Failed to flush pending events', { correlationId, userId, error: err.message });
    return 0;
  }
}

/**
 * Idempotency check for critical operations
 */
async function checkIdempotency(callId, userId, operation) {
  const redis = callSessionStore.redis();
  if (!redis) return null;

  try {
    const key = `idempotent:${callId}:${userId}:${operation}`;
    const existing = await redis.get(key);
    
    if (existing) {
      logger.info('Idempotent operation already processed', { callId, userId, operation });
      return JSON.parse(existing);
    }
    
    return null;
  } catch (err) {
    logger.error('Failed to check idempotency', { callId, userId, operation, error: err.message });
    return null;
  }
}

/**
 * Store idempotency result
 */
async function storeIdempotencyResult(callId, userId, operation, result) {
  const redis = callSessionStore.redis();
  if (!redis) return;

  try {
    const key = `idempotent:${callId}:${userId}:${operation}`;
    await redis.setex(key, 300, JSON.stringify(result)); // 5 minute TTL
  } catch (err) {
    logger.error('Failed to store idempotency result', { callId, userId, operation, error: err.message });
  }
}

module.exports = {
  sendCriticalEvent,
  handleAck,
  isEventAcked,
  removePendingEvent,
  flushPendingEvents,
  checkIdempotency,
  storeIdempotencyResult,
};
