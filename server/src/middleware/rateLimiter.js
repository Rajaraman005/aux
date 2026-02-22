/**
 * Tiered Rate Limiting.
 * Different limits for auth, API, and call endpoints.
 * Uses sliding window with IP + user combination.
 */
const rateLimit = require("express-rate-limit");
const config = require("../config");

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
});

module.exports = { authLimiter, apiLimiter, callLimiter };
