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
  Alert,
  Modal,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  interpolate,
} from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import { useAuth } from "../context/AuthContext";
import { useSignaling } from "../context/SignalingContext";
import apiClient from "../services/api";
import { endpoints } from "../config/api";
import signalingClient from "../services/socket";
import { colors, typography, spacing, radius, shadows } from "../styles/theme";
import MediaViewer from "../components/MediaViewer";
import {
  pickImage,
  pickVideo,
  uploadMedia,
  cancelUpload,
} from "../services/mediaService";
import {
  startRecording,
  stopRecording,
  uploadVoiceMessage,
  cancelRecording,
} from "../services/voiceRecorder";
import VoiceBubble from "../components/VoiceBubble";

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
  const { profileUpdates } = useSignaling();
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
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [viewerMedia, setViewerMedia] = useState(null);

  // Voice recording state
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);

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
  const handleSend = useCallback(
    (media = null) => {
      const text = inputText.trim();
      if (!text && !media) return;

      const tempId = generateTempId();
      const optimistic = {
        tempId,
        sender_id: user.id,
        sender_name: user.name,
        sender_avatar: user.avatar_seed || user.name,
        content: text || null,
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

      setMessages((prev) => [optimistic, ...prev]);
      signalingClient.sendWorldMessage(text || null, tempId, media);
      setInputText("");

      setTimeout(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
      }, 100);
    },
    [inputText, user],
  );

  // ─── Media Pick & Upload ───────────────────────────────────────────
  const handleMediaPick = useCallback(
    async (type, source) => {
      setShowAttachMenu(false);
      try {
        const asset =
          type === "video" ? await pickVideo(source) : await pickImage(source);
        if (!asset) return;

        setIsUploading(true);
        const uploadId = `world_${Date.now()}`;
        const tempId = generateTempId();

        const optimistic = {
          tempId,
          sender_id: user.id,
          sender_name: user.name,
          sender_avatar: user.avatar_seed || user.name,
          content: null,
          created_at: new Date().toISOString(),
          pending: true,
          media_url: asset.uri,
          media_type: type === "video" ? "video" : "image",
          media_width: asset.width,
          media_height: asset.height,
          media_duration: asset.duration,
          uploadProgress: 0,
        };
        setMessages((prev) => [optimistic, ...prev]);

        const result = await uploadMedia({
          uri: asset.uri,
          mediaType: type === "video" ? "video" : "image",
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
          mediaType: type === "video" ? "video" : "image",
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

        signalingClient.sendWorldMessage(null, tempId, media);
      } catch (err) {
        if (err.message !== "Upload cancelled") {
          Alert.alert("Upload Failed", err.message || "Failed to send media");
          setMessages((prev) =>
            prev.filter(
              (m) => (!m.uploadProgress && m.uploadProgress !== 0) || m.id,
            ),
          );
        }
      } finally {
        setIsUploading(false);
      }
    },
    [user],
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
      sender_id: user.id,
      sender_name: user.name,
      sender_avatar: user.avatar_seed || user.name,
      content: null,
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

      const media = {
        url: result.url,
        mediaType: "audio",
        duration: result.duration,
        mimeType: result.mimeType,
        size: result.size,
      };

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

      signalingClient.sendWorldMessage(null, tempId, media);
    } catch (err) {
      console.error("Voice upload failed:", err);
      setMessages((prev) => prev.filter((m) => m.tempId !== tempId));
    }
  };

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

      const liveProf = profileUpdates?.get(item.sender_id) || null;
      const rawAvatar = liveProf?.avatarUrl
        ? `${liveProf.avatarUrl}?t=${liveProf.timestamp}`
        : item.sender_avatar;
      const avatarUri = rawAvatar?.startsWith("http")
        ? rawAvatar
        : `${AVATAR_BASE}${encodeURIComponent(item.sender_name)}`;

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
                <Image source={{ uri: avatarUri }} style={styles.avatar} />
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
                item.media_url && styles.bubbleMedia,
              ]}
            >
              {/* Media Content */}
              {item.media_url && item.media_type === "audio" ? (
                <VoiceBubble
                  uri={item.media_url}
                  duration={item.media_duration}
                  isMine={isMine}
                  isUploading={
                    item.uploadProgress !== undefined && item.uploadProgress < 1
                  }
                />
              ) : (
                item.media_url && (
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() =>
                      setViewerMedia({
                        url: item.media_url,
                        type: item.media_type,
                        thumbnail: item.media_thumbnail,
                        sender: item.sender_name,
                        time: item.created_at,
                      })
                    }
                    style={styles.inlineMedia}
                  >
                    {item.uploadProgress !== undefined &&
                      item.uploadProgress < 1 && (
                        <View style={styles.uploadOverlay}>
                          <ActivityIndicator size="small" color="#fff" />
                          <Text style={styles.uploadText}>
                            {Math.round(item.uploadProgress * 100)}%
                          </Text>
                        </View>
                      )}
                    <Image
                      source={{
                        uri:
                          item.media_type === "video" && item.media_thumbnail
                            ? item.media_thumbnail
                            : item.media_url,
                      }}
                      style={styles.inlineMediaImage}
                      resizeMode="cover"
                    />
                    {item.media_type === "video" && (
                      <View style={styles.playOverlay}>
                        <View style={styles.playButton}>
                          <Icon name="play" size={20} color="#fff" />
                        </View>
                      </View>
                    )}
                  </TouchableOpacity>
                )
              )}
              {item.content && (
                <Text
                  style={[
                    styles.bubbleText,
                    isMine ? styles.bubbleTextMine : styles.bubbleTextTheirs,
                    item.media_url && styles.captionText,
                  ]}
                >
                  {item.content}
                </Text>
              )}
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
                  onChangeText={setInputText}
                  placeholder="Yell into the void..."
                  placeholderTextColor={colors.textMuted}
                  multiline
                  maxLength={1000}
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

      {/* Attachment Bottom Sheet */}
      <Modal
        visible={showAttachMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAttachMenu(false)}
      >
        <TouchableOpacity
          style={styles.attachOverlay}
          activeOpacity={1}
          onPress={() => setShowAttachMenu(false)}
        >
          <View style={styles.attachSheet}>
            <View style={styles.attachHandle} />
            <Text style={styles.attachTitle}>Send Media</Text>
            <View style={styles.attachOptions}>
              <TouchableOpacity
                style={styles.attachOption}
                onPress={() => handleMediaPick("image", "gallery")}
              >
                <View style={[styles.attachIcon, { backgroundColor: "#000" }]}>
                  <Icon name="image" size={22} color="#fff" />
                </View>
                <Text style={styles.attachLabel}>Photo</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.attachOption}
                onPress={() => handleMediaPick("video", "gallery")}
              >
                <View style={[styles.attachIcon, { backgroundColor: "#000" }]}>
                  <Icon name="film" size={22} color="#fff" />
                </View>
                <Text style={styles.attachLabel}>Video</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.attachOption}
                onPress={() => handleMediaPick("image", "camera")}
              >
                <View style={[styles.attachIcon, { backgroundColor: "#000" }]}>
                  <Icon name="camera" size={22} color="#fff" />
                </View>
                <Text style={styles.attachLabel}>Camera</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Full-Screen Media Viewer */}
      {viewerMedia && (
        <MediaViewer
          visible={!!viewerMedia}
          onClose={() => setViewerMedia(null)}
          mediaUrl={viewerMedia.url}
          mediaType={viewerMedia.type}
          thumbnailUrl={viewerMedia.thumbnail}
          senderName={viewerMedia.sender}
          timestamp={viewerMedia.time}
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
  attachOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  attachSheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingTop: 12,
    paddingBottom: 40,
  },
  attachHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: "center",
    marginBottom: 16,
  },
  attachTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 20,
  },
  attachOptions: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  attachOption: {
    alignItems: "center",
  },
  attachIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },
  attachLabel: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: "500",
  },

  // Inline Media
  bubbleMedia: {
    paddingHorizontal: 4,
    paddingTop: 4,
    paddingBottom: 6,
    overflow: "hidden",
  },
  captionText: {
    paddingHorizontal: 10,
    paddingTop: 6,
  },
  inlineMedia: {
    width: 200,
    height: 160,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  inlineMediaImage: {
    width: "100%",
    height: "100%",
    borderRadius: 14,
  },
  uploadOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 5,
    borderRadius: 14,
  },
  uploadText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
    marginTop: 4,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  playButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    paddingLeft: 3,
  },
});
