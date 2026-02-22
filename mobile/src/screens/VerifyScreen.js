/**
 * Email Verification Screen.
 * 6-digit code input with auto-submit and resend functionality.
 */
import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Animated,
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
  animations,
} from "../styles/theme";

const CODE_LENGTH = 6;

export default function VerifyScreen({ navigation }) {
  const { verifyEmail, resendCode, pendingVerification } = useAuth();
  const [code, setCode] = useState(Array(CODE_LENGTH).fill(""));
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const inputRefs = useRef([]);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => {
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
    inputRefs.current[0]?.focus();
  }, []);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown > 0) {
      const timer = setTimeout(
        () => setResendCooldown(resendCooldown - 1),
        1000,
      );
      return () => clearTimeout(timer);
    }
  }, [resendCooldown]);

  const handleCodeChange = useCallback(
    (text, index) => {
      const newCode = [...code];
      newCode[index] = text;
      setCode(newCode);
      setError("");

      // Auto-focus next input
      if (text && index < CODE_LENGTH - 1) {
        inputRefs.current[index + 1]?.focus();
      }

      // Auto-submit when all digits entered
      if (newCode.every((d) => d) && newCode.join("").length === CODE_LENGTH) {
        handleVerify(newCode.join(""));
      }
    },
    [code],
  );

  const handleKeyPress = (e, index) => {
    if (e.nativeEvent.key === "Backspace" && !code[index] && index > 0) {
      const newCode = [...code];
      newCode[index - 1] = "";
      setCode(newCode);
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleVerify = useCallback(
    async (fullCode) => {
      const codeStr = fullCode || code.join("");
      if (codeStr.length !== CODE_LENGTH) {
        setError("Please enter the full 6-digit code");
        return;
      }

      setIsLoading(true);
      try {
        await verifyEmail(codeStr);
        navigation.navigate("Login");
      } catch (err) {
        setError(err.error || "Invalid code. Please try again.");
        setCode(Array(CODE_LENGTH).fill(""));
        inputRefs.current[0]?.focus();
      } finally {
        setIsLoading(false);
      }
    },
    [code, verifyEmail, navigation],
  );

  const handleResend = useCallback(async () => {
    if (resendCooldown > 0) return;
    try {
      await resendCode();
      setResendCooldown(60);
      setError("");
    } catch (err) {
      setError(err.error || "Failed to resend code");
    }
  }, [resendCooldown, resendCode]);

  return (
    <View style={styles.container}>
      <View style={styles.bgOrb} />

      <Animated.View
        style={[
          styles.content,
          { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.emoji}>✉️</Text>
          <Text style={styles.title}>Check your email</Text>
          <Text style={styles.subtitle}>
            We sent a 6-digit code to{"\n"}
            <Text style={styles.emailText}>
              {pendingVerification?.email || "your email"}
            </Text>
          </Text>
        </View>

        <View style={styles.card}>
          {/* Code Input */}
          <View style={styles.codeContainer}>
            {Array(CODE_LENGTH)
              .fill(0)
              .map((_, i) => (
                <TextInput
                  key={i}
                  ref={(ref) => (inputRefs.current[i] = ref)}
                  style={[
                    styles.codeInput,
                    code[i] && styles.codeInputFilled,
                    error && styles.codeInputError,
                  ]}
                  value={code[i]}
                  onChangeText={(text) =>
                    handleCodeChange(text.replace(/[^0-9]/g, "").slice(-1), i)
                  }
                  onKeyPress={(e) => handleKeyPress(e, i)}
                  keyboardType="number-pad"
                  maxLength={1}
                  editable={!isLoading}
                />
              ))}
          </View>

          {error ? <Text style={styles.errorText}>⚠️ {error}</Text> : null}

          {/* Verify Button */}
          <TouchableOpacity
            style={[styles.verifyButton, isLoading && styles.buttonDisabled]}
            onPress={() => handleVerify()}
            disabled={isLoading}
            activeOpacity={0.8}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Verify Email</Text>
            )}
          </TouchableOpacity>

          {/* Resend */}
          <TouchableOpacity
            onPress={handleResend}
            disabled={resendCooldown > 0}
            style={styles.resendLink}
          >
            <Text
              style={[
                styles.resendText,
                resendCooldown > 0 && styles.resendDisabled,
              ]}
            >
              {resendCooldown > 0
                ? `Resend in ${resendCooldown}s`
                : "Resend code"}
            </Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: "center",
    padding: spacing.lg,
  },
  bgOrb: {
    position: "absolute",
    top: "20%",
    left: "50%",
    marginLeft: -150,
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: "rgba(99, 102, 241, 0.06)",
  },
  content: { alignItems: "center" },
  header: { alignItems: "center", marginBottom: spacing.xl },
  emoji: { fontSize: 64, marginBottom: spacing.md },
  title: { ...typography.h2, textAlign: "center" },
  subtitle: {
    ...typography.bodySmall,
    textAlign: "center",
    marginTop: spacing.sm,
    lineHeight: 22,
  },
  emailText: { color: colors.primary, fontWeight: "600" },
  card: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: colors.bgGlass,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.bgGlassBorder,
    padding: spacing.xl,
    ...shadows.lg,
    alignItems: "center",
  },
  codeContainer: { flexDirection: "row", gap: 10, marginBottom: spacing.lg },
  codeInput: {
    width: 48,
    height: 56,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: "rgba(99, 102, 241, 0.1)",
    textAlign: "center",
    fontSize: 24,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  codeInputFilled: {
    borderColor: colors.primary,
    backgroundColor: colors.bgCard,
  },
  codeInputError: { borderColor: colors.error },
  errorText: {
    ...typography.bodySmall,
    color: colors.error,
    marginBottom: spacing.md,
    textAlign: "center",
  },
  verifyButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 16,
    paddingHorizontal: spacing.xxl,
    alignItems: "center",
    width: "100%",
    ...shadows.xl,
  },
  buttonDisabled: { backgroundColor: colors.bgElevated, ...shadows.sm },
  buttonText: { ...typography.button },
  resendLink: { marginTop: spacing.lg, padding: spacing.sm },
  resendText: {
    ...typography.bodySmall,
    color: colors.primary,
    fontWeight: "600",
  },
  resendDisabled: { color: colors.textMuted },
});
