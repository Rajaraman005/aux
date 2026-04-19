/**
 * ZoomableImage — Production-grade zoomable image component.
 *
 * Pinch-to-zoom with focal point, double-tap with focal point,
 * pan with content-aware boundaries, swipe-down dismiss,
 * rubber-band overscroll, spring animations.
 *
 * Gesture composition:
 *   Exclusive(doubleTap, Simultaneous(pinch, pan))
 *
 * Uses onLayout to measure container and compute display dimensions
 * from aspect ratio — ensures image is always centered and visible.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Dimensions, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
  withTiming,
  cancelAnimation,
  runOnJS,
} from "react-native-reanimated";
import { Image } from "expo-image";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const DISMISS_THRESHOLD = 120;
const DISMISS_VELOCITY = 500;
const RUBBER_BAND_DECAY = 0.3;
const SPRING_CONFIG = { damping: 28, stiffness: 180, mass: 0.8 };
const DISMISS_SPRING = { damping: 20, stiffness: 300, mass: 0.8 };

function clamp(val, min, max) {
  "worklet";
  return Math.max(min, Math.min(max, val));
}

export default function ZoomableImage({ uri, simultaneousHandlers, onDismiss, onLoad }) {
  const scale = useSharedValue(MIN_SCALE);
  const savedScale = useSharedValue(MIN_SCALE);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);
  const opacity = useSharedValue(1);
  const containerWidth = useSharedValue(0);
  const containerHeight = useSharedValue(0);
  const displayWidth = useSharedValue(0);
  const displayHeight = useSharedValue(0);
  const isLayoutReady = useSharedValue(false);

  const isZoomed = useDerivedValue(() => scale.value > 1.01);

  const [measuredSize, setMeasuredSize] = useState({
    width: 0,
    height: 0,
  });

  useEffect(() => {
    cancelAnimation(scale);
    cancelAnimation(translateX);
    cancelAnimation(translateY);
    cancelAnimation(opacity);
    scale.value = MIN_SCALE;
    savedScale.value = MIN_SCALE;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    originX.value = 0;
    originY.value = 0;
    opacity.value = 1;
    if (isLayoutReady.value) {
      displayWidth.value = containerWidth.value;
      displayHeight.value = containerHeight.value;
      setMeasuredSize({ width: containerWidth.value, height: containerHeight.value });
    }
  }, [uri]);

  const handleLayout = useCallback(
    (event) => {
      const { width, height } = event.nativeEvent.layout;
      if (width > 0 && height > 0) {
        containerWidth.value = width;
        containerHeight.value = height;
        displayWidth.value = width;
        displayHeight.value = height;
        isLayoutReady.value = true;
        setMeasuredSize({ width, height });
      }
    },
    [],
  );

  const handleImageLoad = useCallback(
    (event) => {
      const { sourceWidth, sourceHeight } = event;
      if (sourceWidth && sourceHeight) {
        const aspect = sourceWidth / sourceHeight;
        const cW = containerWidth.value;
        const cH = containerHeight.value;
        // Fit image within container maintaining aspect ratio (contain behavior)
        const fitWidth = Math.min(cW, cH * aspect);
        const fitHeight = fitWidth / aspect;
        displayWidth.value = fitWidth;
        displayHeight.value = fitHeight;
      }
      if (onLoad) onLoad();
    },
    [onLoad],
  );

  const pinchGesture = Gesture.Pinch()
    .onBegin((event) => {
      originX.value = event.focalX;
      originY.value = event.focalY;
    })
    .onUpdate((event) => {
      const rawScale = savedScale.value * event.scale;
      const newScale =
        rawScale < MIN_SCALE
          ? MIN_SCALE - (MIN_SCALE - rawScale) * RUBBER_BAND_DECAY
          : rawScale > MAX_SCALE
            ? MAX_SCALE + (rawScale - MAX_SCALE) * RUBBER_BAND_DECAY
            : rawScale;
      const deltaScale = newScale / scale.value;
      translateX.value = originX.value - (originX.value - translateX.value) * deltaScale;
      translateY.value = originY.value - (originY.value - translateY.value) * deltaScale;
      scale.value = newScale;
    })
    .onEnd(() => {
      if (scale.value < MIN_SCALE * 1.05) {
        scale.value = withSpring(MIN_SCALE, SPRING_CONFIG);
        savedScale.value = MIN_SCALE;
        translateX.value = withSpring(0, SPRING_CONFIG);
        translateY.value = withSpring(0, SPRING_CONFIG);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        const clampedScale = clamp(scale.value, MIN_SCALE, MAX_SCALE);
        savedScale.value = clampedScale;
        scale.value = withSpring(clampedScale, DISMISS_SPRING);
        const maxPanX = Math.max(0, (clampedScale * displayWidth.value - containerWidth.value) / 2);
        const maxPanY = Math.max(0, (clampedScale * displayHeight.value - containerHeight.value) / 2);
        savedTranslateX.value = clamp(translateX.value, -maxPanX, maxPanX);
        savedTranslateY.value = clamp(translateY.value, -maxPanY, maxPanY);
        translateX.value = withSpring(savedTranslateX.value, SPRING_CONFIG);
        translateY.value = withSpring(savedTranslateY.value, SPRING_CONFIG);
      }
    });

  const panGesture = Gesture.Pan()
    .activeOffsetY([-10, 10])
    .failOffsetX([-10, 10])
    .onUpdate((event) => {
      if (isZoomed.value) {
        const maxPanX = Math.max(0, (scale.value * displayWidth.value - containerWidth.value) / 2);
        const maxPanY = Math.max(0, (scale.value * displayHeight.value - containerHeight.value) / 2);
        translateX.value = clamp(savedTranslateX.value + event.translationX, -maxPanX, maxPanX);
        translateY.value = clamp(savedTranslateY.value + event.translationY, -maxPanY, maxPanY);
      } else {
        translateY.value = event.translationY;
        scale.value = Math.max(0.85, 1 - (Math.abs(event.translationY) / SCREEN_HEIGHT) * 0.3);
      }
    })
    .onEnd((event) => {
      if (!isZoomed.value) {
        if (event.translationY > DISMISS_THRESHOLD || event.velocityY > DISMISS_VELOCITY) {
          translateY.value = withTiming(SCREEN_HEIGHT, { duration: 200 });
          opacity.value = withTiming(0, { duration: 200 }, () => {
            if (onDismiss) runOnJS(onDismiss)();
          });
        } else {
          translateY.value = withSpring(0, SPRING_CONFIG);
          scale.value = withSpring(MIN_SCALE, SPRING_CONFIG);
        }
      } else {
        const maxPanX = Math.max(0, (scale.value * displayWidth.value - containerWidth.value) / 2);
        const maxPanY = Math.max(0, (scale.value * displayHeight.value - containerHeight.value) / 2);
        savedTranslateX.value = clamp(translateX.value, -maxPanX, maxPanX);
        savedTranslateY.value = clamp(translateY.value, -maxPanY, maxPanY);
        translateX.value = withSpring(savedTranslateX.value, SPRING_CONFIG);
        translateY.value = withSpring(savedTranslateY.value, SPRING_CONFIG);
      }
    });

  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(250)
    .onEnd((event) => {
      const currentScale = scale.value;
      const targetScale = currentScale > 1.5 ? MIN_SCALE : DOUBLE_TAP_SCALE;
      const cW = containerWidth.value;
      const cH = containerHeight.value;

      if (targetScale > currentScale) {
        const targetX = ((cW / 2 - event.x) * (targetScale - 1)) / targetScale;
        const targetY = ((cH / 2 - event.y) * (targetScale - 1)) / targetScale;
        const maxPanX = Math.max(0, (targetScale * displayWidth.value - cW) / 2);
        const maxPanY = Math.max(0, (targetScale * displayHeight.value - cH) / 2);
        savedTranslateX.value = clamp(targetX, -maxPanX, maxPanX);
        savedTranslateY.value = clamp(targetY, -maxPanY, maxPanY);
        translateX.value = withSpring(savedTranslateX.value, SPRING_CONFIG);
        translateY.value = withSpring(savedTranslateY.value, SPRING_CONFIG);
      } else {
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        translateX.value = withSpring(0, SPRING_CONFIG);
        translateY.value = withSpring(0, SPRING_CONFIG);
      }

      scale.value = withSpring(targetScale, SPRING_CONFIG);
      savedScale.value = targetScale;
    });

  const composedGestures = Gesture.Exclusive(
    doubleTapGesture,
    Gesture.Simultaneous(pinchGesture, panGesture),
  );

  const finalGesture = simultaneousHandlers
    ? Gesture.Simultaneous(composedGestures, simultaneousHandlers)
    : composedGestures;

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <View style={styles.outerContainer} onLayout={handleLayout}>
      <GestureDetector gesture={finalGesture}>
        <Animated.View style={[styles.container, animatedStyle]}>
          <Image
            source={{ uri }}
            style={[
              styles.image,
              measuredSize.width > 0
                ? { width: measuredSize.width, height: measuredSize.height }
                : styles.imageFill,
            ]}
            contentFit="contain"
            transition={200}
            placeholder={{ color: "#1a1a1a" }}
            onLoad={handleImageLoad}
          />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  outerContainer: {
    flex: 1,
  },
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  image: {
    backgroundColor: "transparent",
  },
  imageFill: {
    width: "100%",
    height: "100%",
  },
});