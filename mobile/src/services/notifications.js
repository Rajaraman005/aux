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
let AndroidStyle = null;
let NotifeeEventType = null;
let AndroidForegroundServiceType = null;
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
    AndroidStyle = notifeeModule.AndroidStyle;
    NotifeeEventType = notifeeModule.EventType;
    AndroidForegroundServiceType = notifeeModule.AndroidForegroundServiceType;
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

// ─── Notification Icon (use ic_launcher which always exists) ─────────────────
const NOTIF_SMALL_ICON = "ic_launcher";

// ─── Request Notification Permission (Android 13+ / API 33+) ────────────────
// ★ CRITICAL: Android 13+ requires POST_NOTIFICATIONS runtime permission.
// Without this, ALL notifications are silently suppressed. This MUST be
// called early (ideally on first app launch) before any push registration.
// Notifee.requestPermission() handles the system dialog on Android 13+ and
// is a no-op on older versions (permission is auto-granted at install).
async function requestNotificationPermission() {
  // Load native modules if not loaded
  loadNativeModules();

  if (Platform.OS === "android" && notifee) {
    try {
      const settings = await notifee.requestPermission();
      // authorizationStatus: 0=DENIED, 1=AUTHORIZED, 2=PROVISIONAL
      const granted = settings.authorizationStatus >= 1;
      console.log(
        `📱 Notification permission: ${granted ? "✅ granted" : "❌ denied"} (status: ${settings.authorizationStatus})`,
      );

      // ★ Check USE_FULL_SCREEN_INTENT on Android 14+ (API 34)
      // Without this permission, fullScreenAction notifications silently
      // downgrade to heads-up and never show full-screen.
      if (granted && Platform.Version >= 34) {
        try {
          const { NativeModules, Linking, Alert } = require("react-native");
          const notificationManager =
            NativeModules.NotifeeApiModule || NativeModules.RNNotifee;

          // Notifee provides getNotificationSettings which includes
          // android.alarm (USE_FULL_SCREEN_INTENT on 14+)
          const notifSettings = await notifee.getNotificationSettings();
          const canFullScreen = notifSettings?.android?.alarm === 1; // 1 = ENABLED

          if (!canFullScreen) {
            console.log(
              "⚠️  USE_FULL_SCREEN_INTENT not granted — prompting user",
            );
            Alert.alert(
              "Enable Full-Screen Calls",
              "To show incoming calls over your lock screen (like WhatsApp), please enable 'Full-screen notifications' for this app.",
              [
                { text: "Later", style: "cancel" },
                {
                  text: "Open Settings",
                  onPress: () => {
                    // Open the app's notification settings
                    Linking.openSettings();
                  },
                },
              ],
            );
          } else {
            console.log("✅ USE_FULL_SCREEN_INTENT permission granted");
          }
        } catch (permErr) {
          console.log("Full-screen permission check error:", permErr.message);
        }
      }

      return granted;
    } catch (err) {
      console.error("Notifee permission request error:", err);
    }
  }

  if (Platform.OS === "android" && messaging) {
    try {
      const authStatus = await messaging().requestPermission();
      const granted =
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL;
      console.log(`📱 FCM permission: ${granted ? "✅ granted" : "❌ denied"}`);
      return granted;
    } catch (err) {
      console.error("FCM permission request error:", err);
    }
  }

  // Expo Go fallback
  if (IS_EXPO_GO) {
    try {
      const { status: existingStatus } =
        await ExpoNotifications.getPermissionsAsync();
      if (existingStatus === "granted") return true;

      const { status } = await ExpoNotifications.requestPermissionsAsync();
      return status === "granted";
    } catch (err) {
      console.error("Expo permission request error:", err);
    }
  }

  // iOS or unavailable — return true (iOS handles permission via FCM)
  return Platform.OS === "ios";
}

