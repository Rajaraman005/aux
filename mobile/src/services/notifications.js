/**
 * Push Notification Service — Mobile Client.
 *
 * Features:
 *   - Registers for Expo Push Token
 *   - Configures Android notification channels (Messages, Calls)
 *   - Handles foreground notifications (show banner)
 *   - Handles notification tap → deep link to correct screen
 *   - Sends token + platform + deviceId to server
 */
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import apiClient from "../services/api";
import { endpoints } from "../config/api";

// ─── Notification Display Config (foreground behavior) ──────────────────────
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data;

    // Always show call notifications, even in foreground
    if (data?.type === "call") {
      return {
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      };
    }

    // Show message notifications in foreground
    return {
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    };
  },
});

// ─── Android Notification Channels ──────────────────────────────────────────
async function setupNotificationChannels() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("messages", {
      name: "Messages",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#6C63FF",
      sound: "default",
    });

    await Notifications.setNotificationChannelAsync("calls", {
      name: "Calls",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 200, 500, 200, 500],
      lightColor: "#FF4444",
      sound: "default",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
}

// ─── Register for Push Notifications ────────────────────────────────────────
async function registerForPushNotifications() {
  try {
    // Must be a physical device
    if (!Device.isDevice) {
      console.log("Push notifications require a physical device");
      return null;
    }

    // Check/request permissions
    const { status: existingStatus } =
      await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      console.log("Push notification permission denied");
      return null;
    }

    // Setup channels before getting token
    await setupNotificationChannels();

    // Get Expo push token
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId,
    });

    const token = tokenData.data;
    console.log("📱 Push token:", token);

    return token;
  } catch (err) {
    console.error("Push registration error:", err);
    return null;
  }
}

// ─── Send Token to Server ───────────────────────────────────────────────────
async function registerTokenWithServer(token) {
  try {
    await apiClient.post(endpoints.push.register, {
      token,
      platform: Platform.OS,
      deviceId: Constants.deviceName || "unknown",
    });
    console.log("📱 Push token registered with server");
  } catch (err) {
    console.error("Failed to register push token with server:", err);
  }
}

// ─── Unregister Token from Server ───────────────────────────────────────────
async function unregisterTokenFromServer(token) {
  try {
    await apiClient.request(endpoints.push.unregister, {
      method: "DELETE",
      body: JSON.stringify({ token }),
      headers: { "Content-Type": "application/json" },
    });
    console.log("📱 Push token unregistered from server");
  } catch (err) {
    console.error("Failed to unregister push token:", err);
  }
}

// ─── Initialize Notifications ───────────────────────────────────────────────
let notificationResponseSubscription = null;
let lastPushToken = null;

async function initializeNotifications(navigationRef) {
  // Setup channels
  await setupNotificationChannels();

  // Handle notification tap (deep linking)
  notificationResponseSubscription =
    Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;

      if (!navigationRef?.current) return;

      switch (data?.type) {
        case "message":
          if (data.conversationId) {
            navigationRef.current.navigate("Chat", {
              conversationId: data.conversationId,
              otherUserName: data.senderName,
            });
          }
          break;

        case "call":
          // Navigate to calls tab or handle incoming call
          navigationRef.current.navigate("CallsTab");
          break;

        case "missed_call":
          navigationRef.current.navigate("CallsTab");
          break;

        default:
          break;
      }
    });
}

function cleanupNotifications() {
  if (notificationResponseSubscription) {
    notificationResponseSubscription.remove();
    notificationResponseSubscription = null;
  }
}

// ─── Full Registration Flow ─────────────────────────────────────────────────
async function registerPushNotifications() {
  const token = await registerForPushNotifications();
  if (token) {
    lastPushToken = token;
    await registerTokenWithServer(token);
  }
  return token;
}

async function unregisterPushNotifications() {
  if (lastPushToken) {
    await unregisterTokenFromServer(lastPushToken);
    lastPushToken = null;
  }
}

export {
  initializeNotifications,
  cleanupNotifications,
  registerPushNotifications,
  unregisterPushNotifications,
};
