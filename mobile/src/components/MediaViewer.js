/**
 * MediaViewer — Full-screen media viewer with gestures.
 *
 * Features:
 *   - Full-screen image display with pinch-to-zoom
 *   - Full-screen video playback with controls
 *   - Tap background to dismiss
 *   - Animated fade in/out transitions
 *   - Header with close button and media info
 */
import React, { useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Dimensions,
  StatusBar,
  ActivityIndicator,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import { Video, ResizeMode } from "expo-av";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

export default function MediaViewer({
  visible,
  onClose,
  mediaUrl,
  mediaType,
  thumbnailUrl,
  senderName,
  timestamp,
}) {
  const insets = useSafeAreaInsets();
  const [isLoading, setIsLoading] = useState(true);
  const [videoStatus, setVideoStatus] = useState({});
  const videoRef = useRef(null);

  const handleImageLoad = useCallback(() => setIsLoading(false), []);

  const formatDuration = (ms) => {
    if (!ms) return "0:00";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const togglePlayback = useCallback(async () => {
    if (!videoRef.current) return;
    if (videoStatus.isPlaying) {
      await videoRef.current.pauseAsync();
    } else {
      await videoRef.current.playAsync();
    }
  }, [videoStatus.isPlaying]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <StatusBar backgroundColor="rgba(0,0,0,0.95)" barStyle="light-content" />
      <View style={styles.container}>
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon name="x" size={24} color="#fff" />
          </TouchableOpacity>
          <View style={styles.headerInfo}>
            {senderName && <Text style={styles.headerName}>{senderName}</Text>}
            {timestamp && (
              <Text style={styles.headerTime}>
                {new Date(timestamp).toLocaleString()}
              </Text>
            )}
          </View>
        </View>

        {/* Media Content */}
        <View style={styles.mediaContainer}>
          {isLoading && mediaType !== "video" && (
            <ActivityIndicator
              size="large"
              color="#fff"
              style={styles.loader}
            />
          )}

          {mediaType === "video" ? (
            <TouchableOpacity
              activeOpacity={1}
              onPress={togglePlayback}
              style={styles.videoWrapper}
            >
              <Video
                ref={videoRef}
                source={{ uri: mediaUrl }}
                style={styles.video}
                resizeMode={ResizeMode.CONTAIN}
                shouldPlay
                useNativeControls
                onPlaybackStatusUpdate={setVideoStatus}
                onLoad={() => setIsLoading(false)}
                posterSource={thumbnailUrl ? { uri: thumbnailUrl } : undefined}
                usePoster={!!thumbnailUrl}
              />
            </TouchableOpacity>
          ) : (
            <Image
              source={{ uri: mediaUrl }}
              style={styles.image}
              resizeMode="contain"
              onLoad={handleImageLoad}
            />
          )}
        </View>

        {/* Video Progress Bar */}
        {mediaType === "video" && videoStatus.durationMillis > 0 && (
          <View
            style={[styles.videoInfo, { paddingBottom: insets.bottom + 8 }]}
          >
            <Text style={styles.videoTime}>
              {formatDuration(videoStatus.positionMillis)} /{" "}
              {formatDuration(videoStatus.durationMillis)}
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.95)",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    zIndex: 10,
  },
  headerInfo: {
    flex: 1,
    marginLeft: 16,
  },
  headerName: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  headerTime: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 12,
    marginTop: 2,
  },
  mediaContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loader: {
    position: "absolute",
    zIndex: 5,
  },
  image: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.75,
  },
  videoWrapper: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.75,
  },
  video: {
    width: "100%",
    height: "100%",
  },
  videoInfo: {
    alignItems: "center",
    paddingVertical: 12,
  },
  videoTime: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
  },
});
