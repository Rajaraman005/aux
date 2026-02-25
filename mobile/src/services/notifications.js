import { Platform } from "react-native";
import Constants from "expo-constants";
import * as ExpoNotifications from "expo-notifications";
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
    console.log(
      "⚠️  Native push modules not available — using Expo Push fallback",
    );
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

// ─── Get Expo Push Token (Expo Go Fallback) ─────────────────────────────────
async function getExpoPushToken() {
  try {
    // Request permission
    const { status: existingStatus } =
      await ExpoNotifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await ExpoNotifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      console.log("⚠️  Expo push notification permission denied");
      return null;
    }

    // Get Expo Push Token using the project ID from app.json
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    if (!projectId) {
      console.error(
        "❌ No Expo project ID found. Add it to app.json under extra.eas.projectId",
      );
      return null;
    }

    const tokenData = await ExpoNotifications.getExpoPushTokenAsync({
      projectId,
    });

    const token = tokenData.data;
    console.log("📱 Expo Push Token:", token);
    return token;
  } catch (err) {
    console.error("Expo push token error:", err);
    return null;
  }
}

// ─── Register Token with Server ─────────────────────────────────────────────
async function registerTokenWithServer(token, tokenType = "fcm") {
  try {
    const deviceInfo = {
      token,
      platform: Platform.OS,
      tokenType,
      deviceId: getDeviceId(),
      appVersion: "1.0.1",
      osVersion: `${Platform.OS} ${Platform.Version}`,
      deviceName: Constants.deviceName || "Unknown Device",
    };

    await apiClient.post(endpoints.push.register, deviceInfo);
    console.log(`📱 Push token registered with server (type: ${tokenType})`);
  } catch (err) {
    console.error("Failed to register push token with server:", err);
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
        smallIcon: "notification_icon",
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
        smallIcon: "notification_icon",
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
      // Navigate to Call screen — either auto-accept (from Notifee action)
      // or show incoming call UI (from FCM notification tap on killed app)
      navigationRef.current.navigate("Call", {
        callId: data.callId || null,
        callerId: data.callerId || null,
        callerName: data.callerName || "Unknown",
        callerAvatar: data.callerAvatar || null,
        callType: data.callType || "video",
        acceptFromNotification: data.acceptFromNotification || false,
        fromPushNotification: true,
      });
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

// ─── Active Conversation Tracker (suppress duplicate foreground notifications) ─
let _activeConversationId = null;

function setActiveConversationForNotifications(conversationId) {
  _activeConversationId = conversationId;
}

// ─── Initialize Notifications ───────────────────────────────────────────────
let tokenRefreshUnsubscribe = null;
let foregroundUnsubscribe = null;
let notifeeEventUnsubscribe = null;
let expoNotifSubscription = null;
let expoResponseSubscription = null;
let lastPushToken = null;

async function initializeNotifications(navigationRef) {
  const native = loadNativeModules();

  if (!native && IS_EXPO_GO) {
    // ★ EXPO GO MODE: Use expo-notifications for foreground handling
    console.log(
      "📱 Expo Go mode — using Expo Push Notifications for push support",
    );

    // Configure how foreground notifications are displayed
    ExpoNotifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const data = notification.request.content.data || {};
        return {
          shouldShowAlert: true,
          shouldPlaySound: data.type === "call" || data.type === "message",
          shouldSetBadge: true,
        };
      },
    });

    // Handle notification received while app is in foreground
    expoNotifSubscription = ExpoNotifications.addNotificationReceivedListener(
      (notification) => {
        console.log(
          "📨 Expo foreground notification:",
          notification.request.content.data?.type,
        );
      },
    );

    // Handle notification tap (app was in background or killed)
    expoResponseSubscription =
      ExpoNotifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data || {};
        console.log("📨 Notification tapped:", data.type);
        setTimeout(() => {
          handleNotificationNavigation(data, navigationRef);
        }, 500);
      });

    return;
  }

  if (!native) {
    console.log(
      "ℹ️  Push notifications disabled (no native modules and not Expo Go).",
    );
    return;
  }

  // ─── NATIVE MODE (Dev Build) ────────────────────────────────────────────
  await setupNotificationChannels();

  // Token Refresh Listener
  tokenRefreshUnsubscribe = messaging().onTokenRefresh(async (newToken) => {
    console.log("📱 FCM token refreshed");
    lastPushToken = newToken;
    await registerTokenWithServer(newToken, "fcm");
  });

  // Foreground Message Handler
  foregroundUnsubscribe = messaging().onMessage(async (remoteMessage) => {
    console.log("📨 Foreground FCM message:", remoteMessage.data?.type);
    const data = remoteMessage.data || {};
    if (data.type === "call") {
      // Show full-screen call notification even in foreground
      await displayCallNotification(data);
    } else if (
      data.type === "message" &&
      _activeConversationId &&
      data.conversationId === _activeConversationId
    ) {
      // User is viewing this conversation — suppress push notification
      // (the message is already visible via WebSocket real-time delivery)
      console.log("📨 Suppressed foreground notification (user in chat)");
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
  if (expoNotifSubscription) {
    expoNotifSubscription.remove();
    expoNotifSubscription = null;
  }
  if (expoResponseSubscription) {
    expoResponseSubscription.remove();
    expoResponseSubscription = null;
  }
}

// ─── Full Registration Flow ─────────────────────────────────────────────────
async function registerPushNotifications() {
  loadNativeModules();

  if (isNativeAvailable) {
    // ★ NATIVE MODE: Use FCM token
    const token = await getFCMToken();
    if (token) {
      lastPushToken = token;
      await registerTokenWithServer(token, "fcm");
    }
    return token;
  }

  if (IS_EXPO_GO) {
    // ★ EXPO GO MODE: Use Expo Push Token
    console.log("📱 Registering Expo Push Token (Expo Go mode)...");
    const token = await getExpoPushToken();
    if (token) {
      lastPushToken = token;
      await registerTokenWithServer(token, "expo");
      console.log("✅ Expo Push Token registered successfully");
    } else {
      console.log("❌ Failed to get Expo Push Token");
    }
    return token;
  }

  console.log("⚠️  Push registration skipped (no push mechanism available)");
  return null;
}

async function unregisterPushNotifications() {
  await unregisterTokenFromServer();
  lastPushToken = null;
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
        // Cancel any basic Android notification (from notification+data push)
        // before showing the full Notifee notification with Accept/Decline
        if (notifee) {
          try {
            await notifee.cancelAllNotifications();
          } catch {}
        }
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
  setActiveConversationForNotifications,
  CHANNELS,
};
