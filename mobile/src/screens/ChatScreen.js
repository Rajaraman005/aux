/**
 * Chat Screen — 1-on-1 messaging with real-time delivery.
 * Features: message bubbles, typing indicator, optimistic send, read receipts.
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
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

let msgCounter = 0;
function generateTempId() {
  return `temp_${Date.now()}_${++msgCounter}`;
}

function formatMessageTime(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ChatScreen({ route, navigation }) {
  const { conversationId, otherUser } = route.params;
  const { user } = useAuth();
  const { onlineUsers } = useSignaling();
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isTyping, setIsTyping] = useState(false);
  const flatListRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const lastTypingSentRef = useRef(0);

  const isOnline = onlineUsers.has(otherUser.id);

  // ─── Load message history ──────────────────────────────────────────────
  useEffect(() => {
    loadMessages();
    // Mark as read
    signalingClient.sendMessageRead(conversationId);
    apiClient.post(endpoints.conversations.read(conversationId)).catch(() => {});
  }, [conversationId]);

  const loadMessages = async () => {
    try {
      const data = await apiClient.get(
        endpoints.conversations.messages(conversationId),
      );
      // API returns newest first, we display oldest first
      setMessages((data.messages || []).reverse());
    } catch (err) {
      console.error("Load messages error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  // ─── Real-time events ──────────────────────────────────────────────────
  useEffect(() => {
    const unsubMsg = signalingClient.on("message-received", (data) => {
      if (data.conversationId === conversationId) {
        setMessages((prev) => [...prev, data.message]);
        // Mark as read immediately since we're viewing this conversation
        signalingClient.sendMessageRead(conversationId);
      }
    });

    const unsubTyping = signalingClient.on("typing", (data) => {
      if (data.conversationId === conversationId) {
        setIsTyping(true);
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => setIsTyping(false), 3000);
      }
    });

    const unsubConfirm = signalingClient.on("message-confirmed", (data) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.tempId === data.tempId
            ? { ...data.message, confirmed: true }
            : m,
        ),
      );
    });

    return () => {
      unsubMsg();
      unsubTyping();
      unsubConfirm();
      clearTimeout(typingTimeoutRef.current);
    };
  }, [conversationId]);

  // ─── Send message ──────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;

    const tempId = generateTempId();
    const optimisticMsg = {
      tempId,
      content: text,
      sender_id: user.id,
      created_at: new Date().toISOString(),
      pending: true,
    };

    setMessages((prev) => [...prev, optimisticMsg]);
    signalingClient.sendChatMessage(conversationId, text, tempId);
    setInputText("");
  }, [inputText, conversationId, user]);

  // ─── Typing indicator (throttled) ──────────────────────────────────────
  const handleTextChange = (text) => {
    setInputText(text);
    const now = Date.now();
    if (text.length > 0 && now - lastTypingSentRef.current > 2000) {
      signalingClient.sendTyping(conversationId);
      lastTypingSentRef.current = now;
    }
  };

  // ─── Render message bubble ─────────────────────────────────────────────
  const renderMessage = ({ item }) => {
    const isMine = item.sender_id === user.id;
    return (
      <View
        style={[
          styles.bubbleRow,
          isMine ? styles.bubbleRowRight : styles.bubbleRowLeft,
        ]}
      >
        <View
          style={[
            styles.bubble,
            isMine ? styles.bubbleMine : styles.bubbleTheirs,
          ]}
        >
          <Text
            style={[
              styles.bubbleText,
              isMine && styles.bubbleTextMine,
            ]}
          >
            {item.content}
          </Text>
          <View style={styles.bubbleFooter}>
            <Text style={[styles.bubbleTime, isMine && styles.bubbleTimeMine]}>
              {formatMessageTime(item.created_at)}
            </Text>
            {item.pending && (
              <Icon name="clock" size={10} color="rgba(255,255,255,0.5)" style={{ marginLeft: 4 }} />
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Icon name="arrow-left" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Image
          source={{
            uri: `${AVATAR_BASE}${otherUser.avatar_seed || otherUser.name}`,
          }}
          style={styles.headerAvatar}
        />
        <View style={styles.headerInfo}>
          <Text style={styles.headerName}>{otherUser.name}</Text>
          <Text style={styles.headerStatus}>
            {isTyping ? "typing..." : isOnline ? "Online" : "Offline"}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => {
            signalingClient.requestCall(otherUser.id);
            const unsub = signalingClient.on("call-ringing", (data) => {
              navigation.navigate("Call", {
                callId: data.callId,
                callerName: otherUser.name,
                isCaller: true,
              });
              unsub();
            });
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Icon name="phone" size={22} color={colors.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={{ marginLeft: 16 }}
          onPress={() => {
            signalingClient.requestCall(otherUser.id);
            const unsub = signalingClient.on("call-ringing", (data) => {
              navigation.navigate("Call", {
                callId: data.callId,
                callerName: otherUser.name,
                isCaller: true,
              });
              unsub();
            });
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Icon name="video" size={22} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {/* Messages */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={(item) => item.id || item.tempId}
            contentContainerStyle={styles.messagesList}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() =>
              flatListRef.current?.scrollToEnd({ animated: false })
            }
            ListEmptyComponent={
              <View style={styles.emptyChat}>
                <Icon
                  name="message-circle"
                  size={48}
                  color={colors.textMuted}
                />
                <Text style={styles.emptyChatText}>
                  Say hello to {otherUser.name}!
                </Text>
              </View>
            }
          />
        )}

        {/* Typing indicator */}
        {isTyping && (
          <View style={styles.typingContainer}>
            <Text style={styles.typingText}>
              {otherUser.name.split(" ")[0]} is typing...
            </Text>
          </View>
        )}

        {/* Input Bar */}
        <View style={styles.inputBar}>
          <TextInput
            style={styles.textInput}
            value={inputText}
            onChangeText={handleTextChange}
            placeholder="Type a message..."
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={5000}
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
              color={inputText.trim() ? "#fff" : colors.textMuted}
            />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingTop: 54,
    paddingBottom: 14,
    backgroundColor: colors.bgCard,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(99,102,241,0.08)",
  },
  headerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginLeft: 12,
    marginRight: 10,
    backgroundColor: colors.bgElevated,
  },
  headerInfo: {
    flex: 1,
  },
  headerName: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  headerStatus: {
    fontSize: 13,
    color: colors.textSecondary,
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
    paddingVertical: spacing.md,
    flexGrow: 1,
    justifyContent: "flex-end",
  },
  bubbleRow: {
    marginBottom: 6,
  },
  bubbleRowRight: {
    alignItems: "flex-end",
  },
  bubbleRowLeft: {
    alignItems: "flex-start",
  },
  bubble: {
    maxWidth: "78%",
    borderRadius: 18,
    paddingVertical: 10,
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
    color: colors.textPrimary,
  },
  bubbleTextMine: {
    color: "#fff",
  },
  bubbleFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 4,
  },
  bubbleTime: {
    fontSize: 11,
    color: "rgba(153, 153, 179, 0.7)",
  },
  bubbleTimeMine: {
    color: "rgba(255, 255, 255, 0.6)",
  },

  // Typing
  typingContainer: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 4,
  },
  typingText: {
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: "italic",
  },

  // Input Bar
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: colors.inputBarBg,
    borderTopWidth: 1,
    borderTopColor: "rgba(99,102,241,0.08)",
  },
  textInput: {
    flex: 1,
    backgroundColor: colors.bgElevated,
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
    ...shadows.md,
  },
  sendButtonDisabled: {
    backgroundColor: colors.bgElevated,
    shadowOpacity: 0,
    elevation: 0,
  },

  // Empty
  emptyChat: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 60,
  },
  emptyChatText: {
    ...typography.bodySmall,
    marginTop: spacing.md,
  },
});
