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
 *
 * Emits DeviceEventEmitter "media-preview-send" on send.
 */
import React, { useState, useRef, useCallback, useEffect } from "react";
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
      quality: 0.8,
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
    quality: 0.8,
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
    mimeType:
      a.mimeType || (a.type === "video" ? "video/mp4" : "image/jpeg"),
    duration: a.duration ? a.duration / 1000 : 0,
    type: a.type === "video" ? "video" : "image",
  }));
}

export default function MediaPreviewScreen({ route, navigation }) {
  const { pickType, pickSource, conversationId } = route.params;
  const insets = useSafeAreaInsets();
  const { height: kbHeight } = useReanimatedKeyboardAnimation();

  const [assets, setAssets] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [caption, setCaption] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(true);
  const videoRef = useRef(null);
  const didPickRef = useRef(false);

  const activeAsset = assets[activeIndex] || null;
  const isVideo = activeAsset?.type === "video";

  const bottomAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: kbHeight.value }],
  }));

  // ─── Open picker immediately on mount ─────────────────────────────
  useEffect(() => {
    if (didPickRef.current) return;
    didPickRef.current = true;

    (async () => {
      const picked = await openPicker(pickType, pickSource);
      setIsPickerOpen(false);
      if (!picked || picked.length === 0) {
        // User cancelled the picker → go back
        navigation.goBack();
        return;
      }
      setAssets(normalizeAssets(picked));
    })();
  }, []);

  // ─── Add more media ───────────────────────────────────────────────
  const handleAddMore = useCallback(async () => {
    const { status } =
      await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: 10 - assets.length,
      quality: 0.8,
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
    navigation.navigate("ImageEditor", {
      imageUri: activeAsset.uri,
      onComplete: (editedUri) => {
        setAssets((prev) =>
          prev.map((a, i) =>
            i === activeIndex ? { ...a, uri: editedUri } : a,
          ),
        );
      },
    });
  }, [activeAsset, activeIndex, isVideo, navigation]);

  // ─── Send ─────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    if (isSending || !assets.length) return;
    setIsSending(true);
    DeviceEventEmitter.emit("media-preview-send", {
      targetConversationId: conversationId,
      mediaAssets: assets,
      caption: caption.trim(),
    });
    navigation.goBack();
  }, [assets, caption, isSending, navigation, conversationId]);

  // ─── Thumbnail item ───────────────────────────────────────────────
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
      <View style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#000" translucent={false} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000" translucent={false} />

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

      {/* ─── Main Preview ────────────────────────────────────────── */}
      <Animated.View
        entering={FadeIn.duration(250)}
        style={[styles.previewArea, bottomAnimStyle]}
      >
        <View style={styles.mediaContainer}>
          {isVideo ? (
            <Video
              key={activeAsset.uri}
              ref={videoRef}
              source={{ uri: activeAsset.uri }}
              style={StyleSheet.absoluteFill}
              resizeMode={ResizeMode.CONTAIN}
              shouldPlay
              isLooping
              isMuted={false}
              useNativeControls
            />
          ) : (
            <Image
              key={activeAsset.uri}
              source={{ uri: activeAsset.uri }}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              transition={150}
            />
          )}
        </View>

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
              keyExtractor={(_, i) => `thumb_${i}`}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.thumbnailList}
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
  topBar: {
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
    justifyContent: "space-between",
  },
  mediaContainer: {
    flex: 1,
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
