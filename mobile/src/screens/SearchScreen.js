/**
 * Search Screen — Find users to chat or call.
 * Features: search bar, user cards, profile modal with call/message actions.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useFocusEffect } from "@react-navigation/native";
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
import callManager from "../services/CallManager";
import { colors, typography, spacing, radius, shadows } from "../styles/theme";
import CustomPopup from "../components/CustomPopup";

const AVATAR_BASE = "https://api.dicebear.com/7.x/initials/png?seed=";

export default function SearchScreen({ navigation }) {
  const { user } = useAuth();
  const { onlineUsers } = useSignaling();
  const [users, setUsers] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState(null);
  const modalAnim = useRef(new Animated.Value(0)).current;
  const [expandedCardId, setExpandedCardId] = useState(null);
  const [popup, setPopup] = useState({
    visible: false,
    title: "",
    message: "",
  });

  // ─── Fetch Users ───────────────────────────────────────────────────────
  const fetchUsers = useCallback(async () => {
    try {
      const url =
        searchQuery.length >= 2
          ? `${endpoints.users.search}?q=${encodeURIComponent(searchQuery)}`
          : endpoints.users.list;
      const data = await apiClient.get(url);
      // Map backend field names to frontend field names
      const mapped = (data.users || []).map((u) => ({
        ...u,
        friendRequestStatus: u.friendStatus || u.friendRequestStatus || null,
      }));
      setUsers(mapped);
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

  // Refresh data when screen gains focus (e.g. after accepting a request)
  useFocusEffect(
    useCallback(() => {
      fetchUsers();
    }, [fetchUsers]),
  );

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

      // ★ Delegate to CallManager — owns signaling, session, state machine
      const started = callManager.startCall(targetUser.id, targetUser.name);
      if (!started) {
        setPopup({
          visible: true,
          title: "Call Failed",
          message: "Already in a call",
        });
        return;
      }

      // Subscribe to state change for navigation and failure handling
      const unsub = callManager.on("stateChange", ({ state }) => {
        if (
          state === "ringing" ||
          state === "calling" ||
          state === "connecting"
        ) {
          // Navigate to CallScreen if not already there
          navigation.navigate("Call", {
            callerName: targetUser.name,
          });
          unsub();
        } else if (state === "failed" || state === "ended") {
          setPopup({
            visible: true,
            title: "Call Failed",
            message: "User is unavailable",
          });
          unsub();
        }
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
        setPopup({
          visible: true,
          title: "Error",
          message: "Failed to start conversation",
        });
      }
    },
    [navigation],
  );

  const handleSendFriendRequest = useCallback(async (targetUser) => {
    try {
      await apiClient.post(endpoints.friends.request, {
        targetUserId: targetUser.id,
      });
      // Update local state to show request sent
      setUsers((prev) =>
        prev.map((u) =>
          u.id === targetUser.id ? { ...u, friendRequestStatus: "pending" } : u,
        ),
      );
      setPopup({
        visible: true,
        title: "Request Sent!",
        message: "Your friend request has been sent.",
        buttons: [{ text: "Let's wait", primary: true }],
      });
    } catch (err) {
      setPopup({
        visible: true,
        title: "Error",
        message: err.error || "Failed to send request",
      });
    }
  }, []);

  // ─── Withdraw Friend Request ────────────────────────────────────────────
  const handleWithdrawFriendRequest = useCallback(async (targetUser) => {
    try {
      await apiClient.delete(endpoints.friends.withdraw(targetUser.id));
      // Update local state to remove pending status
      setUsers((prev) =>
        prev.map((u) =>
          u.id === targetUser.id ? { ...u, friendRequestStatus: null } : u,
        ),
      );
      setPopup({
        visible: true,
        title: "Request Withdrawn",
        message: "Your friend request has been withdrawn.",
        buttons: [{ text: "Let's go", primary: true }],
      });
    } catch (err) {
      setPopup({
        visible: true,
        title: "Error",
        message: err.error || "Failed to withdraw request",
      });
    }
  }, []);

  const renderUserCard = ({ item }) => {
    const isOnline = onlineUsers.has(item.id);
    const isPrivate = item.isPrivate;
    const friendStatus = item.friendRequestStatus; // 'accepted', 'pending', null
    const isFriend = friendStatus === "accepted";
    const canInteract = !isPrivate || isFriend; // Can message/call only if public or friend
    const isExpanded = expandedCardId === item.id;
    return (
      <View>
        <TouchableOpacity
          style={styles.userCard}
          onPress={() => {
            if (canInteract) {
              setSelectedUser(item);
            } else {
              // Toggle expand/collapse for private accounts
              setExpandedCardId(isExpanded ? null : item.id);
            }
          }}
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
            {isPrivate && (
              <View style={styles.privateBadge}>
                <Icon name="lock" size={8} color="#fff" />
              </View>
            )}
          </View>
          <View style={styles.userInfo}>
            <Text style={styles.userName}>{item.name}</Text>
            {item.bio ? (
              <Text style={styles.userBio}>{item.bio}</Text>
            ) : (
              <Text style={styles.userStatus}>
                {isPrivate && !isFriend
                  ? "Private Account"
                  : isOnline
                    ? "Online"
                    : "Offline"}
              </Text>
            )}
          </View>
          {/* Show call button for public/friends, chevron for private */}
          {isPrivate && !isFriend ? (
            <Icon
              name={isExpanded ? "chevron-up" : "chevron-down"}
              size={18}
              color={colors.textMuted}
            />
          ) : (
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
          )}
        </TouchableOpacity>
        {/* Expanded area with Request/Undo button for private accounts */}
        {isPrivate && !isFriend && isExpanded && (
          <View style={styles.expandedActions}>
            <TouchableOpacity
              style={[
                styles.expandedRequestBtn,
                friendStatus === "pending" && styles.expandedRequestBtnUndo,
              ]}
              onPress={() => {
                if (friendStatus === "pending") {
                  handleWithdrawFriendRequest(item);
                } else {
                  handleSendFriendRequest(item);
                }
              }}
            >
              <Icon
                name={friendStatus === "pending" ? "x" : "user-plus"}
                size={16}
                color={friendStatus === "pending" ? "#EF4444" : "#fff"}
              />
              <Text
                style={[
                  styles.expandedRequestBtnText,
                  friendStatus === "pending" && { color: "#EF4444" },
                ]}
              >
                {friendStatus === "pending"
                  ? "Withdraw Request"
                  : "Send Friend Request"}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
        >
          <Icon name="arrow-left" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
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
                {/* Avatar with accent ring */}
                <View style={styles.avatarRing}>
                  <Image
                    source={{
                      uri: `${AVATAR_BASE}${encodeURIComponent(selectedUser.name)}`,
                    }}
                    style={styles.profileAvatar}
                  />
                  {/* Online dot on avatar */}
                  <View
                    style={[
                      styles.profileOnlineDot,
                      {
                        backgroundColor: onlineUsers.has(selectedUser.id)
                          ? colors.online
                          : colors.offline,
                      },
                    ]}
                  />
                </View>

                {/* Name */}
                <Text style={styles.profileName}>{selectedUser.name}</Text>

                {/* Bio */}
                {selectedUser.bio ? (
                  <Text style={styles.profileBio}>{selectedUser.bio}</Text>
                ) : null}

                {/* Status pill */}
                <View
                  style={[
                    styles.profileStatus,
                    {
                      backgroundColor: onlineUsers.has(selectedUser.id)
                        ? "rgba(16, 185, 129, 0.1)"
                        : "rgba(0, 0, 0, 0.04)",
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

                {/* Action Buttons — circular icons */}
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={styles.actionCircle}
                    onPress={() => handleMessageUser(selectedUser)}
                  >
                    <Icon name="message-circle" size={22} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.actionCircle,
                      styles.actionCircleCall,
                      !onlineUsers.has(selectedUser.id) &&
                        styles.actionCircleDisabled,
                    ]}
                    onPress={() => handleCallUser(selectedUser)}
                    disabled={!onlineUsers.has(selectedUser.id)}
                  >
                    <Icon name="phone" size={22} color="#fff" />
                  </TouchableOpacity>
                </View>

                {/* Labels under buttons */}
                <View style={styles.actionLabelRow}>
                  <Text style={styles.actionLabel}>Message</Text>
                  <Text style={styles.actionLabel}>Call</Text>
                </View>
              </>
            )}
          </Animated.View>
        </TouchableOpacity>
      </Modal>

      {/* Custom Popup */}
      <CustomPopup
        visible={popup.visible}
        title={popup.title}
        message={popup.message}
        buttons={popup.buttons}
        onClose={() => setPopup({ visible: false, title: "", message: "" })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: 60,
    paddingBottom: spacing.md,
    gap: 12,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
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
  privateBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#6366F1",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.bgCard,
  },
  requestBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "rgba(99,102,241,0.12)",
    gap: 6,
  },
  requestBtnSent: {
    backgroundColor: "rgba(148,163,184,0.10)",
  },
  requestBtnText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.primary,
  },
  userBio: {
    ...typography.caption,
    marginTop: 2,
    color: colors.textSecondary || "#8E8E93",
    fontStyle: "italic",
  },
  expandedActions: {
    backgroundColor: colors.bgCard,
    marginTop: -6,
    marginBottom: spacing.sm,
    marginHorizontal: 2,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: colors.borderLight,
  },
  expandedRequestBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: colors.primary,
    gap: 8,
  },
  expandedRequestBtnUndo: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
  },
  expandedRequestBtnText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#fff",
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
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  profileModal: {
    width: "80%",
    maxWidth: 300,
    backgroundColor: "#fff",
    borderRadius: 24,
    paddingTop: 32,
    paddingBottom: 24,
    paddingHorizontal: 24,
    alignItems: "center",
  },
  avatarRing: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 3,
    borderColor: colors.primary,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 14,
    position: "relative",
  },
  profileAvatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: "transparent",
  },
  profileOnlineDot: {
    position: "absolute",
    bottom: 4,
    right: 4,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: "#fff",
  },
  profileName: {
    fontSize: 20,
    fontWeight: "700",
    color: "#1A1A2E",
    marginBottom: 2,
  },
  profileBio: {
    fontSize: 14,
    color: "#8E8E93",
    fontStyle: "italic",
    marginBottom: 4,
  },
  profileStatus: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    marginTop: 6,
    marginBottom: 20,
  },
  profileDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: 6,
  },
  profileStatusText: {
    fontSize: 12,
    fontWeight: "500",
  },

  // Action Buttons
  actionRow: {
    flexDirection: "row",
    gap: 24,
    marginBottom: 6,
  },
  actionCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  actionCircleCall: {
    backgroundColor: colors.success,
  },
  actionCircleDisabled: {
    backgroundColor: "#E5E5EA",
  },
  actionLabelRow: {
    flexDirection: "row",
    gap: 24,
  },
  actionLabel: {
    width: 52,
    textAlign: "center",
    fontSize: 11,
    fontWeight: "500",
    color: "#8E8E93",
  },
});
