/**
 * CallScreen — FAANG-Grade Premium UI.
 *
 * ★ Pure UI Subscriber — all state driven by CallManager.
 * ★ NO direct signaling listeners — CallManager owns the call lifecycle.
 * ★ NO stale closures — state updates via event subscription.
 * ★ Navigation driven by state transitions (ENDED → goBack).
 * ★ Glassmorphic frosted control bar
 * ★ Voice-reactive waveform animations
 * ★ Animated PiP with glow border
 * ★ Haptic feedback on call events
 * ★ Gradient end-call button with pulse ring
 * ★ Premium audio-only mode with concentric pulse rings
 * ★ Reconnecting state with animated indicator
 */
import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  Animated,
  Dimensions,
  Platform,
  StatusBar,
  Vibration,
  Image,
  PanResponder,
  Modal,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, typography, spacing, radius, shadows } from "../styles/theme";
import callManager, { CALL_MANAGER_STATES } from "../services/CallManager";
import networkMonitor, { QUALITY_TIERS } from "../services/networkMonitor";
import audioEngine from "../services/audioEngine";
import Icon from "react-native-vector-icons/Feather";

// ─── Conditional WebRTC Import ───────────────────────────────────────────────
let RTCView = null;
let WEBRTC_AVAILABLE = false;
try {
  RTCView = require("react-native-webrtc").RTCView;
  WEBRTC_AVAILABLE = true;
} catch {}

// ─── Haptic Feedback ─────────────────────────────────────────────────────────
let Haptics = null;
try {
  Haptics = require("expo-haptics");
} catch {}

const haptic = (type = "medium") => {
  try {
    if (Haptics) {
      const map = {
        light: Haptics.ImpactFeedbackStyle?.Light,
        medium: Haptics.ImpactFeedbackStyle?.Medium,
        heavy: Haptics.ImpactFeedbackStyle?.Heavy,
        success: "success",
        error: "error",
      };
      if (type === "success" || type === "error") {
        Haptics.notificationAsync?.(
          type === "success"
            ? Haptics.NotificationFeedbackType?.Success
            : Haptics.NotificationFeedbackType?.Error,
        );
      } else {
        Haptics.impactAsync?.(map[type] || map.medium);
      }
    } else {
      Vibration.vibrate(type === "heavy" ? 50 : 25);
    }
  } catch {}
};

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

// ─── Quality Display ─────────────────────────────────────────────────────────
const QUALITY_COLORS = {
  excellent: "#10b981",
  good: "#34d399",
  fair: "#f59e0b",
  audio_only: "#f97316",
  critical: "#ef4444",
};
const QUALITY_BARS = {
  excellent: 5,
  good: 4,
  fair: 3,
  audio_only: 2,
  critical: 1,
};

