/**
 * Settings Screen — Clean profile-centric design.
 * Centered avatar, name/email, flat menu rows, version footer.
 */
import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Image,
  Platform,
  StatusBar,
} from "react-native";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import { useNavigation } from "@react-navigation/native";
import { useAuth } from "../context/AuthContext";
import CustomPopup from "../components/CustomPopup";
import ProfilePictureViewer from "../components/ProfilePictureViewer";

const AVATAR_BASE = "https://api.dicebear.com/7.x/initials/png?seed=";

const MENU_ITEMS = [
  {
    key: "profile",
    icon: "user",
    label: "Personal Information",
    route: "Profile",
  },
  {
    key: "notifications",
    icon: "bell",
    label: "Notifications",
    route: null,
  },
  {
    key: "privacy",
    icon: "shield",
    label: "Privacy & Security",
    route: "Profile",
  },
  {
    key: "help",
    icon: "help-circle",
    label: "Help & Support",
    route: null,
  },
];

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [showLogoutPopup, setShowLogoutPopup] = useState(false);
  const [showAvatarViewer, setShowAvatarViewer] = useState(false);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: 0, paddingBottom: 20 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ─── Premium Banner Background ─────────────────────────────────── */}
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
        {/* ─── Profile Header ─────────────────────────────────────── */}
        <View style={styles.profileSection}>
          <TouchableOpacity
            style={styles.avatarRingPremium}
            onPress={() => setShowAvatarViewer(true)}
            activeOpacity={0.8}
          >
            <Image
              source={{
                uri:
                  user?.avatarUrl ||
                  `${AVATAR_BASE}${encodeURIComponent(user?.name || "User")}`,
              }}
              style={styles.avatar}
            />
            {user?.isPrivate && (
              <View style={styles.verifiedBadge}>
                <Icon name="lock" size={10} color="#fff" />
              </View>
            )}
          </TouchableOpacity>
          <Text style={styles.userName}>{user?.name || "User"}</Text>
          <Text style={styles.userEmail}>{user?.email || ""}</Text>
        </View>

        {/* ─── Menu & Content (With Padding) ───────────────────────── */}
        <View style={{ paddingHorizontal: 24 }}>
          {/* ─── Menu Items ─────────────────────────────────────────── */}
          <View style={styles.menuSection}>
            {MENU_ITEMS.map((item, index) => (
              <TouchableOpacity
                key={item.key}
                style={[
                  styles.menuRow,
                  index === MENU_ITEMS.length - 1 && { borderBottomWidth: 0 },
                ]}
                onPress={() => item.route && navigation.navigate(item.route)}
                activeOpacity={0.6}
              >
                <Icon
                  name={item.icon}
                  size={22}
                  color="#1A1A2E"
                  style={styles.menuIcon}
                />
                <Text style={styles.menuLabel}>{item.label}</Text>
                <Icon name="chevron-right" size={20} color="#C7C7CC" />
              </TouchableOpacity>
            ))}
          </View>

          {/* ─── Logout ─────────────────────────────────────────────── */}
          <TouchableOpacity
            style={styles.menuRow}
            onPress={() => setShowLogoutPopup(true)}
            activeOpacity={0.6}
          >
            <Icon
              name="log-out"
              size={22}
              color="#1A1A2E"
              style={styles.menuIcon}
            />
            <Text style={styles.menuLabel}>Logout</Text>
            <Icon name="chevron-right" size={20} color="#C7C7CC" />
          </TouchableOpacity>

          {/* ─── Version ────────────────────────────────────────────── */}
          <Text style={styles.version}>Aux v1.0.1</Text>
        </View>
      </ScrollView>

      {/* ─── Logout Confirmation ─────────────────────────────────── */}
      <CustomPopup
        visible={showLogoutPopup}
        title="Logout"
        message="Are you sure you want to logout?"
        buttons={[
          {
            text: "Cancel",
            onPress: () => setShowLogoutPopup(false),
          },
          {
            text: "Logout",
            danger: true,
            onPress: () => {
              setShowLogoutPopup(false);
              logout();
            },
          },
        ]}
        onClose={() => setShowLogoutPopup(false)}
      />

      <ProfilePictureViewer
        visible={showAvatarViewer}
        imageUri={user?.avatarUrl}
        userName={user?.name}
        onClose={() => setShowAvatarViewer(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FAFAFA",
  },
  scrollContent: {
    paddingHorizontal: 0,
  },

  // ─── Profile Header ───────────────────────────────────────────
  profileSection: {
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
    marginBottom: 0,
  },
  avatar: {
    width: "100%",
    height: "100%",
    borderRadius: 55,
  },
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
  verifiedBadge: {
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
  userName: {
    fontSize: 22,
    fontWeight: "700",
    color: "#1A1A2E",
    letterSpacing: -0.3,
    marginBottom: 4,
  },
  userEmail: {
    fontSize: 14,
    color: "#8E8E93",
    fontWeight: "400",
  },

  // ─── Menu Items ────────────────────────────────────────────────
  menuSection: {
    marginBottom: 8,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
  },
  menuIcon: {
    width: 32,
    marginRight: 16,
    textAlign: "center",
  },
  menuLabel: {
    flex: 1,
    fontSize: 16,
    fontWeight: "500",
    color: "#1A1A2E",
  },

  // ─── Version ──────────────────────────────────────────────────
  version: {
    textAlign: "center",
    fontSize: 13,
    color: "#C7C7CC",
    marginTop: 32,
    fontWeight: "500",
  },
});
