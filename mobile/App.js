/**
 * App.js — Root Component.
 * Navigation: Auth stack (Splash/Login/Signup/Verify) → Main tabs + stack.
 * Wraps in AuthProvider + SignalingProvider for global state.
 */
import React, { useRef } from "react";
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
} from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import { AuthProvider, useAuth } from "./src/context/AuthContext";
import {
  SignalingProvider,
  useSignaling,
} from "./src/context/SignalingContext";
import signalingClient from "./src/services/socket";
import { colors, typography, shadows, spacing } from "./src/styles/theme";

// Screens
import LoginScreen from "./src/screens/LoginScreen";
import SignupScreen from "./src/screens/SignupScreen";
import VerifyScreen from "./src/screens/VerifyScreen";
import HomeScreen from "./src/screens/HomeScreen";
import CallScreen from "./src/screens/CallScreen";
import SplashScreen from "./src/screens/SplashScreen";
import ChatScreen from "./src/screens/ChatScreen";
import SearchScreen from "./src/screens/SearchScreen";
import CallsScreen from "./src/screens/CallsScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import WorldScreen from "./src/screens/WorldScreen";

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
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.tabBarBg,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 80,
          paddingBottom: 20,
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
              <Icon name="plus" size={28} color={colors.textInverse} />
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
        name="Calls"
        component={CallsScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Icon name="phone" size={size} color={color} />
          ),
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
      </Stack.Navigator>
    </SignalingProvider>
  );
}

// ─── Incoming Call Overlay (visible on any tab) ──────────────────────────────
function IncomingCallOverlay({ navigationRef }) {
  const { incomingCall, clearIncomingCall } = useSignaling();

  const handleAccept = () => {
    if (!incomingCall) return;
    signalingClient.acceptCall(incomingCall.callId);
    clearIncomingCall();
    if (navigationRef?.current) {
      navigationRef.current.navigate("Call", {
        callId: incomingCall.callId,
        callerName: incomingCall.callerName,
        isCaller: false,
      });
    }
  };

  const handleReject = () => {
    if (!incomingCall) return;
    signalingClient.rejectCall(incomingCall.callId);
    clearIncomingCall();
  };

  if (!incomingCall) return null;

  return (
    <Modal visible transparent animationType="slide">
      <View style={styles.incomingCallOverlay}>
        <View style={styles.incomingCallCard}>
          <Icon
            name="phone-incoming"
            size={48}
            color={colors.success}
            style={{ marginBottom: spacing.md }}
          />
          <Text style={styles.incomingCallTitle}>Incoming Call</Text>
          <Text style={styles.incomingCallerName}>
            {incomingCall.callerName}
          </Text>
          <View style={styles.incomingCallActions}>
            <TouchableOpacity
              style={styles.rejectButton}
              onPress={handleReject}
            >
              <Icon name="x" size={28} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.acceptButton}
              onPress={handleAccept}
            >
              <Icon name="phone" size={28} color="#fff" />
            </TouchableOpacity>
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

  if (isLoading) return <LoadingScreen />;

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
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
            regular: { fontFamily: "System", fontWeight: "400" },
            medium: { fontFamily: "System", fontWeight: "500" },
            bold: { fontFamily: "System", fontWeight: "700" },
            heavy: { fontFamily: "System", fontWeight: "800" },
          },
        }}
      >
        {isAuthenticated ? (
          <MainStack navigationRef={navigationRef} />
        ) : (
          <AuthStack />
        )}
      </NavigationContainer>
    </>
  );
}

// ─── App Entry Point ─────────────────────────────────────────────────────────
export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
  },
  fabButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
    ...shadows.md,
  },
  // Incoming Call
  incomingCallOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.overlay,
  },
  incomingCallCard: {
    width: "80%",
    backgroundColor: colors.bg,
    borderRadius: 24,
    padding: 32,
    alignItems: "center",
    ...shadows.xl,
  },
  incomingCallTitle: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  incomingCallerName: {
    ...typography.h2,
    marginBottom: spacing.xl,
  },
  incomingCallActions: {
    flexDirection: "row",
    gap: 40,
  },
  rejectButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.error,
    justifyContent: "center",
    alignItems: "center",
  },
  acceptButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.success,
    justifyContent: "center",
    alignItems: "center",
  },
});
