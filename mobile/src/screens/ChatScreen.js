/**
 * ChatScreen — Production-grade 1-on-1 messaging.
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
  Alert,
  Modal,
  DeviceEventEmitter,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  interpolate,
  FadeIn,
  FadeOut,
  SlideInDown,
  SlideOutDown,
} from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import { useAuth } from "../context/AuthContext";
import { useSignaling } from "../context/SignalingContext";
import apiClient from "../services/api";
import { endpoints } from "../config/api";
import signalingClient from "../services/socket";
import callManager from "../services/CallManager";
import { colors, typography, spacing, shadows } from "../styles/theme";
import MessageBubble from "../components/MessageBubble";
import ProfilePictureViewer from "../components/ProfilePictureViewer";
import { uploadMedia, cancelUpload } from "../services/mediaService";
import {
  startRecording,
  stopRecording,
  uploadVoiceMessage,
  cancelRecording,
} from "../services/voiceRecorder";

const AVATAR_BASE = "https://api.dicebear.com/7.x/initials/png?seed=";
const NEAR_BOTTOM_THRESHOLD = 150;
const INPUT_BAR_HEIGHT = 64; // approximate height for FlatList bottom padding

let msgCounter = 0;
function generateTempId() {
  return `temp_${Date.now()}_${++msgCounter}`;
}

export default function ChatScreen({ route, navigation }) {
  const { conversationId, otherUser } = route.params;
  const { user } = useAuth();
  const { onlineUsers, setActiveConversation, profileUpdates } = useSignaling();
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
  const [isTyping, setIsTyping] = useState(false);
  const [showAvatarViewer, setShowAvatarViewer] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // Voice recording state
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);

  // Scroll tracking for "New Messages" badge
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [newMessageCount, setNewMessageCount] = useState(0);

  // Refs
  const flatListRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const lastTypingSentRef = useRef(0);
  const isNearBottomRef = useRef(true);

  const isOnline = onlineUsers.has(otherUser.id);

  useEffect(() => {
    isNearBottomRef.current = isNearBottom;
  }, [isNearBottom]);

  // ─── Load message history ──────────────────────────────────────────
  useEffect(() => {
    loadMessages();
    signalingClient.sendMessageRead(conversationId);
    apiClient
      .post(endpoints.conversations.read(conversationId))
      .catch(() => {});

    // Tell SignalingContext we're viewing this conversation (suppresses sounds)
    setActiveConversation(conversationId);
    return () => setActiveConversation(null);
  }, [conversationId, setActiveConversation]);

  const loadMessages = async () => {
    try {
      const data = await apiClient.get(
        endpoints.conversations.messages(conversationId),
      );
      setMessages(data.messages || []);
    } catch (err) {
      console.error("Load messages error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  // ─── Real-time events ──────────────────────────────────────────────
  useEffect(() => {
    const unsubMsg = signalingClient.on("message-received", (data) => {
      if (data.conversationId === conversationId) {
        setMessages((prev) => [data.message, ...prev]);
        signalingClient.sendMessageRead(conversationId);
        if (!isNearBottomRef.current) {
          setNewMessageCount((prev) => prev + 1);
        }
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
          m.tempId === data.tempId ? { ...data.message, confirmed: true } : m,
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

  // ─── Send message ──────────────────────────────────────────────────
  const handleSend = useCallback(
    (media = null) => {
      const text = inputText.trim();
      if (!text && !media) return;

      const tempId = generateTempId();
      const optimisticMsg = {
        tempId,
        content: text || null,
        sender_id: user.id,
        created_at: new Date().toISOString(),
        pending: true,
        ...(media && {
          media_url: media.url,
          media_type: media.mediaType,
          media_thumbnail: media.thumbnailUrl,
          media_width: media.width,
          media_height: media.height,
          media_duration: media.duration,
        }),
      };

      setMessages((prev) => [optimisticMsg, ...prev]);
      signalingClient.sendChatMessage(
        conversationId,
        text || null,
        tempId,
        media,
      );
      setInputText("");

      setTimeout(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
      }, 100);
    },
    [inputText, conversationId, user],
  );

  // ─── Media Pick → Navigate instantly → Picker opens on preview ──────
  const handleMediaPick = useCallback(
    (type, source) => {
      setShowAttachMenu(false);
      // Navigate immediately — MediaPreviewScreen opens the picker itself
      navigation.navigate("MediaPreview", {
        pickType: type,
        pickSource: source,
        conversationId,
      });
    },
    [navigation, conversationId],
  );

  // ─── Listen for media send events from MediaPreviewScreen ──────────
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      "media-preview-send",
      ({ targetConversationId, mediaAssets, caption }) => {
        if (targetConversationId !== conversationId) return;
        let captionText = caption || "";
        // Fire all uploads in parallel for speed
        const uploads = mediaAssets.map((item, idx) => {
          const text = idx === 0 ? captionText : "";
          return uploadAndSendMedia(item, text);
        });
        Promise.all(uploads).catch((err) =>
          console.error("Parallel upload error:", err),
        );
      },
    );
    return () => sub.remove();
  }, [conversationId]);

  // ─── Upload a single media item and send via WS ────────────────────
  const uploadAndSendMedia = useCallback(
    async (asset, captionText) => {
      const mediaType = asset.type === "video" ? "video" : "image";
      const uploadId = `chat_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const tempId = generateTempId();

      const optimistic = {
        tempId,
        content: captionText || null,
        sender_id: user.id,
        created_at: new Date().toISOString(),
        pending: true,
        media_url: asset.uri,
        media_type: mediaType,
        media_width: asset.width,
        media_height: asset.height,
        media_duration: asset.duration,
        uploadProgress: 0,
      };
      setMessages((prev) => [optimistic, ...prev]);
      setIsUploading(true);

      try {
        const result = await uploadMedia({
          uri: asset.uri,
          mediaType,
          fileSize: asset.fileSize,
          mimeType: asset.mimeType,
          width: asset.width,
          height: asset.height,
          duration: asset.duration,
          uploadId,
          onProgress: (p) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.tempId === tempId ? { ...m, uploadProgress: p } : m,
              ),
            );
          },
        });

        const media = {
          url: result.url,
          mediaType,
          thumbnailUrl: result.thumbnailUrl,
          width: result.width,
          height: result.height,
          duration: result.duration,
          size: result.size,
          mimeType: result.mimeType,
        };

        setMessages((prev) =>
          prev.map((m) =>
            m.tempId === tempId
              ? {
                  ...m,
                  media_url: result.url,
                  media_thumbnail: result.thumbnailUrl,
                  uploadProgress: 1,
                }
              : m,
          ),
        );

        signalingClient.sendChatMessage(
          conversationId,
          captionText || null,
          tempId,
          media,
        );
      } catch (err) {
        console.error("Media upload failed:", err);
        setMessages((prev) => prev.filter((m) => m.tempId !== tempId));
      } finally {
        setIsUploading(false);
      }
    },
    [user, conversationId],
  );

  // ─── Voice Recording ───────────────────────────────────────────────
  const handleRecordStart = async () => {
    const started = await startRecording({
      onDuration: setRecordDuration,
    });
    if (started) setIsRecordingAudio(true);
  };

  const handleRecordStop = async () => {
    const result = await stopRecording();
    setIsRecordingAudio(false);
    setRecordDuration(0);

    if (result) {
      handleVoiceSend(result);
    }
  };

  const handleVoiceSend = async (asset) => {
    const tempId = generateTempId();
    const optimistic = {
      tempId,
      content: null,
      sender_id: user.id,
      created_at: new Date().toISOString(),
      pending: true,
      media_url: asset.uri,
      media_type: "audio",
      media_duration: asset.duration,
      uploadProgress: 0,
    };
    setMessages((prev) => [optimistic, ...prev]);

    try {
      const result = await uploadVoiceMessage({
        uri: asset.uri,
        duration: asset.duration,
        mimeType: asset.mimeType,
        onProgress: (p) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.tempId === tempId ? { ...m, uploadProgress: p } : m,
            ),
          );
        },
      });

      signalingClient.sendChatMessage(conversationId, null, tempId, {
        url: result.url,
        mediaType: "audio",
        duration: result.duration,
        mimeType: result.mimeType,
        size: result.size,
      });

      setMessages((prev) =>
        prev.map((m) =>
          m.tempId === tempId
            ? {
                ...m,
                media_url: result.url,
                uploadProgress: undefined,
              }
            : m,
        ),
      );
    } catch (err) {
      console.error("Voice upload failed:", err);
      // Remove optimistic message on failure
      setMessages((prev) => prev.filter((m) => m.tempId !== tempId));
    }
  };

  // ─── Typing indicator (throttled) ──────────────────────────────────
  const handleTextChange = useCallback(
    (text) => {
      setInputText(text);
      const now = Date.now();
      if (text.length > 0 && now - lastTypingSentRef.current > 2000) {
        signalingClient.sendTyping(conversationId);
        lastTypingSentRef.current = now;
      }
    },
    [conversationId],
  );

  // ─── Scroll tracking ──────────────────────────────────────────────
  const handleScroll = useCallback((event) => {
    const { contentOffset } = event.nativeEvent;
    const nearBottom = contentOffset.y <= NEAR_BOTTOM_THRESHOLD;
    setIsNearBottom(nearBottom);
    if (nearBottom) {
      setNewMessageCount(0);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    setNewMessageCount(0);
  }, []);

  // ─── Render ────────────────────────────────────────────────────────
  const renderMessage = useCallback(
    ({ item }) => (
      <MessageBubble item={item} isMine={item.sender_id === user.id} />
    ),
    [user.id],
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
        <View style={styles.headerInner}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon name="arrow-left" size={24} color={colors.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowAvatarViewer(true)}
            activeOpacity={0.8}
          >
            <Image
              source={{
                uri: (() => {
                  const liveProfile = profileUpdates.get(otherUser.id);
                  if (liveProfile)
                    return `${liveProfile.avatarUrl}?t=${liveProfile.timestamp}`;
                  return (
                    otherUser.avatar_url ||
                    `${AVATAR_BASE}${encodeURIComponent(otherUser.name || "User")}`
                  );
                })(),
              }}
              style={styles.headerAvatar}
            />
          </TouchableOpacity>
          <View style={styles.headerInfo}>
            <Text style={styles.headerName}>{otherUser.name}</Text>
            <Text style={styles.headerStatus}>
              {isTyping ? "typing..." : isOnline ? "Online" : "Offline"}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.headerAction}
            onPress={() => {
              const started = callManager.startCall(
                otherUser.id,
                otherUser.name,
                "voice",
              );
              if (started) {
                const liveProfile = profileUpdates.get(otherUser.id);
                const rawAvatar = liveProfile?.avatarUrl
                  ? `${liveProfile.avatarUrl}?t=${liveProfile.timestamp}`
                  : otherUser.avatar_url;
                const avatarUri = rawAvatar?.startsWith("http")
                  ? rawAvatar
                  : `${AVATAR_BASE}${encodeURIComponent(otherUser.name)}`;

                navigation.navigate("Call", {
                  callerName: otherUser.name,
                  callerAvatar: avatarUri,
                  callType: "voice",
                });
              }
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon name="phone" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.headerAction}
            onPress={() => {
              const started = callManager.startCall(
                otherUser.id,
                otherUser.name,
                "video",
              );
              if (started) {
                const liveProfile = profileUpdates.get(otherUser.id);
                const rawAvatar = liveProfile?.avatarUrl
                  ? `${liveProfile.avatarUrl}?t=${liveProfile.timestamp}`
                  : otherUser.avatar_url;
                const avatarUri = rawAvatar?.startsWith("http")
                  ? rawAvatar
                  : `${AVATAR_BASE}${encodeURIComponent(otherUser.name)}`;

                navigation.navigate("Call", {
                  callerName: otherUser.name,
                  callerAvatar: avatarUri,
                  callType: "video",
                });
              }
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon name="video" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
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

          {/* ─── "New Messages ↓" indicator ────────────────────────── */}
          {newMessageCount > 0 && !isNearBottom && (
            <TouchableOpacity
              style={styles.newMessagesBadge}
              onPress={scrollToBottom}
              activeOpacity={0.85}
            >
              <Icon name="chevron-down" size={16} color={colors.textInverse} />
              <Text style={styles.newMessagesBadgeText}>
                {newMessageCount} new message{newMessageCount > 1 ? "s" : ""}
              </Text>
            </TouchableOpacity>
          )}

          {/* ─── Typing indicator ──────────────────────────────────── */}
          {isTyping && (
            <View style={styles.typingContainer}>
              <Text style={styles.typingText}>
                {otherUser.name.split(" ")[0]} is typing...
              </Text>
            </View>
          )}

          {/* ─── Input Bar (anchored to bottom, moves with keyboard) ─ */}
          <Animated.View style={[styles.inputBar, inputBarAnimStyle]}>
            {isRecordingAudio ? (
              <View style={styles.recordingContainer}>
                <View
                  style={[
                    styles.recordingDot,
                    { opacity: recordDuration % 1000 < 500 ? 1 : 0.4 },
                  ]}
                />
                <Text style={styles.recordingTime}>
                  {Math.floor(recordDuration / 60000)}:
                  {(Math.floor(recordDuration / 1000) % 60)
                    .toString()
                    .padStart(2, "0")}
                </Text>
                <Text style={styles.recordingSlideText}>
                  {"<"} Slide to cancel
                </Text>
              </View>
            ) : (
              <>
                <TouchableOpacity
                  style={styles.attachButton}
                  onPress={() => setShowAttachMenu(true)}
                  disabled={isUploading}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  {isUploading ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Icon name="plus" size={22} color={colors.primary} />
                  )}
                </TouchableOpacity>
                <TextInput
                  style={styles.textInput}
                  value={inputText}
                  onChangeText={handleTextChange}
                  placeholder="Type a message..."
                  placeholderTextColor={colors.textMuted}
                  multiline
                  maxLength={5000}
                />
              </>
            )}

            {inputText.trim() ? (
              <TouchableOpacity
                style={styles.sendButton}
                onPress={() => handleSend()}
              >
                <Icon name="send" size={20} color={colors.textInverse} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[
                  styles.sendButton,
                  isRecordingAudio && styles.recordingButton,
                ]}
                onPressIn={handleRecordStart}
                onPressOut={handleRecordStop}
                disabled={isUploading}
              >
                <Icon
                  name="mic"
                  size={20}
                  color={isRecordingAudio ? "#fff" : colors.textInverse}
                />
              </TouchableOpacity>
            )}
          </Animated.View>
        </Animated.View>
      </View>

      {/* Profile Picture Viewer */}
      <ProfilePictureViewer
        visible={showAvatarViewer}
        imageUri={(() => {
          const liveProfile = profileUpdates.get(otherUser.id);
          if (liveProfile) return liveProfile.avatarUrl;
          return otherUser.avatar_url;
        })()}
        userName={otherUser.name}
        onClose={() => setShowAvatarViewer(false)}
      />

      {/* ─── Attachment Bottom Sheet ─────────────────────────────── */}
      {showAttachMenu && (
        <Animated.View
          style={[StyleSheet.absoluteFill, { zIndex: 9999, elevation: 10 }]}
          entering={FadeIn.duration(250)}
          exiting={FadeOut.duration(200)}
        >
          <TouchableOpacity
            style={styles.attachOverlay}
            activeOpacity={1}
            onPress={() => setShowAttachMenu(false)}
          >
            <TouchableOpacity activeOpacity={1} style={{ width: "100%" }}>
              <Animated.View
                entering={SlideInDown.duration(300)}
                exiting={SlideOutDown.duration(250)}
                style={[
                  styles.attachSheet,
                  { paddingBottom: Math.max(36, insets.bottom + 12) },
                ]}
              >
                <View style={styles.attachHandle} />
                <Text style={styles.attachTitle}>Send Media</Text>
                <View style={styles.attachOptions}>
                  <TouchableOpacity
                    style={styles.attachOption}
                    onPress={() => handleMediaPick("image", "gallery")}
                  >
                    <View style={styles.attachIcon}>
                      <Icon name="image" size={24} color="#fff" />
                    </View>
                    <Text style={styles.attachLabel}>Photo</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.attachOption}
                    onPress={() => handleMediaPick("video", "gallery")}
                  >
                    <View style={styles.attachIcon}>
                      <Icon name="film" size={24} color="#fff" />
                    </View>
                    <Text style={styles.attachLabel}>Video</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.attachOption}
                    onPress={() => handleMediaPick("image", "camera")}
                  >
                    <View style={styles.attachIcon}>
                      <Icon name="camera" size={24} color="#fff" />
                    </View>
                    <Text style={styles.attachLabel}>Camera</Text>
                  </TouchableOpacity>
                </View>
              </Animated.View>
            </TouchableOpacity>
          </TouchableOpacity>
        </Animated.View>
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
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerInner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  headerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginLeft: 12,
    marginRight: 10,
    backgroundColor: "transparent",
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
  headerAction: {
    marginLeft: 16,
    paddingHorizontal: 8,
    paddingVertical: 6,
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
    paddingTop: 10,
    backgroundColor: colors.inputBarBg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  attachButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.bgElevated,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 8,
    marginBottom: 3,
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

  // New Messages badge
  newMessagesBadge: {
    position: "absolute",
    bottom: 70,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    ...shadows.md,
  },
  newMessagesBadgeText: {
    color: colors.textInverse,
    fontSize: 13,
    fontWeight: "600",
    marginLeft: 4,
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

  // Attachment Bottom Sheet
  attachOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  attachSheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.xl,
    paddingTop: 12,
    ...shadows.lg,
  },
  attachHandle: {
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.border,
    alignSelf: "center",
    marginBottom: 20,
  },
  attachTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 24,
    textAlign: "left",
  },
  attachOptions: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 8,
  },
  attachOption: {
    alignItems: "center",
  },
  attachIcon: {
    width: 64,
    height: 64,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#1A1A1A",
    marginBottom: 10,
    ...shadows.sm,
  },
  attachLabel: {
    fontSize: 14,
    color: colors.textPrimary,
    fontWeight: "600",
  },

  // Voice Recording
  recordingContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,107,107,0.1)",
    borderRadius: 20,
    paddingHorizontal: 16,
    marginRight: 10,
    height: 44,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#FF6B6B",
    marginRight: 8,
  },
  recordingTime: {
    fontSize: 16,
    color: "#FF6B6B",
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  recordingSlideText: {
    marginLeft: "auto",
    fontSize: 14,
    color: colors.textMuted,
  },
  recordingButton: {
    backgroundColor: "#FF6B6B",
    transform: [{ scale: 1.15 }],
  },
});
