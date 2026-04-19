/**
 * MediaViewer — Full-screen media viewer with zoom support.
 *
 * Delegates image zoom/pan/tap to ZoomableImage component.
 * Handles: Modal lifecycle, header, video playback, safe areas.
 *
 * GestureHandlerRootView is inside the Modal for Android compatibility.
 * ZoomableImage does NOT include its own GestureHandlerRootView.
 */
import React, { useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Dimensions,
  ActivityIndicator,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import { Video, ResizeMode } from "expo-av";
import ZoomableImage from "./ZoomableImage";

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

  const handleModalShow = useCallback(() => {
    setIsLoading(true);
  }, []);

  const togglePlayback = useCallback(async () => {
    if (!videoRef.current) return;
    if (videoStatus.isPlaying) {
      await videoRef.current.pauseAsync();
    } else {
      await videoRef.current.playAsync();
    }
  }, [videoStatus.isPlaying]);

  const formatDuration = (ms) => {
    if (!ms) return "0:00";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      onShow={handleModalShow}
    >
      <GestureHandlerRootView style={styles.container}>
        <View style={styles.container}>
          {/* ─── Media Layer (Full Screen) ─────────────────────────── */}
          <View style={StyleSheet.absoluteFill}>
            {mediaType === "video" ? (
              <View style={styles.fullScreenMedia}>
                {isLoading && (
                  <View style={styles.loader}>
                    <ActivityIndicator size="large" color="#fff" />
                  </View>
                )}
                <TouchableOpacity
                  activeOpacity={1}
                  onPress={togglePlayback}
                  style={StyleSheet.absoluteFill}
                >
                  <Video
                    ref={videoRef}
                    source={{ uri: mediaUrl }}
                    style={StyleSheet.absoluteFill}
                    resizeMode={ResizeMode.CONTAIN}
                    shouldPlay
                    useNativeControls
                    onPlaybackStatusUpdate={setVideoStatus}
                    onLoad={() => setIsLoading(false)}
                    posterSource={thumbnailUrl ? { uri: thumbnailUrl } : undefined}
                    usePoster={!!thumbnailUrl}
                  />
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.fullScreenMedia}>
                {isLoading && (
                  <View style={styles.loader}>
                    <ActivityIndicator size="large" color="#fff" />
                  </View>
                )}
                <ZoomableImage
                  uri={mediaUrl}
                  onDismiss={onClose}
                  onLoad={handleImageLoad}
                />
              </View>
            )}
          </View>

          {/* ─── UI Overlay ────────────────────────────────────────── */}
          <View style={styles.overlay} pointerEvents="box-none">
            {/* Header */}
            <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
              <TouchableOpacity
                onPress={onClose}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityLabel="Close viewer"
                accessibilityRole="button"
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

            {/* Video Progress */}
            {mediaType === "video" && videoStatus.durationMillis > 0 && (
              <View style={[styles.videoInfo, { paddingBottom: insets.bottom + 8 }]}>
                <Text style={styles.videoTime}>
                  {formatDuration(videoStatus.positionMillis)} /{" "}
                  {formatDuration(videoStatus.durationMillis)}
                </Text>
              </View>
            )}
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.95)",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "space-between",
    zIndex: 10,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
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
  fullScreenMedia: {
    flex: 1,
    width: "100%",
  },
  loader: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 5,
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