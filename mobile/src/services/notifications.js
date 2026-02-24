/**
 * Push Notification Service — Native FCM with Expo Go Fallback.
 *
 * ★ Dual-Mode Architecture:
 *   - Dev build (expo run:android): Full native FCM + Notifee
 *   - Expo Go (expo start): Graceful no-op (app works, just no push)
 *
 * ★ KEY: We detect Expo Go via expo-constants BEFORE any Firebase require().
 *   This prevents the native bridge crash (RNFBAppModule not found).
 */
import { Platform } from "react-native";
import Constants from "expo-constants";
import apiClient from "../services/api";
import { endpoints } from "../config/api";

// ─── Expo Go Detection ─────────────────────────────────────────────────────
// Must happen BEFORE any Firebase require() to prevent native bridge crash
const IS_EXPO_GO = Constants.appOwnership === "expo";

// ─── Lazy Native Module References ─────────────────────────────────────────
let messaging = null;
let notifee = null;
let AndroidImportance = null;
let AndroidVisibility = null;
let AndroidCategory = null;
let NotifeeEventType = null;
let isNativeAvailable = false;

function loadNativeModules() {
  if (IS_EXPO_GO) {
    isNativeAvailable = false;
    return false;
  }
  if (messaging !== null) return isNativeAvailable;

  try {
    messaging = require("@react-native-firebase/messaging").default;
    const notifeeModule = require("@notifee/react-native");
    notifee = notifeeModule.default;
    AndroidImportance = notifeeModule.AndroidImportance;
    AndroidVisibility = notifeeModule.AndroidVisibility;
    AndroidCategory = notifeeModule.AndroidCategory;
    NotifeeEventType = notifeeModule.EventType;
    isNativeAvailable = true;
    console.log("✅ Native push modules loaded (FCM + Notifee)");
  } catch (err) {
    isNativeAvailable = false;
    messaging = null;
    notifee = null;
    console.log("⚠️  Native push modules not available — push disabled");
  }

  return isNativeAvailable;
}

// ─── Notification Channel IDs ───────────────────────────────────────────────
const CHANNELS = {
  MESSAGES: "messages",
  CALLS: "calls",
  GENERAL: "general",
};

// ─── Setup Android Notification Channels ────────────────────────────────────
async function setupNotificationChannels() {
  if (Platform.OS !== "android" || !notifee) return;

  try {
    await notifee.createChannel({
      id: CHANNELS.MESSAGES,
      name: "Messages",
      importance: AndroidImportance.HIGH,
      vibration: true,
      vibrationPattern: [0, 250, 250, 250],
      lights: true,
      lightColor: "#6C63FF",
      sound: "default",
    });

    await notifee.createChannel({
      id: CHANNELS.CALLS,
      name: "Calls",
      importance: AndroidImportance.HIGH,
      vibration: true,
      vibrationPattern: [0, 500, 200, 500, 200, 500],
      lights: true,
      lightColor: "#FF4444",
      sound: "default",
      visibility: AndroidVisibility.PUBLIC,
    });

    await notifee.createChannel({
      id: CHANNELS.GENERAL,
      name: "General",
      importance: AndroidImportance.DEFAULT,
      sound: "default",
    });

    console.log("✅ Notification channels created");
  } catch (err) {
    console.error("Channel setup error:", err);
  }
}

// ─── Get FCM Registration Token ─────────────────────────────────────────────
async function getFCMToken() {
  if (!messaging) return null;

  try {
    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (!enabled) {
      console.log("Push notification permission denied");
      return null;
    }

    const token = await messaging().getToken();
    console.log("📱 FCM Token:", token?.slice(0, 30) + "...");
    return token;
  } catch (err) {
    console.error("FCM token error:", err);
    return null;
  }
}

// ─── Register Token with Server ─────────────────────────────────────────────
async function registerTokenWithServer(token) {
  try {
    const deviceInfo = {
      token,
      platform: Platform.OS,
      tokenType: "fcm",
      deviceId: getDeviceId(),
      appVersion: "1.0.1",
      osVersion: `${Platform.OS} ${Platform.Version}`,
    };

    await apiClient.post(endpoints.push.register, deviceInfo);
    console.log("📱 FCM token registered with server");
  } catch (err) {
    console.error("Failed to register FCM token with server:", err);
  }
}

// ─── Get Unique Device ID ───────────────────────────────────────────────────
function getDeviceId() {
  return Constants.deviceName || `${Platform.OS}-${Date.now()}`;
}

// ─── Unregister Token from Server ───────────────────────────────────────────
async function unregisterTokenFromServer() {
  try {
    const deviceId = getDeviceId();
    await apiClient.request(endpoints.push.unregister, {
      method: "DELETE",
      body: JSON.stringify({ deviceId }),
      headers: { "Content-Type": "application/json" },
    });
    console.log("📱 Device unregistered from server");
  } catch (err) {
    console.error("Failed to unregister device:", err);
  }
}

