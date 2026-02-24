/**
 * Push Notification Service — Enterprise-Grade Native FCM.
 *
 * ★ Complete rewrite: Expo Push API → Native FCM HTTP v1
 *
 * Features:
 *   - Multi-device: sends to ALL active user devices simultaneously
 *   - Token cleanup: auto-deactivates invalid FCM tokens
 *   - Rate limiting: per-user cooldown (configurable per notification type)
 *   - Priority levels: "high" for calls, "normal" for messages
 *   - Retry with exponential backoff on transient failures
 *   - Async queue: non-blocking push delivery
 *   - Notification preferences: respects per-user per-type settings
 *   - Metrics: tracks sent, failed, cleaned tokens, rate-limited
 *   - Deduplication: prevents redundant pushes within cooldown window
 *
 * Architecture:
 *   User Action → Event → Queue → pushService → fcmService → Google → Device
 */
const { db } = require("../db/supabase");
const presence = require("../signaling/presence");
const fcmService = require("./fcmService");

// ─── Constants ──────────────────────────────────────────────────────────────
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

// ─── Rate Limiting State ────────────────────────────────────────────────────
const pushCooldowns = new Map(); // "userId:type" -> { windowStart, count }
const RATE_LIMITS = {
  message: { windowMs: 2000, maxPerWindow: 5 },
  call: { windowMs: 10000, maxPerWindow: 2 },
  missed_call: { windowMs: 30000, maxPerWindow: 3 },
  friend_request: { windowMs: 5000, maxPerWindow: 3 },
  world_mention: { windowMs: 10000, maxPerWindow: 3 },
  system: { windowMs: 60000, maxPerWindow: 5 },
};

// ─── Metrics ────────────────────────────────────────────────────────────────
const pushMetrics = {
  sent: 0,
  failed: 0,
  tokensCleanedUp: 0,
  rateLimited: 0,
  preferencesBlocked: 0,
  getStats() {
    return {
      push_sent: this.sent,
      push_failed: this.failed,
      push_tokens_cleaned: this.tokensCleanedUp,
      push_rate_limited: this.rateLimited,
      push_prefs_blocked: this.preferencesBlocked,
      ...fcmService.fcmMetrics.getStats(),
    };
  },
};

// ─── Async Push Queue ───────────────────────────────────────────────────────
const pushQueue = [];
let isProcessingQueue = false;

function enqueuePush(job) {
  pushQueue.push(job);
  processQueue();
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (pushQueue.length > 0) {
    const job = pushQueue.shift();
    try {
      await executePush(job);
    } catch (err) {
      console.error("Push queue error:", err.message);
    }
  }

  isProcessingQueue = false;
}

// ─── Rate Limit Check ───────────────────────────────────────────────────────
function isRateLimited(userId, type) {
  const limits = RATE_LIMITS[type] || RATE_LIMITS.message;
  const now = Date.now();
  const key = `${userId}:${type}`;
  const state = pushCooldowns.get(key);

  if (!state || now - state.windowStart > limits.windowMs) {
    pushCooldowns.set(key, { windowStart: now, count: 1 });
    return false;
  }

  if (state.count >= limits.maxPerWindow) {
    pushMetrics.rateLimited++;
    return true;
  }

  state.count++;
  return false;
}

// ─── Notification Preferences Check ─────────────────────────────────────────
async function isPushAllowed(userId, type) {
  try {
    const prefs = await db.getNotificationPreference(userId, type);
    // If no preference set, default to enabled
    if (!prefs) return true;
    return prefs.push_enabled !== false;
  } catch (err) {
    // On error, allow push (fail-open for notifications)
    return true;
  }
}

