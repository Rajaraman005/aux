/**
 * Home Screen — Chat list.
 * Features: greeting header, filter tabs, conversation list with real-time updates.
 */
import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
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

function formatTime(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function HomeScreen({ navigation }) {
  const { user } = useAuth();
  const { onlineUsers } = useSignaling();
  const [conversations, setConversations] = useState([]);
  const [activeFilter, setActiveFilter] = useState("All");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);

  // Fetch unread notification count
  useEffect(() => {
    const fetchCount = async () => {
      try {
        const data = await apiClient.get(endpoints.notifications.count);
        setUnreadNotifCount(data.unread_count);
      } catch (err) {
        // Non-critical
      }
    };
    fetchCount();

    // Real-time badge update
    const unsub = signalingClient.on("notification:new", () => {
      setUnreadNotifCount((prev) => prev + 1);
    });
    return () => unsub();
  }, []);

  // ─── Fetch Conversations ───────────────────────────────────────────────
  const fetchConversations = useCallback(async () => {
    try {
      const data = await apiClient.get(endpoints.conversations.list);
      setConversations(data.conversations || []);
    } catch (err) {
      console.error("Fetch conversations error:", err);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // ─── Real-time message updates ─────────────────────────────────────────
  useEffect(() => {
    const unsubMsg = signalingClient.on("message-received", (data) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === data.conversationId);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            last_message: data.message.content,
            last_message_at: data.message.created_at,
            last_message_sender: data.message.sender_id,
            unread_count: (updated[idx].unread_count || 0) + 1,
          };
          // Move to top
          const [item] = updated.splice(idx, 1);
          updated.unshift(item);
          return updated;
        }
        // New conversation — refetch
        fetchConversations();
        return prev;
      });
    });

    const unsubRead = signalingClient.on("messages-read", (data) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === data.conversationId ? { ...c, unread_count: 0 } : c,
        ),
      );
    });

    return () => {
      unsubMsg();
      unsubRead();
    };
  }, [fetchConversations]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    fetchConversations();
  };

  // ─── Render Chat Item ──────────────────────────────────────────────────
  const renderChatItem = ({ item }) => {
    const isOnline = onlineUsers.has(item.other_user_id);
    return (
      <TouchableOpacity
        style={styles.chatCard}
        onPress={() =>
          navigation.navigate("Chat", {
            conversationId: item.id,
            otherUser: {
              id: item.other_user_id,
              name: item.other_user_name,
              avatar_seed: item.other_user_avatar,
            },
          })
        }
        activeOpacity={0.7}
      >
        <View style={styles.avatarContainer}>
          <Image
            source={{
              uri: `${AVATAR_BASE}${encodeURIComponent(item.other_user_name)}`,
            }}
            style={styles.avatar}
          />
          {isOnline && <View style={styles.onlineDot} />}
        </View>
        <View style={styles.chatInfo}>
          <Text style={styles.chatName}>{item.other_user_name}</Text>
          <Text style={styles.chatPreview} numberOfLines={1}>
            {item.last_message
              ? item.last_message_sender === user?.id
                ? `You: ${item.last_message}`
                : item.last_message
              : "No messages yet"}
          </Text>
        </View>
        <View style={styles.chatMeta}>
          {item.last_message_at && (
            <Text style={styles.chatTime}>
              {formatTime(item.last_message_at)}
            </Text>
          )}
          {item.unread_count > 0 && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadText}>
                {item.unread_count > 99 ? "99+" : item.unread_count}
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const filters = ["All", "Group", "Chats"];

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        {/* Row 1: Title + grid icon */}
        <View style={styles.headerRow}>
          <Text style={styles.greeting}>Let's Aux</Text>
          <TouchableOpacity
            onPress={() => {
              setUnreadNotifCount(0);
              navigation.navigate("Notifications");
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.notifBtn}
          >
            <Icon name="bell" size={22} color={colors.textPrimary} />
            {unreadNotifCount > 0 && (
              <View style={styles.bellBadge}>
                <Text style={styles.bellBadgeText}>
                  {unreadNotifCount > 99 ? "99+" : unreadNotifCount}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
        {/* Row 2: Search bar */}
        <TouchableOpacity
          style={styles.searchBar}
          onPress={() => navigation.navigate("Search")}
          activeOpacity={0.7}
        >
          <Icon
            name="search"
            size={18}
            color={colors.textMuted}
            style={{ marginRight: 8 }}
          />
          <Text style={styles.searchBarText}>Search...</Text>
        </TouchableOpacity>
      </View>

      {/* Filter Tabs */}
      <View style={styles.filterRow}>
        {filters.map((filter) => (
          <TouchableOpacity
            key={filter}
            style={[
              styles.filterTab,
              activeFilter === filter && styles.filterTabActive,
            ]}
            onPress={() => setActiveFilter(filter)}
          >
            <Text
              style={[
                styles.filterText,
                activeFilter === filter && styles.filterTextActive,
              ]}
            >
              {filter}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Conversation List */}
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={conversations}
          renderItem={renderChatItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[
            styles.listContent,
            conversations.length === 0 && { flexGrow: 1 },
          ]}
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
              <Icon name="message-circle" size={64} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>No conversations yet</Text>
              <Text style={styles.emptyText}>
                Search for users and start chatting
              </Text>
              <TouchableOpacity
                style={styles.emptyButton}
                onPress={() => navigation.navigate("Search")}
              >
                <Text style={styles.emptyButtonText}>Find People</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}
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
    paddingBottom: spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  greeting: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  notifBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.bgCard,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  bellBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: "#ef4444",
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.bg,
  },
  bellBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchBarText: {
    fontSize: 15,
    color: colors.textMuted,
  },

  // Filter Tabs
  filterRow: {
    flexDirection: "row",
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
    gap: 8,
  },
  filterTab: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.bgCard,
  },
  filterTabActive: {
    backgroundColor: colors.primary,
  },
  filterText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textMuted,
  },
  filterTextActive: {
    color: colors.textInverse,
  },

  // Chat List
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 100,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  chatCard: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
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
    backgroundColor: colors.online,
    borderWidth: 2,
    borderColor: colors.bg,
  },
  chatInfo: {
    flex: 1,
    marginRight: spacing.sm,
  },
  chatName: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.textPrimary,
    marginBottom: 3,
  },
  chatPreview: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  chatMeta: {
    alignItems: "flex-end",
    gap: 6,
  },
  chatTime: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: "500",
  },
  unreadBadge: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadText: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textInverse,
  },

  // Empty State
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: {
    ...typography.h3,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  emptyText: {
    ...typography.bodySmall,
    marginBottom: spacing.lg,
  },
  emptyButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: 32,
    ...shadows.md,
  },
  emptyButtonText: {
    ...typography.button,
  },
});
