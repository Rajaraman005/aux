/**
 * Notifications Screen — FAANG-grade notification center.
 * Features: All/Unread tabs, date-grouped list, real-time updates,
 * cursor-based infinite scroll, tap-to-navigate, mark-all-read.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Animated,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import apiClient from "../services/api";
import { endpoints } from "../config/api";
import signalingClient from "../services/socket";
import { colors, typography, spacing, radius, shadows } from "../styles/theme";

// ─── Date Grouping Helpers ───────────────────────────────────────────────────
function getDateGroup(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "This Week";
  return "Older";
}

function formatNotifTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} min ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function getNotifIcon(type) {
  switch (type) {
    case "friend_request":
      return { name: "user-plus", color: "#3b82f6", bg: "#eff6ff" };
    case "world_mention":
      return { name: "at-sign", color: "#10b981", bg: "#ecfdf5" };
    case "message":
      return { name: "message-circle", color: "#8b5cf6", bg: "#f5f3ff" };
    case "call":
      return { name: "phone", color: "#f59e0b", bg: "#fffbeb" };
    case "system":
      return { name: "info", color: "#6b7280", bg: "#f3f4f6" };
    default:
      return { name: "bell", color: "#6b7280", bg: "#f3f4f6" };
  }
}

// ─── Group notifications by date ─────────────────────────────────────────────
function groupByDate(notifications) {
  const groups = {};
  const order = ["Today", "Yesterday", "This Week", "Older"];

  for (const notif of notifications) {
    const group = getDateGroup(notif.created_at);
    if (!groups[group]) groups[group] = [];
    groups[group].push(notif);
  }

  const sections = [];
  for (const label of order) {
    if (groups[label] && groups[label].length > 0) {
      sections.push({ title: label, data: groups[label] });
    }
  }
  return sections;
}

export default function NotificationsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activeTab, setActiveTab] = useState("All");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const fadeAnims = useRef(new Map()).current;

  // ─── Fetch Notifications ─────────────────────────────────────────────
  const fetchNotifications = useCallback(
    async (cursor = null, append = false) => {
      try {
        const unreadOnly = activeTab === "Unread";
        let url = `${endpoints.notifications.list}?limit=20&unread=${unreadOnly}`;
        if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

        const data = await apiClient.get(url);

        if (append) {
          setNotifications((prev) => [...prev, ...data.notifications]);
        } else {
          setNotifications(data.notifications);
        }
        setUnreadCount(data.unread_count);
        setNextCursor(data.next_cursor);
      } catch (err) {
        console.error("Failed to fetch notifications:", err);
      }
    },
    [activeTab],
  );

  // Initial load + tab change
  useEffect(() => {
    setIsLoading(true);
    fetchNotifications().finally(() => setIsLoading(false));
  }, [fetchNotifications]);

  // ─── Real-time WebSocket listener ────────────────────────────────────
  useEffect(() => {
    const unsubNotif = signalingClient.on("notification:new", (data) => {
      const notif = data.notification;
      if (!notif) return;

      // Animate entrance
      const anim = new Animated.Value(0);
      fadeAnims.set(notif.id, anim);

      setNotifications((prev) => {
        // Deduplicate: if same id exists (aggregated), replace it
        const filtered = prev.filter((n) => n.id !== notif.id);
        return [notif, ...filtered];
      });
      setUnreadCount((prev) => prev + 1);

      Animated.spring(anim, {
        toValue: 1,
        tension: 60,
        friction: 8,
        useNativeDriver: true,
      }).start();
    });

    return () => unsubNotif();
  }, [fadeAnims]);

  // ─── Actions ─────────────────────────────────────────────────────────
  const handleMarkAllRead = async () => {
    try {
      await apiClient.put(endpoints.notifications.readAll);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch (err) {
      console.error("Mark all read error:", err);
    }
  };

  const handleTapNotification = async (notif) => {
    // Mark as read
    if (!notif.read) {
      try {
        await apiClient.put(endpoints.notifications.read(notif.id));
        setNotifications((prev) =>
          prev.map((n) => (n.id === notif.id ? { ...n, read: true } : n)),
        );
        setUnreadCount((prev) => Math.max(0, prev - 1));
      } catch (err) {
        console.error("Mark read error:", err);
      }
    }

    // Navigate based on type
    switch (notif.type) {
      case "friend_request":
        navigation.navigate("MainTabs", { screen: "Requests" });
        break;
      case "world_mention":
        navigation.navigate("WorldChat");
        break;
      case "message":
        if (notif.data?.conversation_id) {
          navigation.navigate("Chat", {
            conversationId: notif.data.conversation_id,
          });
        }
        break;
      default:
        break;
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchNotifications();
    setIsRefreshing(false);
  };

  const handleLoadMore = async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    await fetchNotifications(nextCursor, true);
    setIsLoadingMore(false);
  };

  // ─── Render Notification Card ────────────────────────────────────────
  const renderNotificationItem = ({ item: notif }) => {
    const icon = getNotifIcon(notif.type);
    const fadeAnim = fadeAnims.get(notif.id);
    const animStyle = fadeAnim
      ? {
          opacity: fadeAnim,
          transform: [
            {
              translateY: fadeAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [-20, 0],
              }),
            },
          ],
        }
      : {};

    return (
      <Animated.View style={animStyle}>
        <TouchableOpacity
          style={[styles.notifCard, !notif.read && styles.notifCardUnread]}
          onPress={() => handleTapNotification(notif)}
          activeOpacity={0.7}
        >
          {/* Icon */}
          <View style={[styles.notifIconWrap, { backgroundColor: icon.bg }]}>
            <Icon name={icon.name} size={20} color={icon.color} />
          </View>

          {/* Content */}
          <View style={styles.notifContent}>
            <View style={styles.notifTitleRow}>
              <Text
                style={[
                  styles.notifTitle,
                  !notif.read && styles.notifTitleBold,
                ]}
                numberOfLines={1}
              >
                {notif.title}
              </Text>
              <Text style={styles.notifTime}>
                {formatNotifTime(notif.created_at)}
              </Text>
            </View>
            <Text style={styles.notifBody} numberOfLines={2}>
              {notif.body}
            </Text>
            {notif.data?.count > 1 && (
              <View style={styles.countBadge}>
                <Text style={styles.countBadgeText}>×{notif.data.count}</Text>
              </View>
            )}
          </View>

          {/* Unread dot */}
          {!notif.read && <View style={styles.unreadDot} />}
        </TouchableOpacity>
      </Animated.View>
    );
  };

  // ─── Render Section Header ───────────────────────────────────────────
  const sections = groupByDate(notifications);

  // Flatten sections into a list with headers
  const flatData = [];
  for (const section of sections) {
    flatData.push({
      type: "header",
      title: section.title,
      id: `h_${section.title}`,
    });
    for (const item of section.data) {
      flatData.push({ type: "item", ...item });
    }
  }

  const renderItem = ({ item }) => {
    if (item.type === "header") {
      return (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionHeaderText}>{item.title}</Text>
        </View>
      );
    }
    return renderNotificationItem({ item });
  };

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Icon name="arrow-left" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notification</Text>
        {unreadCount > 0 && (
          <TouchableOpacity
            onPress={handleMarkAllRead}
            style={styles.markAllBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon name="check-circle" size={20} color={colors.primary} />
          </TouchableOpacity>
        )}
      </View>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {["All", "Unread"].map((tab) => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text
              style={[
                styles.tabText,
                activeTab === tab && styles.tabTextActive,
              ]}
            >
              {tab}
              {tab === "Unread" && unreadCount > 0 ? ` (${unreadCount})` : ""}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      {isLoading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : flatData.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Icon name="bell-off" size={48} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No notifications</Text>
          <Text style={styles.emptySubtitle}>
            {activeTab === "Unread"
              ? "You're all caught up!"
              : "Notifications will appear here"}
          </Text>
        </View>
      ) : (
        <FlatList
          data={flatData}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.3}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              tintColor={colors.primary}
            />
          }
          ListFooterComponent={
            isLoadingMore ? (
              <View style={styles.footerLoader}>
                <ActivityIndicator size="small" color={colors.textMuted} />
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  backBtn: {
    marginRight: spacing.md,
  },
  headerTitle: {
    ...typography.h2,
    flex: 1,
  },
  markAllBtn: {
    padding: spacing.xs,
  },

  // Tabs
  tabRow: {
    flexDirection: "row",
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.lg,
  },
  tab: {
    paddingVertical: spacing.sm + 4,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    borderBottomColor: colors.primary,
  },
  tabText: {
    fontSize: 15,
    fontWeight: "500",
    color: colors.textMuted,
  },
  tabTextActive: {
    color: colors.textPrimary,
    fontWeight: "700",
  },

  // Section Headers
  sectionHeader: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  sectionHeaderText: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: colors.textMuted,
  },

  // Notification Card
  notifCard: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
  },
  notifCardUnread: {
    backgroundColor: "#f8f9ff",
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
  },
  notifIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  notifContent: {
    flex: 1,
  },
  notifTitleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
  },
  notifTitle: {
    fontSize: 15,
    fontWeight: "500",
    color: colors.textPrimary,
    flex: 1,
    marginRight: spacing.sm,
  },
  notifTitleBold: {
    fontWeight: "700",
  },
  notifTime: {
    fontSize: 12,
    color: colors.textMuted,
  },
  notifBody: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  countBadge: {
    marginTop: 4,
    alignSelf: "flex-start",
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  countBadgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textMuted,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
    marginLeft: spacing.sm,
  },

  // Loading / Empty
  loadingWrap: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyWrap: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
  },
  emptyTitle: {
    ...typography.h3,
    marginTop: spacing.md,
  },
  emptySubtitle: {
    ...typography.bodySmall,
    textAlign: "center",
    marginTop: spacing.xs,
  },

  // List
  listContent: {
    paddingBottom: spacing.xxl,
  },
  footerLoader: {
    paddingVertical: spacing.lg,
    alignItems: "center",
  },
});
