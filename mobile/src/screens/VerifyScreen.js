/**
 * OTP Verification Screen — Clean light design.
 * 6-digit code input, back arrow, black verify button, resend timer.
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
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useAuth } from "../context/AuthContext";

const CODE_LENGTH = 6;

export default function VerifyScreen({ navigation }) {
  const { verifyEmail, resendCode, pendingVerification } = useAuth();
  const [code, setCode] = useState(Array(CODE_LENGTH).fill(""));
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(60);
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
        damping: 20,
        stiffness: 200,
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

      if (text && index < CODE_LENGTH - 1) {
        inputRefs.current[index + 1]?.focus();
      }

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
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <Animated.View
          style={[
            styles.content,
            { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
          ]}
        >
          {/* Back Button */}
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <View style={styles.backArrow} />
          </TouchableOpacity>

          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>We just sent an Email</Text>
            <Text style={styles.subtitle}>
              Enter the security code we sent to
            </Text>
            <Text style={styles.emailText}>
              {pendingVerification?.email || "your email"}
            </Text>
          </View>

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

          {/* Error */}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* Verify Button */}
          <TouchableOpacity
            style={[styles.verifyButton, isLoading && styles.buttonDisabled]}
            onPress={() => handleVerify()}
            disabled={isLoading}
            activeOpacity={0.85}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.buttonText}>Verify</Text>
            )}
          </TouchableOpacity>

          {/* Resend */}
          <View style={styles.resendContainer}>
            <Text style={styles.resendLabel}>Didn't receive code?</Text>
            <TouchableOpacity
              onPress={handleResend}
              disabled={resendCooldown > 0}
            >
              <Text
                style={[
                  styles.resendBold,
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
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FAFAFA",
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 50,
  },

  // Back Button
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#F0F0F0",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 32,
    alignSelf: "flex-start",
  },
  backArrow: {
    width: 10,
    height: 10,
    borderLeftWidth: 2.5,
    borderBottomWidth: 2.5,
    borderColor: "#1A1A2E",
    transform: [{ rotate: "45deg" }],
    marginLeft: 2,
  },

  // Header
  header: {
    alignItems: "center",
    marginBottom: 36,
  },
  title: {
    fontSize: 24,
    fontWeight: "800",
    color: "#1A1A2E",
    letterSpacing: -0.5,
    marginBottom: 10,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 15,
    color: "#8E8E93",
    textAlign: "center",
    lineHeight: 22,
  },
  emailText: {
    fontSize: 15,
    color: "#1A1A2E",
    fontWeight: "600",
    marginTop: 4,
  },

  // Code Input
  codeContainer: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 10,
    marginBottom: 28,
  },
  codeInput: {
    width: 46,
    height: 54,
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#E5E5EA",
    textAlign: "center",
    fontSize: 22,
    fontWeight: "700",
    color: "#1A1A2E",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  codeInputFilled: {
    borderColor: "#fdd63d",
    backgroundColor: "#FFFDF5",
  },
  codeInputError: {
    borderColor: "#EF4444",
  },

  // Error
  errorText: {
    fontSize: 13,
    color: "#EF4444",
    textAlign: "center",
    marginBottom: 16,
    fontWeight: "500",
  },

  // Button
  verifyButton: {
    backgroundColor: "#1A1A2E",
    borderRadius: 14,
    height: 52,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#1A1A2E",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
    marginBottom: 24,
  },
  buttonDisabled: {
    backgroundColor: "#C7C7CC",
    shadowOpacity: 0,
    elevation: 0,
  },
  buttonText: {
    fontSize: 17,
    fontWeight: "700",
    color: "#FFFFFF",
    letterSpacing: 0.3,
  },

  // Resend
  resendContainer: {
    alignItems: "center",
  },
  resendLabel: {
    fontSize: 14,
    color: "#8E8E93",
    marginBottom: 4,
  },
  resendBold: {
    color: "#1A1A2E",
    fontWeight: "700",
    fontSize: 14,
  },
  resendDisabled: {
    color: "#C7C7CC",
  },
});
