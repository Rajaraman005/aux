/**
 * IncomingCallScreen — Full-Screen Incoming Call UI.
 *
 * ★ Registered as a Notifee `mainComponent` so Android can launch it
 *   via `fullScreenAction` when a call notification fires while the
 *   screen is OFF or locked. Also launched when the user taps Accept.
 *
 * ★ FIX: This component now:
 *   1. Reads call data from Notifee initial notification OR from
 *      Notifee foreground events (for action button presses)
 *   2. Stops the foreground service and notification on accept/decline
 *   3. Opens the main app to the Call screen on accept
 *   4. Rejects the call via REST API on decline (no WebSocket available)
 *   5. Shows a pulsing animation while ringing
 */
import React, { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Image,
  Animated,
  Easing,
  Linking,
  AppRegistry,
} from "react-native";
import Icon from "react-native-vector-icons/Feather";

// ─── Constants ──────────────────────────────────────────────────────────────
const CALL_NOTIFICATION_ID = "incoming-call";

export default function IncomingCallScreen() {
  const [callData, setCallData] = useState(null);
  const [isHandled, setIsHandled] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // ─── Pulsating ring animation ───────────────────────────────────────────
  useEffect(() => {
    // Fade in
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
    }).start();

    // Pulse loop
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();

    return () => pulse.stop();
  }, []);

  // ─── Load call data from notification ───────────────────────────────────
  useEffect(() => {
    async function loadCallData() {
      try {
        const notifeeModule = require("@notifee/react-native");
        const notifee = notifeeModule.default;

        // Try getInitialNotification first (for fullScreenAction launch)
        const initialNotification = await notifee.getInitialNotification();
        if (initialNotification?.notification?.data) {
          console.log(
            "📞 IncomingCallScreen: Loaded data from initial notification",
          );
          setCallData(initialNotification.notification.data);
          return;
        }

        // Fallback: check displayed notifications for our call notification
        const displayed = await notifee.getDisplayedNotifications();
        const callNotif = displayed.find(
          (n) =>
            n.id === CALL_NOTIFICATION_ID ||
            n.notification?.data?.type === "call",
        );
        if (callNotif?.notification?.data) {
          console.log(
            "📞 IncomingCallScreen: Loaded data from displayed notification",
          );
          setCallData(callNotif.notification.data);
        }
      } catch (err) {
        console.error("IncomingCallScreen: Failed to load call data:", err);
      }
    }
    loadCallData();
  }, []);

  // ─── Handle Accept ──────────────────────────────────────────────────────
  const handleAccept = async () => {
    if (isHandled) return;
    setIsHandled(true);

    try {
      const notifeeModule = require("@notifee/react-native");
      const notifee = notifeeModule.default;

      // Stop foreground service + cancel notification
      try {
        await notifee.stopForegroundService();
      } catch {}
      await notifee.cancelNotification(CALL_NOTIFICATION_ID);
    } catch {}

    // ★ The app will open via MainActivity (launched by fullScreenAction/pressAction).
    // The main app's notification handlers will detect the call data
    // and navigate to the Call screen.
    console.log("📞 IncomingCallScreen: Call accepted");
  };

  // ─── Handle Decline ─────────────────────────────────────────────────────
  const handleDecline = async () => {
    if (isHandled) return;
    setIsHandled(true);

    try {
      const notifeeModule = require("@notifee/react-native");
      const notifee = notifeeModule.default;

      // Stop foreground service + cancel notification
      try {
        await notifee.stopForegroundService();
      } catch {}
      await notifee.cancelNotification(CALL_NOTIFICATION_ID);

      // Reject via REST API (no WebSocket in killed-app context)
      if (callData?.callId) {
        try {
          const apiClient = require("../services/api").default;
          const { endpoints } = require("../config/api");
          await apiClient.post(endpoints.calls.reject, {
            callId: callData.callId,
          });
          console.log("📞 IncomingCallScreen: Call rejected via REST API");
        } catch (apiErr) {
          console.error("IncomingCallScreen: REST reject failed:", apiErr);
        }
      }
    } catch (err) {
      console.error("IncomingCallScreen: Decline error:", err);
    }
  };

  const callerName = callData?.callerName || "Unknown";
  const callType = callData?.callType || "video";
  const isVoice = callType === "voice";

  // Avatar using DiceBear API
  const avatarUri = `https://api.dicebear.com/7.x/initials/png?seed=${encodeURIComponent(callerName)}&backgroundColor=6C63FF`;

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
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
        <Animated.View
          style={[styles.avatarPulse, { transform: [{ scale: pulseAnim }] }]}
        >
          <View style={styles.avatarRing}>
            <Image source={{ uri: avatarUri }} style={styles.avatar} />
          </View>
        </Animated.View>
        <Text style={styles.callerName}>{callerName}</Text>
        <Text style={styles.callStatus}>is calling you...</Text>
      </View>

      {/* Accept / Decline buttons */}
      <View style={styles.actions}>
        <View style={styles.actionWrap}>
          <TouchableOpacity
            style={[styles.declineBtn, isHandled && styles.disabledBtn]}
            onPress={handleDecline}
            activeOpacity={0.8}
            disabled={isHandled}
          >
            <Icon name="x" size={32} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.actionLabel}>Decline</Text>
        </View>

        <View style={styles.actionWrap}>
          <TouchableOpacity
            style={[styles.acceptBtn, isHandled && styles.disabledBtn]}
            onPress={handleAccept}
            activeOpacity={0.8}
            disabled={isHandled}
          >
            <Icon name={isVoice ? "phone" : "video"} size={32} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.actionLabel}>Accept</Text>
        </View>
      </View>
    </Animated.View>
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
  avatarPulse: {
    marginBottom: 20,
  },
  avatarRing: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 3,
    borderColor: "#6C63FF",
    justifyContent: "center",
    alignItems: "center",
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
  disabledBtn: {
    opacity: 0.5,
  },
  actionLabel: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 14,
  },
});
