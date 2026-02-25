/**
 * index.js — App Entry Point with Background Handler Registration.
 *
 * ★ CRITICAL: This file MUST be the entry point ("main" in package.json).
 * React Native's headless JS task runner loads this file BEFORE any
 * React component mounts. Background message handlers MUST be registered
 * here at the top level — NOT inside a component's useEffect or inside
 * a lazily-loaded module.
 *
 * When the app is killed and an FCM data-only push arrives:
 *   1. Android wakes the app process
 *   2. React Native boots the Hermes/JSC engine
 *   3. This file (index.js) is executed
 *   4. setBackgroundMessageHandler runs the callback
 *   5. The callback uses Notifee to display the notification
 *   6. The process goes back to sleep
 *
 * If this handler is NOT registered here, step 4 never happens and
 * the push silently dies — which is exactly the bug we're fixing.
 */

import { AppRegistry, Platform } from "react-native";
import { expo as appConfig } from "./app.json";
import App from "./App";

// ─── GLOBAL ERROR HANDLERS (MUST be first) ──────────────────────────────────
// ★ These prevent "AUX keeps stopping" by catching unhandled errors
// and logging them instead of letting them crash the app process.
import crashLogger, { CATEGORIES } from "./src/services/CrashLogger";

// 1. Catch all unhandled JS exceptions (synchronous throws, etc.)
const defaultHandler = ErrorUtils.getGlobalHandler();
ErrorUtils.setGlobalHandler((error, isFatal) => {
  try {
    crashLogger.log(
      CATEGORIES.CRASH_DETECTED,
      `Unhandled ${isFatal ? "FATAL" : "non-fatal"} JS error`,
      error,
    );
  } catch (_) {
    // CrashLogger itself failed — don't make things worse
  }

  if (isFatal) {
    // ★ ALWAYS forward fatal errors to the default handler.
    // Swallowing fatals causes a white screen because the app state is corrupt.
    // The ErrorBoundary in App.js handles React-level errors with a recovery UI.
    defaultHandler?.(error, isFatal);
  }
  // Non-fatal: log only, do not crash
});

// 2. Catch unhandled Promise rejections (wrapped in try-catch for safety)
try {
  const tracking = require("promise/setimmediate/rejection-tracking");
  tracking.enable({
    allRejections: true,
    onUnhandled: (_id, error) => {
      try {
        crashLogger.log(
          CATEGORIES.PROMISE_REJECTION,
          "Unhandled Promise rejection",
          error instanceof Error ? error : new Error(String(error)),
        );
      } catch (_) {}
      // ★ Do NOT re-throw — swallow to prevent crash
    },
    onHandled: () => {},
  });
} catch (_) {
  // Module not available in this RN version — that's fine,
  // the global error handler above catches most issues anyway.
}

crashLogger.log(CATEGORIES.APP_START, "index.js loaded — app process starting");

