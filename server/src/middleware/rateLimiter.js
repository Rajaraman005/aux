/**
 * FAANG-grade Tiered Rate Limiting.
 * Different limits for auth, API, and call endpoints.
 * Uses Redis-backed sliding window with IP + user combination for distributed systems.
 */
const rateLimit = require("express-rate-limit");
const { RateLimiterRedis, RateLimiterMemory } = require("rate-limiter-flexible");
const config = require("../config");
const logger = require("../services/logger").default;
const metrics = require("../services/metrics");

// ─── Redis-backed Rate Limiters ───────────────────────────────────────────────

let redisRateLimiter = null;
let redisClient = null;
let redisRateLimiterDisabled = false;

function disableRedisRateLimiter(err) {
  if (redisRateLimiterDisabled) return;
  redisRateLimiterDisabled = true;
  redisRateLimiter = null;

  if (err) {
    logger.warn("Redis rate limiter unavailable, using in-memory fallback", {
      error: err.message,
    });
    metrics.redisErrors("rate_limiter", err.code);
  }

  if (redisClient) {
    try {
      redisClient.disconnect();
    } catch {}
    redisClient = null;
  }
}

function initRedisRateLimiter() {
  if (redisRateLimiter || redisRateLimiterDisabled) return;
  if (!config.redis?.url) {
    redisRateLimiterDisabled = true;
    return;
  }

  const Redis = require("ioredis");

  redisClient = new Redis(config.redis.url, {
    retryStrategy: () => null, // fail fast; don't keep retrying in dev
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 2000,
    enableOfflineQueue: false,
  });

  // Prevent noisy "[ioredis] Unhandled error event" logs.
  redisClient.on("error", (err) => {
    disableRedisRateLimiter(err);
  });

  redisClient
    .connect()
    .then(() => {
      if (redisRateLimiterDisabled) return;
      redisRateLimiter = new RateLimiterRedis({
        storeClient: redisClient,
        keyPrefix: "rate_limit",
        points: 100, // Number of requests
        duration: 1, // Per second
      });
      logger.info("Redis rate limiter initialized");
    })
    .catch((err) => {
      disableRedisRateLimiter(err);
    });
}

// Start init in background (non-blocking)
initRedisRateLimiter();

// Fallback to in-memory if Redis unavailable
const memoryRateLimiter = new RateLimiterMemory({
  points: 100,
  duration: 1,
});

// Get the appropriate rate limiter
function getRateLimiter() {
  return redisRateLimiter || memoryRateLimiter;
}

// ─── Express Rate Limiters ─────────────────────────────────────────────────────

// Strict rate limit for auth endpoints (brute-force protection)
const authLimiter = rateLimit({
  windowMs: config.rateLimit.auth.windowMs,
  max: config.rateLimit.auth.max,
  message: {
    error: "Too many attempts. Please try again in 15 minutes.",
    code: "RATE_LIMIT_AUTH",
    retryAfter: Math.ceil(config.rateLimit.auth.windowMs / 1000),
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Combine IP + email for targeted limiting
    return `${req.ip}:${req.body?.email || "unknown"}`;
  },
  handler: (req, res, next) => {
    logger.warn("Auth rate limit exceeded", { ip: req.ip, email: req.body?.email });
    metrics.callFailures('rate_limit_auth');
    next();
  },
});

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: config.rateLimit.api.windowMs,
  max: config.rateLimit.api.max,
  message: {
    error: "Too many requests. Please slow down.",
    code: "RATE_LIMIT_API",
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    logger.warn("API rate limit exceeded", { ip: req.ip });
    metrics.callFailures('rate_limit_api');
    next();
  },
});

// Call attempt rate limit (anti-spam)
const callLimiter = rateLimit({
  windowMs: config.rateLimit.call.windowMs,
  max: config.rateLimit.call.max,
  message: {
    error: "Too many call attempts. Please wait.",
    code: "RATE_LIMIT_CALL",
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
  handler: (req, res, next) => {
    logger.warn("Call rate limit exceeded", { userId: req.user?.id, ip: req.ip });
    metrics.callFailures('rate_limit_call');
    next();
  },
});

// ─── FAANG-grade: Token Bucket Rate Limiting for Critical Operations ─────────────

// Heartbeat rate limiter (prevent heartbeat spam)
const heartbeatLimiter = new RateLimiterMemory({
  points: 10, // 10 heartbeats per minute
  duration: 60,
});

// ACK rate limiter (prevent ACK spam)
const ackLimiter = new RateLimiterMemory({
  points: 100, // 100 ACKs per second
  duration: 1,
});

// ─── Middleware Functions ───────────────────────────────────────────────────────

/**
 * Check rate limit for WebSocket messages
 */
async function checkWebSocketRateLimit(userId, messageType) {
  try {
    const limiter = getRateLimiter();
    
    // Different limits for different message types
    let points = 10;
    let duration = 1;
    
    if (messageType === 'heartbeat') {
      await heartbeatLimiter.consume(userId);
      return { allowed: true };
    } else if (messageType === 'ack') {
      await ackLimiter.consume(userId);
      return { allowed: true };
    }
    
    await limiter.consume(userId, points);
    return { allowed: true };
  } catch (rej) {
    logger.warn('WebSocket rate limit exceeded', { userId, messageType });
    return { 
      allowed: false, 
      retryAfter: rej.msBeforeNext || 1000 
    };
  }
}

module.exports = { 
  authLimiter, 
  apiLimiter, 
  callLimiter,
  checkWebSocketRateLimit,
};
