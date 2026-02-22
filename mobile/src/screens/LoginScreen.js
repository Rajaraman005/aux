/**
 * Login Screen — Glassmorphism design.
 * Animated transitions, input validation, error handling.
 */
import React, { useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Animated,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { useAuth } from "../context/AuthContext";
import {
  colors,
  typography,
  spacing,
  radius,
  shadows,
  commonStyles,
  animations,
} from "../styles/theme";

export default function LoginScreen({ navigation }) {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  React.useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }),
      Animated.spring(slideAnim, {
        toValue: 0,
        ...animations.spring,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  const handleLogin = useCallback(async () => {
    setError("");
    if (!email.trim() || !password) {
      setError("Email and password are required");
      return;
    }

    setIsLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
      // Navigation handled by AuthContext → App.js
    } catch (err) {
      if (err.code === "EMAIL_NOT_VERIFIED") {
        navigation.navigate("Verify");
        return;
      }
      setError(err.error || "Login failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [email, password, login, navigation]);

  return (
    <View style={styles.container}>
      {/* Background gradient effect */}
      <View style={styles.bgGradient} />
      <View style={styles.bgOrb1} />
      <View style={styles.bgOrb2} />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View
            style={[
              styles.content,
              { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
            ]}
          >
            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.logo}>📞</Text>
              <Text style={styles.title}>VideoCall</Text>
              <Text style={styles.subtitle}>
                Crystal-clear calls, anywhere.
              </Text>
            </View>

            {/* Glass Card */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Welcome back</Text>

              {/* Email Input */}
              <View style={styles.inputGroup}>
                <Text style={styles.label}>EMAIL</Text>
                <TextInput
                  style={styles.input}
                  placeholder="your@email.com"
                  placeholderTextColor={colors.textMuted}
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isLoading}
                />
              </View>

              {/* Password Input */}
              <View style={styles.inputGroup}>
                <Text style={styles.label}>PASSWORD</Text>
                <View style={styles.passwordContainer}>
                  <TextInput
                    style={styles.passwordInput}
                    placeholder="Enter password"
                    placeholderTextColor={colors.textMuted}
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!showPassword}
                    editable={!isLoading}
                  />
                  <TouchableOpacity
                    onPress={() => setShowPassword(!showPassword)}
                    style={styles.showPasswordBtn}
                  >
                    <Text style={styles.showPasswordText}>
                      {showPassword ? "🙈" : "👁️"}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Error Message */}
              {error ? (
                <View style={styles.errorContainer}>
                  <Text style={styles.errorText}>⚠️ {error}</Text>
                </View>
              ) : null}

              {/* Login Button */}
              <TouchableOpacity
                style={[
                  styles.loginButton,
                  isLoading && styles.loginButtonDisabled,
                ]}
                onPress={handleLogin}
                disabled={isLoading}
                activeOpacity={0.8}
              >
                {isLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.loginButtonText}>Sign In</Text>
                )}
              </TouchableOpacity>

              {/* Signup Link */}
              <TouchableOpacity
                onPress={() => navigation.navigate("Signup")}
                style={styles.signupLink}
              >
                <Text style={styles.signupText}>
                  Don't have an account?{" "}
                  <Text style={styles.signupTextBold}>Create one</Text>
                </Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  bgGradient: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg,
  },
  bgOrb1: {
    position: "absolute",
    top: -100,
    right: -80,
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: "rgba(99, 102, 241, 0.08)",
  },
  bgOrb2: {
    position: "absolute",
    bottom: -50,
    left: -100,
    width: 250,
    height: 250,
    borderRadius: 125,
    backgroundColor: "rgba(139, 92, 246, 0.06)",
  },
  keyboardView: { flex: 1 },
  scrollContent: { flexGrow: 1, justifyContent: "center", padding: spacing.lg },
  content: { alignItems: "center" },
  header: { alignItems: "center", marginBottom: spacing.xl },
  logo: { fontSize: 56, marginBottom: spacing.sm },
  title: { ...typography.h1, fontSize: 36, letterSpacing: -1 },
  subtitle: { ...typography.bodySmall, marginTop: spacing.xs },
  card: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: colors.bgGlass,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.bgGlassBorder,
    padding: spacing.xl,
    ...shadows.lg,
  },
  cardTitle: { ...typography.h3, marginBottom: spacing.lg },
  inputGroup: { marginBottom: spacing.md },
  label: { ...typography.label, marginBottom: spacing.xs },
  input: { ...commonStyles.input },
  passwordContainer: { flexDirection: "row", alignItems: "center" },
  passwordInput: { ...commonStyles.input, flex: 1 },
  showPasswordBtn: { position: "absolute", right: 12, padding: 8 },
  showPasswordText: { fontSize: 18 },
  errorContainer: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  errorText: { ...typography.bodySmall, color: colors.error },
  loginButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: spacing.sm,
    ...shadows.xl,
  },
  loginButtonDisabled: { backgroundColor: colors.bgElevated, ...shadows.sm },
  loginButtonText: { ...typography.button },
  signupLink: {
    alignItems: "center",
    marginTop: spacing.lg,
    padding: spacing.sm,
  },
  signupText: { ...typography.bodySmall },
  signupTextBold: { color: colors.primary, fontWeight: "600" },
});
