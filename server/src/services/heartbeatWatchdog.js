/**
 * FAANG-grade distributed heartbeat watchdog for stale call detection.
 * Uses leader election to ensure only one pod runs the watchdog,
 * preventing duplicate work across multiple instances.
 */

const logger = require('./logger').default;
const metrics = require('./metrics');
const callSessionStore = require('./callSessionStore');

const LEADER_LOCK_KEY = 'heartbeat_watchdog_leader';
const LEADER_LOCK_TTL = 10000; // 10 seconds
const WATCHDOG_INTERVAL = 10000; // Check every 10 seconds
const HEARTBEAT_TIMEOUT = 30000; // 30 seconds without heartbeat = stale

let isLeader = false;
let leaderTimer = null;
let watchdogInterval = null;
let loggedRedisUnavailable = false;

/**
 * Try to become the leader for heartbeat watchdog
 */
async function tryBecomeLeader() {
  const redis = callSessionStore.redis();
  if (!redis) {
    if (!loggedRedisUnavailable) {
      logger.warn('Redis not available, skipping leader election');
      loggedRedisUnavailable = true;
    }
    return false;
  }

  try {
    loggedRedisUnavailable = false;
    const podId = process.env.POD_ID || `pod-${process.pid}-${Date.now()}`;
    const result = await redis.set(LEADER_LOCK_KEY, podId, 'PX', LEADER_LOCK_TTL, 'NX');
    
    if (result === 'OK') {
      if (!isLeader) {
        logger.info('Became heartbeat watchdog leader', { podId });
        isLeader = true;
        metrics.redisCircuitBreakerState(0);
        startWatchdog();
      }
      return true;
    }
    
    // Not the leader
    if (isLeader) {
      logger.info('Lost heartbeat watchdog leadership', { podId });
      isLeader = false;
      stopWatchdog();
    }
    
    return false;
  } catch (err) {
    logger.error('Leader election failed', { error: err.message });
    metrics.redisErrors('leader_election', err.code);
    return false;
  }
}

/**
 * Start the heartbeat watchdog
 */
function startWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
  }

  watchdogInterval = setInterval(async () => {
    try {
      // Renew leadership
      const renewed = await tryBecomeLeader();
      if (!renewed) {
        return;
      }

      // Scan for stale calls
      await scanStaleCalls();
    } catch (err) {
      logger.error('Watchdog error', { error: err.message });
    }
  }, WATCHDOG_INTERVAL);
}

/**
 * Stop the heartbeat watchdog
 */
function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
}

/**
 * Scan for stale calls using Redis SCAN (no KEYS command)
 */
async function scanStaleCalls() {
  const startTime = Date.now();
  const correlationId = logger.correlationId;
  
  try {
    const shardCount = parseInt(process.env.REDIS_SHARD_COUNT || '16');
    const staleCalls = [];
    const now = Date.now();

    for (let shard = 0; shard < shardCount; shard++) {
      const pattern = `call:${shard}:*`;
      let cursor = '0';

      do {
        const redis = callSessionStore.redis();
        if (!redis) break;

        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
        cursor = result[0];
        const keys = result[1];

        for (const key of keys) {
          const call = await redis.hgetall(key);
          if (!call) continue;

          const lastHeartbeat = parseInt(call.lastHeartbeat);
          const age = now - lastHeartbeat;

          if (age > HEARTBEAT_TIMEOUT) {
            staleCalls.push({
              callId: call.callId,
              state: call.state,
              age,
            });
          }
        }
      } while (cursor !== '0');
    }

    // Force end stale calls
    for (const { callId, state, age } of staleCalls) {
      logger.warn('Stale call detected, force ending', { correlationId, callId, state, age });
      metrics.staleCallsDetected();
      await callSessionStore.forceEndCall(callId, 'heartbeat_timeout');
    }

    if (staleCalls.length > 0) {
      logger.info('Stale calls cleaned up', { correlationId, count: staleCalls.length });
    }

    metrics.redisOperations('watchdog_scan', (Date.now() - startTime) / 1000);
  } catch (err) {
    logger.error('Failed to scan stale calls', { correlationId, error: err.message });
    metrics.redisErrors('watchdog_scan', err.code);
  }
}

/**
 * Initialize the heartbeat watchdog
 */
function initialize() {
  if (leaderTimer) return;
  // Try to become leader immediately
  tryBecomeLeader();

  // Periodically try to become leader (in case current leader fails)
  leaderTimer = setInterval(() => {
    tryBecomeLeader();
  }, 5000);
}

/**
 * Shutdown the heartbeat watchdog
 */
function shutdown() {
  stopWatchdog();
  if (leaderTimer) {
    clearInterval(leaderTimer);
    leaderTimer = null;
  }

  // Release leadership if we have it
  if (isLeader) {
    const redis = callSessionStore.redis();
    if (redis) {
      redis.del(LEADER_LOCK_KEY).catch(() => {
        // Ignore errors during shutdown
      });
    }
  }
}

module.exports = {
  tryBecomeLeader,
  scanStaleCalls,
  initialize,
  shutdown,
};