export default function CallScreen({ route, navigation }) {
  const {
    callerName,
    callerAvatar,
    callType = "video",
    acceptFromNotification = false,
  } = route.params;
  const insets = useSafeAreaInsets();
  const isVoiceCall = callType === "voice";

  // ─── State (all driven by CallManager events) ──────────────────────────────
  const [localStream, setLocalStream] = useState(null);
  const localStreamVersion = useRef(0);
  const [remoteStream, setRemoteStream] = useState(null);
  const remoteStreamVersion = useRef(0);
  const [callState, setCallState] = useState(
    callManager.state || CALL_MANAGER_STATES.CALLING,
  );
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(isVoiceCall);
  const [isAudioOnly, setIsAudioOnly] = useState(isVoiceCall);
  const [currentCallType, setCurrentCallType] = useState(callType);
  const [duration, setDuration] = useState(0);
  const [qualityTier, setQualityTier] = useState(QUALITY_TIERS.EXCELLENT);
  const [stats, setStats] = useState(null);
  const [showStats, setShowStats] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);

  // Video switch consent state
  const [videoRequest, setVideoRequest] = useState(null);
  const [requestingVideo, setRequestingVideo] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);

  // ─── Animations ─────────────────────────────────────────────────────────────
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const controlsAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const dotAnims = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];
  const waveAnims = Array.from(
    { length: 12 },
    () => useRef(new Animated.Value(0.3)).current,
  );
  const glowAnim = useRef(new Animated.Value(0)).current;
  const overlayAnim = useRef(new Animated.Value(1)).current;
  const ringAnims = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];

  // ─── Draggable PiP State ────────────────────────────────────────────────────
  const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
  const pipPan = useRef(new Animated.ValueXY()).current;

  const pipPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        pipPan.setOffset({
          x: pipPan.x._value,
          y: pipPan.y._value,
        });
        pipPan.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: Animated.event(
        [null, { dx: pipPan.x, dy: pipPan.y }],
        { useNativeDriver: false }, // pan responders rarely support true native driver for XY easily
      ),
      onPanResponderRelease: (e, gestureState) => {
        pipPan.flattenOffset();

        // Calculate snap positions
        // PiP is 110px wide, 155px tall. Default position was right: 16
        const pipWidth = 110;
        const pipHeight = 155;
        const margin = 16;

        // Bound Y so it doesn't go off screen (top bar or bottom controls)
        const minY = -100 + insets.top; // Relative to its original top:100 start
        const maxY = screenHeight - pipHeight - 200 - insets.bottom;

        let finalY = pipPan.y._value;
        if (finalY < minY) finalY = minY;
        if (finalY > maxY) finalY = maxY;

        // Snap X to left or right edge
        // Originally it was right: 16 (which means X=0 is right aligned)
        // To move to left edge, X needs to be total width - pipWidth - margins
        const leftX = -(screenWidth - pipWidth - margin * 2);
        const rightX = 0;

        const isCloserToLeft = pipPan.x._value < leftX / 2;
        const finalX = isCloserToLeft ? leftX : rightX;

        Animated.spring(pipPan, {
          toValue: { x: finalX, y: finalY },
          friction: 7,
          tension: 50,
          useNativeDriver: false,
        }).start();
      },
    }),
  ).current;

  // ─── Subscribe to CallManager (Single Source of Truth) ──────────────────────
  useEffect(() => {
    // ★ ALWAYS run entrance animation — even if WebRTC is unavailable
    //   (otherwise fadeAnim stays at 0 → screen invisible)
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
      Animated.spring(controlsAnim, {
        toValue: 1,
        damping: 20,
        stiffness: 200,
        useNativeDriver: true,
      }),
    ]).start();

    // ★ ALWAYS subscribe to CallManager state changes — even without WebRTC
    //   the signaling lifecycle (ringing → rejected → ended) still works and
    //   we need to react to it for proper navigation.
    const unsubState = callManager.on("stateChange", ({ state, prevState }) => {
      setCallState(state);

      // Haptic feedback on state transitions
      if (state === CALL_MANAGER_STATES.CONNECTED) {
        haptic("success");
      } else if (state === CALL_MANAGER_STATES.RECONNECTING) {
        haptic("heavy");
      } else if (state === CALL_MANAGER_STATES.FAILED) {
        haptic("error");
      } else if (state === CALL_MANAGER_STATES.ENDING) {
        haptic("heavy");
      }

      // ★ Navigation driven by state: when ENDED → navigate back
      if (state === CALL_MANAGER_STATES.ENDED) {
        // Brief delay so UI shows "Call Ended"
        setTimeout(() => {
          if (navigation.canGoBack()) {
            navigation.goBack();
          }
        }, 1200);
      }
    });

    // ★ Subscribe to media streams
    const unsubLocal = callManager.on("localStream", (stream) => {
      // Force local RTCView to re-mount when stream changes (e.g. video track added)
      localStreamVersion.current += 1;
      setLocalStream(stream);
    });

    const unsubRemote = callManager.on("remoteStream", (stream) => {
      // ★ Force RTCView re-mount: increment version counter.
      // When switching voice→video, ontrack fires on the SAME stream object.
      // React's useState doesn't detect the mutation, so RTCView stays black.
      remoteStreamVersion.current += 1;
      setRemoteStream(stream);
      haptic("light");
    });

    // ★ Bootstrap from notification accept (app was backgrounded/killed)
    if (acceptFromNotification && !callManager.isActive) {
      const pendingCall = callManager.getPendingIncomingCall?.();
      if (pendingCall) {
        callManager.acceptIncomingCall(pendingCall);
      }
    }

    // ★ Subscribe to mode switches
    const unsubMode = callManager.on("modeSwitch", ({ mode }) => {
      const audioOnly = mode === "audio_only";
      setIsAudioOnly(audioOnly);
      setCurrentCallType(audioOnly ? "voice" : "video");
      setIsCameraOff(audioOnly);
      haptic("medium");
    });

    // ★ Subscribe to quality changes
    const unsubQuality = callManager.on("qualityChange", (newTier) => {
      setQualityTier(newTier);
      if (newTier.name === "audio_only" || newTier.name === "critical") {
        setIsAudioOnly(true);
      }
    });

    // ★ Subscribe to stats
    const unsubStats = callManager.on("statsUpdate", (data) => {
      setStats(data);
    });

    // ★ Subscribe to duration ticks
    const unsubDuration = callManager.on("durationTick", (seconds) => {
      setDuration(seconds);
    });

    // ★ Subscribe to video switch requests
    const unsubVideoReq = callManager.on("videoSwitchRequest", () => {
      setVideoRequest(true);
      haptic("medium");
    });

    // ★ Subscribe to video switch declines
    const unsubVideoDeclined = callManager.on("videoSwitchDeclined", () => {
      setRequestingVideo(false);
      setToastMessage("Video request declined");
      setTimeout(() => setToastMessage(null), 3000);
      haptic("heavy");
    });

    // ★ If WebRTC unavailable, mark failed AFTER subscriptions are in place
    //   so the CallManager's ENDED transition can still navigate us back.
    if (!WEBRTC_AVAILABLE) {
      setCallState(CALL_MANAGER_STATES.FAILED);
    }

    return () => {
      unsubState();
      unsubLocal();
      unsubRemote();
      unsubMode();
      unsubQuality();
      unsubStats();
      unsubDuration();
      unsubVideoReq();
      unsubVideoDeclined();
    };
  }, []);

  // ─── Duration Timer ─────────────────────────────────────────────────────────
  // Duration is now handled by CallManager and subscribed via 'durationTick' event.
  // This useEffect is no longer needed.

  // ─── Connecting Dot Animation ───────────────────────────────────────────────
  useEffect(() => {
    if (
      callState === CALL_MANAGER_STATES.CALLING ||
      callState === CALL_MANAGER_STATES.CONNECTING ||
      callState === CALL_MANAGER_STATES.RINGING ||
      callState === CALL_MANAGER_STATES.RECONNECTING
    ) {
      const anims = dotAnims.map((dot, i) =>
        Animated.loop(
          Animated.sequence([
            Animated.delay(i * 250),
            Animated.timing(dot, {
              toValue: 1,
              duration: 400,
              useNativeDriver: true,
            }),
            Animated.timing(dot, {
              toValue: 0,
              duration: 400,
              useNativeDriver: true,
            }),
          ]),
        ),
      );
      Animated.parallel(anims).start();
      return () => anims.forEach((a) => a.stop());
    }
  }, [callState]);

  // ─── End Call Pulse Ring ────────────────────────────────────────────────────
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 1200,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  // ─── PiP Glow Animation ────────────────────────────────────────────────────
  useEffect(() => {
    if (localStream && callState === CALL_MANAGER_STATES.CONNECTED) {
      const glow = Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, {
            toValue: 1,
            duration: 2000,
            useNativeDriver: false,
          }),
          Animated.timing(glowAnim, {
            toValue: 0,
            duration: 2000,
            useNativeDriver: false,
          }),
        ]),
      );
      glow.start();
      return () => glow.stop();
    }
  }, [localStream, callState]);

  // ─── Audio-Only Waveform Animation ──────────────────────────────────────────
  useEffect(() => {
    if (isAudioOnly && callState === CALL_MANAGER_STATES.CONNECTED) {
      audioEngine.startMonitoring(remoteStream);

      const waveAnimations = waveAnims.map((anim, i) =>
        Animated.loop(
          Animated.sequence([
            Animated.delay(i * 60),
            Animated.timing(anim, {
              toValue: 0.4 + Math.random() * 0.6,
              duration: 300 + Math.random() * 200,
              useNativeDriver: true,
            }),
            Animated.timing(anim, {
              toValue: 0.15 + Math.random() * 0.2,
              duration: 300 + Math.random() * 200,
              useNativeDriver: true,
            }),
          ]),
        ),
      );
      Animated.parallel(waveAnimations).start();

      // Concentric ring animation for audio-only
      const ringAnimations = ringAnims.map((anim, i) =>
        Animated.loop(
          Animated.sequence([
            Animated.delay(i * 700),
            Animated.parallel([
              Animated.timing(anim, {
                toValue: 1,
                duration: 2000,
                useNativeDriver: true,
              }),
            ]),
            Animated.timing(anim, {
              toValue: 0,
              duration: 0,
              useNativeDriver: true,
            }),
          ]),
        ),
      );
      Animated.parallel(ringAnimations).start();

      return () => {
        waveAnimations.forEach((a) => a.stop());
        ringAnimations.forEach((a) => a.stop());
        audioEngine.stop();
      };
    }
  }, [isAudioOnly, callState, remoteStream]);

  // ─── End Call Handler (delegates to CallManager) ────────────────────────────
  const handleCallEnd = useCallback(() => {
    callManager.endCall("user_hangup");
  }, []);

  // ─── Controls ───────────────────────────────────────────────────────────────
  const toggleMute = () => {
    haptic("light");
    const muted = callManager.toggleMute();
    setIsMuted(muted);
  };

  const toggleCamera = () => {
    haptic("light");
    const off = callManager.toggleCamera();
    setIsCameraOff(off);
  };

  const switchCamera = () => {
    haptic("light");
    callManager.switchCamera();
  };

  const toggleSpeaker = () => {
    haptic("light");
    const speakerState = callManager.toggleSpeaker();
    setIsSpeakerOn(speakerState);
  };

  const handleSwitchCallType = () => {
    haptic("medium");
    const newType = currentCallType === "voice" ? "video" : "voice";

    // For voice -> video, switchCallType now returns false and sends a request
    const switched = callManager.switchCallType(newType);

    if (switched) {
      setCurrentCallType(newType);
      setIsAudioOnly(newType === "voice");
      setIsCameraOff(newType === "voice");
    } else if (newType === "video") {
      setRequestingVideo(true);
    }
  };

  const handleVideoRequestResponse = (accepted) => {
    haptic("light");
    callManager.respondToVideoRequest(accepted);
    setVideoRequest(null);
  };

  // Listen for modeSwitch event to clear the requesting state if accepted
  useEffect(() => {
    const unsub = callManager.on("modeSwitch", () => {
      setRequestingVideo(false);
    });
    return unsub;
  }, []);

  // ─── Toggle Controls Visibility ─────────────────────────────────────────────
  const toggleControls = useCallback(() => {
    const toValue = controlsVisible ? 0 : 1;
    setControlsVisible(!controlsVisible);
    Animated.timing(overlayAnim, {
      toValue,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [controlsVisible, overlayAnim]);

  // ─── Formatters ─────────────────────────────────────────────────────────────
  const formatDuration = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  const getStatusText = () => {
    switch (callState) {
      case CALL_MANAGER_STATES.CALLING:
        return "Calling...";
      case CALL_MANAGER_STATES.RINGING:
        return "Ringing...";
      case CALL_MANAGER_STATES.CONNECTING:
        return "Connecting...";
      case CALL_MANAGER_STATES.RECONNECTING:
        return "Reconnecting...";
      case CALL_MANAGER_STATES.FAILED:
        return "Call Failed";
      case CALL_MANAGER_STATES.ENDED:
      case CALL_MANAGER_STATES.ENDING:
        return "Call Ended";
      case CALL_MANAGER_STATES.CONNECTED:
        return formatDuration(duration);
      default:
        return "";
    }
  };

  const isConnected = callState === CALL_MANAGER_STATES.CONNECTED;
  const isLive =
    callState === CALL_MANAGER_STATES.CONNECTED ||
    callState === CALL_MANAGER_STATES.RECONNECTING;

  // ─── Render: Quality Bars ──────────────────────────────────────────────────
  const renderQualityBars = () => {
    const bars = QUALITY_BARS[qualityTier.name] || 3;
    const color = QUALITY_COLORS[qualityTier.name] || colors.textMuted;
    return (
      <TouchableOpacity
        style={styles.qualityContainer}
        onPress={() => {
          haptic("light");
          setShowStats(!showStats);
        }}
      >
        <View style={styles.qualityBars}>
          {[1, 2, 3, 4, 5].map((i) => (
            <View
              key={i}
              style={[
                styles.qualityBar,
                {
                  height: 4 + i * 3,
                  backgroundColor: i <= bars ? color : "rgba(255,255,255,0.12)",
                },
              ]}
            />
          ))}
        </View>
        <Text style={[styles.qualityLabel, { color }]}>
          {networkMonitor.getQualityLabel()}
        </Text>
      </TouchableOpacity>
    );
  };

  // ─── Render: Stats Overlay ──────────────────────────────────────────────────
  const renderStatsOverlay = () => {
    if (!showStats || !stats) return null;
    const { averaged } = stats;
    return (
      <View style={styles.statsOverlay}>
        <View style={styles.statsCard}>
          <Text style={styles.statsTitle}>Network Stats</Text>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Packet Loss</Text>
            <Text style={styles.statValue}>
              {averaged.packetLoss.toFixed(1)}%
            </Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Jitter</Text>
            <Text style={styles.statValue}>{averaged.jitter.toFixed(0)}ms</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>RTT</Text>
            <Text style={styles.statValue}>{averaged.rtt.toFixed(0)}ms</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Bandwidth</Text>
            <Text style={styles.statValue}>
              {(averaged.bandwidth / 1000).toFixed(0)} kbps
            </Text>
          </View>
          <View style={[styles.statRow, { borderBottomWidth: 0 }]}>
            <Text style={styles.statLabel}>State</Text>
            <Text style={[styles.statValue, { color: colors.primary }]}>
              {callState.toUpperCase()}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  // ─── Render: Connecting/Reconnecting State ─────────────────────────────────
  const renderConnectingState = () => (
    <View style={styles.centerOverlay}>
      <View style={styles.avatarCircle}>
        {callerAvatar?.startsWith("http") ? (
          <Image
            source={{ uri: callerAvatar }}
            style={{ width: 100, height: 100, borderRadius: 50 }}
          />
        ) : (
          <Text style={styles.avatarInitial}>
            {(callerName || "?").charAt(0).toUpperCase()}
          </Text>
        )}
      </View>
      <Text style={styles.callerNameLarge}>{callerName || "Unknown"}</Text>
      <View style={styles.dotsRow}>
        {dotAnims.map((dot, i) => (
          <Animated.View
            key={i}
            style={[
              styles.dot,
              {
                opacity: dot,
                transform: [
                  {
                    translateY: dot.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -8],
                    }),
                  },
                ],
              },
              callState === CALL_MANAGER_STATES.RECONNECTING && {
                backgroundColor: colors.warning,
              },
            ]}
          />
        ))}
      </View>
      <Text style={styles.statusLabel}>{getStatusText()}</Text>
      {callState === CALL_MANAGER_STATES.RECONNECTING && (
        <Text style={styles.reconnectHint}>
          Network changed — restoring connection
        </Text>
      )}
    </View>
  );

  // ─── Render: Audio-Only Mode ───────────────────────────────────────────────
  const renderAudioOnly = () => (
    <View style={styles.audioOnlyContainer}>
      {/* Centered avatar with pulse rings */}
      <View style={styles.audioAvatarSection}>
        {ringAnims.map((anim, i) => (
          <Animated.View
            key={i}
            style={[
              styles.pulseRing,
              {
                opacity: anim.interpolate({
                  inputRange: [0, 0.5, 1],
                  outputRange: [0.25, 0.08, 0],
                }),
                transform: [
                  {
                    scale: anim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 2.5],
                    }),
                  },
                ],
              },
            ]}
          />
        ))}

        <View style={styles.audioAvatar}>
          {callerAvatar?.startsWith("http") ? (
            <Image
              source={{ uri: callerAvatar }}
              style={{ width: 160, height: 160, borderRadius: 80 }}
            />
          ) : (
            <Text style={styles.audioAvatarText}>
              {(callerName || "?").charAt(0).toUpperCase()}
            </Text>
          )}
        </View>
      </View>
    </View>
  );

  // ─── Render: Video Mode ────────────────────────────────────────────────────
  const renderVideoMode = () => (
    <View style={styles.videoContainer}>
      {remoteStream && RTCView ? (
        <RTCView
          key={`remote-${remoteStreamVersion.current}`}
          streamURL={remoteStream.toURL()}
          style={styles.remoteVideo}
          objectFit="cover"
          zOrder={0}
        />
      ) : (
        <View style={styles.remoteVideoPlaceholder}>
          <View style={styles.placeholderAvatar}>
            {callerAvatar?.startsWith("http") ? (
              <Image
                source={{ uri: callerAvatar }}
                style={{ width: 80, height: 80, borderRadius: 40 }}
              />
            ) : (
              <Text style={styles.placeholderAvatarText}>
                {(callerName || "?").charAt(0).toUpperCase()}
              </Text>
            )}
          </View>
          <Text style={styles.waitingText}>Waiting for video...</Text>
        </View>
      )}
    </View>
  );

  // ─── Main Render ────────────────────────────────────────────────────────────
  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      <StatusBar
        barStyle="light-content"
        backgroundColor="transparent"
        translucent
      />

      {/* Background / Main Content */}
      {!isLive
        ? renderConnectingState()
        : isAudioOnly
          ? renderAudioOnly()
          : renderVideoMode()}

      {/* Tap overlay to toggle controls */}
      {isConnected && (
        <TouchableWithoutFeedback onPress={toggleControls}>
          <View style={styles.tapZone} />
        </TouchableWithoutFeedback>
      )}

      {/* ─── Top Bar ─────────────────────────────────────────────────── */}
      <Animated.View
        style={[
          styles.topBar,
          { paddingTop: insets.top + 8 },
          {
            opacity: overlayAnim,
            transform: [
              {
                translateY: overlayAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-80, 0],
                }),
              },
            ],
          },
        ]}
        pointerEvents={controlsVisible ? "auto" : "none"}
      >
        <View style={styles.topBarContent}>
          {/* Back / End button */}
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => handleCallEnd("user_hangup")}
            activeOpacity={0.7}
          >
            <Icon name="chevron-left" size={28} color="#fff" />
          </TouchableOpacity>

          {/* Center: Name + Duration */}
          <View style={styles.topCenterInfo}>
            <Text style={styles.topCallerName} numberOfLines={1}>
              {callerName || "Unknown"}
            </Text>
            <Text
              style={[
                styles.topDuration,
                isConnected && { color: "rgba(255,255,255,0.7)" },
                callState === CALL_MANAGER_STATES.RECONNECTING && {
                  color: colors.warning,
                },
              ]}
            >
              {getStatusText()}
            </Text>
          </View>

          {/* Right: 3-dots menu */}
          <TouchableOpacity
            style={styles.menuButton}
            onPress={() => {
              haptic("light");
              setShowStats(!showStats);
            }}
            activeOpacity={0.7}
          >
            <Icon name="more-horizontal" size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* ─── Stats Overlay ──────────────────────────────────────────── */}
      {renderStatsOverlay()}

      {/* ─── Local PiP (animated & draggable) ──────────────────── */}
      {isLive && localStream && RTCView && !isCameraOff && !isAudioOnly && (
        <Animated.View
          {...pipPanResponder.panHandlers}
          style={[
            styles.pipWrapper,
            {
              opacity: overlayAnim,
              transform: [{ translateX: pipPan.x }, { translateY: pipPan.y }],
            },
          ]}
          pointerEvents={controlsVisible ? "auto" : "none"}
        >
          <Animated.View
            style={[
              styles.localPreview,
              {
                borderColor: glowAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [
                    "rgba(255, 255, 255, 0.15)",
                    "rgba(255, 255, 255, 0.4)",
                  ],
                }),
              },
            ]}
          >
            <RTCView
              key={`local-${localStreamVersion.current}`}
              streamURL={localStream.toURL()}
              style={styles.localVideo}
              objectFit="cover"
              mirror={true}
              zOrder={1}
            />
          </Animated.View>
          <TouchableOpacity
            style={styles.switchCameraBtn}
            onPress={switchCamera}
            activeOpacity={0.7}
          >
            <Icon name="refresh-cw" size={13} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* ─── Bottom Controls ──────────────────────────────────────── */}
      <Animated.View
        style={[
          styles.controlBar,
          { paddingBottom: insets.bottom + 16 },
          {
            opacity: overlayAnim,
            transform: [
              {
                translateY: overlayAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [120, 0],
                }),
              },
            ],
          },
        ]}
        pointerEvents={controlsVisible ? "auto" : "none"}
      >
        <View style={styles.controlRow}>
          {/* Speaker toggle */}
          <TouchableOpacity
            style={[
              styles.controlBtnCircle,
              isSpeakerOn && styles.controlBtnCircleActive,
            ]}
            onPress={toggleSpeaker}
            activeOpacity={0.7}
          >
            <Icon
              name={isSpeakerOn ? "volume-2" : "volume-1"}
              size={22}
              color={isSpeakerOn ? "#000" : "#fff"}
            />
          </TouchableOpacity>

          {/* Mute */}
          <TouchableOpacity
            style={[
              styles.controlBtnCircle,
              isMuted && styles.controlBtnCircleActive,
            ]}
            onPress={toggleMute}
            activeOpacity={0.7}
          >
            <Icon
              name={isMuted ? "mic-off" : "mic"}
              size={22}
              color={isMuted ? "#000" : "#fff"}
            />
          </TouchableOpacity>

          {/* Video mode: Camera toggle / Voice mode: Switch to video */}
          {currentCallType === "video" ? (
            <TouchableOpacity
              style={[
                styles.controlBtnCircle,
                isCameraOff && styles.controlBtnCircleActive,
              ]}
              onPress={toggleCamera}
              activeOpacity={0.7}
            >
              <Icon
                name={isCameraOff ? "video-off" : "video"}
                size={22}
                color={isCameraOff ? "#000" : "#fff"}
              />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.controlBtnCircle}
              onPress={handleSwitchCallType}
              activeOpacity={0.7}
            >
              <Icon name="video" size={22} color="#fff" />
            </TouchableOpacity>
          )}

          {/* End Call */}
          <TouchableOpacity
            style={styles.endCallBtnPill}
            onPress={() => handleCallEnd("user_hangup")}
            activeOpacity={0.8}
          >
            <View style={{ transform: [{ rotate: "135deg" }] }}>
              <Icon name="phone" size={24} color="#fff" />
            </View>
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* ─── Toasts / Notifications ───────────────────────────────── */}
      {requestingVideo && (
        <View style={styles.toastContainer}>
          <Text style={styles.toastText}>Waiting for response...</Text>
        </View>
      )}

      {toastMessage && (
        <View style={styles.toastContainer}>
          <Text style={styles.toastText}>{toastMessage}</Text>
        </View>
      )}

      {/* ─── Video Switch Request Popup ──────────────────────── */}
      {videoRequest && (
        <Modal transparent animationType="fade" visible={!!videoRequest}>
          <View style={styles.consentOverlay}>
            <View style={styles.consentBox}>
              <View style={styles.consentIcon}>
                <Image
                  source={{ uri: callerAvatar }}
                  style={{ width: 64, height: 64, borderRadius: 32 }}
                  resizeMode="cover"
                />
              </View>
              <Text style={styles.consentTitle}>Video Request</Text>
              <Text style={styles.consentText}>
                {callerName} is requesting to switch to a video call.
              </Text>

              <View style={styles.consentActions}>
                <TouchableOpacity
                  style={[styles.consentBtn, styles.consentBtnReject]}
                  onPress={() => handleVideoRequestResponse(false)}
                >
                  <Text style={styles.consentBtnText}>Decline</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.consentBtn, styles.consentBtnAccept]}
                  onPress={() => handleVideoRequestResponse(true)}
                >
                  <Text style={styles.consentBtnAcceptText}>Accept</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </Animated.View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#050508",
  },

  // ─── Tap Zone ──────────────────────────────────────────────────────
  tapZone: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 5,
  },

  // ─── Top Bar ───────────────────────────────────────────────────────
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 12,
    paddingBottom: 16,
  },
  topBarContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  topCenterInfo: {
    flex: 1,
    alignItems: "center",
  },
  topCallerName: {
    fontSize: 17,
    fontWeight: "700",
    color: "#fff",
    letterSpacing: -0.2,
  },
  topDuration: {
    fontSize: 14,
    color: "rgba(255,255,255,0.5)",
    fontWeight: "500",
    marginTop: 2,
  },
  menuButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
  },

  // ─── Quality ──────────────────────────────────────────────────────
  qualityContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  qualityBars: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    height: 16,
  },
  qualityBar: {
    width: 3,
    borderRadius: 1.5,
  },
  qualityLabel: {
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  // ─── Video ────────────────────────────────────────────────────────
  videoContainer: {
    flex: 1,
  },
  remoteVideo: {
    flex: 1,
    backgroundColor: "#0a0a0f",
  },
  remoteVideoPlaceholder: {
    flex: 1,
    backgroundColor: "#0a0a0f",
    justifyContent: "center",
    alignItems: "center",
  },
  placeholderAvatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  placeholderAvatarText: {
    fontSize: 34,
    fontWeight: "700",
    color: "rgba(255, 255, 255, 0.4)",
  },
  waitingText: {
    color: "rgba(255,255,255,0.3)",
    fontSize: 14,
    marginTop: 16,
    fontWeight: "500",
  },

  // ─── Local PiP ────────────────────────────────────────────────────
  pipWrapper: {
    position: "absolute",
    top: 100,
    right: 16,
    zIndex: 8,
  },
  localPreview: {
    width: 110,
    height: 155,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  localVideo: {
    width: "100%",
    height: "100%",
  },
  switchCameraBtn: {
    position: "absolute",
    bottom: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.15)",
  },

  // ─── Connecting State ─────────────────────────────────────────────
  centerOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#050508",
  },
  avatarCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "rgba(239, 68, 68, 0.08)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "rgba(239, 68, 68, 0.2)",
    marginBottom: 20,
  },
  avatarInitial: {
    fontSize: 40,
    fontWeight: "800",
    color: "#ef4444",
  },
  callerNameLarge: {
    fontSize: 26,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 12,
    letterSpacing: -0.3,
  },
  dotsRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#fff",
  },
  statusLabel: {
    fontSize: 15,
    color: "rgba(255,255,255,0.5)",
    fontWeight: "500",
  },
  reconnectHint: {
    fontSize: 13,
    color: colors.warning,
    marginTop: 8,
    fontWeight: "500",
  },

  // ─── Audio-Only Mode ──────────────────────────────────────────────
  audioOnlyContainer: {
    flex: 1,
    backgroundColor: "#050508",
  },
  audioAvatarSection: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  pulseRing: {
    position: "absolute",
    width: 160,
    height: 160,
    borderRadius: 80,
    borderWidth: 2,
    borderColor: "rgba(255, 255, 255, 0.12)",
  },
  audioAvatar: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 3,
    borderColor: "rgba(255, 255, 255, 0.15)",
    zIndex: 1,
  },
  audioAvatarText: {
    fontSize: 56,
    fontWeight: "800",
    color: "rgba(255, 255, 255, 0.7)",
  },

  // ─── Audio-Only Badge ─────────────────────────────────────────────
  audioOnlyBadge: {
    backgroundColor: "rgba(249, 115, 22, 0.15)",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: "rgba(249, 115, 22, 0.25)",
  },
  audioOnlyBadgeText: {
    fontSize: 12,
    color: "#f97316",
    fontWeight: "600",
  },

  // ─── Control Bar ──────────────────────────────────────────────────
  controlBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingTop: 24,
    paddingHorizontal: 40,
    backgroundColor: "rgba(15, 15, 20, 0.9)",
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderTopWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.04)",
  },
  controlRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 28,
  },

  // ─── Control Buttons ──────────────────────────────────────────────
  controlBtnCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    justifyContent: "center",
    alignItems: "center",
  },
  controlBtnCircleActive: {
    backgroundColor: "#fff",
  },

  // ─── End Call Button (pill shape) ─────────────────────────────────
  endCallBtnPill: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#ef4444",
    justifyContent: "center",
    alignItems: "center",
  },

  // ─── Switch Mode Button ──────────────────────────────────────────
  switchModeBtn: {
    paddingHorizontal: 8,
  },
  switchModeLabel: {
    fontSize: 10,
    color: "rgba(255,255,255,0.7)",
    fontWeight: "600",
    marginTop: 2,
    letterSpacing: 0.3,
  },
  secondaryControlRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginBottom: 14,
  },
  endCallRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 16,
    marginBottom: 4,
  },
  controlBtnSmall: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },

  // ─── End Call Button ──────────────────────────────────────────────
  endCallBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#ef4444",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#ef4444",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },

  // ─── Stats Overlay ────────────────────────────────────────────────
  statsOverlay: {
    position: "absolute",
    top: 110,
    left: 16,
    zIndex: 15,
  },
  statsCard: {
    backgroundColor: "rgba(10, 10, 15, 0.92)",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    minWidth: 200,
  },
  statsTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "rgba(255, 255, 255, 0.7)",
    marginBottom: 10,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  statRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.05)",
  },
  statLabel: {
    fontSize: 13,
    color: "rgba(255,255,255,0.5)",
    fontWeight: "500",
  },
  statValue: {
    fontSize: 13,
    color: "#fff",
    fontWeight: "600",
  },

  // ─── Consent Popup ────────────────────────────────────────────────
  consentOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  consentBox: {
    width: "100%",
    backgroundColor: "#1c1c1e",
    borderRadius: 24,
    padding: 24,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
  },
  consentIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
    overflow: "hidden", // Ensure the image stays a circle
  },
  consentTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 8,
  },
  consentText: {
    fontSize: 15,
    color: "rgba(255,255,255,0.7)",
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 22,
  },
  consentActions: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
  },
  consentBtn: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    justifyContent: "center",
    alignItems: "center",
  },
  consentBtnReject: {
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  consentBtnAccept: {
    backgroundColor: "#fff",
  },
  consentBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  consentBtnAcceptText: {
    color: "#000",
    fontSize: 16,
    fontWeight: "700",
  },

  // ─── Toasts ───────────────────────────────────────────────────────
  toastContainer: {
    position: "absolute",
    bottom: 140,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    zIndex: 50,
  },
  toastText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "500",
  },
});