// ─── Setup Android Notification Channels ────────────────────────────────────
async function setupNotificationChannels() {
  if (Platform.OS !== "android" || !notifee) return;

  try {
    await notifee.createChannel({
      id: CHANNELS.MESSAGES,
      name: "Messages",
      importance: AndroidImportance.HIGH,
      vibration: true,
      vibrationPattern: [250, 250, 250, 250],
      lights: true,
      lightColor: "#6C63FF",
      sound: "default",
    });

    // ★ Delete old calls channel first — Android caches channel settings
    // and won't upgrade importance from HIGH to MAX without delete+recreate
    try {
      await notifee.deleteChannel(CHANNELS.CALLS);
    } catch {}

    await notifee.createChannel({
      id: CHANNELS.CALLS,
      name: "Calls",
      importance: AndroidImportance.MAX,
      vibration: true,
      vibrationPattern: [500, 200, 500, 200, 500, 200],
      lights: true,
      lightColor: "#FF4444",
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

async function displayCallNotification(data) {
  if (!notifee) {
    console.warn("Notifee not available — cannot show call notification");
    return;
  }

  const callerName = data.callerName || "Unknown";
  const callType = data.callType || "video";

  try {
    // ★ Cancel any existing call notification first
    try {
      await notifee.stopForegroundService();
    } catch {}
    try {
      await notifee.cancelNotification(CALL_NOTIFICATION_ID);
    } catch {}

    // ★ WhatsApp-style full-screen incoming call notification
    await notifee.displayNotification({
      id: CALL_NOTIFICATION_ID,
      title: "Aux",
      subtitle: callerName,
      body: `Incoming ${callType} call`,
      data: { ...data, type: "call" },
      android: {
        channelId: CHANNELS.CALLS,
        category: AndroidCategory.CALL,
        importance: AndroidImportance.HIGH,
        visibility: AndroidVisibility.PUBLIC,
        smallIcon: NOTIF_SMALL_ICON,
        color: "#6C63FF",
        colorized: true,
        ongoing: true,
        autoCancel: false,
        loopSound: true,
        sound: "default",
        vibrationPattern: [500, 200, 500, 200, 500, 200],
        // ★ Show over lock screen as full-screen intent
        fullScreenAction: {
          id: "default",
          launchActivity: "default",
        },
        // ★ Keep notification alive as a foreground service
        asForegroundService: true,
        foregroundServiceTypes: [AndroidForegroundServiceType.PHONE_CALL],
        // ★ WhatsApp-style Decline | Answer action buttons
        actions: [
          {
            title: "Decline",
            pressAction: { id: "decline_call" },
            icon: "ic_launcher",
          },
          {
            title: "Answer",
            pressAction: { id: "accept_call", launchActivity: "default" },
            icon: "ic_launcher",
          },
        ],
        timestamp: Date.now(),
        showTimestamp: true,
      },
    });
    console.log(
      `📞 WhatsApp-style call notification displayed: ${callerName} (${callType})`,
    );
  } catch (err) {
    console.error("Call notification display error:", err);
  }
}

// ─── Cancel Call Notification ───────────────────────────────────────────────
async function cancelCallNotification() {
  try {
    if (notifee) {
      if (Platform.OS === "android") {
        try {
          await notifee.stopForegroundService();
        } catch {}
      }
      await notifee.cancelNotification(CALL_NOTIFICATION_ID);
    }
    console.log("⏹️  Cancelled call notification and foreground service");
  } catch (err) {
    console.error("Failed to cancel call notification:", err);
  }
}

// ─── Display WhatsApp-Style Message Notification (via Notifee) ──────────────
async function displayMessageNotification(data) {
  if (!notifee) return;

  const senderName = data.senderName || data.title || "Someone";
  const messageText = data.body || data.messagePreview || "New message";
  const conversationId = data.conversationId || "";
  const timestamp = Date.now();

  try {
    // ★ Use a unique ID per conversation so new messages GROUP together
    const notificationId = `msg-${conversationId || timestamp}`;

    const androidConfig = {
      channelId: CHANNELS.MESSAGES,
      importance: AndroidImportance.HIGH,
      smallIcon: NOTIF_SMALL_ICON,
      color: "#6C63FF",
      // ★ FIX: launchActivity ensures tapping notification opens the app
      pressAction: { id: "default", launchActivity: "default" },
      autoCancel: true,
      showTimestamp: true,
      timestamp,
      // ★ Group notifications by conversation
      groupId: conversationId || "messages",
    };

    // ★ WhatsApp-style: messaging style with sender info
    if (AndroidStyle) {
      androidConfig.style = {
        type: AndroidStyle.MESSAGING,
        person: {
          name: senderName,
          icon: `https://api.dicebear.com/7.x/initials/png?seed=${encodeURIComponent(senderName)}`,
        },
        messages: [
          {
            text: messageText,
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
      body: messageText,
      data: { ...data, type: "message" },
      android: androidConfig,
    });

    console.log(`📨 Displayed message notification from ${senderName}`);
  } catch (err) {
    console.error("Message notification display error:", err);
  }
}

// (Duplicate removed)
// ─── Display Foreground Notification (via Notifee) ──────────────────────────
async function displayForegroundNotification(remoteMessage) {
  if (!notifee) return;

  const data = remoteMessage.data || {};
  const notification = remoteMessage.notification || {};

  // ★ For message type, use the WhatsApp-style notification
  if (data.type === "message") {
    await displayMessageNotification({
      senderName: data.senderName || notification.title || "Someone",
      body: notification.body || data.body || "New message",
      conversationId: data.conversationId || "",
      ...data,
    });
    return;
  }

  let channelId = CHANNELS.GENERAL;
  if (data.type === "call" || data.type === "missed_call") {
    channelId = CHANNELS.CALLS;
  }

  try {
    await notifee.displayNotification({
      title: notification.title || data.title || "Aux",
      body: notification.body || data.body || "",
      data,
      android: {
        channelId,
        smallIcon: NOTIF_SMALL_ICON,
        color: "#6C63FF",
        // ★ FIX: launchActivity ensures tapping notification opens the app
        pressAction: { id: "default", launchActivity: "default" },
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

  // ★ Check if navigation is ready (prevents crash on cold start)
  if (!navigationRef.current.isReady || !navigationRef.current.isReady()) {
    // Retry after a delay if not ready
    setTimeout(() => handleNotificationNavigation(data, navigationRef), 1000);
    return;
  }

  try {
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
  } catch (err) {
    console.error("Notification navigation error:", err);
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
    const notification = remoteMessage.notification || {};

    if (data.type === "call") {
      // 🚨 CRITICAL FIX: Do NOT trigger Notifee's full-screen ringtone intent
      // if the app is in the foreground. SignalingContext.js already handles
      // the incoming call UI and uses SoundService for the ringtone.
      // Triggering Notifee here causes an OS audio focus conflict that mutes
      // the ringtone after 1 second.
      //
      // ★ ADDITIONALLY: Cancel any auto-displayed notification from the
      // notification+data push. Android auto-displays it BEFORE this handler
      // runs, and its sound steals audio focus from our expo-av ringtone.
      cancelCallNotification();
      console.log(
        "📨 Foreground FCM message: call (cancelled auto-notification, delegating to WebSocket/SignalingContext)",
      );
    } else if (
      data.type === "message" &&
      _activeConversationId &&
      data.conversationId === _activeConversationId
    ) {
      // User is viewing this conversation — suppress push notification
      // (the message is already visible via WebSocket real-time delivery)
      console.log("📨 Suppressed foreground notification (user in chat)");
    } else {
      // ★ FIX: For data-only pushes, read from data fields
      // (notification field is empty on data-only messages)
      if (data.type === "message") {
        await displayMessageNotification({
          senderName:
            data.senderName || data.title || notification.title || "Someone",
          body: data.body || notification.body || "New message",
          conversationId: data.conversationId || "",
          ...data,
        });
      } else {
        await displayForegroundNotification(remoteMessage);
      }
    }
  });

  // ─── Notifee Call Action Handlers (WhatsApp-style Accept/Decline) ─────────
  // These are handled here for foreground events (when the app is open).
  // Background events are handled in index.js onBackgroundEvent.

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

  // Background notification tap (FCM notification+data payloads)
  messaging().onNotificationOpenedApp((remoteMessage) => {
    console.log("📨 Notification opened from background (FCM)");
    setTimeout(() => {
      handleNotificationNavigation(remoteMessage.data, navigationRef);
    }, 500);
  });

  // ★ Notifee cold-start check — CRITICAL for data-only pushes.
  // When the app is killed and a data-only push triggers a Notifee
  // notification, FCM's getInitialNotification() returns null because
  // there's no FCM notification payload. Notifee's version works
  // because Notifee created the notification from the background handler.
  if (notifee) {
    try {
      const initialNotifee = await notifee.getInitialNotification();
      if (initialNotifee) {
        const notifData = initialNotifee.notification?.data;
        const actionId = initialNotifee.pressAction?.id;
        console.log(
          "📨 Cold start from Notifee notification:",
          notifData?.type,
          "action:",
          actionId,
        );
        if (notifData) {
          // If user tapped "Accept" on a call notification
          if (actionId === "accept_call") {
            notifData.acceptFromNotification = true;
            notifData.type = "call";
          }
          setTimeout(() => {
            handleNotificationNavigation(notifData, navigationRef);
          }, 1000);
        }
      }
    } catch (err) {
      console.error("Notifee cold start check error:", err);
    }
  }

  // FCM cold start check (notification+data payloads, e.g. call fallback)
  try {
    const initial = await messaging().getInitialNotification();
    if (initial) {
      console.log("📨 Cold start from FCM notification");
      setTimeout(() => {
        handleNotificationNavigation(initial.data, navigationRef);
      }, 1000);
    }
  } catch (err) {
    console.error("FCM cold start check error:", err);
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
    // ★ CRITICAL: Request permission FIRST (Android 13+ requirement)
    // Without this, getFCMToken() succeeds but notifications are blocked
    // at the OS level, resulting in silent delivery failures.
    const permissionGranted = await requestNotificationPermission();
    if (!permissionGranted) {
      console.warn(
        "📱 Notification permission denied — push will not be delivered.",
        "User must enable notifications in system Settings > Apps > Aux.",
      );
      // Still attempt to register token — permission can be granted later
      // and FCM will start delivering once enabled.
    }

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
    const permissionGranted = await requestNotificationPermission();
    if (!permissionGranted) {
      console.warn("📱 Expo notification permission denied");
    }
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
// ★ MOVED TO index.js — background handlers MUST be registered at the
// entry point level (before React components mount) for headless JS
// execution when the app is killed. See index.js for the handlers.

export {
  initializeNotifications,
  cleanupNotifications,
  registerPushNotifications,
  unregisterPushNotifications,
  handleNotificationNavigation,
  displayCallNotification,
  displayMessageNotification,
  cancelCallNotification,
  setActiveConversationForNotifications,
  requestNotificationPermission,
  CHANNELS,
};
