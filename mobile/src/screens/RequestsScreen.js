/**
 * Requests Screen — Friend requests & friends list.
 * Replaces the Calls tab. Features: Requests/Friends tabs, accept/reject,
 * real-time badge count, premium design.
 */
import React, { useState, useCallback, useEffect } from "react";
import { useFocusEffect } from "@react-navigation/native";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import apiClient from "../services/api";
import { endpoints } from "../config/api";
import signalingClient from "../services/socket";
import CustomPopup from "../components/CustomPopup";

const AVATAR_BASE = "https://api.dicebear.com/7.x/initials/png?seed=";

export default function RequestsScreen() {
  const insets = useSafeAreaInsets();
  const [requests, setRequests] = useState([]);
  const [friends, setFriends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState("requests");
  const [popup, setPopup] = useState({
    visible: false,
    title: "",
    message: "",
  });

  // ─── Load Data ────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    try {
      const [reqData, friendData] = await Promise.all([
        apiClient.get(endpoints.friends.requests),
        apiClient.get(endpoints.friends.list),
      ]);
      setRequests(reqData.requests || []);
      setFriends(friendData.friends || []);
    } catch (err) {
      console.error("Load friend data error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Refresh when screen gains focus (e.g. after switching tabs)
  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData]),
  );

  // ─── Real-time: refresh on new friend_request notification ────────────
  useEffect(() => {
    const unsub = signalingClient.on("notification:new", (data) => {
      if (data?.notification?.type === "friend_request") {
        loadData();
      }
    });
    return () => unsub();
  }, [loadData]);

  // ─── Actions ──────────────────────────────────────────────────────────
  const handleRespond = useCallback(
    async (requestId, action) => {
      try {
        await apiClient.put(endpoints.friends.respond(requestId), { action });
        setPopup({
          visible: true,
          title: "Done",
          message:
            action === "accept"
              ? "Friend request accepted!"
              : "Friend request declined.",
        });
        loadData();
      } catch (err) {
        setPopup({
          visible: true,
          title: "Error",
          message: err.error || "Failed to respond.",
        });
      }
    },
    [loadData],
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  // ─── Render Request Card ──────────────────────────────────────────────
  const renderRequest = ({ item: req }) => (
    <View style={styles.card}>
      <View style={styles.cardAvatar}>
        <Text style={styles.cardAvatarText}>
          {(req.sender_name || "?")[0].toUpperCase()}
        </Text>
      </View>
      <View style={styles.cardInfo}>
        <Text style={styles.cardName}>{req.sender_name}</Text>
        <Text style={styles.cardMeta}>Wants to be friends</Text>
      </View>
      <TouchableOpacity
        style={styles.rejectBtn}
        onPress={() => handleRespond(req.id, "reject")}
      >
        <Icon name="x" size={16} color="#EF4444" />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.acceptBtn}
        onPress={() => handleRespond(req.id, "accept")}
      >
        <Icon name="check" size={16} color="#fff" />
      </TouchableOpacity>
    </View>
  );

  // ─── Render Friend Card ───────────────────────────────────────────────
  const renderFriend = ({ item: f }) => (
    <View style={styles.card}>
      <View style={styles.cardAvatar}>
        <Text style={styles.cardAvatarText}>
          {(f.name || "?")[0].toUpperCase()}
        </Text>
      </View>
      <View style={styles.cardInfo}>
        <Text style={styles.cardName}>{f.name}</Text>
      </View>
      <Icon name="check-circle" size={18} color="#1A1A2E" />
    </View>
  );

  const activeData = tab === "requests" ? requests : friends;

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Requests</Text>
      </View>

      {/* Tab Switcher */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tab, tab === "requests" && styles.tabActive]}
          onPress={() => setTab("requests")}
        >
          <Text
            style={[styles.tabText, tab === "requests" && styles.tabTextActive]}
          >
            Requests{requests.length > 0 ? ` (${requests.length})` : ""}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, tab === "friends" && styles.tabActive]}
          onPress={() => setTab("friends")}
        >
          <Text
            style={[styles.tabText, tab === "friends" && styles.tabTextActive]}
          >
            Friends{friends.length > 0 ? ` (${friends.length})` : ""}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#1A1A2E" />
        </View>
      ) : (
        <FlatList
          data={activeData}
          keyExtractor={(item) => item.id}
          renderItem={tab === "requests" ? renderRequest : renderFriend}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor="#1A1A2E"
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Icon
                name={tab === "requests" ? "inbox" : "users"}
                size={48}
                color="#C7C7CC"
              />
              <Text style={styles.emptyTitle}>
                {tab === "requests" ? "No pending requests" : "No friends yet"}
              </Text>
              <Text style={styles.emptySubtitle}>
                {tab === "requests"
                  ? "Friend requests will appear here"
                  : "Add friends by searching for people"}
              </Text>
            </View>
          }
        />
      )}

      {/* Popup */}
      <CustomPopup
        visible={popup.visible}
        title={popup.title}
        message={popup.message}
        onClose={() => setPopup({ visible: false, title: "", message: "" })}
      />
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FAFAFA",
  },
  header: {
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: "#1A1A2E",
    letterSpacing: -0.3,
  },

  // Tab Switcher
  tabRow: {
    flexDirection: "row",
    marginHorizontal: 24,
    backgroundColor: "#F0F0F0",
    borderRadius: 10,
    padding: 3,
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  tabActive: {
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  tabText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#8E8E93",
  },
  tabTextActive: {
    color: "#1A1A2E",
  },

  // Cards
  card: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
    gap: 12,
  },
  cardAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "#F0EDE8",
    alignItems: "center",
    justifyContent: "center",
  },
  cardAvatarText: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1A2E",
  },
  cardInfo: {
    flex: 1,
  },
  cardName: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1A1A2E",
  },
  cardMeta: {
    fontSize: 13,
    color: "#8E8E93",
    marginTop: 2,
  },
  acceptBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#1A1A2E",
    alignItems: "center",
    justifyContent: "center",
  },
  rejectBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    alignItems: "center",
    justifyContent: "center",
  },

  // Loading / Empty
  loadingWrap: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyWrap: {
    alignItems: "center",
    paddingTop: 80,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1A2E",
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    color: "#8E8E93",
    textAlign: "center",
    marginTop: 6,
  },
  listContent: {
    paddingBottom: 100,
  },
});
