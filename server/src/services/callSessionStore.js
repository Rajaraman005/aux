/**
 * FAANG-grade Redis-backed call session store with strict state machine.
 * Replaces in-memory activeCalls Map for horizontal scalability and fault tolerance.
 * Features: state machine validation, optimistic locking, circuit breaker, idempotency.
 */

const Redis = require('ioredis');
const CircuitBreaker = require('opossum');
const crypto = require('crypto');
const logger = require('./logger').default;
const metrics = require('./metrics');
const config = require('../config');

// ─── Call State Machine ─────────────────────────────────────────────────────

const CALL_STATES = {
  INIT: 'init',
  RINGING: 'ringing',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ENDING: 'ending',
  ENDED: 'ended',
  FAILED: 'failed',
};

const VALID_TRANSITIONS = {
  [CALL_STATES.INIT]: [CALL_STATES.RINGING, CALL_STATES.FAILED],
  [CALL_STATES.RINGING]: [CALL_STATES.CONNECTING, CALL_STATES.ENDING, CALL_STATES.FAILED],
  [CALL_STATES.CONNECTING]: [CALL_STATES.CONNECTED, CALL_STATES.ENDING, CALL_STATES.FAILED],
  [CALL_STATES.CONNECTED]: [CALL_STATES.ENDING, CALL_STATES.FAILED],
  [CALL_STATES.ENDING]: [CALL_STATES.ENDED],
  [CALL_STATES.ENDED]: [], // Terminal state
  [CALL_STATES.FAILED]: [CALL_STATES.ENDING, CALL_STATES.ENDED],
};

// ─── Redis Cluster Configuration ─────────────────────────────────────────────

let redis;
let redisBreaker;
const inMemoryFallback = new Map(); // Emergency fallback

// Initialize Redis with cluster support
function initializeRedis() {
  if (redis) return redis;

  try {
    const commonRedisOptions = {
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
      // In dev, fail fast and fall back to in-memory instead of endless retries/spam.
      maxRetriesPerRequest: config.isDev ? 1 : 3,
      retryStrategy: (times) => {
        if (config.isDev) return null;
        if (times > 3) return null;
        return Math.min(times * 100, 3000);
      },
      lazyConnect: true,
      connectTimeout: 3000,
      enableOfflineQueue: false,
    };

    // Check if Redis cluster mode is enabled
    if (process.env.REDIS_CLUSTER_MODE === 'true') {
      const nodes = (process.env.REDIS_CLUSTER_NODES || '').split(',').map(node => {
        const [host, port] = node.split(':');
        return { host, port: parseInt(port) || 6379 };
      });

      redis = new Redis.Cluster(nodes, {
        redisOptions: commonRedisOptions,
        enableReadyCheck: true,
        scaleReads: 'slave',
        clusterRetryStrategy: (times) => {
          if (config.isDev) return null;
          if (times > 3) return null;
          return Math.min(times * 100, 3000);
        },
      });
    } else {
      redis = new Redis(config.redis.url, commonRedisOptions);
    }

    redis.on('error', (err) => {
      logger.error('Redis connection error', { error: err.message });
      metrics.redisErrors('connection', err.code);
    });

    redis.on('connect', () => {
      logger.info('Redis connected');
    });

    // Kick off connection attempt (non-blocking). If it fails, we just keep using in-memory.
    redis.connect().catch(() => {});

    // Initialize circuit breaker
    initializeCircuitBreaker();

    return redis;
  } catch (err) {
    logger.error('Failed to initialize Redis', { error: err.message });
    return null;
  }
}

function getRedisClient() {
  if (!redis) return null;
  if (redis.status !== 'ready') return null;
  return redis;
}

