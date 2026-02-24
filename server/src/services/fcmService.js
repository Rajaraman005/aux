/**
 * Firebase Cloud Messaging (FCM) HTTP v1 Service — Production-Grade.
 *
 * ★ Features:
 *   - FCM HTTP v1 API (modern, recommended by Google)
 *   - OAuth2 access token caching with auto-refresh
 *   - Batch send support (up to 500 per batch)
 *   - Invalid token detection + auto-cleanup callback
 *   - Android notification channel mapping
 *   - Data-only (silent) push support
 *   - Priority levels: HIGH for calls, NORMAL for messages
 *   - Structured error handling with actionable error codes
 *
 * ★ Token Lifecycle:
 *   - Access tokens are cached for 55 minutes (they expire in 60)
 *   - Auto-refreshes before expiry
 *   - Graceful fallback if credentials not configured
 *
 * Setup:
 *   1. Create Firebase project at https://console.firebase.google.com
 *   2. Generate service account key (Project Settings → Service Accounts)
 *   3. Set FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_PATH in .env
 */
const config = require("../config");
const fs = require("fs");
const crypto = require("crypto");

// ─── Constants ──────────────────────────────────────────────────────────────
const FCM_V1_URL = "https://fcm.googleapis.com/v1/projects";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

// ─── Cached Access Token ────────────────────────────────────────────────────
let cachedAccessToken = null;
let tokenExpiresAt = 0;
let serviceAccount = null;

// ─── Error Codes That Mean Token Is Invalid ─────────────────────────────────
const UNRECOVERABLE_ERRORS = new Set([
  "UNREGISTERED",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "SENDER_ID_MISMATCH",
]);

// ─── Metrics ────────────────────────────────────────────────────────────────
const fcmMetrics = {
  sent: 0,
  failed: 0,
  tokensCleaned: 0,
  authRefreshes: 0,
  getStats() {
    return {
      fcm_sent: this.sent,
      fcm_failed: this.failed,
      fcm_tokens_cleaned: this.tokensCleaned,
      fcm_auth_refreshes: this.authRefreshes,
    };
  },
};

// ─── Load Service Account ───────────────────────────────────────────────────
function loadServiceAccount() {
  if (serviceAccount) return serviceAccount;

  const saPath = config.fcm?.serviceAccountPath;
  if (!saPath) {
    console.warn(
      "⚠️  FCM: No service account path configured (FCM_SERVICE_ACCOUNT_PATH)",
    );
    return null;
  }

  try {
    const raw = fs.readFileSync(saPath, "utf8");
    serviceAccount = JSON.parse(raw);
    console.log(
      `✅ FCM: Service account loaded (project: ${serviceAccount.project_id})`,
    );
    return serviceAccount;
  } catch (err) {
    console.warn(
      `⚠️  FCM: Failed to load service account from ${saPath}: ${err.message}`,
    );
    return null;
  }
}

