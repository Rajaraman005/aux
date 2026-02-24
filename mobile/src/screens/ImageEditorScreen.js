/**
 * ImageEditorScreen — Custom avatar editor with crop, zoom, rotate, flip.
 *
 * Architecture:
 *   - Gesture Handler for pan/pinch (60fps, native thread)
 *   - Reanimated for smooth transform animations
 *   - Square mask overlay for avatar preview
 *   - Client-side processing via expo-image-manipulator
 *   - Aspect-ratio-aware sizing: image fills crop width, height scales proportionally
 *
 * Navigation params:
 *   - imageUri: string — source image URI
 *   - onComplete: (editedUri: string) => void — callback via route params
 */
import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  StatusBar,
  Image as RNImage,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "react-native-vector-icons/Feather";
import { Image } from "expo-image";
import * as ImageManipulator from "expo-image-manipulator";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const CROP_SIZE = SCREEN_WIDTH - 16;
const CROP_HEIGHT = CROP_SIZE + 60;
const MIN_SCALE = 1;
const MAX_SCALE = 5;

export default function ImageEditorScreen({ route, navigation }) {
  const { imageUri, onComplete } = route.params;
  const insets = useSafeAreaInsets();

  const [processing, setProcessing] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [imgSize, setImgSize] = useState({ w: CROP_SIZE, h: CROP_HEIGHT });

  // Get actual image dimensions so we can size it properly
  useEffect(() => {
    RNImage.getSize(
      imageUri,
      (w, h) => {
        // Scale image so it fills the crop width; height is proportional
        const displayW = CROP_SIZE;
        const displayH = (h / w) * CROP_SIZE;
        setImgSize({ w: displayW, h: Math.max(displayH, CROP_HEIGHT) });
      },
      () => {
        // Fallback: assume square
        setImgSize({ w: CROP_SIZE, h: CROP_HEIGHT });
      },
    );
  }, [imageUri]);

  // Gesture shared values
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  // Clamp translation so image edges stay within the crop area
  const clampTranslation = useCallback((imgW, imgH) => {
    "worklet";
    const s = scale.value;
    const scaledW = imgW * s;
    const scaledH = imgH * s;

    // How much the image overflows the crop area on each side
    const overflowX = Math.max(0, (scaledW - CROP_SIZE) / 2);
    const overflowY = Math.max(0, (scaledH - CROP_HEIGHT) / 2);

    if (translateX.value > overflowX) {
      translateX.value = withTiming(overflowX, { duration: 200 });
    } else if (translateX.value < -overflowX) {
      translateX.value = withTiming(-overflowX, { duration: 200 });
    }

    if (translateY.value > overflowY) {
      translateY.value = withTiming(overflowY, { duration: 200 });
    } else if (translateY.value < -overflowY) {
      translateY.value = withTiming(-overflowY, { duration: 200 });
    }
  }, []);

  // Pinch gesture
  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      const newScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, savedScale.value * e.scale),
      );
      scale.value = newScale;
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value < MIN_SCALE) {
        scale.value = withTiming(MIN_SCALE, { duration: 200 });
        savedScale.value = MIN_SCALE;
      }
      clampTranslation(imgSize.w, imgSize.h);
    });

  // Pan gesture
  const panGesture = Gesture.Pan()
    .minPointers(1)
    .onUpdate((e) => {
      translateX.value = savedTranslateX.value + e.translationX;
      translateY.value = savedTranslateY.value + e.translationY;
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      clampTranslation(imgSize.w, imgSize.h);
    });

  const composedGesture = Gesture.Simultaneous(pinchGesture, panGesture);

  const imageAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // Rotate 90 degrees
  const handleRotate = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360);
    scale.value = withTiming(1, { duration: 200 });
    savedScale.value = 1;
    translateX.value = withTiming(0, { duration: 200 });
    translateY.value = withTiming(0, { duration: 200 });
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  }, []);

  // Flip horizontal
  const handleFlipH = useCallback(() => {
    setFlipH((prev) => !prev);
  }, []);

  // Flip vertical
  const handleFlipV = useCallback(() => {
    setFlipV((prev) => !prev);
  }, []);

  // Reset all transforms
  const handleReset = useCallback(() => {
    scale.value = withTiming(1, { duration: 200 });
    savedScale.value = 1;
    translateX.value = withTiming(0, { duration: 200 });
    translateY.value = withTiming(0, { duration: 200 });
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    setRotation(0);
    setFlipH(false);
    setFlipV(false);
  }, []);

  // Apply edits and return
  const handleDone = useCallback(async () => {
    setProcessing(true);
    try {
      const s = scale.value;
      const panX = translateX.value;
      const panY = translateY.value;

      const actions = [];

      // Apply rotation
      if (rotation !== 0) {
        actions.push({ rotate: rotation });
      }

      // Apply flips
      if (flipH) actions.push({ flip: ImageManipulator.FlipType.Horizontal });
      if (flipV) actions.push({ flip: ImageManipulator.FlipType.Vertical });

      // Resize to working size
      const workingSize = 1024;
      const workingH = Math.round(workingSize * (imgSize.h / imgSize.w));
      actions.push({ resize: { width: workingSize, height: workingH } });

      // Calculate crop in working-size coordinates
      const cropW = Math.round(workingSize / s);
      const cropH = Math.round(((CROP_HEIGHT / CROP_SIZE) * workingSize) / s);

      const panFractionX = panX / CROP_SIZE;
      const panFractionY = panY / CROP_HEIGHT;

      const originX = Math.max(
        0,
        Math.min(
          workingSize - cropW,
          Math.round(workingSize / 2 - cropW / 2 - panFractionX * cropW),
        ),
      );
      const originY = Math.max(
        0,
        Math.min(
          workingH - cropH,
          Math.round(workingH / 2 - cropH / 2 - panFractionY * cropH),
        ),
      );

      actions.push({
        crop: {
          originX,
          originY,
          width: Math.min(cropW, workingSize - originX),
          height: Math.min(cropH, workingH - originY),
        },
      });

      // Final resize to avatar dimensions
      actions.push({ resize: { width: 512, height: 512 } });

      const result = await ImageManipulator.manipulateAsync(imageUri, actions, {
        compress: 0.8,
        format: ImageManipulator.SaveFormat.JPEG,
      });

      if (onComplete) {
        onComplete(result.uri);
      }
      navigation.goBack();
    } catch (err) {
      console.error("Image processing error:", err);
      setProcessing(false);
    }
  }, [imageUri, rotation, flipH, flipV, navigation, onComplete, imgSize]);

  return (
    <GestureHandlerRootView style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Icon name="x" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Edit Photo</Text>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={handleReset}
          activeOpacity={0.7}
        >
          <Icon name="refresh-cw" size={18} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Canvas Area */}
      <View style={styles.canvasArea}>
        <GestureDetector gesture={composedGesture}>
          <Animated.View style={styles.gestureContainer}>
            {/* The image layer — gesture transforms applied to wrapper */}
            <Animated.View style={[styles.imageWrapper, imageAnimatedStyle]}>
              <Image
                source={{ uri: imageUri }}
                style={[
                  {
                    width: imgSize.w,
                    height: imgSize.h,
                    transform: [
                      { rotate: `${rotation}deg` },
                      { scaleX: flipH ? -1 : 1 },
                      { scaleY: flipV ? -1 : 1 },
                    ],
                  },
                ]}
                contentFit="cover"
              />
            </Animated.View>

            {/* Square mask overlay */}
            <View style={styles.maskContainer} pointerEvents="none">
              {/* Top bar */}
              <View
                style={[
                  styles.maskBar,
                  {
                    height: (SCREEN_HEIGHT - CROP_HEIGHT) / 2 - 120,
                    width: SCREEN_WIDTH,
                  },
                ]}
              />
              {/* Middle row with side bars and square cutout */}
              <View style={styles.maskMiddleRow}>
                <View
                  style={[styles.maskBar, { width: 8, height: CROP_HEIGHT }]}
                />
                <View style={styles.cropSquare} />
                <View
                  style={[styles.maskBar, { width: 8, height: CROP_HEIGHT }]}
                />
              </View>
              {/* Bottom bar */}
              <View
                style={[styles.maskBar, { flex: 1, width: SCREEN_WIDTH }]}
              />
            </View>
          </Animated.View>
        </GestureDetector>

        {/* Instruction */}
        <Text style={styles.instruction}>Pinch to zoom, drag to position</Text>
      </View>

      {/* Bottom Controls */}
      <View
        style={[styles.bottomControls, { paddingBottom: insets.bottom + 16 }]}
      >
        {/* Tools row */}
        <View style={styles.toolsRow}>
          <TouchableOpacity
            style={styles.toolBtn}
            onPress={handleFlipH}
            activeOpacity={0.7}
          >
            <Icon
              name="minimize-2"
              size={20}
              color={flipH ? "#4FC3F7" : "#fff"}
            />
            <Text style={[styles.toolLabel, flipH && { color: "#4FC3F7" }]}>
              Flip H
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.toolBtn}
            onPress={handleRotate}
            activeOpacity={0.7}
          >
            <Icon name="rotate-cw" size={20} color="#fff" />
            <Text style={styles.toolLabel}>Rotate</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.toolBtn}
            onPress={handleFlipV}
            activeOpacity={0.7}
          >
            <Icon
              name="minimize-2"
              size={20}
              color={flipV ? "#4FC3F7" : "#fff"}
              style={{ transform: [{ rotate: "90deg" }] }}
            />
            <Text style={[styles.toolLabel, flipV && { color: "#4FC3F7" }]}>
              Flip V
            </Text>
          </TouchableOpacity>
        </View>

        {/* Action buttons */}
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.doneBtn, processing && styles.doneBtnDisabled]}
            onPress={handleDone}
            disabled={processing}
            activeOpacity={0.85}
          >
            {processing ? (
              <ActivityIndicator color="#000" size="small" />
            ) : (
              <>
                <Icon name="check" size={18} color="#000" />
                <Text style={styles.doneText}>Done</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    zIndex: 10,
  },
  headerBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: "#fff",
    letterSpacing: -0.2,
  },

  // Canvas
  canvasArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  gestureContainer: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT - 280,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  imageWrapper: {
    alignItems: "center",
    justifyContent: "center",
  },

  // Mask overlay
  maskContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
  },
  maskBar: {
    backgroundColor: "rgba(0,0,0,0.65)",
  },
  maskMiddleRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  cropSquare: {
    width: CROP_SIZE,
    height: CROP_HEIGHT,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.6)",
  },
  instruction: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 13,
    marginTop: 16,
    fontWeight: "500",
  },

  // Bottom controls
  bottomControls: {
    paddingHorizontal: 24,
    paddingTop: 16,
    backgroundColor: "#000",
  },
  toolsRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginBottom: 20,
    gap: 32,
  },
  toolBtn: {
    alignItems: "center",
    gap: 6,
  },
  toolLabel: {
    fontSize: 11,
    color: "rgba(255,255,255,0.7)",
    fontWeight: "500",
  },

  // Actions
  actionRow: {
    flexDirection: "row",
    gap: 12,
  },
  cancelBtn: {
    flex: 1,
    height: 50,
    borderRadius: 25,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  doneBtn: {
    flex: 1,
    height: 50,
    borderRadius: 25,
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  doneBtnDisabled: {
    opacity: 0.6,
  },
  doneText: {
    color: "#000",
    fontSize: 16,
    fontWeight: "700",
  },
});
