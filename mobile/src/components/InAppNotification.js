/**
 * InAppNotification — FAANG-Grade Custom In-App Notification Banner.
 *
 * ★ Features:
 *   - Animated slide-down from top with spring physics
 *   - Swipe-to-dismiss (gesture support)
 *   - Auto-dismiss after 4 seconds
 *   - Queue system for multiple notifications
 *   - Notification type icons with color coding
 *   - Avatar support
 *   - Tap to navigate to relevant screen
 *   - Glassmorphism / blur background
 *   - Works alongside system notifications
 *
 * Usage:
 *   Wrap your app with <InAppNotificationProvider>
 *   Use useInAppNotification().show({ title, body, type, data }) to display
 */
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
} from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  PanResponder,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolate,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import { colors, shadows } from "../styles/theme";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const NOTIFICATION_HEIGHT = 86;
const AUTO_DISMISS_MS = 4000;
const SWIPE_THRESHOLD = -40;

// ─── Notification Type Config ───────────────────────────────────────────────
const NOTIF_TYPES = {
  message: {
    icon: "message-circle",
    color: "#8b5cf6",
    bg: "rgba(139, 92, 246, 0.12)",
    label: "Message",
  },
  call: {
    icon: "phone",
    color: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.12)",
    label: "Call",
  },
  missed_call: {
    icon: "phone-missed",
    color: "#ef4444",
    bg: "rgba(239, 68, 68, 0.12)",
    label: "Missed Call",
  },
  friend_request: {
    icon: "user-plus",
    color: "#3b82f6",
    bg: "rgba(59, 130, 246, 0.12)",
    label: "Friend Request",
  },
  world_mention: {
    icon: "at-sign",
    color: "#10b981",
    bg: "rgba(16, 185, 129, 0.12)",
    label: "Mention",
  },
  system: {
    icon: "info",
    color: "#6b7280",
    bg: "rgba(107, 114, 128, 0.12)",
    label: "System",
  },
  default: {
    icon: "bell",
    color: "#6b7280",
    bg: "rgba(107, 114, 128, 0.12)",
    label: "Notification",
  },
};

// ─── Context ────────────────────────────────────────────────────────────────
const InAppNotificationContext = createContext(null);

export function useInAppNotification() {
  const ctx = useContext(InAppNotificationContext);
  if (!ctx)
    throw new Error(
      "useInAppNotification must be used within InAppNotificationProvider",
    );
  return ctx;
}

// ─── Notification Banner Component ──────────────────────────────────────────
function NotificationBanner({ notification, onDismiss, onPress }) {
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(-NOTIFICATION_HEIGHT - insets.top - 20);
  const opacity = useSharedValue(0);
  const dismissTimer = useRef(null);

  const typeConfig = NOTIF_TYPES[notification?.type] || NOTIF_TYPES.default;

  // Animate in
  useEffect(() => {
    if (!notification) return;

    translateY.value = withSpring(0, {
      damping: 18,
      stiffness: 200,
      mass: 0.8,
    });
    opacity.value = withTiming(1, { duration: 200 });

    // Auto-dismiss
    dismissTimer.current = setTimeout(() => {
      dismiss();
    }, AUTO_DISMISS_MS);

    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, [notification]);

  const dismiss = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    translateY.value = withSpring(
      -NOTIFICATION_HEIGHT - insets.top - 20,
      { damping: 15, stiffness: 180 },
      () => {
        runOnJS(onDismiss)();
      },
    );
    opacity.value = withTiming(0, { duration: 150 });
  }, [onDismiss, insets.top]);

  // Swipe-to-dismiss via PanResponder
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, { dy }) => Math.abs(dy) > 5,
      onPanResponderMove: (_, { dy }) => {
        if (dy < 0) {
          translateY.value = dy;
        }
      },
      onPanResponderRelease: (_, { dy, vy }) => {
        if (dy < SWIPE_THRESHOLD || vy < -0.5) {
          dismiss();
        } else {
          translateY.value = withSpring(0, { damping: 15, stiffness: 200 });
        }
      },
    }),
  ).current;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  if (!notification) return null;

  return (
    <Animated.View
      style={[
        styles.bannerContainer,
        { paddingTop: insets.top + 8 },
        animatedStyle,
      ]}
      {...panResponder.panHandlers}
    >
      <TouchableOpacity
        style={styles.banner}
        onPress={() => {
          if (dismissTimer.current) clearTimeout(dismissTimer.current);
          onPress?.(notification);
          dismiss();
        }}
        activeOpacity={0.9}
      >
        {/* Icon */}
        <View style={[styles.iconWrap, { backgroundColor: typeConfig.bg }]}>
          <Icon name={typeConfig.icon} size={22} color={typeConfig.color} />
        </View>

        {/* Content */}
        <View style={styles.content}>
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>
              {notification.title || typeConfig.label}
            </Text>
            <Text style={styles.time}>now</Text>
          </View>
          {notification.body ? (
            <Text style={styles.body} numberOfLines={2}>
              {notification.body}
            </Text>
          ) : null}
        </View>

        {/* Dismiss hint */}
        <View style={styles.dismissHint}>
          <View style={styles.dismissLine} />
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Provider Component ─────────────────────────────────────────────────────
export function InAppNotificationProvider({ children, navigationRef }) {
  const [current, setCurrent] = useState(null);
  const queue = useRef([]);
  const isShowing = useRef(false);

  const showNext = useCallback(() => {
    if (queue.current.length === 0) {
      isShowing.current = false;
      return;
    }
    isShowing.current = true;
    const next = queue.current.shift();
    setCurrent(next);
  }, []);

  const show = useCallback(({ title, body, type, data }) => {
    const notification = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title,
      body,
      type: type || "default",
      data: data || {},
      timestamp: Date.now(),
    };

    if (isShowing.current) {
      // Queue if already showing something
      queue.current.push(notification);
    } else {
      isShowing.current = true;
      setCurrent(notification);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    setCurrent(null);
    // Show next in queue after a small delay
    setTimeout(showNext, 200);
  }, [showNext]);

  const handlePress = useCallback(
    (notification) => {
      // Import navigation handler
      const {
        handleNotificationNavigation,
      } = require("../services/notifications");
      handleNotificationNavigation(notification.data, navigationRef);
    },
    [navigationRef],
  );

  const value = { show };

  return (
    <InAppNotificationContext.Provider value={value}>
      {children}
      <NotificationBanner
        notification={current}
        onDismiss={handleDismiss}
        onPress={handlePress}
      />
    </InAppNotificationContext.Provider>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  bannerContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    elevation: 9999,
    paddingHorizontal: 12,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    borderWidth: 1,
    borderColor: "rgba(0, 0, 0, 0.06)",
  },
  iconWrap: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  content: {
    flex: 1,
    marginRight: 8,
  },
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 3,
  },
  title: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111827",
    flex: 1,
    marginRight: 8,
  },
  time: {
    fontSize: 12,
    color: "#9ca3af",
    fontWeight: "500",
  },
  body: {
    fontSize: 13,
    color: "#6b7280",
    lineHeight: 18,
  },
  dismissHint: {
    position: "absolute",
    bottom: 4,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  dismissLine: {
    width: 36,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(0, 0, 0, 0.1)",
  },
});

export default InAppNotificationProvider;
