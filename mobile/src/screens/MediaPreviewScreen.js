/**
 * MediaPreviewScreen — WhatsApp-style premium media preview before sending.
 *
 * Flow:
 *   1. ChatScreen navigates here instantly with pickType + pickSource
 *   2. This screen opens the system picker on mount (no delay)
 *   3. If user cancels picker → auto-goBack
 *   4. If user picks media → shows full-screen preview with caption/crop/send
 *
 * Navigation params:
 *   - pickType: 'image' | 'video'
 *   - pickSource: 'gallery' | 'camera'
 *   - conversationId: string
 *   - preselectedAssets: (optional) already-picked assets from ChatScreen
 *
 * Emits DeviceEventEmitter "media-preview-send" on send.
 * NO function params — avoids React Navigation non-serializable warning.
 */
import React, { useState, useRef, useCallback, useEffect, memo } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  FlatList,
  Platform,
  ActivityIndicator,
  DeviceEventEmitter,
} from "react-native";
import Animated, {
  FadeIn,
  SlideInDown,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import { Image } from "expo-image";
import { Video, ResizeMode } from "expo-av";
import * as ImagePicker from "expo-image-picker";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";

// ─── Picker helpers (inline — no waiting for mediaService round-trip) ────────
async function openPicker(type, source) {
  const mediaTypes = type === "video" ? ["videos"] : ["images"];

  if (source === "camera") {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") return null;
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes,
      allowsEditing: false,
      videoMaxDuration: 60,
    });
    if (result.canceled || !result.assets?.length) return null;
    return result.assets;
  }

  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== "granted") return null;
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes,
    allowsEditing: false,
    videoMaxDuration: 60,
  });
  if (result.canceled || !result.assets?.length) return null;
  return result.assets;
}

function normalizeAssets(rawAssets) {
  return rawAssets.map((a) => ({
    uri: a.uri,
    width: a.width,
    height: a.height,
    fileSize: a.fileSize || 0,
    mimeType: a.mimeType || (a.type === "video" ? "video/mp4" : "image/jpeg"),
    duration: a.duration ? a.duration / 1000 : 0,
    type: a.type === "video" ? "video" : "image",
  }));
}