// Initialize circuit breaker for Redis operations
function initializeCircuitBreaker() {
  const options = {
    timeout: 1000, // 1 second timeout
    errorThresholdPercentage: 50, // Open if 50% of calls fail
    resetTimeout: 30000, // Try again after 30 seconds
    rollingCountTimeout: 10000, // Consider last 10 seconds
    rollingCountBuckets: 10,
  };

  redisBreaker = new CircuitBreaker(redisOperationWrapper, options);

  redisBreaker.on('open', () => {
    logger.error('Redis circuit breaker OPEN - failing fast to in-memory fallback');
    metrics.redisCircuitBreakerState(1);
  });

  redisBreaker.on('halfOpen', () => {
    logger.warn('Redis circuit breaker HALF-OPEN - testing Redis');
    metrics.redisCircuitBreakerState(2);
  });

  redisBreaker.on('close', () => {
    logger.info('Redis circuit breaker CLOSED - Redis operational');
    metrics.redisCircuitBreakerState(0);
  });
}

// Wrapper for circuit breaker
async function redisOperationWrapper(operation) {
  return await operation();
}

// ─── Helper Functions ───────────────────────────────────────────────────────

// Compute state checksum for Byzantine failure detection
function computeStateChecksum(call) {
  const fields = ['state', 'callerId', 'calleeId', 'startedAt', 'lastHeartbeat'];
  const data = fields.map(f => call[f]).join('|');
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Get Redis key with sharding support
function getCallKey(callId) {
  const shardCount = parseInt(process.env.REDIS_SHARD_COUNT || '16');
  const shard = hash(callId) % shardCount;
  return `call:${shard}:${callId}`;
}

function hash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

// ─── Call Session Operations ─────────────────────────────────────────────────

/**
 * Create a new call session
 */
async function createCall(callData) {
  const startTime = Date.now();
  const correlationId = logger.correlationId;

  try {
    const callId = callData.callId;
    const key = getCallKey(callId);

    const session = {
      ...callData,
      state: CALL_STATES.INIT,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      version: 0,
      checksum: null,
      podId: process.env.POD_ID || `pod-${process.pid}-${Date.now()}`,
    };

    session.checksum = computeStateChecksum(session);

    const client = getRedisClient();
    if (!client) {
      inMemoryFallback.set(callId, session);
      logger.warn('Call session created in-memory fallback', { correlationId, callId });
      return session;
    }

    const result = await redisBreaker.fire(async () => {
      await client.hset(key, session);
      await client.expire(key, 300); // 5 minute TTL
      return true;
    });

    if (result) {
      metrics.redisOperations('create', (Date.now() - startTime) / 1000);
      logger.info('Call session created', { correlationId, callId });
      metrics.callStateTransitions('none', CALL_STATES.INIT);
      return session;
    }

    // Fallback to in-memory
    inMemoryFallback.set(callId, session);
    logger.warn('Call session created in-memory fallback', { correlationId, callId });
    return session;
  } catch (err) {
    logger.error('Failed to create call session', { correlationId, error: err.message });
    metrics.redisErrors('create', err.code);
    // Fallback to in-memory
    inMemoryFallback.set(callData.callId, callData);
    return callData;
  }
}

/**
 * Get call session with validation
 */
async function getCall(callId) {
  const startTime = Date.now();
  const correlationId = logger.correlationId;

  try {
    const key = getCallKey(callId);

    const client = getRedisClient();
    if (!client) {
      return inMemoryFallback.get(callId) || null;
    }

    const call = await redisBreaker.fire(async () => {
      const data = await client.hgetall(key);
      if (!data || Object.keys(data).length === 0) return null;
      
      // Validate checksum
      const expectedChecksum = computeStateChecksum(data);
      if (data.checksum && data.checksum !== expectedChecksum) {
        logger.error('State corruption detected', { correlationId, callId, expected: expectedChecksum, actual: data.checksum });
        metrics.ghostConnections();
        // Force end call on corruption
        await forceEndCall(callId, 'state_corruption');
        return null;
      }

      // Check if expired
      const age = Date.now() - parseInt(data.lastHeartbeat);
      if (age > 300000) { // 5 minutes
        logger.warn('Call session expired', { correlationId, callId, age });
        await client.del(key);
        return null;
      }

      return data;
    });

    metrics.redisOperations('get', (Date.now() - startTime) / 1000);
    return call;
  } catch (err) {
    logger.error('Failed to get call session', { correlationId, error: err.message });
    metrics.redisErrors('get', err.code);
    // Fallback to in-memory
    return inMemoryFallback.get(callId) || null;
  }
}

/**
 * Transition call state with validation and optimistic locking
 */
async function transitionCallState(callId, newState, expectedVersion = null) {
  const startTime = Date.now();
  const correlationId = logger.correlationId;

  try {
    const key = getCallKey(callId);

    // Validate transition
    const current = await getCall(callId);
    if (!current) {
      throw new Error(`Call ${callId} not found`);
    }

    const currentState = current.state;
    if (!VALID_TRANSITIONS[currentState]?.includes(newState)) {
      logger.error('Invalid state transition', { correlationId, callId, from: currentState, to: newState });
      throw new Error(`Invalid transition: ${currentState} → ${newState}`);
    }

    // Check version if provided (optimistic locking)
    const currentVersion = parseInt(current.version || '0');
    if (expectedVersion !== null && currentVersion !== expectedVersion) {
      logger.warn('Version conflict - retry', { correlationId, callId, expected: expectedVersion, actual: currentVersion });
      throw new Error('Version conflict - retry');
    }

    const client = getRedisClient();
    if (!client) {
      const updated = {
        ...current,
        state: newState,
        version: currentVersion + 1,
        lastHeartbeat: Date.now(),
      };
      updated.checksum = computeStateChecksum(updated);
      inMemoryFallback.set(callId, updated);

      metrics.callStateTransitions(currentState, newState);
      logger.info('Call state transitioned (in-memory)', {
        correlationId,
        callId,
        from: currentState,
        to: newState,
        version: currentVersion + 1,
      });

      return currentVersion + 1;
    }

    // Watch key for changes
    await client.watch(key);

    // Transaction
    const tx = client.multi();
    tx.hset(key, 'state', newState);
    tx.hset(key, 'version', currentVersion + 1);
    tx.hset(key, 'lastHeartbeat', Date.now());
    
    // Recompute checksum
    const updatedData = { ...current, state: newState, version: currentVersion + 1, lastHeartbeat: Date.now() };
    tx.hset(key, 'checksum', computeStateChecksum(updatedData));

    const results = await tx.exec();

    if (!results) {
      await client.unwatch();
      throw new Error('Transaction failed - key modified');
    }

    metrics.redisOperations('transition', (Date.now() - startTime) / 1000);
    logger.info('Call state transitioned', { correlationId, callId, from: currentState, to: newState, version: currentVersion + 1 });
    metrics.callStateTransitions(currentState, newState);

    return currentVersion + 1;
  } catch (err) {
    logger.error('Failed to transition call state', { correlationId, callId, error: err.message });
    metrics.redisErrors('transition', err.code);
    throw err;
  }
}

/**
 * Force end a call (emergency cleanup)
 */
async function forceEndCall(callId, reason) {
  const startTime = Date.now();
  const correlationId = logger.correlationId;

  try {
    const key = getCallKey(callId);
    const call = await getCall(callId);

    if (!call || call.state === CALL_STATES.ENDED) {
      return;
    }

    const client = getRedisClient();
    if (!client) {
      const updated = {
        ...call,
        state: CALL_STATES.ENDED,
        endReason: reason,
        endedAt: Date.now(),
        lastHeartbeat: Date.now(),
      };
      updated.checksum = computeStateChecksum(updated);
      inMemoryFallback.set(callId, updated);
      metrics.callStateTransitions(call.state, CALL_STATES.ENDED);
      logger.warn('Call force ended (in-memory)', { correlationId, callId, reason });
      return;
    }

    const tx = client.multi();
    tx.hset(key, 'state', CALL_STATES.ENDED);
    tx.hset(key, 'endReason', reason);
    tx.hset(key, 'endedAt', Date.now());
    tx.hset(key, 'lastHeartbeat', Date.now());

    const results = await tx.exec();

    if (results) {
      metrics.redisOperations('force_end', (Date.now() - startTime) / 1000);
      logger.warn('Call force ended', { correlationId, callId, reason });
      metrics.callStateTransitions(call.state, CALL_STATES.ENDED);
      
      // Delete after delay
      setTimeout(async () => {
        try {
          await client.del(key);
        } catch (err) {
          // Ignore delete errors
        }
      }, 5000);
    }
  } catch (err) {
    logger.error('Failed to force end call', { correlationId, callId, error: err.message });
    metrics.redisErrors('force_end', err.code);
  }
}

/**
 * Delete call session
 */
async function deleteCall(callId) {
  const startTime = Date.now();
  const correlationId = logger.correlationId;

  try {
    const key = getCallKey(callId);

    const client = getRedisClient();
    if (!client) {
      inMemoryFallback.delete(callId);
      logger.info('Call session deleted (in-memory)', { correlationId, callId });
      return;
    }

    await redisBreaker.fire(async () => {
      await client.del(key);
    });

    metrics.redisOperations('delete', (Date.now() - startTime) / 1000);
    inMemoryFallback.delete(callId);
    logger.info('Call session deleted', { correlationId, callId });
  } catch (err) {
    logger.error('Failed to delete call session', { correlationId, error: err.message });
    metrics.redisErrors('delete', err.code);
    inMemoryFallback.delete(callId);
  }
}

/**
 * Update call heartbeat
 */
async function updateHeartbeat(callId) {
  const startTime = Date.now();
  const correlationId = logger.correlationId;

  try {
    const key = getCallKey(callId);

    const client = getRedisClient();
    if (!client) {
      const call = inMemoryFallback.get(callId);
      if (call) {
        call.lastHeartbeat = Date.now();
        call.checksum = computeStateChecksum(call);
        inMemoryFallback.set(callId, call);
      }
      metrics.heartbeatReceived();
      return;
    }

    await redisBreaker.fire(async () => {
      await client.hset(key, 'lastHeartbeat', Date.now());
    });

    metrics.redisOperations('heartbeat', (Date.now() - startTime) / 1000);
    metrics.heartbeatReceived();
  } catch (err) {
    logger.error('Failed to update heartbeat', { correlationId, callId, error: err.message });
    metrics.redisErrors('heartbeat', err.code);
  }
}

/**
 * Get all active calls (for watchdog)
 */
async function getAllActiveCalls() {
  const startTime = Date.now();
  const correlationId = logger.correlationId;

  try {
    const shardCount = parseInt(process.env.REDIS_SHARD_COUNT || '16');
    const allCalls = [];

    const client = getRedisClient();
    if (!client) {
      return Array.from(inMemoryFallback.values());
    }

    for (let shard = 0; shard < shardCount; shard++) {
      const pattern = `call:${shard}:*`;
      let cursor = '0';

      do {
        const result = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = result[0];
        const keys = result[1];

        for (const key of keys) {
          const call = await client.hgetall(key);
          if (call && call.state === CALL_STATES.CONNECTED) {
            allCalls.push(call);
          }
        }
      } while (cursor !== '0');
    }

    metrics.redisOperations('scan_all', (Date.now() - startTime) / 1000);
    return allCalls;
  } catch (err) {
    logger.error('Failed to get all active calls', { correlationId, error: err.message });
    metrics.redisErrors('scan_all', err.code);
    return Array.from(inMemoryFallback.values());
  }
}

// Initialize Redis on module load
initializeRedis();

module.exports = {
  CALL_STATES,
  VALID_TRANSITIONS,
  createCall,
  getCall,
  transitionCallState,
  forceEndCall,
  deleteCall,
  updateHeartbeat,
  getAllActiveCalls,
  redis: () => getRedisClient(),
  isRedisReady: () => !!getRedisClient(),
  circuitBreaker: () => redisBreaker,
};
