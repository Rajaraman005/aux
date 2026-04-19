/**
 * App.js — Root Component.
 * Navigation: Auth stack (Splash/Login/Signup/Verify) → Main tabs + stack.
 * Wraps in AuthProvider + SignalingProvider for global state.
 */
import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  NavigationContainer,
  createNavigationContainerRef,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import {
  StatusBar,
  View,
  ActivityIndicator,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Text,
  Image,
  AppState,
} from "react-native";
import crashLogger, { CATEGORIES } from "./src/services/CrashLogger";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import Icon from "react-native-vector-icons/Feather";
import { AuthProvider, useAuth } from "./src/context/AuthContext";
import {
  SignalingProvider,
  useSignaling,
} from "./src/context/SignalingContext";
import { UploadProvider } from "./src/context/UploadContext";
import signalingClient from "./src/services/socket";
import callManager from "./src/services/CallManager";
import {
  initializeNotifications,
  cleanupNotifications,
  requestNotificationPermission,
} from "./src/services/notifications";
import { InAppNotificationProvider } from "./src/components/InAppNotification";
import { colors, typography, shadows, spacing } from "./src/styles/theme";

// Screens
import LoginScreen from "./src/screens/LoginScreen";
import SignupScreen from "./src/screens/SignupScreen";
import VerifyScreen from "./src/screens/VerifyScreen";
import HomeScreen from "./src/screens/HomeScreen";
// import FeedScreen from "./src/screens/FeedScreen";
import CallScreen from "./src/screens/CallScreen";
import SplashScreen from "./src/screens/SplashScreen";
import ChatScreen from "./src/screens/ChatScreen";
import SearchScreen from "./src/screens/SearchScreen";
import RequestsScreen from "./src/screens/RequestsScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import WorldScreen from "./src/screens/WorldScreen";
import ProfileScreen from "./src/screens/ProfileScreen";
import ImageEditorScreen from "./src/screens/ImageEditorScreen";
import MediaPreviewScreen from "./src/screens/MediaPreviewScreen";
import NotificationsScreen from "./src/screens/NotificationsScreen";
import NotificationPreferencesScreen from "./src/screens/NotificationPreferencesScreen";

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

// ─── Auth Navigator (Unauthenticated) ────────────────────────────────────────
function AuthStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        animation: "slide_from_right",
        contentStyle: { backgroundColor: "#FAFAFA" },
      }}
    >
      <Stack.Screen
        name="Splash"
        component={SplashScreen}
        options={{ animation: "fade" }}
      />
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Signup" component={SignupScreen} />
      <Stack.Screen name="Verify" component={VerifyScreen} />
    </Stack.Navigator>
  );
}

