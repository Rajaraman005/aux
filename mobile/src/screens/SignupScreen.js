/**
 * Signup Screen — Premium clean design matching LoginScreen theme.
 * Features: step-like form, password strength meter, smooth animations.
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
  Dimensions,
} from "react-native";
import Feather from "react-native-vector-icons/Feather";
import { useAuth } from "../context/AuthContext";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

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
  const [focusedFields, setFocusedFields] = useState({});

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(40)).current;

  React.useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 700,
        useNativeDriver: true,
      }),
      Animated.spring(slideAnim, {
        toValue: 0,
        damping: 20,
        stiffness: 200,
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

  const getPasswordStrength = () => {
    const p = form.password;
    if (!p) return { level: 0, label: "", color: "#D1D1D6" };
    let score = 0;
    if (p.length >= 8) score++;
    if (p.length >= 12) score++;
    if (/[A-Z]/.test(p)) score++;
    if (/[0-9]/.test(p)) score++;
    if (/[^A-Za-z0-9]/.test(p)) score++;

    if (score <= 1) return { level: score, label: "Weak", color: "#EF4444" };
    if (score <= 3) return { level: score, label: "Fair", color: "#F59E0B" };
    return { level: score, label: "Strong", color: "#10B981" };
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
      console.error("Signup error:", JSON.stringify(err));
      setServerError(
        err.error || err.message || "Signup failed. Please try again.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [form, signup, navigation]);

  const strength = getPasswordStrength();

  const setFieldFocused = useCallback((field, focused) => {
    setFocusedFields((prev) => ({ ...prev, [field]: focused }));
  }, []);

  const renderInput = (field, label, placeholder, iconName, options = {}) => (
    <View style={styles.inputGroup}>
      <Text style={styles.label}>{label}</Text>
      <View
        style={[
          styles.inputWrapper,
          focusedFields[field] && styles.inputWrapperFocused,
          errors[field] && styles.inputWrapperError,
        ]}
      >
        {typeof iconName === "string" && iconName.startsWith("+") ? (
          <Text style={styles.phoneCode}>{iconName}</Text>
        ) : (
          <Feather
            name={iconName}
            size={18}
            color="#6B6B80"
            style={styles.inputIconSvg}
          />
        )}
        <TextInput
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor="#A0A0A0"
          value={form[field]}
          onChangeText={(v) => updateField(field, v)}
          editable={!isLoading}
          onFocus={() => setFieldFocused(field, true)}
          onBlur={() => setFieldFocused(field, false)}
          {...options}
        />
      </View>
      {errors[field] && <Text style={styles.fieldError}>{errors[field]}</Text>}
    </View>
  );

  return (
    <View style={styles.container}>
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
            {/* Header with Back Button */}
            <View style={styles.headerRow}>
              <TouchableOpacity
                style={styles.backButton}
                onPress={() => navigation.goBack()}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <View style={styles.backArrow} />
              </TouchableOpacity>
              <Text style={styles.title}>Create Account</Text>
            </View>
            <View style={styles.header}>
              <Text style={styles.subtitle}>
                Join us and start making crystal-clear calls today.
              </Text>
            </View>

            {/* Form */}
            <View style={styles.formCard}>
              {renderInput("name", "Full Name", "John Doe", "user", {
                autoCapitalize: "words",
              })}
              {renderInput("email", "Email", "your@email.com", "mail", {
                keyboardType: "email-address",
                autoCapitalize: "none",
              })}
              {renderInput("phone", "Phone Number", "98765 43210", "+91", {
                keyboardType: "phone-pad",
              })}

              {/* Password */}
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Password</Text>
                <View
                  style={[
                    styles.inputWrapper,
                    focusedFields.password && styles.inputWrapperFocused,
                    errors.password && styles.inputWrapperError,
                  ]}
                >
                  <Feather
                    name="lock"
                    size={18}
                    color="#6B6B80"
                    style={styles.inputIconSvg}
                  />
                  <TextInput
                    key={showPassword ? "pw-visible" : "pw-hidden"}
                    style={styles.input}
                    placeholder="Min. 8 characters"
                    placeholderTextColor="#A0A0A0"
                    value={form.password}
                    onChangeText={(v) => updateField("password", v)}
                    secureTextEntry={!showPassword}
                    autoComplete="password"
                    textContentType="password"
                    editable={!isLoading}
                    onFocus={() => setFieldFocused("password", true)}
                    onBlur={() => setFieldFocused("password", false)}
                  />
                  <TouchableOpacity
                    onPress={() => setShowPassword(!showPassword)}
                    style={styles.eyeBtn}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Text style={styles.eyeText}>
                      {showPassword ? "Hide" : "Show"}
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* Strength Meter */}
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
                                  : "#E5E5EA",
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

              {/* Confirm Password */}
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Confirm Password</Text>
                <View
                  style={[
                    styles.inputWrapper,
                    focusedFields.confirmPassword && styles.inputWrapperFocused,
                    errors.confirmPassword && styles.inputWrapperError,
                  ]}
                >
                  <Feather
                    name="lock"
                    size={18}
                    color="#6B6B80"
                    style={styles.inputIconSvg}
                  />
                  <TextInput
                    key={showPassword ? "cpw-visible" : "cpw-hidden"}
                    style={styles.input}
                    placeholder="Re-enter password"
                    placeholderTextColor="#A0A0A0"
                    value={form.confirmPassword}
                    onChangeText={(v) => updateField("confirmPassword", v)}
                    secureTextEntry={!showPassword}
                    autoComplete="password"
                    textContentType="password"
                    editable={!isLoading}
                    onFocus={() => setFieldFocused("confirmPassword", true)}
                    onBlur={() => setFieldFocused("confirmPassword", false)}
                  />
                </View>
                {errors.confirmPassword && (
                  <Text style={styles.fieldError}>
                    {errors.confirmPassword}
                  </Text>
                )}
              </View>

              {/* Server Error */}
              {serverError ? (
                <View style={styles.errorContainer}>
                  <Text style={styles.errorText}>{serverError}</Text>
                </View>
              ) : null}

              {/* Signup Button */}
              <TouchableOpacity
                style={[
                  styles.signupButton,
                  isLoading && styles.buttonDisabled,
                ]}
                onPress={handleSignup}
                disabled={isLoading}
                activeOpacity={0.85}
              >
                {isLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.buttonText}>Create Account</Text>
                )}
              </TouchableOpacity>

              {/* Terms */}
              <Text style={styles.termsText}>
                By signing up, you agree to our{" "}
                <Text style={styles.termsLink}>Terms of Service</Text> and{" "}
                <Text style={styles.termsLink}>Privacy Policy</Text>
              </Text>
            </View>

            {/* Login Link */}
            <TouchableOpacity
              onPress={() => navigation.navigate("Login")}
              style={styles.loginLink}
            >
              <Text style={styles.linkText}>
                Already have an account?{" "}
                <Text style={styles.linkBold}>Sign In</Text>
              </Text>
            </TouchableOpacity>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FAFAFA",
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 50,
    paddingBottom: 30,
  },
  content: {
    flex: 1,
  },

  // Header Row (back + title on same line)
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
    gap: 12,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#F0F0F0",
    justifyContent: "center",
    alignItems: "center",
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
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: "#1A1A2E",
    letterSpacing: -0.8,
  },

  // Header
  header: {
    marginBottom: 16,
  },
  subtitle: {
    fontSize: 14,
    color: "#8E8E93",
    lineHeight: 20,
    fontWeight: "400",
  },

  // Form
  formCard: {
    marginBottom: 16,
  },
  inputGroup: {
    marginBottom: 14,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: "#3A3A4A",
    marginBottom: 6,
    letterSpacing: 0.2,
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "#E5E5EA",
    paddingHorizontal: 14,
    height: 48,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  inputWrapperFocused: {
    borderColor: "#fdd63d",
    shadowColor: "#fdd63d",
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  inputWrapperError: {
    borderColor: "#EF4444",
  },
  inputIconSvg: {
    marginRight: 10,
  },
  phoneCode: {
    fontSize: 15,
    fontWeight: "600",
    color: "#1A1A2E",
    marginRight: 10,
    letterSpacing: 0.3,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: "#1A1A2E",
    paddingVertical: 0,
    fontWeight: "400",
  },
  eyeBtn: {
    paddingLeft: 10,
  },
  eyeText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fdd63d",
  },
  fieldError: {
    fontSize: 12,
    color: "#EF4444",
    marginTop: 6,
    fontWeight: "500",
  },

  // Strength Meter
  strengthContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
  },
  strengthBar: {
    flexDirection: "row",
    flex: 1,
    gap: 4,
  },
  strengthSegment: {
    flex: 1,
    height: 4,
    borderRadius: 2,
  },
  strengthLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginLeft: 10,
  },

  // Error
  errorContainer: {
    backgroundColor: "#FEF2F2",
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  errorText: {
    fontSize: 14,
    color: "#DC2626",
    fontWeight: "500",
    textAlign: "center",
  },

  // Button
  signupButton: {
    backgroundColor: "#1A1A2E",
    borderRadius: 14,
    height: 52,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 4,
    shadowColor: "#1A1A2E",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
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

  // Terms
  termsText: {
    fontSize: 12,
    color: "#A0A0A0",
    textAlign: "center",
    marginTop: 16,
    lineHeight: 18,
  },
  termsLink: {
    color: "#fdd63d",
    fontWeight: "600",
  },

  // Login Link
  loginLink: {
    alignItems: "center",
    paddingVertical: 16,
  },
  linkText: {
    fontSize: 15,
    color: "#8E8E93",
    fontWeight: "400",
  },
  linkBold: {
    color: "#fdd63d",
    fontWeight: "700",
  },
});
