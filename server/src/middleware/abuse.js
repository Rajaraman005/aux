/**
 * Abuse Detection Middleware.
 * Tracks failed auth attempts, call spam, and brute-force attacks.
 * Auto-escalating IP blacklisting: 15min → 1hr → 24hr.
 */
const { db } = require("../db/supabase");

// In-memory tracking for fast lookups (synced to DB for persistence)
const failedAttempts = new Map(); // ip -> { count, firstAttempt, blockedUntil }
const THRESHOLDS = {
  failed_login: {
    max: 5,
    windows: [15 * 60 * 1000, 60 * 60 * 1000, 24 * 60 * 60 * 1000],
  }, // 15min, 1hr, 24hr
  call_spam: { max: 10, windows: [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000] },
};

function getKey(ip, action) {
  return `${ip}:${action}`;
}

/**
 * Check if IP is currently blocked for an action.
 */
function isBlocked(ip, action) {
  const key = getKey(ip, action);
  const record = failedAttempts.get(key);
  if (!record || !record.blockedUntil) return false;
  if (Date.now() > record.blockedUntil) {
    // Block expired — reset
    failedAttempts.delete(key);
    return false;
  }
  return true;
}

/**
 * Record a failed attempt and potentially block.
 */
async function recordFailure(ip, action, userId = null) {
  const key = getKey(ip, action);
  const threshold = THRESHOLDS[action] || THRESHOLDS.failed_login;

  let record = failedAttempts.get(key) || {
    count: 0,
    escalation: 0,
    firstAttempt: Date.now(),
  };
  record.count++;

  if (record.count >= threshold.max) {
    // Escalate block duration
    const windowIndex = Math.min(
      record.escalation,
      threshold.windows.length - 1,
    );
    const blockDuration = threshold.windows[windowIndex];
    record.blockedUntil = Date.now() + blockDuration;
    record.escalation++;
    record.count = 0;

    // Persist to DB for cross-instance awareness
    try {
      await db.logAbuse({ ip_address: ip, user_id: userId, action });
    } catch (err) {
      console.error("Failed to log abuse:", err.message);
    }

    console.warn(
      `🚫 IP ${ip} blocked for ${action} — ${blockDuration / 1000}s (escalation ${record.escalation})`,
    );
  }

  failedAttempts.set(key, record);
}

/**
 * Reset failure counter (on successful auth).
 */
function resetFailures(ip, action) {
  failedAttempts.delete(getKey(ip, action));
}

/**
 * Express middleware — block abusive IPs.
 */
function abuseGuard(action) {
  return (req, res, next) => {
    if (isBlocked(req.ip, action)) {
      const record = failedAttempts.get(getKey(req.ip, action));
      const retryAfter = Math.ceil((record.blockedUntil - Date.now()) / 1000);
      return res.status(429).json({
        error: "Too many failed attempts. You are temporarily blocked.",
        code: "IP_BLOCKED",
        retryAfter,
      });
    }
    next();
  };
}

module.exports = { abuseGuard, recordFailure, resetFailures, isBlocked };