// ─── Call Notification ID (for cancellation) ───────────────────────────────
const CALL_NOTIFICATION_ID = "incoming-call";

// ─── Display Full-Screen Incoming Call Notification ─────────────────────────
async function displayCallNotification(data) {
  if (!notifee) return;

  const callerName = data.callerName || "Unknown";
  const callType = data.callType || "video";
  const isVoice = callType === "voice";

  try {
    await notifee.displayNotification({
      id: CALL_NOTIFICATION_ID,
      title: isVoice ? "Incoming Voice Call" : "Incoming Video Call",
      body: callerName,
      data,
      android: {
        channelId: CHANNELS.CALLS,
        category: AndroidCategory?.CALL,
        importance: AndroidImportance.HIGH,
        visibility: AndroidVisibility.PUBLIC,
        smallIcon: "ic_notification",
        ongoing: true,
        autoCancel: false,
        vibrationPattern: [0, 500, 200, 500, 200, 500, 200, 500],
        lights: true,
        lightColor: "#FF4444",
        fullScreenAction: {
          id: "default",
        },
        actions: [
          {
            title: "Accept",
            pressAction: { id: "accept_call" },
          },
          {
            title: "Decline",
            pressAction: { id: "decline_call" },
          },
        ],
      },
    });
  } catch (err) {
    console.error("Call notification display error:", err);
  }
}

// ─── Cancel Call Notification ───────────────────────────────────────────────
async function cancelCallNotification() {
  if (!notifee) return;
  try {
    await notifee.cancelNotification(CALL_NOTIFICATION_ID);
  } catch {}
}

// ─── Display Foreground Notification (via Notifee) ──────────────────────────
async function displayForegroundNotification(remoteMessage) {
  if (!notifee) return;

  const data = remoteMessage.data || {};
  const notification = remoteMessage.notification || {};

  let channelId = CHANNELS.GENERAL;
  if (data.type === "call" || data.type === "missed_call") {
    channelId = CHANNELS.CALLS;
  } else if (data.type === "message") {
    channelId = CHANNELS.MESSAGES;
  }

  try {
    await notifee.displayNotification({
      title: notification.title || data.title || "Aux",
      body: notification.body || data.body || "",
      data,
      android: {
        channelId,
        smallIcon: "ic_notification",
        pressAction: { id: "default" },
        importance:
          data.type === "call"
            ? AndroidImportance.HIGH
            : AndroidImportance.DEFAULT,
      },
    });
  } catch (err) {
    console.error("Notifee display error:", err);
  }
}

// ─── Handle Notification Navigation ─────────────────────────────────────────
function handleNotificationNavigation(data, navigationRef) {
  if (!navigationRef?.current || !data) return;

  switch (data.type) {
    case "message":
      if (data.conversationId) {
        navigationRef.current.navigate("Chat", {
          conversationId: data.conversationId,
          otherUserName: data.senderName,
        });
      }
      break;

    case "call":
      if (data.acceptFromNotification) {
        navigationRef.current.navigate("Call", {
          callerName: data.callerName || "Unknown",
          callerAvatar: data.callerAvatar || null,
          callType: data.callType || "video",
          acceptFromNotification: true,
        });
      } else {
        navigationRef.current.navigate("MainTabs", { screen: "Home" });
      }
      break;
    case "missed_call":
      navigationRef.current.navigate("MainTabs", { screen: "Home" });
      break;

    case "friend_request":
      navigationRef.current.navigate("MainTabs", { screen: "Requests" });
      break;

    case "world_mention":
      navigationRef.current.navigate("WorldChat");
      break;

    default:
      navigationRef.current.navigate("Notifications");
      break;
  }
}

// ─── Initialize Notifications ───────────────────────────────────────────────
let tokenRefreshUnsubscribe = null;
let foregroundUnsubscribe = null;
let notifeeEventUnsubscribe = null;
let lastFCMToken = null;