// ─── Execute Push (FCM native) ──────────────────────────────────────────────
async function executePush({
  devices,
  title,
  body,
  data,
  priority,
  channelId,
  dataOnly,
}) {
  if (!devices || devices.length === 0) return;

  // Filter to only devices with FCM tokens
  const fcmDevices = devices.filter(
    (d) => d.push_token && (d.token_type === "fcm" || d.platform === "android"),
  );

  if (fcmDevices.length === 0) return;

  const options = {
    title,
    body,
    data: data || {},
    priority: priority || "normal",
    channelId: channelId || "messages",
    dataOnly: dataOnly || false,
  };

  // Retry wrapper
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      const results = await fcmService.sendToDevices(
        fcmDevices,
        options,
        // Callback for invalid token cleanup
        async (token, deviceId) => {
          try {
            await db.deactivateDeviceByToken(token);
            pushMetrics.tokensCleanedUp++;
            console.log(
              `🧹 Deactivated device with invalid token: ${token.slice(0, 20)}...`,
            );
          } catch (err) {
            console.error("Device deactivation error:", err.message);
          }
        },
      );

      // Count successes/failures
      for (const result of results) {
        if (result.success) {
          pushMetrics.sent++;
        } else {
          pushMetrics.failed++;
        }
      }

      return results;
    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        console.error("Push delivery failed after retries:", err.message);
        pushMetrics.failed += fcmDevices.length;
        return [];
      }
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`Push retry ${attempt}/${MAX_RETRIES} in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Send push notification for a new message.
 * Only sends if recipient is offline and has push enabled.
 */
async function sendMessagePush(recipientId, senderName, messagePreview) {
  if (isRateLimited(recipientId, "message")) return;

  // Check if user is online — skip push if online
  const online = await presence.isOnline(recipientId);
  if (online) return;

  // Check notification preferences
  const allowed = await isPushAllowed(recipientId, "message");
  if (!allowed) {
    pushMetrics.preferencesBlocked++;
    return;
  }

  const devices = await db.getActiveDevices(recipientId);
  if (devices.length === 0) return;

  enqueuePush({
    devices,
    title: senderName,
    body:
      messagePreview.length > 100
        ? messagePreview.slice(0, 100) + "…"
        : messagePreview,
    data: {
      type: "message",
      senderName,
    },
    priority: "normal",
    channelId: "messages",
  });
}

/**
 * Send high-priority push for incoming call.
 * ★ FIX: ALWAYS sends, even if user is online — needed for background/locked screen wake-up.
 *    Unlike message pushes, call pushes must bypass the online check because:
 *    1. App may be backgrounded (WS still connected, but screen locked)
 *    2. Push is the only way to trigger full-screen incoming call on Android
 *    3. Call pushes have their own rate limiting (2 per 10s)
 */
async function sendCallPush(
  targetUserId,
  callerId,
  callerName,
  callId,
  callType = "video",
) {
  if (isRateLimited(targetUserId, "call")) return;

  const allowed = await isPushAllowed(targetUserId, "call");
  if (!allowed) {
    pushMetrics.preferencesBlocked++;
    return;
  }

  const devices = await db.getActiveDevices(targetUserId);
  if (devices.length === 0) return;

  const isVoice = callType === "voice";
  enqueuePush({
    devices,
    title: isVoice ? "Incoming Voice Call" : "Incoming Video Call",
    body: `${callerName} is calling you...`,
    data: {
      type: "call",
      callId,
      callerId,
      callerName,
      callType,
    },
    priority: "high",
    channelId: "calls",
  });
}

/**
 * Send push for missed call.
 */
async function sendMissedCallPush(targetUserId, callerName) {
  if (isRateLimited(targetUserId, "missed_call")) return;

  const allowed = await isPushAllowed(targetUserId, "missed_call");
  if (!allowed) {
    pushMetrics.preferencesBlocked++;
    return;
  }

  const devices = await db.getActiveDevices(targetUserId);
  if (devices.length === 0) return;

  enqueuePush({
    devices,
    title: "Missed Call",
    body: `You missed a call from ${callerName}`,
    data: {
      type: "missed_call",
      callerName,
    },
    priority: "normal",
    channelId: "calls",
  });
}

/**
 * Send push for friend request.
 */
async function sendFriendRequestPush(targetUserId, senderName) {
  if (isRateLimited(targetUserId, "friend_request")) return;

  const allowed = await isPushAllowed(targetUserId, "friend_request");
  if (!allowed) {
    pushMetrics.preferencesBlocked++;
    return;
  }

  const devices = await db.getActiveDevices(targetUserId);
  if (devices.length === 0) return;

  enqueuePush({
    devices,
    title: "Friend Request",
    body: `${senderName} wants to connect with you`,
    data: {
      type: "friend_request",
      senderName,
    },
    priority: "normal",
    channelId: "messages",
  });
}

/**
 * Send silent data-only push (for badge sync, etc.).
 */
async function sendSilentPush(targetUserId, data) {
  const devices = await db.getActiveDevices(targetUserId);
  if (devices.length === 0) return;

  enqueuePush({
    devices,
    data: { type: "silent", ...data },
    dataOnly: true,
    priority: "normal",
  });
}

module.exports = {
  sendMessagePush,
  sendCallPush,
  sendMissedCallPush,
  sendFriendRequestPush,
  sendSilentPush,
  pushMetrics,
};
