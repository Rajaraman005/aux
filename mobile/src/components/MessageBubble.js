/**
 * MessageBubble — Memoized chat message bubble with media support.
 *
 * Renders:
 *   - Text-only messages
 *   - Image messages (with tap-to-fullscreen)
 *   - Video messages (thumbnail + play icon overlay)
 *   - Mixed messages (media + text caption)
 *   - Upload progress indicator for pending media
 *
 * Prevents re-renders on unrelated state changes via React.memo.
 */
import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import Icon from "react-native-vector-icons/Feather";
import { colors, spacing } from "../styles/theme";
import MediaViewer from "./MediaViewer";
import VoiceBubble from "./VoiceBubble";

// ─── Constants ──────────────────────────────────────────────────────────────
const MEDIA_MAX_WIDTH = 220;
const MEDIA_MAX_HEIGHT = 280;

function formatMessageTime(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Calculate aspect-ratio-preserving dimensions.
 */
function getMediaDimensions(width, height) {
  if (!width || !height) return { width: MEDIA_MAX_WIDTH, height: 160 };
  const aspect = width / height;
  let w = Math.min(width, MEDIA_MAX_WIDTH);
  let h = w / aspect;
  if (h > MEDIA_MAX_HEIGHT) {
    h = MEDIA_MAX_HEIGHT;
    w = h * aspect;
  }
  return { width: Math.round(w), height: Math.round(h) };
}

function formatDuration(seconds) {
  if (!seconds) return "";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function MessageBubble({ item, isMine }) {
  const [viewerVisible, setViewerVisible] = useState(false);
  const hasMedia = !!item.media_url;
  const hasText = !!item.content;
  const isVideo = item.media_type === "video";

  const mediaDims = hasMedia
    ? getMediaDimensions(item.media_width, item.media_height)
    : null;

  const openViewer = useCallback(() => setViewerVisible(true), []);
  const closeViewer = useCallback(() => setViewerVisible(false), []);

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
          hasMedia && item.media_type !== "audio" && styles.bubbleMedia,
        ]}
      >
        {/* ─── Media Content ──────────────────────────────────────── */}
        {hasMedia && item.media_type === "audio" ? (
          <VoiceBubble
            uri={item.media_url}
            duration={item.media_duration}
            isMine={isMine}
            isUploading={
              item.uploadProgress !== undefined && item.uploadProgress < 1
            }
            footer={
              <View
                style={[
                  styles.bubbleFooter,
                  { marginTop: 0, paddingHorizontal: 0 },
                ]}
              >
                <Text
                  style={[styles.bubbleTime, isMine && styles.bubbleTimeMine]}
                >
                  {formatMessageTime(item.created_at)}
                </Text>
                {item.pending && (
                  <Icon
                    name="clock"
                    size={10}
                    color={colors.textMuted}
                    style={styles.pendingIcon}
                  />
                )}
              </View>
            }
          />
        ) : (
          hasMedia && (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={openViewer}
              style={[styles.mediaContainer, mediaDims]}
            >
              {/* Upload Progress Overlay */}
              {item.uploadProgress !== undefined && item.uploadProgress < 1 && (
                <View style={styles.uploadOverlay}>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.uploadText}>
                    {Math.round(item.uploadProgress * 100)}%
                  </Text>
                </View>
              )}

              {/* Image / Video Thumbnail */}
              <Image
                source={{
                  uri:
                    isVideo && item.media_thumbnail
                      ? item.media_thumbnail
                      : item.media_url,
                }}
                style={[styles.mediaImage, mediaDims]}
                resizeMode="cover"
              />

              {/* Video Play Button Overlay */}
              {isVideo && (
                <View style={styles.playOverlay}>
                  <View style={styles.playButton}>
                    <Icon name="play" size={24} color="#fff" />
                  </View>
                  {item.media_duration > 0 && (
                    <View style={styles.durationBadge}>
                      <Text style={styles.durationText}>
                        {formatDuration(item.media_duration)}
                      </Text>
                    </View>
                  )}
                </View>
              )}
            </TouchableOpacity>
          )
        )}

        {/* ─── Text Content ───────────────────────────────────────── */}
        {hasText && (
          <Text
            style={[
              styles.bubbleText,
              isMine ? styles.bubbleTextMine : styles.bubbleTextTheirs,
              hasMedia && styles.captionText,
            ]}
          >
            {item.content}
          </Text>
        )}

        {/* ─── Footer (time + pending) ────────────────────────────── */}
        {!(hasMedia && item.media_type === "audio") && (
          <View style={styles.bubbleFooter}>
            <Text style={[styles.bubbleTime, isMine && styles.bubbleTimeMine]}>
              {formatMessageTime(item.created_at)}
            </Text>
            {item.pending && (
              <Icon
                name="clock"
                size={10}
                color={colors.textMuted}
                style={styles.pendingIcon}
              />
            )}
          </View>
        )}
      </View>

      {/* ─── Full-Screen Media Viewer ─────────────────────────────── */}
      {hasMedia && (
        <MediaViewer
          visible={viewerVisible}
          onClose={closeViewer}
          mediaUrl={item.media_url}
          mediaType={item.media_type}
          thumbnailUrl={item.media_thumbnail}
          timestamp={item.created_at}
        />
      )}
    </View>
  );
}

// ─── Memoization ────────────────────────────────────────────────────────────
function areEqual(prevProps, nextProps) {
  const p = prevProps.item;
  const n = nextProps.item;
  return (
    p.id === n.id &&
    p.tempId === n.tempId &&
    p.pending === n.pending &&
    p.content === n.content &&
    p.media_url === n.media_url &&
    p.uploadProgress === n.uploadProgress &&
    prevProps.isMine === nextProps.isMine
  );
}

export default React.memo(MessageBubble, areEqual);

// ─── Styles ─────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
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
  bubbleMedia: {
    paddingHorizontal: 4,
    paddingTop: 4,
    paddingBottom: 6,
    overflow: "hidden",
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
  captionText: {
    paddingHorizontal: 10,
    paddingTop: 6,
  },
  bubbleFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 4,
    paddingHorizontal: 6,
  },
  bubbleTime: {
    fontSize: 11,
    color: colors.textMuted,
  },
  bubbleTimeMine: {
    color: "rgba(255, 255, 255, 0.6)",
  },
  pendingIcon: {
    marginLeft: 4,
  },

  // Media
  mediaContainer: {
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  mediaImage: {
    borderRadius: 14,
  },

  // Upload Progress
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

  // Video Overlay
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  playButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    paddingLeft: 4,
  },
  durationBadge: {
    position: "absolute",
    bottom: 8,
    right: 8,
    backgroundColor: "rgba(0,0,0,0.65)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  durationText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
  },
});
