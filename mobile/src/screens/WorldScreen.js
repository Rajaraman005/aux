/**
 * World Screen — Global public chat visible to all users.
 *
 * Keyboard model: Translation (not KAV).
 *   - useReanimatedKeyboardAnimation tracks keyboard height
 *   - Animated.View translateY moves the entire content area up
 *   - Zero dependency on windowSoftInputMode
 *   - Works identically on all Android OEMs and iOS devices
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Image,
  StatusBar,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  interpolate,
} from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import { useAuth } from "../context/AuthContext";
import apiClient from "../services/api";
import { endpoints } from "../config/api";
import signalingClient from "../services/socket";
import { colors, typography, spacing, radius, shadows } from "../styles/theme";

const AVATAR_BASE = "https://api.dicebear.com/7.x/initials/png?seed=";
const NEAR_BOTTOM_THRESHOLD = 150;
const INPUT_BAR_HEIGHT = 64;

let msgCounter = 0;
function generateTempId() {
  return `wtemp_${Date.now()}_${++msgCounter}`;
}

function formatTime(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440)
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function WorldScreen({ navigation }) {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();

  // ─── Keyboard animation (translation model) ────────────────────────
  const { height: kbHeight, progress: kbProgress } =
    useReanimatedKeyboardAnimation();

  const translateStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: kbHeight.value }],
  }));

  // Animate bottom padding: insets.bottom when closed → 0 when keyboard open
  const safeBottom = Math.max(10, insets.bottom);
  const inputBarAnimStyle = useAnimatedStyle(() => ({
    paddingBottom: interpolate(kbProgress.value, [0, 1], [safeBottom, 0]),
  }));

  // ─── State ───────────────────────────────────────────────────────────
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  // Scroll tracking
  const [isNearBottom, setIsNearBottom] = useState(true);
  const flatListRef = useRef(null);
  const isNearBottomRef = useRef(true);

  useEffect(() => {
    isNearBottomRef.current = isNearBottom;
  }, [isNearBottom]);

  // ─── Load history ──────────────────────────────────────────────────────
  useEffect(() => {
    loadMessages();
  }, []);

  const loadMessages = async () => {
    try {
      const data = await apiClient.get(endpoints.world);
      const msgs = data.messages || [];
      setMessages(msgs.reverse());
    } catch (err) {
      console.error("World chat load error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  // ─── Real-time events ──────────────────────────────────────────────────
  useEffect(() => {
    const unsubReceived = signalingClient.on(
      "world-message-received",
      (data) => {
        setMessages((prev) => [data.message, ...prev]);
      },
    );

    const unsubConfirmed = signalingClient.on(
      "world-message-confirmed",
      (data) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.tempId === data.tempId ? { ...data.message, confirmed: true } : m,
          ),
        );
      },
    );

    return () => {
      unsubReceived();
      unsubConfirmed();
    };
  }, []);

  // ─── Send message ──────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;

    const tempId = generateTempId();
    const optimistic = {
      tempId,
      sender_id: user.id,
      sender_name: user.name,
      sender_avatar: user.avatar_seed || user.name,
      content: text,
      created_at: new Date().toISOString(),
      pending: true,
    };

    setMessages((prev) => [optimistic, ...prev]);
    signalingClient.sendWorldMessage(text, tempId);
    setInputText("");

    setTimeout(() => {
      flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    }, 100);
  }, [inputText, user]);

  // ─── Scroll tracking ──────────────────────────────────────────────────
  const handleScroll = useCallback((event) => {
    const { contentOffset } = event.nativeEvent;
    const nearBottom = contentOffset.y <= NEAR_BOTTOM_THRESHOLD;
    setIsNearBottom(nearBottom);
  }, []);

  // ─── Render message ────────────────────────────────────────────────────
  const renderMessage = useCallback(
    ({ item, index }) => {
      const isMine = item.sender_id === user.id;
      const prevItem = index < messages.length - 1 ? messages[index + 1] : null;
      const showAvatar = !prevItem || prevItem.sender_id !== item.sender_id;

      return (
        <View
          style={[
            styles.messageRow,
            isMine ? styles.messageRowMine : styles.messageRowTheirs,
          ]}
        >
          {!isMine && (
            <View style={styles.avatarCol}>
              {showAvatar ? (
                <Image
                  source={{
                    uri: `${AVATAR_BASE}${encodeURIComponent(item.sender_name)}`,
                  }}
                  style={styles.avatar}
                />
              ) : (
                <View style={styles.avatarPlaceholder} />
              )}
            </View>
          )}

          <View style={[styles.bubbleCol, isMine && styles.bubbleColMine]}>
            {showAvatar && !isMine && (
              <Text style={styles.senderName}>{item.sender_name}</Text>
            )}
            <View
              style={[
                styles.bubble,
                isMine ? styles.bubbleMine : styles.bubbleTheirs,
              ]}
            >
              <Text
                style={[
                  styles.bubbleText,
                  isMine ? styles.bubbleTextMine : styles.bubbleTextTheirs,
                ]}
              >
                {item.content}
              </Text>
            </View>
            <Text style={[styles.timeText, isMine && styles.timeTextMine]}>
              {item.pending ? "sending..." : formatTime(item.created_at)}
            </Text>
          </View>
        </View>
      );
    },
    [messages, user.id],
  );

  const keyExtractor = useCallback((item) => item.id || item.tempId, []);

  return (
    <View style={styles.container}>
      <StatusBar
        barStyle="dark-content"
        backgroundColor={colors.bg}
        translucent={false}
      />
      <View style={[styles.statusBarSpacer, { height: insets.top }]} />

      {/* ─── Header ────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.backButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon name="arrow-left" size={24} color={colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.title}>World</Text>
            <Text style={styles.subtitle}>Everyone can see this</Text>
          </View>
        </View>
      </View>

      {/* ─── Clip container — prevents content overflowing above header */}
      <View style={styles.contentClip}>
        <Animated.View style={[styles.flex1, translateStyle]}>
        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={keyExtractor}
            inverted
            style={styles.flex1}
            contentContainerStyle={[
              styles.messagesList,
              { paddingBottom: spacing.md + INPUT_BAR_HEIGHT + safeBottom },
            ]}
            showsVerticalScrollIndicator={false}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            windowSize={7}
            maxToRenderPerBatch={10}
            initialNumToRender={20}
            updateCellsBatchingPeriod={50}
            removeClippedSubviews={Platform.OS === "android"}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <View style={styles.emptyIconCircle}>
                  <Icon name="globe" size={40} color={colors.primary} />
                </View>
                <Text style={styles.emptyTitle}>World Chat</Text>
                <Text style={styles.emptyText}>
                  Be the first to say something to everyone!
                </Text>
              </View>
            }
          />
        )}

        {/* ─── Input Bar (moves with keyboard via translateY) ──── */}
        <Animated.View
          style={[
            styles.inputBar,
            inputBarAnimStyle,
          ]}
        >
          <TextInput
            style={styles.textInput}
            value={inputText}
            onChangeText={setInputText}
            placeholder="Say something to the world..."
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={1000}
          />
          <TouchableOpacity
            style={[
              styles.sendButton,
              !inputText.trim() && styles.sendButtonDisabled,
            ]}
            onPress={handleSend}
            disabled={!inputText.trim()}
          >
            <Icon
              name="send"
              size={20}
              color={inputText.trim() ? colors.textInverse : colors.textMuted}
            />
          </TouchableOpacity>
        </Animated.View>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex1: {
    flex: 1,
  },
  contentClip: {
    flex: 1,
    overflow: "hidden",
  },
  statusBarSpacer: {
    backgroundColor: colors.bg,
  },

  // Header
  header: {
    paddingHorizontal: spacing.md,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
  },
  backButton: {
    padding: 4,
    marginRight: 12,
  },
  headerCenter: {
    flex: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 1,
  },

  // Messages
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  messagesList: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  messageRow: {
    flexDirection: "row",
    marginBottom: 4,
    alignItems: "flex-end",
  },
  messageRowMine: {
    justifyContent: "flex-end",
  },
  messageRowTheirs: {
    justifyContent: "flex-start",
  },

  // Avatar
  avatarCol: {
    width: 32,
    marginRight: 8,
    alignItems: "center",
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "transparent",
  },
  avatarPlaceholder: {
    width: 32,
    height: 32,
  },

  // Bubble
  bubbleCol: {
    maxWidth: "72%",
  },
  bubbleColMine: {
    alignItems: "flex-end",
  },
  senderName: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textMuted,
    marginBottom: 2,
    marginLeft: 4,
  },
  bubble: {
    borderRadius: 18,
    paddingVertical: 9,
    paddingHorizontal: 14,
  },
  bubbleMine: {
    backgroundColor: colors.chatBubbleMine,
    borderBottomRightRadius: 4,
  },
  bubbleTheirs: {
    backgroundColor: colors.chatBubbleTheirs,
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 21,
  },
  bubbleTextMine: {
    color: colors.chatBubbleTextMine,
  },
  bubbleTextTheirs: {
    color: colors.chatBubbleTextTheirs,
  },
  timeText: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 2,
    marginLeft: 4,
  },
  timeTextMine: {
    marginLeft: 0,
    marginRight: 4,
  },

  // Empty
  emptyContainer: {
    alignItems: "center",
    paddingTop: 80,
  },
  emptyIconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.bgElevated,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  emptyTitle: {
    ...typography.h3,
    marginBottom: spacing.sm,
  },
  emptyText: {
    ...typography.bodySmall,
    textAlign: "center",
    paddingHorizontal: spacing.xl,
  },

  // Input Bar
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: spacing.md,
    paddingTop: 10,
    backgroundColor: colors.inputBarBg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  textInput: {
    flex: 1,
    backgroundColor: colors.bgCard,
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.textPrimary,
    maxHeight: 120,
    marginRight: 10,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    justifyContent: "center",
    alignItems: "center",
    ...shadows.sm,
  },
  sendButtonDisabled: {
    backgroundColor: colors.bgElevated,
    shadowOpacity: 0,
    elevation: 0,
  },
});