// ─── Background Message Handler (MUST be registered before AppRegistry) ─────
// This runs in a headless JS context when the app is killed/backgrounded.
// It MUST be at the entry point level, not inside a React component.
if (Platform.OS !== "web") {
  try {
    const messaging = require("@react-native-firebase/messaging").default;
    const notifeeModule = require("@notifee/react-native");
    const notifee = notifeeModule.default;
    const { AndroidImportance, AndroidStyle, AndroidVisibility } =
      notifeeModule;

    // ─── Notification Channel IDs (must match notifications.js) ───────────
    const CHANNELS = {
      MESSAGES: "messages",
      CALLS: "calls",
      GENERAL: "general",
    };
    const NOTIF_SMALL_ICON = "ic_launcher";
    const CALL_NOTIFICATION_ID = "incoming-call";

    // ─── Ensure channels exist (idempotent — safe to call multiple times) ──
    async function ensureChannels() {
      try {
        await notifee.createChannel({
          id: CHANNELS.MESSAGES,
          name: "Messages",
          importance: AndroidImportance.HIGH,
          vibration: true,
          sound: "default",
        });
        await notifee.createChannel({
          id: CHANNELS.CALLS,
          name: "Calls",
          importance: AndroidImportance.HIGH,
          vibration: true,
          sound: "default",
          visibility: AndroidVisibility.PUBLIC,
          bypassDnd: true,
        });
        await notifee.createChannel({
          id: CHANNELS.GENERAL,
          name: "General",
          importance: AndroidImportance.DEFAULT,
          sound: "default",
        });
      } catch (err) {
        console.error("Background channel setup error:", err);
      }
    }

    // ─── FCM Background Message Handler ──────────────────────────────────
    messaging().setBackgroundMessageHandler(async (remoteMessage) => {
      console.log(
        "📨 [index.js] Background FCM message:",
        remoteMessage.data?.type,
      );
      const data = remoteMessage.data || {};

      // Ensure notification channels exist
      await ensureChannels();

      if (data.type === "call") {
        // ★ Cancel any auto-displayed notification from notification+data push
        try {
          await notifee.cancelAllNotifications();
        } catch {}

        // Show full-screen call notification with Accept/Decline
        const callerName = data.callerName || "Unknown";
        const callType = data.callType || "video";
        const isVoice = callType === "voice";

        await notifee.displayNotification({
          id: CALL_NOTIFICATION_ID,
          title: isVoice ? "Incoming Voice Call" : "Incoming Video Call",
          body: callerName,
          data,
          android: {
            channelId: CHANNELS.CALLS,
            importance: AndroidImportance.HIGH,
            visibility: AndroidVisibility.PUBLIC,
            smallIcon: NOTIF_SMALL_ICON,
            color: "#6C63FF",
            ongoing: true,
            autoCancel: false,
            asForegroundService: true,
            vibrationPattern: [0, 500, 200, 500, 200, 500, 200, 500],
            sound: "default",
            loopSound: true,
            lights: true,
            lightColor: "#FF4444",
            fullScreenAction: { id: "default" },
            actions: [
              { title: "✅ Accept", pressAction: { id: "accept_call" } },
              { title: "❌ Decline", pressAction: { id: "decline_call" } },
            ],
          },
        });
        console.log(`📞 [index.js] Call notification displayed: ${callerName}`);
      } else if (data.type === "message") {
        // ★ WhatsApp-style message notification
        const senderName = data.senderName || data.title || "Someone";
        const messageBody = data.body || "New message";
        const conversationId = data.conversationId || "";
        const timestamp = Date.now();
        const notificationId = `msg-${conversationId || timestamp}`;

        const androidConfig = {
          channelId: CHANNELS.MESSAGES,
          importance: AndroidImportance.HIGH,
          smallIcon: NOTIF_SMALL_ICON,
          color: "#6C63FF",
          pressAction: { id: "default", launchActivity: "default" },
          autoCancel: true,
          showTimestamp: true,
          timestamp,
          groupId: conversationId || "messages",
        };

        // WhatsApp-style messaging notification
        if (AndroidStyle) {
          androidConfig.style = {
            type: AndroidStyle.MESSAGING,
            person: {
              name: senderName,
              icon: `https://api.dicebear.com/7.x/initials/png?seed=${encodeURIComponent(senderName)}`,
            },
            messages: [
              {
                text: messageBody,
                timestamp,
                person: {
                  name: senderName,
                  icon: `https://api.dicebear.com/7.x/initials/png?seed=${encodeURIComponent(senderName)}`,
                },
              },
            ],
          };
        }

        await notifee.displayNotification({
          id: notificationId,
          title: senderName,
          body: messageBody,
          data: { ...data, type: "message" },
          android: androidConfig,
        });
        console.log(
          `📨 [index.js] Message notification displayed: ${senderName}`,
        );
      } else {
        // Generic notification for other types
        const notification = remoteMessage.notification || {};
        await notifee.displayNotification({
          title: notification.title || data.title || "Aux",
          body: notification.body || data.body || "",
          data,
          android: {
            channelId: CHANNELS.GENERAL,
            smallIcon: NOTIF_SMALL_ICON,
            color: "#6C63FF",
            pressAction: { id: "default", launchActivity: "default" },
            importance: AndroidImportance.HIGH,
          },
        });
        console.log(`📨 [index.js] Generic notification displayed`);
      }
    });

    // ─── Notifee Background Event Handler ─────────────────────────────────
    notifee.onBackgroundEvent(async ({ type, detail }) => {
      const { EventType } = require("@notifee/react-native");
      const actionId = detail.pressAction?.id;
      const notifData = detail.notification?.data;

      console.log("📨 [index.js] Notifee background event:", type, actionId);

      if (type === EventType.ACTION_PRESS) {
        if (actionId === "accept_call") {
          await notifee.cancelNotification(CALL_NOTIFICATION_ID);
          // App will open via fullScreenAction — CallScreen handles the rest
        } else if (actionId === "decline_call" && notifData?.callId) {
          await notifee.cancelNotification(CALL_NOTIFICATION_ID);
          // Reject via REST API (no WebSocket in background)
          try {
            const apiClient = require("./src/services/api").default;
            const { endpoints } = require("./src/config/api");
            await apiClient.post(endpoints.calls.reject, {
              callId: notifData.callId,
            });
          } catch {}
        }
      }
    });

    console.log("✅ [index.js] Background handlers registered");
  } catch (err) {
    console.log("⚠️  [index.js] Native modules not available:", err.message);
  }
}

// ─── Register the App Component ──────────────────────────────────────────────
// ★ Must be "main" to match MainActivity.kt getMainComponentName()
AppRegistry.registerComponent(appConfig.name || "main", () => App);
