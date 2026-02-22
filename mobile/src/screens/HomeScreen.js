/**
 * Home Screen — User list with search and call initiation.
 * Features: search bar, user cards with avatars, online indicators, profile modal.
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
  RefreshControl,
  Image,
} from "react-native";
import { useAuth } from "../context/AuthContext";
import apiClient from "../services/api";
import { endpoints } from "../config/api";
import signalingClient from "../services/socket";
import {
  colors,
  typography,
  spacing,
  radius,
  shadows,
  commonStyles,
} from "../styles/theme";

export default function HomeScreen({ navigation }) {
  const { user, logout, accessToken } = useAuth();
  const [users, setUsers] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const [selectedUser, setSelectedUser] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);

  const modalAnim = useRef(new Animated.Value(0)).current;

  // ─── Connect Signaling ───────────────────────────────────────────────
  useEffect(() => {
    if (accessToken) {
      signalingClient.connect(accessToken);

      // Listen for presence updates
      const unsubPresence = signalingClient.on("presence", (data) => {
        setOnlineUsers((prev) => {
          const next = new Set(prev);
          if (data.status === "online") next.add(data.userId);
          else next.delete(data.userId);
          return next;
        });
      });

      // Listen for presence list
      const unsubList = signalingClient.on("presence-list", (data) => {
        setOnlineUsers(new Set(data.users));
      });

      // Listen for incoming calls
      const unsubCall = signalingClient.on("incoming-call", (data) => {
        setIncomingCall(data);
      });

      return () => {
        unsubPresence();
        unsubList();
        unsubCall();
        signalingClient.disconnect();
      };
    }
  }, [accessToken]);

  // ─── Fetch Users ─────────────────────────────────────────────────────
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
      setIsRefreshing(false);
    }
  }, [searchQuery]);

  useEffect(() => {
    const timer = setTimeout(fetchUsers, searchQuery ? 300 : 0); // Debounce search
    return () => clearTimeout(timer);
  }, [fetchUsers]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    fetchUsers();
  };

  // ─── Call Actions ────────────────────────────────────────────────────
  const handleCallUser = useCallback(
    (targetUser) => {
      setSelectedUser(null);
      signalingClient.requestCall(targetUser.id);

      // Listen for call status
      const unsubRinging = signalingClient.on("call-ringing", (data) => {
        navigation.navigate("Call", {
          callId: data.callId,
          targetUser,
          isCaller: true,
          callState: "ringing",
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

  const handleAcceptCall = useCallback(() => {
    if (!incomingCall) return;
    signalingClient.acceptCall(incomingCall.callId);
    navigation.navigate("Call", {
      callId: incomingCall.callId,
      targetUser: { id: incomingCall.callerId, name: incomingCall.callerName },
      isCaller: false,
      callState: "connecting",
    });
    setIncomingCall(null);
  }, [incomingCall, navigation]);

  const handleRejectCall = useCallback(() => {
    if (!incomingCall) return;
    signalingClient.rejectCall(incomingCall.callId);
    setIncomingCall(null);
  }, [incomingCall]);

  // ─── Profile Modal Animation ────────────────────────────────────────
  useEffect(() => {
    Animated.spring(modalAnim, {
      toValue: selectedUser ? 1 : 0,
      damping: 20,
      stiffness: 300,
      useNativeDriver: true,
    }).start();
  }, [selectedUser]);

  // ─── Render User Card ───────────────────────────────────────────────
  const renderUserCard = ({ item }) => {
    const isOnline = onlineUsers.has(item.id);
    return (
      <TouchableOpacity
        style={styles.userCard}
        onPress={() => setSelectedUser(item)}
        activeOpacity={0.7}
      >
        <View style={styles.avatarContainer}>
          <Image source={{ uri: item.avatar }} style={styles.avatar} />
          <View
            style={[
              styles.onlineDot,
              { backgroundColor: isOnline ? colors.online : colors.offline },
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
          <Text style={styles.quickCallIcon}>📞</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>
            Hey, {user?.name?.split(" ")[0]} 👋
          </Text>
          <Text style={styles.headerSubtitle}>
            {onlineUsers.size} contacts online
          </Text>
        </View>
        <TouchableOpacity onPress={logout} style={styles.logoutBtn}>
          <Text style={styles.logoutText}>↗️</Text>
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          style={styles.searchInput}
          placeholder="Search contacts..."
          placeholderTextColor={colors.textMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCorrect={false}
        />
        {searchQuery ? (
          <TouchableOpacity
            onPress={() => setSearchQuery("")}
            style={styles.clearBtn}
          >
            <Text style={styles.clearText}>✕</Text>
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
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyEmoji}>👥</Text>
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
                  source={{ uri: selectedUser.avatar }}
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
                        : "rgba(102, 102, 128, 0.1)",
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
                <TouchableOpacity
                  style={[
                    styles.callButton,
                    !onlineUsers.has(selectedUser.id) &&
                      styles.callButtonDisabled,
                  ]}
                  onPress={() => handleCallUser(selectedUser)}
                  disabled={!onlineUsers.has(selectedUser.id)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.callButtonText}>📞 Call Now</Text>
                </TouchableOpacity>
              </>
            )}
          </Animated.View>
        </TouchableOpacity>
      </Modal>

      {/* Incoming Call Modal */}
      <Modal visible={!!incomingCall} transparent animationType="slide">
        <View style={styles.incomingCallOverlay}>
          <View style={styles.incomingCallCard}>
            <Text style={styles.incomingCallEmoji}>📞</Text>
            <Text style={styles.incomingCallTitle}>Incoming Call</Text>
            <Text style={styles.incomingCallerName}>
              {incomingCall?.callerName}
            </Text>
            <View style={styles.incomingCallActions}>
              <TouchableOpacity
                style={styles.rejectButton}
                onPress={handleRejectCall}
              >
                <Text style={styles.rejectText}>✕</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.acceptButton}
                onPress={handleAcceptCall}
              >
                <Text style={styles.acceptText}>✓</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: 60,
    paddingBottom: spacing.md,
  },
  greeting: { ...typography.h2, fontSize: 28 },
  headerSubtitle: { ...typography.bodySmall, marginTop: 2 },
  logoutBtn: { padding: spacing.sm },
  logoutText: { fontSize: 24 },

  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: "rgba(99,102,241,0.08)",
  },
  searchIcon: { fontSize: 16, marginRight: spacing.sm },
  searchInput: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.textPrimary,
  },
  clearBtn: { padding: spacing.sm },
  clearText: { color: colors.textMuted, fontSize: 16, fontWeight: "600" },

  listContent: { paddingHorizontal: spacing.lg, paddingBottom: 100 },
  loadingContainer: { flex: 1, justifyContent: "center", alignItems: "center" },

  userCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: "rgba(99,102,241,0.05)",
  },
  avatarContainer: { position: "relative", marginRight: spacing.md },
  avatar: { width: 52, height: 52, borderRadius: 26 },
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
  userInfo: { flex: 1 },
  userName: { ...typography.body, fontWeight: "600" },
  userStatus: { ...typography.caption, marginTop: 2 },
  quickCallBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(99, 102, 241, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  quickCallBtnDisabled: { opacity: 0.3 },
  quickCallIcon: { fontSize: 20 },

  emptyContainer: { alignItems: "center", paddingTop: 80 },
  emptyEmoji: { fontSize: 64, marginBottom: spacing.md },
  emptyText: { ...typography.bodySmall },

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
    backgroundColor: colors.bgCard,
    borderRadius: radius.xl,
    padding: spacing.xl,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.bgGlassBorder,
    ...shadows.xl,
  },
  profileAvatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    marginBottom: spacing.md,
  },
  profileName: { ...typography.h3, marginBottom: 4 },
  profileEmail: { ...typography.bodySmall, marginBottom: spacing.md },
  profileStatus: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.full,
    marginBottom: spacing.lg,
  },
  profileDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  profileStatusText: { ...typography.caption },
  callButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: 32,
    width: "100%",
    alignItems: "center",
    ...shadows.xl,
  },
  callButtonDisabled: { backgroundColor: colors.bgElevated, ...shadows.sm },
  callButtonText: { ...typography.button },

  // Incoming Call
  incomingCallOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.85)",
  },
  incomingCallCard: {
    width: "80%",
    backgroundColor: colors.bgCard,
    borderRadius: radius.xl,
    padding: spacing.xl,
    alignItems: "center",
    ...shadows.xl,
  },
  incomingCallEmoji: { fontSize: 48, marginBottom: spacing.md },
  incomingCallTitle: { ...typography.label, marginBottom: spacing.sm },
  incomingCallerName: { ...typography.h2, marginBottom: spacing.xl },
  incomingCallActions: { flexDirection: "row", gap: 40 },
  rejectButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.error,
    justifyContent: "center",
    alignItems: "center",
  },
  rejectText: { fontSize: 28, color: "#fff", fontWeight: "700" },
  acceptButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.success,
    justifyContent: "center",
    alignItems: "center",
  },
  acceptText: { fontSize: 28, color: "#fff", fontWeight: "700" },
});