async function initializeNotifications(navigationRef) {
  const native = loadNativeModules();

  if (!native) {
    console.log(
      "ℹ️  Push notifications disabled (Expo Go). Use `npx expo run:android` for push support.",
    );
    return;
  }

  await setupNotificationChannels();

  // Token Refresh Listener
  tokenRefreshUnsubscribe = messaging().onTokenRefresh(async (newToken) => {
    console.log("📱 FCM token refreshed");
    lastFCMToken = newToken;
    await registerTokenWithServer(newToken);
  });

  // Foreground Message Handler
  foregroundUnsubscribe = messaging().onMessage(async (remoteMessage) => {
    console.log("📨 Foreground FCM message:", remoteMessage.data?.type);
    const data = remoteMessage.data || {};
    if (data.type === "call") {
      // Show full-screen call notification even in foreground
      await displayCallNotification(data);
    } else {
      await displayForegroundNotification(remoteMessage);
    }
  });

  // Notifee tap/action handler
  if (notifee && NotifeeEventType) {
    notifeeEventUnsubscribe = notifee.onForegroundEvent(({ type, detail }) => {
      const actionId = detail.pressAction?.id;
      const notifData = detail.notification?.data;

      if (type === NotifeeEventType.ACTION_PRESS) {
        if (actionId === "accept_call" && notifData) {
          cancelCallNotification();
          handleNotificationNavigation(
            { ...notifData, type: "call", acceptFromNotification: true },
            navigationRef,
          );
        } else if (actionId === "decline_call" && notifData) {
          cancelCallNotification();
          // Reject via REST if callId available
          if (notifData.callId) {
            const apiClient = require("./api").default;
            const { endpoints } = require("../config/api");
            apiClient
              .post(endpoints.calls.reject, { callId: notifData.callId })
              .catch(() => {});
          }
        }
      } else if (type === NotifeeEventType.PRESS) {
        handleNotificationNavigation(notifData, navigationRef);
      }
    });
  }

  // Background notification tap
  messaging().onNotificationOpenedApp((remoteMessage) => {
    console.log("📨 Notification opened from background");
    setTimeout(() => {
      handleNotificationNavigation(remoteMessage.data, navigationRef);
    }, 500);
  });

  // Cold start check
  try {
    const initial = await messaging().getInitialNotification();
    if (initial) {
      console.log("📨 Cold start from notification");
      setTimeout(() => {
        handleNotificationNavigation(initial.data, navigationRef);
      }, 1000);
    }
  } catch (err) {
    console.error("Cold start check error:", err);
  }
}

function cleanupNotifications() {
  if (tokenRefreshUnsubscribe) {
    tokenRefreshUnsubscribe();
    tokenRefreshUnsubscribe = null;
  }
  if (foregroundUnsubscribe) {
    foregroundUnsubscribe();
    foregroundUnsubscribe = null;
  }
  if (notifeeEventUnsubscribe) {
    notifeeEventUnsubscribe();
    notifeeEventUnsubscribe = null;
  }
}

// ─── Full Registration Flow ─────────────────────────────────────────────────
async function registerPushNotifications() {
  loadNativeModules();

  if (!isNativeAvailable) {
    console.log("⚠️  Push registration skipped (Expo Go mode)");
    return null;
  }

  const token = await getFCMToken();
  if (token) {
    lastFCMToken = token;
    await registerTokenWithServer(token);
  }
  return token;
}

async function unregisterPushNotifications() {
  await unregisterTokenFromServer();
  lastFCMToken = null;
}

// ─── Background Message Handler ─────────────────────────────────────────────
// ONLY register if NOT in Expo Go (prevents native bridge crash)
if (!IS_EXPO_GO) {
  try {
    const bgMessaging = require("@react-native-firebase/messaging").default;
    bgMessaging().setBackgroundMessageHandler(async (remoteMessage) => {
      console.log("📨 Background FCM message:", remoteMessage.data?.type);
      const data = remoteMessage.data || {};
      if (data.type === "call") {
        // Load notifee if not already loaded
        loadNativeModules();
        await displayCallNotification(data);
      }
    });
  } catch {
    // Native module not available
  }

  // ─── Notifee Background Event Handler ─────────────────────────────────────
  try {
    const bgNotifee = require("@notifee/react-native").default;
    const { EventType: BgEventType } = require("@notifee/react-native");
    bgNotifee.onBackgroundEvent(async ({ type, detail }) => {
      const actionId = detail.pressAction?.id;
      const notifData = detail.notification?.data;

      if (type === BgEventType.ACTION_PRESS) {
        if (actionId === "accept_call") {
          await bgNotifee.cancelNotification(CALL_NOTIFICATION_ID);
          // App will open automatically via fullScreenAction — CallScreen
          // will detect acceptFromNotification and bootstrap.
        } else if (actionId === "decline_call" && notifData?.callId) {
          await bgNotifee.cancelNotification(CALL_NOTIFICATION_ID);
          // Reject via REST API (no WebSocket available when backgrounded)
          try {
            const apiClient = require("./api").default;
            const { endpoints } = require("../config/api");
            await apiClient.post(endpoints.calls.reject, {
              callId: notifData.callId,
            });
          } catch {}
        }
      }
    });
  } catch {
    // Native module not available
  }
}

export {
  initializeNotifications,
  cleanupNotifications,
  registerPushNotifications,
  unregisterPushNotifications,
  handleNotificationNavigation,
  displayCallNotification,
  cancelCallNotification,
  CHANNELS,
};
