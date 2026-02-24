/**
 * ProfilePictureViewer — Full-screen avatar popup.
 *
 * Features:
 *   - Background blur with dim overlay
 *   - Smooth scale-up entrance, smooth scale-down exit (no flicker)
 *   - Tap outside image to dismiss
 *   - Pinch to zoom
 *   - Cached image rendering via expo-image
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  Modal,
  TouchableOpacity,
  Pressable,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  runOnJS,
  Easing,
} from "react-native-reanimated";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import { BlurView } from "expo-blur";
import { Image } from "expo-image";
import Icon from "react-native-vector-icons/Feather";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const IMAGE_SIZE = SCREEN_WIDTH - 64;
const AVATAR_BASE = "https://api.dicebear.com/7.x/initials/png?seed=";

const ANIM_IN_MS = 180;
const ANIM_OUT_MS = 150;

export default function ProfilePictureViewer({
  visible,
  imageUri,
  userName,
  onClose,
}) {
  // Keep modal mounted until exit animation completes
  const [modalVisible, setModalVisible] = useState(false);

  const opacity = useSharedValue(0);
  const imageScale = useSharedValue(0.88);

  // Pinch to zoom
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);

  // ─── Open / Close lifecycle ────────────────────────────────────────────
  useEffect(() => {
    if (visible) {
      // Reset pinch zoom
      scale.value = 1;
      savedScale.value = 1;

      // Mount modal first, THEN animate in
      setModalVisible(true);
      // Small delay so first frame renders with 0 opacity
      requestAnimationFrame(() => {
        opacity.value = withTiming(1, {
          duration: ANIM_IN_MS,
          easing: Easing.out(Easing.cubic),
        });
        imageScale.value = withTiming(1, {
          duration: ANIM_IN_MS,
          easing: Easing.out(Easing.cubic),
        });
      });
    } else if (modalVisible) {
      // Animate out, THEN unmount
      opacity.value = withTiming(0, {
        duration: ANIM_OUT_MS,
        easing: Easing.in(Easing.cubic),
      });
      imageScale.value = withTiming(
        0.88,
        {
          duration: ANIM_OUT_MS,
          easing: Easing.in(Easing.cubic),
        },
        (finished) => {
          if (finished) {
            runOnJS(setModalVisible)(false);
          }
        },
      );
    }
  }, [visible]);

  const dismiss = useCallback(() => {
    onClose();
  }, [onClose]);

  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(4, Math.max(0.5, savedScale.value * e.scale));
    })
    .onEnd(() => {
      if (scale.value < 1) {
        scale.value = withSpring(1, { damping: 20 });
        savedScale.value = 1;
      } else {
        savedScale.value = scale.value;
      }
    });

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const imageContainerStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: imageScale.value * scale.value }],
  }));

  const uiElementStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const resolvedUri =
    imageUri || `${AVATAR_BASE}${encodeURIComponent(userName || "User")}`;

  if (!modalVisible) return null;

  return (
    <Modal
      visible={modalVisible}
      transparent
      animationType="none"
      onRequestClose={dismiss}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={styles.root}>
        {/* Blur backdrop — tap to dismiss */}
        <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismiss}>
            <BlurView
              intensity={40}
              tint="dark"
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.dimOverlay} />
          </Pressable>
        </Animated.View>

        {/* Close button */}
        <Animated.View style={[styles.closeContainer, uiElementStyle]}>
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={dismiss}
            activeOpacity={0.7}
          >
            <Icon name="x" size={22} color="#fff" />
          </TouchableOpacity>
        </Animated.View>

        {/* User name */}
        <Animated.View style={[styles.nameContainer, uiElementStyle]}>
          <Text style={styles.userName}>{userName || "User"}</Text>
        </Animated.View>

        {/* Image */}
        <GestureDetector gesture={pinchGesture}>
          <Animated.View style={[styles.imageContainer, imageContainerStyle]}>
            <Image
              source={{ uri: resolvedUri }}
              style={styles.image}
              contentFit="cover"
              cachePolicy="memory-disk"
              placeholder={null}
              transition={150}
            />
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  dimOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.6)",
  },

  // Close
  closeContainer: {
    position: "absolute",
    top: 60,
    right: 20,
    zIndex: 10,
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },

  // Name
  nameContainer: {
    position: "absolute",
    top: 65,
    left: 20,
    zIndex: 10,
  },
  userName: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
    letterSpacing: -0.2,
  },

  // Image
  imageContainer: {
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
    borderRadius: IMAGE_SIZE / 2,
    overflow: "hidden",
    backgroundColor: "#222",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 16,
  },
  image: {
    width: "100%",
    height: "100%",
  },
});
