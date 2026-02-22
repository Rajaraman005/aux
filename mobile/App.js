/**
 * App.js — Root Component.
 * Navigation: Auth stack (Login/Signup/Verify) → Main stack (Home/Call).
 * Wraps in AuthProvider for global auth state.
 */
import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar, View, ActivityIndicator, StyleSheet } from "react-native";
import { AuthProvider, useAuth } from "./src/context/AuthContext";

// Screens
import LoginScreen from "./src/screens/LoginScreen";
import SignupScreen from "./src/screens/SignupScreen";
import VerifyScreen from "./src/screens/VerifyScreen";
import HomeScreen from "./src/screens/HomeScreen";
import CallScreen from "./src/screens/CallScreen";

const Stack = createNativeStackNavigator();

// ─── Auth Navigator (Unauthenticated) ────────────────────────────────────────
function AuthStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        animation: "slide_from_right",
        contentStyle: { backgroundColor: "#0a0a1a" },
      }}
    >
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Signup" component={SignupScreen} />
      <Stack.Screen name="Verify" component={VerifyScreen} />
    </Stack.Navigator>
  );
}

// ─── Main Navigator (Authenticated) ─────────────────────────────────────────
function MainStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: "#0a0a1a" },
      }}
    >
      <Stack.Screen
        name="Home"
        component={HomeScreen}
        options={{ animation: "fade" }}
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
  );
}

// ─── Loading Splash ──────────────────────────────────────────────────────────
function LoadingScreen() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="large" color="#6366f1" />
    </View>
  );
}

// ─── Root Navigator ──────────────────────────────────────────────────────────
function RootNavigator() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <LoadingScreen />;

  return (
    <NavigationContainer
      theme={{
        dark: true,
        colors: {
          primary: "#6366f1",
          background: "#0a0a1a",
          card: "#12122a",
          text: "#f0f0ff",
          border: "rgba(99, 102, 241, 0.15)",
          notification: "#ef4444",
        },
      }}
    >
      {isAuthenticated ? <MainStack /> : <AuthStack />}
    </NavigationContainer>
  );
}

// ─── App Entry Point ─────────────────────────────────────────────────────────
export default function App() {
  return (
    <AuthProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a1a" />
      <RootNavigator />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#0a0a1a",
  },
});
