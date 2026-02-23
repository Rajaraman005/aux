/**
 * Push Notification Service — FAANG-Grade.
 *
 * Features:
 *   - Multi-device: sends to ALL user tokens simultaneously
 *   - Token cleanup: auto-deletes DeviceNotRegistered tokens
 *   - Rate limiting: per-user cooldown (configurable per notification type)
 *   - Priority levels: "high" for calls, "default" for messages
 *   - Retry with exponential backoff on transient failures
 *   - Async queue: non-blocking push delivery
 *   - Metrics: tracks sent, failed, and cleaned tokens
 */
const { db } = require("../db/supabase");
const presence = require("../signaling/presence");

// ─── Constants ──────────────────────────────────────────────────────────────
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_BATCH_SIZE = 100;

// ─── Rate Limiting State ────────────────────────────────────────────────────
const pushCooldowns = new Map(); // userId -> { lastPushAt, count }
const RATE_LIMITS = {
  message: { windowMs: 2000, maxPerWindow: 5 }, // 5 pushes per 2s
  call: { windowMs: 10000, maxPerWindow: 2 }, // 2 call pushes per 10s
  missed_call: { windowMs: 30000, maxPerWindow: 3 }, // 3 per 30s
};

// ─── Metrics ────────────────────────────────────────────────────────────────
const pushMetrics = {
  sent: 0,
  failed: 0,
  tokensCleanedUp: 0,
  rateLimited: 0,
  getStats() {
    return {
      push_sent: this.sent,
      push_failed: this.failed,
      push_tokens_cleaned: this.tokensCleanedUp,
      push_rate_limited: this.rateLimited,
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

// ─── Execute Push (with retry) ──────────────────────────────────────────────
async function executePush({ tokens, title, body, data, priority, channelId }) {
  if (!tokens || tokens.length === 0) return;

  // Build Expo push messages
  const messages = tokens.map((tokenEntry) => ({
    to: tokenEntry.token,
    title,
    body,
    data: data || {},
    sound: priority === "high" ? "default" : undefined,
    priority: priority || "default",
    channelId: channelId || "messages",
    badge: 1,
  }));

  // Batch in chunks of 100
  for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
    const batch = messages.slice(i, i + MAX_BATCH_SIZE);
    await sendBatchWithRetry(batch, 0);
  }
}

async function sendBatchWithRetry(batch, attempt) {
  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(batch),
    });

    const result = await response.json();

    if (result.data) {
      for (let i = 0; i < result.data.length; i++) {
        const ticket = result.data[i];
        if (ticket.status === "ok") {
          pushMetrics.sent++;
        } else if (ticket.status === "error") {
          pushMetrics.failed++;

          // Auto-cleanup invalid tokens
          if (
            ticket.details &&
            ticket.details.error === "DeviceNotRegistered"
          ) {
            const token = batch[i].to;
            console.log(
              `🧹 Removing invalid push token: ${token.slice(0, 20)}...`,
            );
            try {
              await db.deletePushToken(token);
              pushMetrics.tokensCleanedUp++;
            } catch (err) {
              console.error("Token cleanup error:", err.message);
            }
          }
        }
      }
    }
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      console.log(`Push retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      return sendBatchWithRetry(batch, attempt + 1);
    }
    console.error("Push delivery failed after retries:", err.message);
    pushMetrics.failed += batch.length;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Send push notification for a new message.
 * Only sends if recipient is offline.
 */
async function sendMessagePush(recipientId, senderName, messagePreview) {
  if (isRateLimited(recipientId, "message")) return;

  // Check if user is online (WebSocket connected) — skip push if online
  const online = await presence.isOnline(recipientId);
  if (online) return;

  const tokens = await db.getPushTokens(recipientId);
  if (tokens.length === 0) return;

  enqueuePush({
    tokens,
    title: senderName,
    body:
      messagePreview.length > 100
        ? messagePreview.slice(0, 100) + "…"
        : messagePreview,
    data: {
      type: "message",
      senderName,
    },
    priority: "default",
    channelId: "messages",
  });
}

/**
 * Send high-priority push for incoming call.
 * Sends even for quick wake-up.
 */
async function sendCallPush(targetUserId, callerId, callerName, callId) {
  if (isRateLimited(targetUserId, "call")) return;

  const tokens = await db.getPushTokens(targetUserId);
  if (tokens.length === 0) return;

  enqueuePush({
    tokens,
    title: "Incoming Call 📞",
    body: `${callerName} is calling you...`,
    data: {
      type: "call",
      callId,
      callerId,
      callerName,
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

  const tokens = await db.getPushTokens(targetUserId);
  if (tokens.length === 0) return;

  enqueuePush({
    tokens,
    title: "Missed Call",
    body: `You missed a call from ${callerName}`,
    data: {
      type: "missed_call",
      callerName,
    },
    priority: "default",
    channelId: "calls",
  });
}

module.exports = {
  sendMessagePush,
  sendCallPush,
  sendMissedCallPush,
  pushMetrics,
};
