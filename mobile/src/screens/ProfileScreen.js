/**
 * ProfileScreen — Clean light design matching reference.
 * Features: Edit name, change password, private account toggle, secret name, friends.
 */
import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Animated,
  Switch,
  ActivityIndicator,
  StatusBar,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import { useAuth } from "../context/AuthContext";
import apiClient from "../services/api";
import { endpoints } from "../config/api";
import CustomPopup from "../components/CustomPopup";

const AVATAR_BASE = "https://api.dicebear.com/7.x/initials/png?seed=";

export default function ProfileScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { user, setUser } = useAuth();

  // ─── State ────────────────────────────────────────────────────────────────
  const [name, setName] = useState(user?.name || "");
  const [bio, setBio] = useState(user?.bio || "");
  const [isPrivate, setIsPrivate] = useState(user?.isPrivate || false);
  const [secretName, setSecretName] = useState(user?.secretName || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [changingPw, setChangingPw] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [popup, setPopup] = useState({
    visible: false,
    title: "",
    message: "",
  });

  // ─── Animations ───────────────────────────────────────────────────────────
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;
  const privateSlide = useRef(new Animated.Value(isPrivate ? 1 : 0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }),
      Animated.spring(slideAnim, {
        toValue: 0,
        tension: 65,
        friction: 11,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  useEffect(() => {
    Animated.spring(privateSlide, {
      toValue: isPrivate ? 1 : 0,
      tension: 80,
      friction: 12,
      useNativeDriver: false,
    }).start();
  }, [isPrivate]);

  useEffect(() => {
    const dirty =
      name !== (user?.name || "") ||
      bio !== (user?.bio || "") ||
      isPrivate !== (user?.isPrivate || false) ||
      secretName !== (user?.secretName || "");
    setProfileDirty(dirty);
  }, [name, bio, isPrivate, secretName, user]);

  // ─── Save Profile ─────────────────────────────────────────────────────────
  const handleSaveProfile = useCallback(async () => {
    if (!name.trim() || name.trim().length < 2) {
      setPopup({
        visible: true,
        title: "Invalid Name",
        message: "Name must be at least 2 characters.",
      });
      return;
    }
    if (isPrivate && (!secretName || secretName.length < 3)) {
      setPopup({
        visible: true,
        title: "Secret Name Required",
        message:
          "When private mode is enabled, you need a secret name (at least 3 characters).",
      });
      return;
    }

    setSaving(true);
    try {
      const result = await apiClient.put(endpoints.users.me, {
        name: name.trim(),
        bio: bio.trim() || null,
        isPrivate,
        secretName: isPrivate ? secretName : null,
      });
      setUser(result);
      await apiClient.saveUser(result);
      setPopup({
        visible: true,
        title: "Success",
        message: "Profile updated successfully!",
      });
    } catch (err) {
      const msg = err.error || "Failed to update profile. Please try again.";
      setPopup({ visible: true, title: "Error", message: msg });
    } finally {
      setSaving(false);
    }
  }, [name, bio, isPrivate, secretName, setUser]);

  // ─── Change Password ──────────────────────────────────────────────────────
  const handleChangePassword = useCallback(async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPopup({
        visible: true,
        title: "Missing Fields",
        message: "Please fill in all password fields.",
      });
      return;
    }
    if (newPassword.length < 8) {
      setPopup({
        visible: true,
        title: "Weak Password",
        message: "New password must be at least 8 characters.",
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPopup({
        visible: true,
        title: "Mismatch",
        message: "New passwords do not match.",
      });
      return;
    }

    setChangingPw(true);
    try {
      await apiClient.put(endpoints.users.password, {
        currentPassword,
        newPassword,
        confirmPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPopup({
        visible: true,
        title: "Success",
        message: "Password changed successfully!",
      });
    } catch (err) {
      const msg = err.error || "Failed to change password. Please try again.";
      setPopup({ visible: true, title: "Error", message: msg });
    } finally {
      setChangingPw(false);
    }
  }, [currentPassword, newPassword, confirmPassword]);

  const secretNameMaxHeight = privateSlide.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 120],
  });
  const secretNameOpacity = privateSlide.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0, 0, 1],
  });

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Icon name="arrow-left" size={22} color="#1A1A2E" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Personal Information</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: insets.bottom + 100 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View
          style={{
            opacity: fadeAnim,
            transform: [{ translateY: slideAnim }],
          }}
        >
          {/* ─── Avatar Section ──────────────────────────────────────── */}
          <View style={styles.avatarSection}>
            <View style={styles.avatarRing}>
              <Image
                source={{
                  uri: `${AVATAR_BASE}${encodeURIComponent(user?.name || "User")}`,
                }}
                style={styles.avatar}
              />
              {isPrivate && (
                <View style={styles.privateBadge}>
                  <Icon name="lock" size={10} color="#fff" />
                </View>
              )}
            </View>
            <Text style={styles.changePhotoText}>Change your photo</Text>
          </View>

          {/* ─── Name Field ─────────────────────────────────────────── */}
          <Text style={styles.fieldLabel}>Name</Text>
          <TextInput
            style={styles.fieldInput}
            value={name}
            onChangeText={setName}
            placeholder="Your display name"
            placeholderTextColor="#C7C7CC"
            autoCapitalize="words"
          />
          <View style={styles.divider} />

          {/* ─── Bio Field ──────────────────────────────────────────── */}
          <Text style={styles.fieldLabel}>Bio</Text>
          <View style={styles.bioRow}>
            <TextInput
              style={[styles.fieldInput, { flex: 1 }]}
              value={bio}
              onChangeText={(text) => setBio(text.slice(0, 12))}
              placeholder="Write a short bio..."
              placeholderTextColor="#C7C7CC"
              maxLength={12}
            />
            <Text style={styles.bioCounter}>{bio.length}/12</Text>
          </View>
          <View style={styles.divider} />

          {/* ─── Email Field ──────────────────────────────────────── */}
          <Text style={styles.fieldLabel}>Email</Text>
          <Text style={styles.fieldValue}>{user?.email || ""}</Text>
          <View style={styles.divider} />

          {/* ─── Phone Number Field ────────────────────────────────── */}
          <Text style={styles.fieldLabel}>Phone Number</Text>
          <Text style={styles.fieldValue}>{user?.phone || "Not set"}</Text>
          <View style={styles.divider} />

          {/* ─── Private Account Toggle ─────────────────────────────── */}
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Private Account</Text>
              <Text style={styles.toggleSubtext}>
                Hidden from search & world chat
              </Text>
            </View>
            <Switch
              value={isPrivate}
              onValueChange={setIsPrivate}
              trackColor={{ false: "#E5E5EA", true: "#22c15a" }}
              thumbColor="#fff"
              ios_backgroundColor="#E5E5EA"
            />
          </View>

          {/* Secret Name (Animated reveal) */}
          <Animated.View
            style={{
              maxHeight: secretNameMaxHeight,
              opacity: secretNameOpacity,
              overflow: "hidden",
            }}
          >
            <Text style={[styles.fieldLabel, { marginTop: 8 }]}>
              Secret Name
            </Text>
            <TextInput
              style={styles.fieldInput}
              value={secretName}
              onChangeText={setSecretName}
              placeholder="Your unique secret name"
              placeholderTextColor="#C7C7CC"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.hint}>
              Others can find you only by typing this name exactly
            </Text>
          </Animated.View>
          <View style={styles.divider} />

          {/* ─── Change Password Section ─────────────────────────────── */}
          <Text style={styles.sectionTitle}>Change Password</Text>

          <Text style={styles.fieldLabel}>Current Password</Text>
          <View style={styles.passwordRow}>
            <TextInput
              style={[styles.fieldInput, { flex: 1, borderBottomWidth: 0 }]}
              value={currentPassword}
              onChangeText={setCurrentPassword}
              placeholder="Enter current password"
              placeholderTextColor="#C7C7CC"
              secureTextEntry={!showCurrentPw}
            />
            <TouchableOpacity
              onPress={() => setShowCurrentPw(!showCurrentPw)}
              style={styles.eyeBtn}
            >
              <Icon
                name={showCurrentPw ? "eye-off" : "eye"}
                size={18}
                color="#C7C7CC"
              />
            </TouchableOpacity>
          </View>
          <View style={styles.divider} />

          <Text style={styles.fieldLabel}>New Password</Text>
          <View style={styles.passwordRow}>
            <TextInput
              style={[styles.fieldInput, { flex: 1, borderBottomWidth: 0 }]}
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder="Min. 8 characters"
              placeholderTextColor="#C7C7CC"
              secureTextEntry={!showNewPw}
            />
            <TouchableOpacity
              onPress={() => setShowNewPw(!showNewPw)}
              style={styles.eyeBtn}
            >
              <Icon
                name={showNewPw ? "eye-off" : "eye"}
                size={18}
                color="#C7C7CC"
              />
            </TouchableOpacity>
          </View>

          {/* Password strength */}
          {newPassword.length > 0 && (
            <View style={styles.strengthRow}>
              <View
                style={[
                  styles.strengthBar,
                  {
                    width: `${Math.min((newPassword.length / 16) * 100, 100)}%`,
                    backgroundColor:
                      newPassword.length < 8
                        ? "#EF4444"
                        : newPassword.length < 12
                          ? "#FBBF24"
                          : "#22c15a",
                  },
                ]}
              />
              <Text style={styles.strengthText}>
                {newPassword.length < 8
                  ? "Too short"
                  : newPassword.length < 12
                    ? "Good"
                    : "Strong"}
              </Text>
            </View>
          )}
          <View style={styles.divider} />

          <Text style={styles.fieldLabel}>Confirm New Password</Text>
          <View style={styles.passwordRow}>
            <TextInput
              style={[styles.fieldInput, { flex: 1, borderBottomWidth: 0 }]}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="Re-enter new password"
              placeholderTextColor="#C7C7CC"
              secureTextEntry={!showConfirmPw}
            />
            <TouchableOpacity
              onPress={() => setShowConfirmPw(!showConfirmPw)}
              style={styles.eyeBtn}
            >
              <Icon
                name={showConfirmPw ? "eye-off" : "eye"}
                size={18}
                color="#C7C7CC"
              />
            </TouchableOpacity>
          </View>
          <View style={styles.divider} />
        </Animated.View>
      </ScrollView>

      {/* ─── Bottom Buttons ────────────────────────────────────────── */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
        {/* Save Profile */}
        <TouchableOpacity
          style={[styles.saveBtn, !profileDirty && styles.saveBtnDisabled]}
          onPress={handleSaveProfile}
          disabled={saving || !profileDirty}
          activeOpacity={0.85}
        >
          {saving ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.saveBtnText}>Save Changes</Text>
          )}
        </TouchableOpacity>

        {/* Change Password */}
        {currentPassword || newPassword || confirmPassword ? (
          <TouchableOpacity
            style={[styles.passwordBtn]}
            onPress={handleChangePassword}
            disabled={changingPw}
            activeOpacity={0.85}
          >
            {changingPw ? (
              <ActivityIndicator color="#1A1A2E" size="small" />
            ) : (
              <Text style={styles.passwordBtnText}>Update Password</Text>
            )}
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Custom Popup */}
      <CustomPopup
        visible={popup.visible}
        title={popup.title}
        message={popup.message}
        onClose={() => setPopup({ visible: false, title: "", message: "" })}
      />
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FAFAFA",
  },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#F0F0F0",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1A2E",
    letterSpacing: -0.2,
  },

  // Scroll
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 24,
  },

  // Avatar
  avatarSection: {
    alignItems: "center",
    marginBottom: 32,
    marginTop: 8,
  },
  avatarRing: {
    position: "relative",
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "#F0EDE8",
    padding: 4,
    marginBottom: 12,
  },
  avatar: {
    width: "100%",
    height: "100%",
    borderRadius: 50,
  },
  privateBadge: {
    position: "absolute",
    bottom: 2,
    right: 2,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#22c15a",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "#FAFAFA",
  },
  changePhotoText: {
    fontSize: 14,
    color: "#8E8E93",
    fontWeight: "500",
  },

  // Fields
  fieldLabel: {
    fontSize: 13,
    color: "#8E8E93",
    fontWeight: "500",
    marginBottom: 4,
    marginTop: 12,
  },
  fieldInput: {
    fontSize: 16,
    color: "#1A1A2E",
    fontWeight: "400",
    paddingVertical: 10,
  },
  fieldValue: {
    fontSize: 16,
    color: "#1A1A2E",
    fontWeight: "400",
    paddingVertical: 10,
  },
  divider: {
    height: 1,
    backgroundColor: "#F0F0F0",
  },
  row: {
    flexDirection: "row",
    gap: 24,
  },
  halfField: {
    flex: 1,
  },
  hint: {
    fontSize: 12,
    color: "#8E8E93",
    marginTop: 2,
    marginBottom: 8,
    lineHeight: 18,
  },
  bioRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  bioCounter: {
    fontSize: 12,
    color: "#C7C7CC",
    marginLeft: 8,
  },

  // Toggle
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 16,
  },
  toggleLabel: {
    fontSize: 16,
    fontWeight: "500",
    color: "#1A1A2E",
  },
  toggleSubtext: {
    fontSize: 12,
    color: "#8E8E93",
    marginTop: 2,
  },

  // Password
  passwordRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  eyeBtn: {
    padding: 10,
  },

  // Strength
  strengthRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 4,
    gap: 8,
  },
  strengthBar: {
    height: 3,
    borderRadius: 2,
    minWidth: 20,
  },
  strengthText: {
    fontSize: 11,
    color: "#8E8E93",
    fontWeight: "500",
  },

  // Section Title
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1A2E",
    marginTop: 24,
    marginBottom: 4,
  },

  // Bottom
  bottomBar: {
    paddingHorizontal: 24,
    paddingTop: 12,
    backgroundColor: "#FAFAFA",
    borderTopWidth: 1,
    borderTopColor: "#F0F0F0",
  },
  saveBtn: {
    backgroundColor: "#1A1A2E",
    borderRadius: 28,
    height: 52,
    justifyContent: "center",
    alignItems: "center",
  },
  saveBtnDisabled: {
    opacity: 0.3,
  },
  saveBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  passwordBtn: {
    backgroundColor: "#F0F0F0",
    borderRadius: 28,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 10,
  },
  passwordBtnText: {
    color: "#1A1A2E",
    fontSize: 15,
    fontWeight: "600",
  },

  emptyState: {
    alignItems: "center",
    paddingVertical: 24,
    gap: 8,
  },
  emptyText: {
    fontSize: 13,
    color: "#C7C7CC",
  },
});
