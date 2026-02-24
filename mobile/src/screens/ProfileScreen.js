/**
 * ProfileScreen — Clean light design matching reference.
 * Features: Edit name, change password, private account toggle, secret name, friends.
 *
 * Image upload pipeline:
 *   1. Pick image (camera/gallery) — NO system editor (allowsEditing: false)
 *   2. Navigate to custom ImageEditorScreen (crop, zoom, rotate)
 *   3. Optimistic UI — show local preview instantly
 *   4. Client-side compress (512x512, JPEG 0.8)
 *   5. Upload with progress indicator via XHR
 *   6. Retry on failure, cancel support
 *   7. Cache-bust on success
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
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import { Image } from "expo-image";
import { BlurView } from "expo-blur";
import * as ImagePicker from "expo-image-picker";
import { useAuth } from "../context/AuthContext";
import apiClient from "../services/api";
import { endpoints } from "../config/api";
import CustomPopup from "../components/CustomPopup";
import ProfilePictureViewer from "../components/ProfilePictureViewer";
import { compressImage } from "../utils/imageUtils";

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
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [localPreviewUri, setLocalPreviewUri] = useState(null);
  const [showPhotoPicker, setShowPhotoPicker] = useState(false);
  const [showAvatarViewer, setShowAvatarViewer] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [phone, setPhone] = useState(user?.phone || "");
  const [popup, setPopup] = useState({
    visible: false,
    title: "",
    message: "",
  });

  // Upload abort controller
  const uploadAbortRef = useRef(null);

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
      secretName !== (user?.secretName || "") ||
      phone !== (user?.phone || "");
    setProfileDirty(dirty);
  }, [name, bio, isPrivate, secretName, phone, user]);

  // Cleanup upload abort on unmount
  useEffect(() => {
    return () => {
      if (uploadAbortRef.current) {
        uploadAbortRef.current();
        uploadAbortRef.current = null;
      }
    };
  }, []);

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
        phone: phone.trim() || null,
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
  }, [name, bio, isPrivate, secretName, phone, setUser]);

  // ─── Avatar tap — show viewer (long press) or change photo (tap) ────────
  const handleAvatarTap = useCallback(() => {
    setShowPhotoPicker(true);
  }, []);

  const handleAvatarLongPress = useCallback(() => {
    if (user?.avatarUrl || localPreviewUri) {
      setShowAvatarViewer(true);
    }
  }, [user?.avatarUrl, localPreviewUri]);

  // ─── Upload edited image ────────────────────────────────────────────────
  const uploadEditedImage = useCallback(
    async (editedUri) => {
      // Optimistic UI: show local preview immediately
      setLocalPreviewUri(editedUri);
      setUploadingAvatar(true);
      setUploadProgress(0);

      try {
        // Compress (may already be compressed from editor, but ensure 512x512 JPEG)
        const compressed = await compressImage(editedUri, {
          maxSize: 512,
          quality: 0.8,
        });

        // Build FormData
        const formData = new FormData();
        formData.append("avatar", {
          uri:
            Platform.OS === "ios"
              ? compressed.uri.replace("file://", "")
              : compressed.uri,
          type: "image/jpeg",
          name: "avatar.jpg",
        });

        // Upload with progress
        const { promise, abort } = apiClient.uploadWithProgress(
          endpoints.users.avatar,
          formData,
          (progress) => setUploadProgress(progress),
        );

        // Store abort function for cancellation
        uploadAbortRef.current = abort;

        const updated = await promise;
        uploadAbortRef.current = null;

        // Cache-bust
        if (updated.avatarUrl) {
          const separator = updated.avatarUrl.includes("?") ? "&" : "?";
          updated.avatarUrl = `${updated.avatarUrl}${separator}t=${Date.now()}`;
        }

        setUser(updated);
        await apiClient.saveUser(updated);
        setLocalPreviewUri(null); // Clear local preview, use server URL now
        setPopup({
          visible: true,
          title: "Success",
          message: "Profile photo updated!",
        });
      } catch (err) {
        console.error("Avatar upload error:", err);
        if (err.code === "CANCELLED") {
          setLocalPreviewUri(null);
          return;
        }
        // Keep local preview on failure — offer retry
        const msg = err.error || "Failed to upload photo.";
        setPopup({
          visible: true,
          title: "Upload Failed",
          message: msg,
          buttons: [
            {
              text: "Retry",
              primary: true,
              onPress: () => {
                setPopup({ visible: false, title: "", message: "" });
                uploadEditedImage(editedUri);
              },
            },
            {
              text: "Cancel",
              onPress: () => {
                setLocalPreviewUri(null);
                setPopup({ visible: false, title: "", message: "" });
              },
            },
          ],
        });
      } finally {
        setUploadingAvatar(false);
        setUploadProgress(0);
      }
    },
    [setUser],
  );

  // ─── Cancel upload ──────────────────────────────────────────────────────
  const handleCancelUpload = useCallback(() => {
    if (uploadAbortRef.current) {
      uploadAbortRef.current();
      uploadAbortRef.current = null;
    }
  }, []);

  // ─── Pick Image → Navigate to Editor ───────────────────────────────────
  const pickImage = useCallback(
    async (launcher) => {
      setShowPhotoPicker(false);
      try {
        const { status } =
          launcher === ImagePicker.launchCameraAsync
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();

        if (status !== "granted") {
          setPopup({
            visible: true,
            title: "Permission Denied",
            message: "Please allow access to your photos in Settings.",
          });
          return;
        }

        // No system editor — we use our custom one
        const result = await launcher({
          mediaTypes: ["images"],
          allowsEditing: false,
          quality: 0.8,
        });

        if (result.canceled) return;

        const asset = result.assets[0];

        // Navigate to custom image editor
        navigation.navigate("ImageEditor", {
          imageUri: asset.uri,
          onComplete: uploadEditedImage,
        });
      } catch (err) {
        console.error("Image picker error:", err);
        setPopup({
          visible: true,
          title: "Error",
          message: "Failed to open image picker.",
        });
      }
    },
    [navigation, uploadEditedImage],
  );

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

  // Resolved avatar URI: local preview > server URL > fallback
  const avatarUri =
    localPreviewUri ||
    user?.avatarUrl ||
    `${AVATAR_BASE}${encodeURIComponent(user?.name || "User")}`;

  // Progress bar width animation

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />

      {/* Fixed Back Button */}
      <View
        style={{
          position: "absolute",
          top: insets.top,
          left: 0,
          zIndex: 60,
          paddingHorizontal: 20,
          paddingVertical: 10,
        }}
      >
        <TouchableOpacity
          style={styles.backBtnBlur}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Icon name="arrow-left" size={22} color="#1A1A2E" />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: 0, paddingBottom: 40 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View
          style={{
            opacity: fadeAnim,
            transform: [{ translateY: slideAnim }],
            width: "100%",
          }}
        >
          {/* Scrolling Title (Absolute within ScrollView to avoid gap) */}
          <View
            style={{
              position: "absolute",
              top: insets.top,
              left: 0,
              right: 0,
              height: 56,
              alignItems: "center",
              justifyContent: "center",
              zIndex: 20,
            }}
          >
            <Text style={styles.headerTitleDark}>Profile</Text>
          </View>
          {/* ─── Banner Background ───────────────────────────────────────── */}
          <View style={styles.bannerContainer}>
            <Image
              source={require("../../assets/banner.jpg")}
              style={styles.bannerImage}
              blurRadius={Platform.OS === "ios" ? 0 : 40}
            />
            {Platform.OS === "ios" && (
              <BlurView
                intensity={60}
                style={StyleSheet.absoluteFill}
                tint="light"
              />
            )}
            <View style={styles.bannerOverlay} />
          </View>

          {/* ─── Avatar Section ────────────────────────────────────────── */}
          <View style={styles.avatarSection}>
            <View style={styles.avatarRingPremium}>
              <TouchableOpacity
                onPress={() => setShowAvatarViewer(true)}
                activeOpacity={0.9}
                style={styles.avatarTouch}
              >
                <Image
                  source={{ uri: avatarUri }}
                  style={styles.avatar}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={200}
                />
              </TouchableOpacity>

              {/* Edit Trigger (Pencil Icon) */}
              {!uploadingAvatar && (
                <TouchableOpacity
                  style={styles.editBadge}
                  onPress={handleAvatarTap}
                  activeOpacity={0.8}
                >
                  <Icon name="edit-2" size={14} color="#fff" />
                </TouchableOpacity>
              )}

              {/* Upload overlay with simple spinner */}
              {uploadingAvatar && (
                <View style={styles.avatarOverlay}>
                  <ActivityIndicator color="#fff" size="small" />
                </View>
              )}

              {isPrivate && !uploadingAvatar && (
                <View style={styles.privateBadge}>
                  <Icon name="lock" size={10} color="#fff" />
                </View>
              )}
            </View>
          </View>

          {/* ─── Form Details ─────────────────────────────────────────── */}
          <View style={{ paddingHorizontal: 0, paddingBottom: 20 }}>
            {/* ─── Name Field ─────────────────────────────────────────── */}
            <Text style={[styles.fieldLabel, { paddingHorizontal: 24 }]}>
              Name
            </Text>
            <TextInput
              style={[styles.fieldInput, { paddingHorizontal: 24 }]}
              value={name}
              onChangeText={setName}
              placeholder="Your display name"
              placeholderTextColor="#C7C7CC"
              autoCapitalize="words"
            />
            <View style={[styles.divider, { marginHorizontal: 24 }]} />

            {/* ─── Bio Field ──────────────────────────────────────────── */}
            <Text style={[styles.fieldLabel, { paddingHorizontal: 24 }]}>
              Bio
            </Text>
            <View style={[styles.bioRow, { paddingHorizontal: 24 }]}>
              <TextInput
                style={[styles.fieldInput, { flex: 1 }]}
                value={bio}
                onChangeText={setBio}
                placeholder="Short bio (12 chars)"
                placeholderTextColor="#C7C7CC"
                maxLength={12}
              />
              <Text style={styles.bioCounter}>{bio.length}/12</Text>
            </View>
            <View style={[styles.divider, { marginHorizontal: 24 }]} />

            {/* ─── Email Field (Read-only) ─────────────────────────────── */}
            <Text style={[styles.fieldLabel, { paddingHorizontal: 24 }]}>
              Email
            </Text>
            <View style={{ paddingVertical: 10, paddingHorizontal: 24 }}>
              <Text style={{ fontSize: 16, color: "#1A1A2E" }}>
                {user?.email}
              </Text>
            </View>
            <View style={[styles.divider, { marginHorizontal: 24 }]} />

            {/* ─── Phone Field ────────────────────────────────────────── */}
            <Text style={[styles.fieldLabel, { paddingHorizontal: 24 }]}>
              Phone Number
            </Text>
            <TextInput
              style={[styles.fieldInput, { paddingHorizontal: 24 }]}
              value={phone}
              onChangeText={setPhone}
              placeholder="Your phone number"
              placeholderTextColor="#C7C7CC"
              keyboardType="phone-pad"
            />
            <View style={[styles.divider, { marginHorizontal: 24 }]} />

            {/* ─── Private Account Toggle ──────────────────────────────── */}
            <View style={[styles.toggleRow, { paddingHorizontal: 24 }]}>
              <View>
                <Text style={styles.toggleLabel}>Private Account</Text>
                <Text style={styles.toggleSubtext}>
                  Hidden from search & world chat
                </Text>
              </View>
              <Switch
                value={isPrivate}
                onValueChange={setIsPrivate}
                trackColor={{ false: "#D1D1D6", true: "#000" }}
                thumbColor="#fff"
              />
            </View>

            {/* Secret Name (Animated reveal) */}
            <Animated.View
              style={{
                maxHeight: secretNameMaxHeight,
                opacity: secretNameOpacity,
                overflow: "hidden",
                paddingHorizontal: 24,
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
            <View style={[styles.divider, { marginHorizontal: 24 }]} />

            {/* ─── Change Password Section ─────────────────────────────── */}
            <Text style={[styles.sectionTitle, { paddingHorizontal: 24 }]}>
              Change Password
            </Text>

            <Text style={[styles.fieldLabel, { paddingHorizontal: 24 }]}>
              Current Password
            </Text>
            <View style={[styles.passwordRow, { paddingHorizontal: 24 }]}>
              <TextInput
                style={[styles.fieldInput, { flex: 1, borderBottomWidth: 0 }]}
                value={currentPassword}
                onChangeText={setCurrentPassword}
                secureTextEntry={!showCurrentPw}
                placeholder="Enter current password"
                placeholderTextColor="#C7C7CC"
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
            <View style={[styles.divider, { marginHorizontal: 24 }]} />

            <Text style={[styles.fieldLabel, { paddingHorizontal: 24 }]}>
              New Password
            </Text>
            <View style={[styles.passwordRow, { paddingHorizontal: 24 }]}>
              <TextInput
                style={[styles.fieldInput, { flex: 1, borderBottomWidth: 0 }]}
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry={!showNewPw}
                placeholder="Min. 8 characters"
                placeholderTextColor="#C7C7CC"
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
              <View style={[styles.strengthRow, { paddingHorizontal: 24 }]}>
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
            <View style={[styles.divider, { marginHorizontal: 24 }]} />

            <Text style={[styles.fieldLabel, { paddingHorizontal: 24 }]}>
              Confirm New Password
            </Text>
            <View style={[styles.passwordRow, { paddingHorizontal: 24 }]}>
              <TextInput
                style={[styles.fieldInput, { flex: 1, borderBottomWidth: 0 }]}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry={!showConfirmPw}
                placeholder="Re-enter new password"
                placeholderTextColor="#C7C7CC"
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
            <View style={[styles.divider, { marginHorizontal: 24 }]} />
          </View>
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

      {/* Photo Picker Popup */}
      <CustomPopup
        visible={showPhotoPicker}
        title="Change Photo"
        message="Choose where to pick your photo from"
        buttons={[
          {
            text: "Camera",
            onPress: () => pickImage(ImagePicker.launchCameraAsync),
          },
          {
            text: "Gallery",
            primary: true,
            onPress: () => pickImage(ImagePicker.launchImageLibraryAsync),
          },
        ]}
        onClose={() => setShowPhotoPicker(false)}
      />

      {/* Custom Popup */}
      <CustomPopup
        visible={popup.visible}
        title={popup.title}
        message={popup.message}
        buttons={popup.buttons}
        onClose={() => setPopup({ visible: false, title: "", message: "" })}
      />

      {/* Profile Picture Viewer */}
      <ProfilePictureViewer
        visible={showAvatarViewer}
        imageUri={avatarUri}
        userName={user?.name}
        onClose={() => setShowAvatarViewer(false)}
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
    height: 56 + (Platform.OS === "ios" ? 0 : 10),
    zIndex: 10,
  },
  backBtnBlur: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.7)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitleDark: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
    letterSpacing: -0.5,
  },

  // Banner
  // ─── Banner ───────────────────────────────────────────────────
  bannerContainer: {
    height: 200,
    backgroundColor: "#F0EDE8",
    width: "100%",
  },
  bannerImage: {
    width: "100%",
    height: "100%",
  },
  bannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.3)",
  },

  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 0,
  },

  avatarSection: {
    alignItems: "center",
    marginBottom: 8,
  },
  avatarRingPremium: {
    position: "relative",
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "#fff",
    padding: 5,
    elevation: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    marginTop: -60,
  },
  avatarTouch: {
    width: "100%",
    height: "100%",
    borderRadius: 55,
    overflow: "hidden",
  },
  avatar: {
    width: "100%",
    height: "100%",
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

  avatarOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 50,
    alignItems: "center",
    justifyContent: "center",
  },

  editBadge: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#1A1A2E",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 4,
    borderColor: "#fff",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    zIndex: 20,
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
