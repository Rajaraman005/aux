/**
 * Search Screen — Find users to chat or call.
 * Features: search bar, user cards, profile modal with call/message actions.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  Animated,
  StyleSheet,
  ActivityIndicator,
  Modal,
  Image,
} from "react-native";
import Icon from "react-native-vector-icons/Feather";
import { useAuth } from "../context/AuthContext";
import { useSignaling } from "../context/SignalingContext";
import apiClient from "../services/api";
import { endpoints } from "../config/api";
import signalingClient from "../services/socket";
import { colors, typography, spacing, radius, shadows } from "../styles/theme";

const AVATAR_BASE = "https://api.dicebear.com/7.x/initials/png?seed=";

export default function SearchScreen({ navigation }) {
  const { user } = useAuth();
  const { onlineUsers } = useSignaling();
  const [users, setUsers] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState(null);
  const modalAnim = useRef(new Animated.Value(0)).current;

  // ─── Fetch Users ───────────────────────────────────────────────────────
  const fetchUsers = useCallback(async () => {
    try {
      const url =
        searchQuery.length >= 2
          ? `${endpoints.users.search}?q=${encodeURIComponent(searchQuery)}`
          : endpoints.users.list;
      const data = await apiClient.get(url);
      setUsers(data.users || []);
    } catch (err) {
      console.error("Fetch users error:", err);
    } finally {
      setIsLoading(false);
    }
  }, [searchQuery]);

  useEffect(() => {
    setIsLoading(true);
    const timer = setTimeout(fetchUsers, searchQuery ? 300 : 0);
    return () => clearTimeout(timer);
  }, [fetchUsers]);

  // ─── Profile Modal Animation ──────────────────────────────────────────
  useEffect(() => {
    Animated.spring(modalAnim, {
      toValue: selectedUser ? 1 : 0,
      damping: 20,
      stiffness: 300,
      useNativeDriver: true,
    }).start();
  }, [selectedUser]);

  // ─── Actions ───────────────────────────────────────────────────────────
  const handleCallUser = useCallback(
    (targetUser) => {
      setSelectedUser(null);
      signalingClient.requestCall(targetUser.id);

      const unsubRinging = signalingClient.on("call-ringing", (data) => {
        navigation.navigate("Call", {
          callId: data.callId,
          callerName: targetUser.name,
          isCaller: true,
        });
        unsubRinging();
      });

      const unsubFailed = signalingClient.on("call-failed", (data) => {
        alert(
          data.reason === "user_offline"
            ? "User is offline"
            : data.reason === "target_busy"
              ? "User is on another call"
              : "Call failed",
        );
        unsubFailed();
      });
    },
    [navigation],
  );

  const handleMessageUser = useCallback(
    async (targetUser) => {
      setSelectedUser(null);
      try {
        const result = await apiClient.post(endpoints.conversations.create, {
          targetUserId: targetUser.id,
        });
        navigation.navigate("Chat", {
          conversationId: result.conversation.id,
          otherUser: targetUser,
        });
      } catch (err) {
        console.error("Create conversation error:", err);
        alert("Failed to start conversation");
      }
    },
    [navigation],
  );

  // ─── Render User Card ─────────────────────────────────────────────────
  const renderUserCard = ({ item }) => {
    const isOnline = onlineUsers.has(item.id);
    return (
      <TouchableOpacity
        style={styles.userCard}
        onPress={() => setSelectedUser(item)}
        activeOpacity={0.7}
      >
        <View style={styles.avatarContainer}>
          <Image
            source={{ uri: `${AVATAR_BASE}${encodeURIComponent(item.name)}` }}
            style={styles.avatar}
          />
          <View
            style={[
              styles.onlineDot,
              {
                backgroundColor: isOnline ? colors.online : colors.offline,
              },
            ]}
          />
        </View>
        <View style={styles.userInfo}>
          <Text style={styles.userName}>{item.name}</Text>
          <Text style={styles.userStatus}>
            {isOnline ? "Online" : "Offline"}
          </Text>
        </View>
        <TouchableOpacity
          style={[
            styles.quickCallBtn,
            !isOnline && styles.quickCallBtnDisabled,
          ]}
          onPress={() => isOnline && handleCallUser(item)}
          disabled={!isOnline}
        >
          <Icon
            name="phone"
            size={18}
            color={isOnline ? colors.primary : colors.textMuted}
          />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Search</Text>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <Icon
          name="search"
          size={18}
          color={colors.textMuted}
          style={{ marginRight: spacing.sm }}
        />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name or email..."
          placeholderTextColor={colors.textMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCorrect={false}
          autoCapitalize="none"
        />
        {searchQuery ? (
          <TouchableOpacity
            onPress={() => setSearchQuery("")}
            style={styles.clearBtn}
          >
            <Icon name="x" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* User List */}
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={users}
          renderItem={renderUserCard}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Icon name="users" size={48} color={colors.textMuted} />
              <Text style={styles.emptyText}>
                {searchQuery ? "No users found" : "No contacts yet"}
              </Text>
            </View>
          }
        />
      )}

      {/* Profile Modal */}
      <Modal
        visible={!!selectedUser}
        transparent
        animationType="none"
        onRequestClose={() => setSelectedUser(null)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setSelectedUser(null)}
        >
          <Animated.View
            style={[
              styles.profileModal,
              {
                transform: [
                  {
                    scale: modalAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.9, 1],
                    }),
                  },
                ],
                opacity: modalAnim,
              },
            ]}
          >
            {selectedUser && (
              <>
                <Image
                  source={{
                    uri: `${AVATAR_BASE}${encodeURIComponent(selectedUser.name)}`,
                  }}
                  style={styles.profileAvatar}
                />
                <Text style={styles.profileName}>{selectedUser.name}</Text>
                <Text style={styles.profileEmail}>{selectedUser.email}</Text>
                <View
                  style={[
                    styles.profileStatus,
                    {
                      backgroundColor: onlineUsers.has(selectedUser.id)
                        ? "rgba(16, 185, 129, 0.1)"
                        : "rgba(0, 0, 0, 0.05)",
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.profileDot,
                      {
                        backgroundColor: onlineUsers.has(selectedUser.id)
                          ? colors.online
                          : colors.offline,
                      },
                    ]}
                  />
                  <Text
                    style={[
                      styles.profileStatusText,
                      {
                        color: onlineUsers.has(selectedUser.id)
                          ? colors.online
                          : colors.textMuted,
                      },
                    ]}
                  >
                    {onlineUsers.has(selectedUser.id) ? "Online" : "Offline"}
                  </Text>
                </View>

                {/* Action Buttons */}
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={() => handleMessageUser(selectedUser)}
                  >
                    <Icon
                      name="message-circle"
                      size={22}
                      color={colors.textInverse}
                    />
                    <Text style={styles.actionText}>Message</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.actionButton,
                      styles.actionButtonCall,
                      !onlineUsers.has(selectedUser.id) &&
                        styles.actionButtonDisabled,
                    ]}
                    onPress={() => handleCallUser(selectedUser)}
                    disabled={!onlineUsers.has(selectedUser.id)}
                  >
                    <Icon name="phone" size={22} color="#fff" />
                    <Text style={styles.actionText}>Call</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </Animated.View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: 60,
    paddingBottom: spacing.md,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },

  // Search
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.textPrimary,
  },
  clearBtn: {
    padding: spacing.sm,
  },

  // List
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 100,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },

  // User Card
  userCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  avatarContainer: {
    position: "relative",
    marginRight: spacing.md,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "transparent",
  },
  onlineDot: {
    position: "absolute",
    bottom: 2,
    right: 2,
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.bgCard,
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    ...typography.body,
    fontWeight: "600",
  },
  userStatus: {
    ...typography.caption,
    marginTop: 2,
  },
  quickCallBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.bgElevated,
    justifyContent: "center",
    alignItems: "center",
  },
  quickCallBtnDisabled: {
    opacity: 0.3,
  },

  // Empty
  emptyContainer: {
    alignItems: "center",
    paddingTop: 80,
  },
  emptyText: {
    ...typography.bodySmall,
    marginTop: spacing.md,
  },

  // Profile Modal
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.overlay,
  },
  profileModal: {
    width: "85%",
    maxWidth: 340,
    backgroundColor: colors.bg,
    borderRadius: radius.xl,
    padding: spacing.xl,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.xl,
  },
  profileAvatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    marginBottom: spacing.md,
    backgroundColor: "transparent",
  },
  profileName: {
    ...typography.h3,
    marginBottom: 4,
  },
  profileEmail: {
    ...typography.bodySmall,
    marginBottom: spacing.md,
  },
  profileStatus: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.full,
    marginBottom: spacing.lg,
  },
  profileDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  profileStatusText: {
    ...typography.caption,
  },

  // Action Buttons
  actionRow: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
  },
  actionButton: {
    flex: 1,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    ...shadows.sm,
  },
  actionButtonCall: {
    backgroundColor: colors.success,
  },
  actionButtonDisabled: {
    backgroundColor: colors.bgElevated,
    shadowOpacity: 0,
    elevation: 0,
  },
  actionText: {
    ...typography.button,
  },
});
