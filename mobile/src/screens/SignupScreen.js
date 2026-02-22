/**
 * Signup Screen — Full validation, premium design.
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

export default function SignupScreen({ navigation }) {
  const { signup } = useAuth();
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
    confirmPassword: "",
  });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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

  const updateField = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: null }));
  };

  const validate = () => {
    const errs = {};
    if (!form.name.trim() || form.name.trim().length < 2)
      errs.name = "Name must be at least 2 characters";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
      errs.email = "Enter a valid email";
    if (!/^\+?[\d\s\-()]{7,20}$/.test(form.phone))
      errs.phone = "Enter a valid phone number";
    if (form.password.length < 8)
      errs.password = "Password must be at least 8 characters";
    if (form.password !== form.confirmPassword)
      errs.confirmPassword = "Passwords do not match";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  // Password strength indicator
  const getPasswordStrength = () => {
    const p = form.password;
    if (!p) return { level: 0, label: "", color: colors.textMuted };
    let score = 0;
    if (p.length >= 8) score++;
    if (p.length >= 12) score++;
    if (/[A-Z]/.test(p)) score++;
    if (/[0-9]/.test(p)) score++;
    if (/[^A-Za-z0-9]/.test(p)) score++;

    if (score <= 1) return { level: score, label: "Weak", color: colors.error };
    if (score <= 3)
      return { level: score, label: "Fair", color: colors.warning };
    return { level: score, label: "Strong", color: colors.success };
  };

  const handleSignup = useCallback(async () => {
    setServerError("");
    if (!validate()) return;

    setIsLoading(true);
    try {
      await signup({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        phone: form.phone.trim(),
        password: form.password,
        confirmPassword: form.confirmPassword,
      });
      navigation.navigate("Verify");
    } catch (err) {
      setServerError(err.error || "Signup failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [form, signup, navigation]);

  const strength = getPasswordStrength();

  const renderInput = (field, label, placeholder, options = {}) => (
    <View style={styles.inputGroup}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, errors[field] && styles.inputError]}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        value={form[field]}
        onChangeText={(v) => updateField(field, v)}
        editable={!isLoading}
        {...options}
      />
      {errors[field] && <Text style={styles.fieldError}>{errors[field]}</Text>}
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.bgOrb1} />
      <View style={styles.bgOrb2} />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
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
              <Text style={styles.title}>Create Account</Text>
              <Text style={styles.subtitle}>
                Join millions making crystal-clear calls
              </Text>
            </View>

            {/* Glass Card */}
            <View style={styles.card}>
              {renderInput("name", "FULL NAME", "John Doe", {
                autoCapitalize: "words",
              })}
              {renderInput("email", "EMAIL", "your@email.com", {
                keyboardType: "email-address",
                autoCapitalize: "none",
              })}
              {renderInput("phone", "PHONE NUMBER", "+1 234 567 8900", {
                keyboardType: "phone-pad",
              })}

              {/* Password with strength meter */}
              <View style={styles.inputGroup}>
                <Text style={styles.label}>PASSWORD</Text>
                <View style={styles.passwordContainer}>
                  <TextInput
                    style={[
                      styles.passwordInput,
                      errors.password && styles.inputError,
                    ]}
                    placeholder="Min. 8 characters"
                    placeholderTextColor={colors.textMuted}
                    value={form.password}
                    onChangeText={(v) => updateField("password", v)}
                    secureTextEntry={!showPassword}
                    editable={!isLoading}
                  />
                  <TouchableOpacity
                    onPress={() => setShowPassword(!showPassword)}
                    style={styles.showPasswordBtn}
                  >
                    <Text style={{ fontSize: 18 }}>
                      {showPassword ? "🙈" : "👁️"}
                    </Text>
                  </TouchableOpacity>
                </View>
                {form.password.length > 0 && (
                  <View style={styles.strengthContainer}>
                    <View style={styles.strengthBar}>
                      {[1, 2, 3, 4, 5].map((i) => (
                        <View
                          key={i}
                          style={[
                            styles.strengthSegment,
                            {
                              backgroundColor:
                                i <= strength.level
                                  ? strength.color
                                  : colors.bgElevated,
                            },
                          ]}
                        />
                      ))}
                    </View>
                    <Text
                      style={[styles.strengthLabel, { color: strength.color }]}
                    >
                      {strength.label}
                    </Text>
                  </View>
                )}
                {errors.password && (
                  <Text style={styles.fieldError}>{errors.password}</Text>
                )}
              </View>

              {renderInput(
                "confirmPassword",
                "CONFIRM PASSWORD",
                "Re-enter password",
                { secureTextEntry: !showPassword },
              )}

              {serverError ? (
                <View style={styles.errorContainer}>
                  <Text style={styles.errorText}>⚠️ {serverError}</Text>
                </View>
              ) : null}

              <TouchableOpacity
                style={[
                  styles.signupButton,
                  isLoading && styles.buttonDisabled,
                ]}
                onPress={handleSignup}
                disabled={isLoading}
                activeOpacity={0.8}
              >
                {isLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.buttonText}>Create Account</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => navigation.navigate("Login")}
                style={styles.loginLink}
              >
                <Text style={styles.linkText}>
                  Already have an account?{" "}
                  <Text style={styles.linkBold}>Sign in</Text>
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
  bgOrb1: {
    position: "absolute",
    top: -80,
    left: -60,
    width: 250,
    height: 250,
    borderRadius: 125,
    backgroundColor: "rgba(139, 92, 246, 0.08)",
  },
  bgOrb2: {
    position: "absolute",
    bottom: -80,
    right: -60,
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: "rgba(99, 102, 241, 0.06)",
  },
  scrollContent: { flexGrow: 1, justifyContent: "center", padding: spacing.lg },
  content: { alignItems: "center" },
  header: { alignItems: "center", marginBottom: spacing.xl },
  title: { ...typography.h1, fontSize: 32 },
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
  inputGroup: { marginBottom: spacing.md },
  label: { ...typography.label, marginBottom: spacing.xs },
  input: { ...commonStyles.input },
  inputError: { borderColor: colors.error },
  passwordContainer: { flexDirection: "row", alignItems: "center" },
  passwordInput: { ...commonStyles.input, flex: 1 },
  showPasswordBtn: { position: "absolute", right: 12, padding: 8 },
  strengthContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 6,
  },
  strengthBar: { flexDirection: "row", flex: 1, gap: 3 },
  strengthSegment: { flex: 1, height: 3, borderRadius: 2 },
  strengthLabel: { ...typography.caption, marginLeft: spacing.sm },
  fieldError: { ...typography.caption, color: colors.error, marginTop: 4 },
  errorContainer: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  errorText: { ...typography.bodySmall, color: colors.error },
  signupButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: spacing.sm,
    ...shadows.xl,
  },
  buttonDisabled: { backgroundColor: colors.bgElevated, ...shadows.sm },
  buttonText: { ...typography.button },
  loginLink: {
    alignItems: "center",
    marginTop: spacing.lg,
    padding: spacing.sm,
  },
  linkText: { ...typography.bodySmall },
  linkBold: { color: colors.primary, fontWeight: "600" },
});