// ─── Generate JWT for OAuth2 ────────────────────────────────────────────────
function generateJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600, // 1 hour
  };

  const encode = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  const unsigned = `${encode(header)}.${encode(payload)}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(unsigned);
  const signature = sign.sign(sa.private_key, "base64url");

  return `${unsigned}.${signature}`;
}

// ─── Get OAuth2 Access Token (Cached) ───────────────────────────────────────
async function getAccessToken() {
  // Return cached if still valid
  if (
    cachedAccessToken &&
    Date.now() < tokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS
  ) {
    return cachedAccessToken;
  }

  const sa = loadServiceAccount();
  if (!sa) return null;

  const jwt = generateJwt(sa);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("FCM: OAuth2 token exchange failed:", err);
    return null;
  }

  const data = await response.json();
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  fcmMetrics.authRefreshes++;

  return cachedAccessToken;
}

// ─── Build FCM V1 Message Payload ───────────────────────────────────────────
/**
 * Build an FCM v1 message payload.
 * @param {string} token - FCM registration token
 * @param {object} options
 * @param {string} options.title - Notification title
 * @param {string} options.body - Notification body
 * @param {object} options.data - Custom data payload (all values must be strings)
 * @param {string} options.priority - 'high' | 'normal'
 * @param {string} options.channelId - Android notification channel
 * @param {boolean} options.dataOnly - If true, send data-only (silent) push
 */
function buildMessage(
  token,
  {
    title,
    body,
    data = {},
    priority = "normal",
    channelId = "messages",
    dataOnly = false,
  },
) {
  // FCM data payload: all values must be strings
  const stringData = {};
  for (const [key, value] of Object.entries(data)) {
    stringData[key] = typeof value === "string" ? value : JSON.stringify(value);
  }

  const message = {
    token,
    data: stringData,
    android: {
      priority: priority === "high" ? "HIGH" : "NORMAL",
      ttl: priority === "high" ? "0s" : "86400s", // Calls: immediate, Messages: 24h
    },
  };

  // Add notification payload (unless data-only / silent push)
  if (!dataOnly && title) {
    message.android.notification = {
      title,
      body,
      channel_id: channelId,
      click_action: "OPEN_APP",
      default_sound: true,
      notification_priority:
        priority === "high" ? "PRIORITY_MAX" : "PRIORITY_HIGH",
      default_vibrate_timings: true,
    };

    // Call notifications: full-screen intent
    if (channelId === "calls") {
      message.android.notification.visibility = "PUBLIC";
      message.android.notification.notification_priority = "PRIORITY_MAX";
    }
  }

  return message;
}

// ─── Send Single Push ───────────────────────────────────────────────────────
/**
 * Send a single FCM push notification.
 * @param {string} token - FCM registration token
 * @param {object} options - See buildMessage
 * @returns {{ success: boolean, error?: string, shouldCleanToken?: boolean }}
 */
async function sendPush(token, options) {
  const projectId = config.fcm?.projectId;
  if (!projectId) {
    console.warn(
      "⚠️  FCM: Project ID not configured (FCM_PROJECT_ID) — push skipped",
    );
    return { success: false, error: "FCM_NOT_CONFIGURED" };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: false, error: "FCM_AUTH_FAILED" };
  }

  const message = buildMessage(token, options);
  const url = `${FCM_V1_URL}/${projectId}/messages:send`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });

    if (response.ok) {
      fcmMetrics.sent++;
      return { success: true };
    }

    const errorBody = await response.json();
    const errorCode =
      errorBody.error?.details?.[0]?.errorCode ||
      errorBody.error?.status ||
      "UNKNOWN";

    fcmMetrics.failed++;

    // Token is permanently invalid — should be cleaned up
    if (UNRECOVERABLE_ERRORS.has(errorCode)) {
      fcmMetrics.tokensCleaned++;
      console.log(
        `🧹 FCM: Invalid token detected (${errorCode}): ${token.slice(0, 20)}...`,
      );
      return { success: false, error: errorCode, shouldCleanToken: true };
    }

    // Auth expired — clear cache so next call refreshes
    if (response.status === 401) {
      cachedAccessToken = null;
      tokenExpiresAt = 0;
    }

    console.error(
      `FCM send error (${response.status}):`,
      JSON.stringify(errorBody),
    );
    return { success: false, error: errorCode };
  } catch (err) {
    fcmMetrics.failed++;
    console.error("FCM network error:", err.message);
    return { success: false, error: "NETWORK_ERROR" };
  }
}

// ─── Send to Multiple Tokens ────────────────────────────────────────────────
/**
 * Send push to multiple FCM tokens (fan-out).
 * Returns array of results for each token.
 * @param {Array<{push_token: string, device_id: string}>} devices
 * @param {object} options - See buildMessage
 * @param {function} onInvalidToken - Callback when a token should be cleaned up
 */
async function sendToDevices(devices, options, onInvalidToken) {
  if (!devices || devices.length === 0) return [];

  const results = [];

  // Send concurrently in batches of 10 to not overwhelm
  const BATCH_SIZE = 10;
  for (let i = 0; i < devices.length; i += BATCH_SIZE) {
    const batch = devices.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (device) => {
        if (!device.push_token) return { success: false, error: "NO_TOKEN" };

        const result = await sendPush(device.push_token, options);

        // Auto-cleanup invalid tokens
        if (result.shouldCleanToken && onInvalidToken) {
          try {
            await onInvalidToken(device.push_token, device.device_id);
          } catch (err) {
            console.error("Token cleanup callback error:", err.message);
          }
        }

        return result;
      }),
    );

    results.push(
      ...batchResults.map((r) =>
        r.status === "fulfilled"
          ? r.value
          : { success: false, error: r.reason?.message },
      ),
    );
  }

  return results;
}

// ─── Health Check ───────────────────────────────────────────────────────────
function isConfigured() {
  return !!(config.fcm?.projectId && loadServiceAccount());
}

module.exports = {
  sendPush,
  sendToDevices,
  buildMessage,
  isConfigured,
  fcmMetrics,
};