export default function MediaPreviewScreen({ route, navigation }) {
  const { pickType, pickSource, preselectedAssets, conversationId } =
    route.params;
  const insets = useSafeAreaInsets();
  const { height: kbHeight } = useReanimatedKeyboardAnimation();

  // Initialize with pre-selected assets immediately — no black screen
  const [assets, setAssets] = useState(
    preselectedAssets ? normalizeAssets(preselectedAssets) : [],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [caption, setCaption] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false); // Only true if we need to open picker
  const videoRef = useRef(null);
  const didPickRef = useRef(false);

  const activeAsset = assets[activeIndex] || null;
  const isVideo = activeAsset?.type === "video";

  const bottomAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: kbHeight.value }],
  }));

  // ─── Open picker immediately on mount if no preselected assets ──
  useEffect(() => {
    if (preselectedAssets) {
      // If preselectedAssets are provided, we don't need to open the picker.
      // If assets are empty despite preselectedAssets being provided, navigate back.
      if (assets.length === 0) navigation.goBack();
      return;
    }

    // If no preselectedAssets, proceed with opening the picker
    if (didPickRef.current) return;
    didPickRef.current = true;
    setIsPickerOpen(true); // Indicate picker is opening

    (async () => {
      try {
        const picked = await openPicker(pickType, pickSource);
        if (!picked || picked.length === 0) {
          // User cancelled the picker → go back
          navigation.goBack();
          return;
        }
        setAssets(normalizeAssets(picked));
      } catch (err) {
        console.error("openPicker error", err);
        navigation.goBack();
      } finally {
        setIsPickerOpen(false); // Picker has closed
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Add more media ───────────────────────────────────────────────
  const handleAddMore = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: 10 - assets.length,
    });
    if (result.canceled || !result.assets?.length) return;
    setAssets((prev) => [...prev, ...normalizeAssets(result.assets)]);
  }, [assets.length]);

  // ─── Remove current ───────────────────────────────────────────────
  const handleRemoveCurrent = useCallback(() => {
    if (assets.length <= 1) {
      navigation.goBack();
      return;
    }
    const newLen = assets.length - 1;
    setAssets((prev) => prev.filter((_, i) => i !== activeIndex));
    setActiveIndex((prev) => Math.min(prev, newLen - 1));
  }, [assets, activeIndex, navigation]);

  // ─── Crop / Edit ──────────────────────────────────────────────────
  const handleCrop = useCallback(() => {
    if (!activeAsset || isVideo) return;
    // Use DeviceEventEmitter for image editor results (avoids non-serializable function in params)
    const editorSubscription = DeviceEventEmitter.addListener(
      "image-editor-complete",
      ({ uri }) => {
        editorSubscription.remove();
        setAssets((prev) =>
          prev.map((a, i) =>
            i === activeIndex ? { ...a, uri } : a,
          ),
        );
      },
    );
    navigation.navigate("ImageEditor", {
      imageUri: activeAsset.uri,
      conversationId,
    });
  }, [activeAsset, activeIndex, isVideo, navigation, conversationId]);

  // ─── Send ─────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (isSending || !assets.length) return;
    setIsSending(true);

    // Small delay to allow UI to show loading state
    await new Promise(resolve => setTimeout(resolve, 100));

    // Always use DeviceEventEmitter (no non-serializable function in route params)
    DeviceEventEmitter.emit("media-preview-send", {
      targetConversationId: conversationId,
      mediaAssets: assets,
      caption: caption.trim(),
    });

    // Navigate back after a brief delay to ensure event is emitted
    setTimeout(() => {
      navigation.goBack();
    }, 50);
  }, [assets, caption, isSending, navigation, conversationId]);

  // ─── Thumbnail render (optimized with memo) ─────────────────────
  const renderThumbnail = useCallback(
    ({ item, index }) => {
      const isActive = index === activeIndex;
      return (
        <TouchableOpacity
          onPress={() => setActiveIndex(index)}
          activeOpacity={0.8}
          style={[styles.thumbnailWrap, isActive && styles.thumbnailActive]}
        >
          <Image
            source={{ uri: item.uri }}
            style={styles.thumbnailImg}
            contentFit="cover"
            cachePolicy="memory-disk"
            priority={isActive ? "high" : "low"}
            transition={200}
          />
          {item.type === "video" && (
            <View style={styles.thumbnailVideoIcon}>
              <Icon name="play" size={10} color="#fff" />
            </View>
          )}
          {isActive && <View style={styles.thumbnailBorder} />}
        </TouchableOpacity>
      );
    },
    [activeIndex],
  );

  // ─── Loading state while picker is open ───────────────────────────
  if (isPickerOpen || assets.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <StatusBar
          barStyle="light-content"
          backgroundColor="#000"
          translucent
        />
        <ActivityIndicator size="large" color="rgba(255,255,255,0.5)" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar
        barStyle="light-content"
        backgroundColor="transparent"
        translucent
      />

      {/* ─── Media Layer (Full Screen) ─────────────────────────── */}
      <View style={styles.mediaContainer}>
        {isVideo ? (
          <Video
            key={`video_${activeAsset.uri}`}
            ref={videoRef}
            source={{ uri: activeAsset.uri }}
            style={StyleSheet.absoluteFill}
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay={false}
            isLooping={false}
            isMuted={true}
            useNativeControls={true}
            onLoad={() => {
              // Auto-play once loaded for better UX
              if (videoRef.current) {
                videoRef.current.playAsync();
              }
            }}
          />
        ) : (
          <Image
            key={`img_${activeAsset.uri}`}
            source={{ uri: activeAsset.uri }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            transition={200}
            cachePolicy="memory-disk"
            priority="high"
          />
        )}
      </View>

      {/* ─── Top Bar ─────────────────────────────────────────────── */}
      <Animated.View
        entering={FadeIn.duration(200)}
        style={[styles.topBar, { paddingTop: insets.top + 8 }]}
      >
        <TouchableOpacity
          style={styles.topBtn}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Icon name="x" size={22} color="#fff" />
        </TouchableOpacity>

        <View style={styles.topRight}>
          {!isVideo && (
            <TouchableOpacity
              style={styles.topBtn}
              onPress={handleCrop}
              activeOpacity={0.7}
            >
              <Icon name="crop" size={20} color="#fff" />
            </TouchableOpacity>
          )}
          {assets.length > 1 && (
            <TouchableOpacity
              style={styles.topBtn}
              onPress={handleRemoveCurrent}
              activeOpacity={0.7}
            >
              <Icon name="trash-2" size={20} color="#FF6B6B" />
            </TouchableOpacity>
          )}
        </View>
      </Animated.View>

      {/* ─── Main Preview UI Overlay ────────────────────────────── */}
      <Animated.View
        entering={FadeIn.duration(250)}
        style={[styles.previewArea, bottomAnimStyle]}
        pointerEvents="box-none"
      >
        <View style={{ flex: 1 }} pointerEvents="none" />

        {/* Media count badge */}
        {assets.length > 1 && (
          <View style={styles.countBadge}>
            <Text style={styles.countText}>
              {activeIndex + 1} / {assets.length}
            </Text>
          </View>
        )}

        {/* Thumbnail Strip */}
        {assets.length > 1 && (
          <Animated.View
            entering={SlideInDown.duration(300)}
            style={styles.thumbnailStrip}
          >
            <FlatList
              data={assets}
              renderItem={renderThumbnail}
              keyExtractor={(_, i) => `thumb_${i}_${assets.length}`}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.thumbnailList}
              windowSize={5}
              maxToRenderPerBatch={10}
              initialNumToRender={10}
              updateCellsBatchingPeriod={50}
              removeClippedSubviews={Platform.OS === "android"}
            />
          </Animated.View>
        )}

        {/* ─── Bottom Bar ────────────────────────────────────────── */}
        <View
          style={[
            styles.bottomBar,
            { paddingBottom: Math.max(insets.bottom, 12) },
          ]}
        >
          <TouchableOpacity
            style={styles.addMoreBtn}
            onPress={handleAddMore}
            activeOpacity={0.7}
            disabled={assets.length >= 10}
          >
            <Icon
              name="plus"
              size={20}
              color={assets.length >= 10 ? "rgba(255,255,255,0.3)" : "#fff"}
            />
          </TouchableOpacity>

          <View style={styles.captionWrap}>
            <TextInput
              style={styles.captionInput}
              value={caption}
              onChangeText={setCaption}
              placeholder="Add a caption..."
              placeholderTextColor="rgba(255,255,255,0.4)"
              multiline
              maxLength={1000}
              textAlignVertical="center"
            />
          </View>

          <TouchableOpacity
            style={[styles.sendBtn, isSending && styles.sendBtnDisabled]}
            onPress={handleSend}
            activeOpacity={0.85}
            disabled={isSending}
          >
            {isSending ? (
              <ActivityIndicator size="small" color="#000" />
            ) : (
              <Icon name="send" size={20} color="#000" />
            )}
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  loadingContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
  },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    zIndex: 10,
  },
  topRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  topBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  previewArea: {
    flex: 1,
    justifyContent: "flex-end",
    zIndex: 5,
  },
  mediaContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
  },
  countBadge: {
    position: "absolute",
    top: 8,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
  },
  countText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  thumbnailStrip: {
    paddingVertical: 10,
  },
  thumbnailList: {
    paddingHorizontal: 16,
    gap: 8,
  },
  thumbnailWrap: {
    width: 56,
    height: 56,
    borderRadius: 10,
    overflow: "hidden",
    position: "relative",
  },
  thumbnailActive: {
    transform: [{ scale: 1.05 }],
  },
  thumbnailImg: {
    width: "100%",
    height: "100%",
  },
  thumbnailBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 10,
    borderWidth: 2.5,
    borderColor: "#fff",
  },
  thumbnailVideoIcon: {
    position: "absolute",
    bottom: 3,
    right: 3,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  bottomBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingTop: 10,
    backgroundColor: "rgba(0,0,0,0.85)",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.1)",
  },
  addMoreBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
    marginBottom: 2,
  },
  captionWrap: {
    flex: 1,
    marginRight: 10,
  },
  captionInput: {
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 10 : 8,
    fontSize: 15,
    color: "#fff",
    maxHeight: 100,
    minHeight: 42,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.15)",
  },
  sendBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#fff",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 6,
  },
  sendBtnDisabled: {
    opacity: 0.6,
  },
});
