/**
 * Settings Screen — Profile info and logout.
 */
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, Image } from "react-native";
import Icon from "react-native-vector-icons/Feather";
import { useAuth } from "../context/AuthContext";
import {
  colors,
  typography,
  spacing,
  radius,
  shadows,
} from "../styles/theme";

const AVATAR_BASE = "https://api.dicebear.com/7.x/initials/png?seed=";

export default function SettingsScreen() {
  const { user, logout } = useAuth();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
      </View>

      {/* Profile Card */}
      <View style={styles.profileCard}>
        <Image
          source={{
            uri: `${AVATAR_BASE}${user?.avatar_seed || user?.name}`,
          }}
          style={styles.avatar}
        />
        <Text style={styles.userName}>{user?.name}</Text>
        <Text style={styles.userEmail}>{user?.email}</Text>
      </View>

      {/* Menu Items */}
      <View style={styles.menuSection}>
        <TouchableOpacity style={styles.menuItem}>
          <Icon name="user" size={20} color={colors.textSecondary} />
          <Text style={styles.menuText}>Edit Profile</Text>
          <Icon name="chevron-right" size={18} color={colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem}>
          <Icon name="bell" size={20} color={colors.textSecondary} />
          <Text style={styles.menuText}>Notifications</Text>
          <Icon name="chevron-right" size={18} color={colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem}>
          <Icon name="shield" size={20} color={colors.textSecondary} />
          <Text style={styles.menuText}>Privacy</Text>
          <Icon name="chevron-right" size={18} color={colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem}>
          <Icon name="help-circle" size={20} color={colors.textSecondary} />
          <Text style={styles.menuText}>Help & Support</Text>
          <Icon name="chevron-right" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Logout */}
      <TouchableOpacity style={styles.logoutButton} onPress={logout}>
        <Icon name="log-out" size={20} color={colors.error} />
        <Text style={styles.logoutText}>Log Out</Text>
      </TouchableOpacity>

      {/* Version */}
      <Text style={styles.version}>Aux v1.0.0</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.lg,
  },
  header: {
    paddingTop: 60,
    paddingBottom: spacing.md,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },

  // Profile Card
  profileCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.xl,
    padding: spacing.xl,
    alignItems: "center",
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: "rgba(99,102,241,0.08)",
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    marginBottom: spacing.md,
    backgroundColor: colors.bgElevated,
  },
  userName: {
    ...typography.h3,
    marginBottom: 4,
  },
  userEmail: {
    ...typography.bodySmall,
  },

  // Menu
  menuSection: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    marginBottom: spacing.lg,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(99,102,241,0.08)",
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.04)",
  },
  menuText: {
    flex: 1,
    fontSize: 16,
    color: colors.textPrimary,
    marginLeft: 14,
    fontWeight: "500",
  },

  // Logout
  logoutButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderRadius: radius.lg,
    paddingVertical: 16,
    gap: 10,
  },
  logoutText: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.error,
  },

  // Version
  version: {
    textAlign: "center",
    ...typography.caption,
    marginTop: spacing.xl,
  },
});
