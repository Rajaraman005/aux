const { db } = require("../db/supabase");
const presence = require("../signaling/presence");
const fcmService = require("./fcmService");
const expoPushService = require("./expoPushService");

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
      ...expoPushService.expoMetrics.getStats(),
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

// ─── Token Cleanup Callback ─────────────────────────────────────────────────
async function cleanupInvalidToken(token, deviceId) {
  try {
    await db.deactivateDeviceByToken(token);
    pushMetrics.tokensCleanedUp++;
    console.log(
      `🧹 Deactivated device with invalid token: ${token.slice(0, 20)}...`,
    );
  } catch (err) {
    console.error("Device deactivation error:", err.message);
  }
}

// ─── Execute Push (Dual-Mode: FCM + Expo) ──────────────────────────────────
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

  // ★ Split devices by token type: FCM vs Expo
  const fcmDevices = devices.filter(
    (d) =>
      d.push_token &&
      !expoPushService.isExpoToken(d.push_token) &&
      (d.token_type === "fcm" || d.platform === "android"),
  );
  const expoDevices = devices.filter(
    (d) =>
      d.push_token &&
      (d.token_type === "expo" || expoPushService.isExpoToken(d.push_token)),
  );

  if (fcmDevices.length === 0 && expoDevices.length === 0) {
    console.log("⚠️  No valid push tokens found for any device");
    return;
  }

  const options = {
    title,
    body,
    data: data || {},
    priority: priority || "normal",
    channelId: channelId || "messages",
    dataOnly: dataOnly || false,
  };

  // ★ Send to both FCM and Expo devices in parallel
  const promises = [];

  // ── FCM Path ──────────────────────────────────────────────────────────
  if (fcmDevices.length > 0) {
    console.log(`📤 Sending FCM push to ${fcmDevices.length} device(s)`);
    promises.push(sendViaFCM(fcmDevices, options));
  }

  // ── Expo Path ─────────────────────────────────────────────────────────
  if (expoDevices.length > 0) {
    console.log(`📤 Sending Expo push to ${expoDevices.length} device(s)`);
    promises.push(sendViaExpo(expoDevices, options));
  }

  const allResults = await Promise.allSettled(promises);
  return allResults.flatMap((r) =>
    r.status === "fulfilled"
      ? r.value
      : [{ success: false, error: r.reason?.message }],
  );
}

// ─── FCM Send with Retries ──────────────────────────────────────────────────
async function sendViaFCM(fcmDevices, options) {
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      const results = await fcmService.sendToDevices(
        fcmDevices,
        options,
        cleanupInvalidToken,
      );

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
        console.error("FCM push failed after retries:", err.message);
        pushMetrics.failed += fcmDevices.length;
        return [];
      }
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`FCM retry ${attempt}/${MAX_RETRIES} in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Expo Push Send ─────────────────────────────────────────────────────────
async function sendViaExpo(expoDevices, options) {
  try {
    const results = await expoPushService.sendToDevices(
      expoDevices,
      options,
      cleanupInvalidToken,
    );

    for (const result of results) {
      if (result.success) {
        pushMetrics.sent++;
      } else {
        pushMetrics.failed++;
      }
    }

    return results;
  } catch (err) {
    console.error("Expo push error:", err.message);
    pushMetrics.failed += expoDevices.length;
    return [];
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Send push notification for a new message.
 * Always sends push regardless of online status — the user's app may be
 * backgrounded with WebSocket still alive, unable to display the message.
 * The mobile foreground handler will suppress the notification if the user
 * is actively viewing the chat.
 */
async function sendMessagePush(recipientId, senderName, messagePreview, conversationId) {
  if (isRateLimited(recipientId, "message")) return;

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
      conversationId: conversationId || "",
    },
    priority: "high",
    channelId: "messages",
  });
}

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
  const callTitle = isVoice ? "Incoming Voice Call" : "Incoming Video Call";
  const callBody = `${callerName} is calling you...`;

  // ★ Send TWO pushes for maximum reliability:
  //
  // 1. Data-only (high priority) — triggers setBackgroundMessageHandler
  //    when app is backgrounded. The JS handler creates a full-screen
  //    Notifee notification with Accept/Decline buttons.
  //    Does NOT work when app is killed on Android 12+.
  //
  // 2. Notification+data (high priority) — auto-displayed by Android
  //    when app is killed/force-stopped. Tapping it opens the app.
  //    When app is backgrounded, Android auto-displays this AND the
  //    data-only message triggers the JS handler. The mobile handler
  //    replaces the basic Android notification with the Notifee one.

  // Push 1: Data-only for background JS handler
  enqueuePush({
    devices,
    title: callTitle,
    body: callBody,
    data: {
      type: "call",
      callId,
      callerId,
      callerName,
      callType,
      notifTitle: callTitle,
      notifBody: callBody,
    },
    priority: "high",
    channelId: "calls",
    dataOnly: true,
  });

  // Push 2: Notification+data for killed app fallback
  enqueuePush({
    devices,
    title: callTitle,
    body: callBody,
    data: {
      type: "call",
      callId,
      callerId,
      callerName,
      callType,
      notifTitle: callTitle,
      notifBody: callBody,
    },
    priority: "high",
    channelId: "calls",
    dataOnly: false,
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