// ─── Bottom Tab Navigator ────────────────────────────────────────────────────
function MainTabs() {
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, 10);

  // Badge count for pending friend requests
  const [requestCount, setRequestCount] = useState(0);

  const fetchRequestCount = useCallback(async () => {
    try {
      const apiClient = require("./src/services/api").default;
      const { endpoints } = require("./src/config/api");
      const data = await apiClient.get(endpoints.friends.requests);
      setRequestCount((data.requests || []).length);
    } catch (err) {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    fetchRequestCount();

    // Real-time: refresh count when a new notification arrives
    const unsub = signalingClient.on("notification:new", (data) => {
      if (data?.notification?.type === "friend_request") {
        setRequestCount((prev) => prev + 1);
      }
    });
    return () => unsub();
  }, [fetchRequestCount]);

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.tabBarBg,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 60 + bottomPad,
          paddingBottom: bottomPad,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarLabel: "Chats",
          tabBarIcon: ({ color, size }) => (
            <Icon name="message-circle" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="World"
        component={View}
        options={{
          tabBarLabel: "World",
          tabBarIcon: ({ color, size }) => (
            <Icon name="globe" size={size} color={color} />
          ),
        }}
        listeners={({ navigation }) => ({
          tabPress: (e) => {
            e.preventDefault();
            navigation.navigate("WorldChat");
          },
        })}
      />
      <Tab.Screen
        name="NewAction"
        component={View}
        options={{
          tabBarLabel: "",
          tabBarIcon: () => (
            <View style={styles.fabButton}>
              <Icon name="plus" size={26} color="#fff" />
            </View>
          ),
        }}
        listeners={({ navigation }) => ({
          tabPress: (e) => {
            e.preventDefault();
            navigation.navigate("Search");
          },
        })}
      />
      <Tab.Screen
        name="Requests"
        component={RequestsScreen}
        options={{
          tabBarLabel: "Requests",
          tabBarIcon: ({ color, size }) => (
            <Icon name="user-plus" size={size} color={color} />
          ),
          tabBarBadge: requestCount > 0 ? requestCount : undefined,
          tabBarBadgeStyle: {
            backgroundColor: "#ef4444",
            color: "#fff",
            fontSize: 10,
            fontWeight: "700",
            minWidth: 16,
            height: 16,
            lineHeight: 16,
            borderRadius: 8,
            top: -2,
          },
        }}
        listeners={{
          tabPress: () => setRequestCount(0),
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Icon name="settings" size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

// ─── Main Navigator (Authenticated) ─────────────────────────────────────────
function MainStack({ navigationRef }) {
  return (
    <SignalingProvider>
      <IncomingCallOverlay navigationRef={navigationRef} />
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen
          name="MainTabs"
          component={MainTabs}
          options={{ animation: "fade" }}
        />
        <Stack.Screen
          name="Search"
          component={SearchScreen}
          options={{ animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="WorldChat"
          component={WorldScreen}
          options={{ animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="Chat"
          component={ChatScreen}
          options={{ animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="Call"
          component={CallScreen}
          options={{
            animation: "slide_from_bottom",
            gestureEnabled: false,
            presentation: "fullScreenModal",
          }}
        />
        <Stack.Screen
          name="Profile"
          component={ProfileScreen}
          options={{ animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="ImageEditor"
          component={ImageEditorScreen}
          options={{
            animation: "slide_from_bottom",
            presentation: "fullScreenModal",
            gestureEnabled: false,
          }}
        />
        <Stack.Screen
          name="MediaPreview"
          component={MediaPreviewScreen}
          options={{
            animation: "slide_from_bottom",
            presentation: "fullScreenModal",
            gestureEnabled: false,
          }}
        />
        <Stack.Screen
          name="Notifications"
          component={NotificationsScreen}
          options={{ animation: "slide_from_right" }}
        />
        <Stack.Screen
          name="NotificationPreferences"
          component={NotificationPreferencesScreen}
          options={{ animation: "slide_from_right" }}
        />
      </Stack.Navigator>
    </SignalingProvider>
  );
}

// ─── Incoming Call Overlay (visible on any tab) ──────────────────────────────
const AVATAR_BASE = "https://api.dicebear.com/7.x/initials/png?seed=";

function IncomingCallOverlay({ navigationRef }) {
  const { incomingCall, clearIncomingCall, profileUpdates } = useSignaling();

  const handleAccept = () => {
    if (!incomingCall) return;
    // ★ Delegate to CallManager — sets up session, signaling listeners, WebRTC
    callManager.acceptIncomingCall(incomingCall);
    clearIncomingCall();
    if (navigationRef?.current) {
      const liveProf = profileUpdates.get(incomingCall.callerId);
      const rawAvatar = liveProf?.avatarUrl
        ? `${liveProf.avatarUrl}?t=${liveProf.timestamp}`
        : incomingCall.callerAvatar;
      const avatarUri = rawAvatar?.startsWith("http")
        ? rawAvatar
        : `${AVATAR_BASE}${encodeURIComponent(incomingCall.callerName || "User")}`;

      navigationRef.current.navigate("Call", {
        callerName: incomingCall.callerName,
        callerAvatar: avatarUri,
        callType: incomingCall.callType || "video",
      });
    }
  };

  const handleReject = () => {
    if (!incomingCall) return;
    // ★ Delegate to CallManager for proper rejection
    callManager.rejectIncomingCall(incomingCall.callId);
    clearIncomingCall();
  };

  if (!incomingCall) return null;

  const liveProf = profileUpdates.get(incomingCall.callerId);
  const rawAvatar = liveProf?.avatarUrl
    ? `${liveProf.avatarUrl}?t=${liveProf.timestamp}`
    : incomingCall.callerAvatar;
  const avatarUri = rawAvatar?.startsWith("http")
    ? rawAvatar
    : `${AVATAR_BASE}${encodeURIComponent(incomingCall.callerName || "User")}`;
  const isVoice = incomingCall.callType === "voice";

  return (
    <Modal visible transparent animationType="slide">
      <View style={styles.incomingCallOverlay}>
        <StatusBar barStyle="dark-content" />

        {/* Center content: avatar + name */}
        <View style={styles.incomingCenterContent}>
          <View style={styles.avatarRing}>
            <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
          </View>
          <Text style={styles.incomingCallLabel}>
            {isVoice ? "Incoming Voice Call" : "Incoming Video Call"}
          </Text>
          <Text style={styles.incomingCallerName}>
            {incomingCall.callerName}
          </Text>
        </View>

        {/* Bottom action buttons */}
        <View style={styles.incomingCallActions}>
          <View style={styles.actionBtnWrap}>
            <TouchableOpacity
              style={styles.acceptButton}
              onPress={handleAccept}
              activeOpacity={0.8}
            >
              <Icon name={isVoice ? "phone" : "video"} size={32} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.actionLabel}>Accept</Text>
          </View>

          <View style={styles.actionBtnWrap}>
            <TouchableOpacity
              style={styles.rejectButton}
              onPress={handleReject}
              activeOpacity={0.8}
            >
              <Icon name="x" size={32} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.actionLabel}>Decline</Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Loading Splash ──────────────────────────────────────────────────────────
function LoadingScreen() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

// ─── Root Navigator ──────────────────────────────────────────────────────────
function RootNavigator() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigationRef = useRef(null);

  // ★ Request all permissions immediately on app start.
  // This ensures fresh installs see the permission dialogs for Notifications,
  // Camera, Microphone, and Contacts on the very first screen.
  React.useEffect(() => {
    async function requestAllPermissions() {
      if (Platform.OS === "android") {
        try {
          const { PermissionsAndroid } = require("react-native");
          // Request core device permissions first
          await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.CAMERA,
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
          ]);
        } catch (err) {
          console.warn("Failed to request core Android permissions:", err);
        }
      }
      
      // Request notification permission (handles Android 13+ POST_NOTIFICATIONS)
      // This also checks for Android 14+ USE_FULL_SCREEN_INTENT
      await requestNotificationPermission();
    }

    requestAllPermissions();
  }, []);

  // Initialize push notification listeners
  React.useEffect(() => {
    if (isAuthenticated) {
      initializeNotifications(navigationRef);
    }
    return () => cleanupNotifications();
  }, [isAuthenticated]);

  if (isLoading) return <LoadingScreen />;

  return (
    <>
      <StatusBar
        barStyle="dark-content"
        backgroundColor={colors.bg}
        translucent={false}
      />
      <NavigationContainer
        ref={navigationRef}
        theme={{
          dark: false,
          colors: {
            primary: colors.primary,
            background: colors.bg,
            card: colors.bgCard,
            text: colors.textPrimary,
            border: colors.border,
            notification: colors.error,
          },
          fonts: {
            regular: { fontFamily: "sans-serif", fontWeight: "400" },
            medium: { fontFamily: "sans-serif-medium", fontWeight: "500" },
            bold: { fontFamily: "sans-serif", fontWeight: "700" },
            heavy: { fontFamily: "sans-serif", fontWeight: "800" },
          },
        }}
      >
        <InAppNotificationProvider navigationRef={navigationRef}>
          <UploadProvider>
            {isAuthenticated ? (
              <MainStack navigationRef={navigationRef} />
            ) : (
              <AuthStack />
            )}
          </UploadProvider>
        </InAppNotificationProvider>
      </NavigationContainer>
    </>
  );
}

// ─── Error Boundary (catches React component tree crashes) ────────────────
class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    crashLogger.log(
      CATEGORIES.ERROR_BOUNDARY,
      `React tree crash: ${error.message}`,
      error,
    );
    crashLogger.logMemoryUsage();
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.errorBoundary}>
          <Text style={styles.errorTitle}>Something went wrong</Text>
          <Text style={styles.errorMessage}>
            {this.state.error?.message || "An unexpected error occurred"}
          </Text>
          <TouchableOpacity
            style={styles.errorButton}
            onPress={() => this.setState({ hasError: false, error: null })}
          >
            <Text style={styles.errorButtonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

// ─── App Entry Point ─────────────────────────────────────────────────────────
export default function App() {
  // ★ Log app lifecycle for crash diagnostics
  useEffect(() => {
    crashLogger.log(CATEGORIES.APP_START, "App component mounted");
    crashLogger.logMemoryUsage();

    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        crashLogger.log(CATEGORIES.APP_FOREGROUND, "App foregrounded");
        crashLogger.logMemoryUsage();
      } else if (state === "background") {
        crashLogger.log(CATEGORIES.APP_BACKGROUND, "App backgrounded");
        crashLogger.logMemoryUsage();
        // Force flush logs before going to background
        crashLogger.flushNow();
      }
    });

    // ★ Periodic memory monitoring (every 30s during active use)
    const memTimer = setInterval(() => {
      if (AppState.currentState === "active") {
        crashLogger.logMemoryUsage();
      }
    }, 30000);

    return () => {
      appStateSub.remove();
      clearInterval(memTimer);
    };
  }, []);

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <KeyboardProvider>
          <AuthProvider>
            <RootNavigator />
          </AuthProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
  },
  errorBoundary: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#FAFAFA",
    padding: 24,
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#1a1a1a",
    marginBottom: 12,
  },
  errorMessage: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 20,
  },
  errorButton: {
    backgroundColor: "#1a1a1a",
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
  },
  errorButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },

  // Incoming Call Overlay
  incomingCallOverlay: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    paddingTop: 60,
    paddingBottom: 50,
    alignItems: "center",
  },
  incomingCenterContent: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarRing: {
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 3,
    borderColor: "#d0d0d0",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
  },
  avatarImage: {
    width: 118,
    height: 118,
    borderRadius: 59,
    backgroundColor: "#e0e0e0",
  },
  incomingCallLabel: {
    fontSize: 14,
    color: "#888",
    letterSpacing: 0.3,
    marginBottom: 8,
  },
  incomingCallerName: {
    fontSize: 26,
    fontWeight: "700",
    color: "#1a1a1a",
  },
  incomingCallActions: {
    flexDirection: "row",
    justifyContent: "center",
    width: "100%",
    gap: 150,
    paddingBottom: 20,
  },
  actionBtnWrap: {
    alignItems: "center",
  },
  acceptButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: "#1a1a1a",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },
  rejectButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: "#e53935",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },
  actionLabel: {
    fontSize: 13,
    color: "#666",
    fontWeight: "500",
  },
  fabButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#1a1a1a",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
});
