/**
 * IncomingCallScreen — Full-Screen Incoming Call UI.
 *
 * ★ Registered as a Notifee `mainComponent` so Android can launch it
 *   via `fullScreenAction` when a call notification fires while the
 *   screen is OFF or locked. Also launched when the user taps Accept.
 *
 * This component receives the call data via `initialNotification` from
 * Notifee and displays a WhatsApp-style incoming call screen with
 * caller info and Accept/Decline buttons.
 */
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Image,
  AppRegistry,
} from "react-native";
import Icon from "react-native-vector-icons/Feather";

// ─── Constants ──────────────────────────────────────────────────────────────
const CALL_NOTIFICATION_ID = "incoming-call";

export default function IncomingCallScreen() {
  const [callData, setCallData] = useState(null);

  useEffect(() => {
    // Read the notification that launched this component
    async function loadCallData() {
      try {
        const notifeeModule = require("@notifee/react-native");
        const notifee = notifeeModule.default;

        const initialNotification = await notifee.getInitialNotification();
        if (initialNotification?.notification?.data) {
          setCallData(initialNotification.notification.data);
        }
      } catch (err) {
        console.error("IncomingCallScreen: Failed to load call data:", err);
      }
    }
    loadCallData();
  }, []);

  const handleAccept = async () => {
    try {
      const notifeeModule = require("@notifee/react-native");
      const notifee = notifeeModule.default;
      try {
        await notifee.stopForegroundService();
      } catch {}
      await notifee.cancelNotification(CALL_NOTIFICATION_ID);
    } catch {}
    // The app will open to the main Activity — CallScreen handles the rest
  };

  const handleDecline = async () => {
    try {
      const notifeeModule = require("@notifee/react-native");
      const notifee = notifeeModule.default;
      try {
        await notifee.stopForegroundService();
      } catch {}
      await notifee.cancelNotification(CALL_NOTIFICATION_ID);

      // Reject via REST API
      if (callData?.callId) {
        try {
          const apiClient = require("../services/api").default;
          const { endpoints } = require("../config/api");
          await apiClient.post(endpoints.calls.reject, {
            callId: callData.callId,
          });
        } catch {}
      }
    } catch {}
  };

  const callerName = callData?.callerName || "Unknown";
  const callType = callData?.callType || "video";
  const isVoice = callType === "voice";

  // Avatar using DiceBear API
  const avatarUri = `https://api.dicebear.com/7.x/initials/png?seed=${encodeURIComponent(callerName)}&backgroundColor=6C63FF`;

  return (
    <View style={styles.container}>
      <StatusBar
        barStyle="light-content"
        backgroundColor="transparent"
        translucent
      />

      {/* Top label */}
      <Text style={styles.callLabel}>
        {isVoice ? "Incoming Voice Call" : "Incoming Video Call"}
      </Text>

      {/* Avatar + name */}
      <View style={styles.callerInfo}>
        <View style={styles.avatarRing}>
          <Image source={{ uri: avatarUri }} style={styles.avatar} />
        </View>
        <Text style={styles.callerName}>{callerName}</Text>
        <Text style={styles.callStatus}>is calling you...</Text>
      </View>

      {/* Accept / Decline buttons */}
      <View style={styles.actions}>
        <View style={styles.actionWrap}>
          <TouchableOpacity
            style={styles.declineBtn}
            onPress={handleDecline}
            activeOpacity={0.8}
          >
            <Icon name="x" size={32} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.actionLabel}>Decline</Text>
        </View>

        <View style={styles.actionWrap}>
          <TouchableOpacity
            style={styles.acceptBtn}
            onPress={handleAccept}
            activeOpacity={0.8}
          >
            <Icon name={isVoice ? "phone" : "video"} size={32} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.actionLabel}>Accept</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a2e",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 80,
    paddingBottom: 60,
  },
  callLabel: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 16,
    fontWeight: "500",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  callerInfo: {
    alignItems: "center",
  },
  avatarRing: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 3,
    borderColor: "#6C63FF",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
  },
  avatar: {
    width: 110,
    height: 110,
    borderRadius: 55,
  },
  callerName: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "700",
    marginBottom: 8,
  },
  callStatus: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 16,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "space-around",
    width: "70%",
  },
  actionWrap: {
    alignItems: "center",
  },
  declineBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#FF4444",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },
  acceptBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#4CAF50",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },
  actionLabel: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 14,
  },
});
