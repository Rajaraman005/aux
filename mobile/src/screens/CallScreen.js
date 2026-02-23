/**
 * CallScreen — FAANG-Grade Premium UI.
 *
 * Features:
 * ★ Call State Machine integration (CALLING→RINGING→CONNECTING→CONNECTED→RECONNECTING→ENDED→FAILED)
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
  StyleSheet,
  Animated,
  Dimensions,
  Platform,
  StatusBar,
  Vibration,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, typography, spacing, radius, shadows } from "../styles/theme";
import webrtcEngine, { CALL_STATES } from "../services/webrtc";
import signalingClient from "../services/socket";
import networkMonitor, { QUALITY_TIERS } from "../services/networkMonitor";
import audioEngine from "../services/audioEngine";

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
  const { callId, callerName, isCaller } = route.params;
  const insets = useSafeAreaInsets();

  // ─── State ──────────────────────────────────────────────────────────────────
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callState, setCallState] = useState(
    isCaller ? CALL_STATES.CALLING : CALL_STATES.CONNECTING,
  );
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isAudioOnly, setIsAudioOnly] = useState(false);
  const [duration, setDuration] = useState(0);
  const [qualityTier, setQualityTier] = useState(QUALITY_TIERS.EXCELLENT);
  const [stats, setStats] = useState(null);
  const [showStats, setShowStats] = useState(false);

  const durationTimer = useRef(null);
  const cleanupRefs = useRef({});

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
  const ringAnims = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];

  // ─── Initialize ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!WEBRTC_AVAILABLE) {
      setCallState(CALL_STATES.FAILED);
      return;
    }

    // Entrance animation
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

    // ★ State Machine callback
    webrtcEngine.onCallStateChange = (newState, prevState) => {
      setCallState(newState);

      if (newState === CALL_STATES.CONNECTED) {
        haptic("success");
      } else if (newState === CALL_STATES.RECONNECTING) {
        haptic("heavy");
      } else if (newState === CALL_STATES.FAILED) {
        haptic("error");
        // Auto-exit after showing failed state briefly
        setTimeout(() => handleCallEnd("failed"), 2000);
      }
    };

    webrtcEngine.onLocalStream = (stream) => setLocalStream(stream);
    webrtcEngine.onRemoteStream = (stream) => {
      setRemoteStream(stream);
      haptic("light");
    };

    webrtcEngine.onModeSwitch = (mode) => {
      setIsAudioOnly(mode === "audio_only");
      haptic("medium");
    };

    networkMonitor.onQualityChange = (newTier) => {
      setQualityTier(newTier);
      // ★ Update audio-only from quality tier as well
      if (newTier.name === "audio_only" || newTier.name === "critical") {
        setIsAudioOnly(true);
      } else if (webrtcEngine.isAudioOnly === false) {
        setIsAudioOnly(false);
      }
    };
    networkMonitor.onStatsUpdate = (data) => setStats(data);

    // ─── Signaling Listeners (register BEFORE init so we don't miss messages) ─
    const unsubOffer = signalingClient.on("offer", async (msg) => {
      if (msg.callId === callId) {
        await webrtcEngine.handleOffer(msg.sdp);
      }
    });
    const unsubAnswer = signalingClient.on("answer", async (msg) => {
      if (msg.callId === callId) {
        await webrtcEngine.handleAnswer(msg.sdp);
      }
    });
    const unsubIce = signalingClient.on("ice-candidate", async (msg) => {
      if (msg.callId === callId) {
        await webrtcEngine.handleIceCandidate(msg.candidate);
      }
    });
    const unsubIceRestart = signalingClient.on("ice-restart", async (msg) => {
      if (msg.callId === callId) {
        await webrtcEngine.handleOffer(msg.sdp);
      }
    });
    // ★ Server sends "call-ended" (not "hang-up") when remote peer hangs up
    const unsubCallEnded = signalingClient.on("call-ended", (msg) => {
      if (msg.callId === callId) {
        handleCallEnd("remote_hangup");
      }
    });
    const unsubHangUp = signalingClient.on("hang-up", (msg) => {
      if (msg.callId === callId) {
        handleCallEnd("remote_hangup");
      }
    });
    const unsubRejected = signalingClient.on("call-rejected", (msg) => {
      if (msg.callId === callId) {
        handleCallEnd("rejected");
      }
    });

    // ─── Initialize Call ──────────────────────────────────────────────
    if (isCaller) {
      // ★ Caller: wait for callee to accept, THEN init WebRTC and create offer
      const unsubAccepted = signalingClient.on("call-accepted", async (msg) => {
        if (msg.callId === callId) {
          unsubAccepted();
          try {
            await webrtcEngine.initialize(callId, true);
            networkMonitor.start(callId);
            await webrtcEngine.createOffer();
          } catch (err) {
            console.error("Call init error:", err);
            setCallState(CALL_STATES.FAILED);
            haptic("error");
          }
        }
      });
      // Store for cleanup
      cleanupRefs.current.unsubAccepted = unsubAccepted;
    } else {
      // ★ Callee: init WebRTC immediately (offer will arrive via signaling)
      const initCallee = async () => {
        try {
          await webrtcEngine.initialize(callId, false);
          networkMonitor.start(callId);
        } catch (err) {
          console.error("Call init error:", err);
          setCallState(CALL_STATES.FAILED);
          haptic("error");
        }
      };
      initCallee();
    }

    return () => {
      unsubOffer?.();
      unsubAnswer?.();
      unsubIce?.();
      unsubIceRestart?.();
      unsubCallEnded?.();
      unsubHangUp?.();
      unsubRejected?.();
      cleanupRefs.current.unsubAccepted?.();
    };
  }, [callId]);

  // ─── Duration Timer ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (callState === CALL_STATES.CONNECTED) {
      durationTimer.current = setInterval(
        () => setDuration((d) => d + 1),
        1000,
      );
    }
    return () => {
      if (durationTimer.current) clearInterval(durationTimer.current);
    };
  }, [callState]);

  // ─── Connecting Dot Animation ───────────────────────────────────────────────
  useEffect(() => {
    if (
      callState === CALL_STATES.CALLING ||
      callState === CALL_STATES.CONNECTING ||
      callState === CALL_STATES.RINGING ||
      callState === CALL_STATES.RECONNECTING
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
    if (localStream && callState === CALL_STATES.CONNECTED) {
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
    if (isAudioOnly && callState === CALL_STATES.CONNECTED) {
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

  // ─── Call End Handler ───────────────────────────────────────────────────────
  const handleCallEnd = useCallback(
    (reason = "user_hangup") => {
      haptic("heavy");
      signalingClient.hangUp(callId);
      webrtcEngine.cleanup();
      networkMonitor.stop();
      audioEngine.stop();
      if (durationTimer.current) clearInterval(durationTimer.current);
      navigation.goBack();
    },
    [callId, navigation],
  );

  // ─── Controls ───────────────────────────────────────────────────────────────
  const toggleMute = () => {
    haptic("light");
    const muted = webrtcEngine.toggleMute();
    setIsMuted(muted);
  };

  const toggleCamera = () => {
    haptic("light");
    const off = webrtcEngine.toggleCamera();
    setIsCameraOff(off);
  };

  const switchCamera = () => {
    haptic("light");
    webrtcEngine.switchCamera();
  };

  // ─── Formatters ─────────────────────────────────────────────────────────────
  const formatDuration = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  const getStatusText = () => {
    switch (callState) {
      case CALL_STATES.CALLING:
        return "Calling...";
      case CALL_STATES.RINGING:
        return "Ringing...";
      case CALL_STATES.CONNECTING:
        return "Connecting...";
      case CALL_STATES.RECONNECTING:
        return "Reconnecting...";
      case CALL_STATES.FAILED:
        return "Call Failed";
      case CALL_STATES.ENDED:
        return "Call Ended";
      case CALL_STATES.CONNECTED:
        return formatDuration(duration);
      default:
        return "";
    }
  };

  const isConnected = callState === CALL_STATES.CONNECTED;
  const isLive =
    callState === CALL_STATES.CONNECTED ||
    callState === CALL_STATES.RECONNECTING;

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
        <Text style={styles.avatarInitial}>
          {(callerName || "?").charAt(0).toUpperCase()}
        </Text>
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
              callState === CALL_STATES.RECONNECTING && {
                backgroundColor: colors.warning,
              },
            ]}
          />
        ))}
      </View>
      <Text style={styles.statusLabel}>{getStatusText()}</Text>
      {callState === CALL_STATES.RECONNECTING && (
        <Text style={styles.reconnectHint}>
          Network changed — restoring connection
        </Text>
      )}
    </View>
  );

  // ─── Render: Audio-Only Mode ───────────────────────────────────────────────
  const renderAudioOnly = () => (
    <View style={styles.audioOnlyContainer}>
      {/* Concentric pulse rings */}
      {ringAnims.map((anim, i) => (
        <Animated.View
          key={i}
          style={[
            styles.pulseRing,
            {
              opacity: anim.interpolate({
                inputRange: [0, 0.5, 1],
                outputRange: [0.4, 0.15, 0],
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
        <Text style={styles.audioAvatarText}>
          {(callerName || "?").charAt(0).toUpperCase()}
        </Text>
      </View>

      <Text style={styles.audioCallerName}>{callerName || "Unknown"}</Text>

      {/* Voice-reactive waveform */}
      <View style={styles.waveform}>
        {waveAnims.map((anim, i) => (
          <Animated.View
            key={i}
            style={[
              styles.waveBar,
              {
                transform: [{ scaleY: anim }],
                backgroundColor:
                  i % 3 === 0
                    ? colors.primary
                    : i % 3 === 1
                      ? colors.primaryLight
                      : colors.accent,
              },
            ]}
          />
        ))}
      </View>

      <Text style={styles.audioModeLabel}>Audio Only</Text>
    </View>
  );

  // ─── Render: Video Mode ────────────────────────────────────────────────────
  const renderVideoMode = () => (
    <View style={styles.videoContainer}>
      {/* Remote Video (full screen) */}
      {remoteStream && RTCView ? (
        <RTCView
          streamURL={remoteStream.toURL()}
          style={styles.remoteVideo}
          objectFit="cover"
          zOrder={0}
        />
      ) : (
        <View style={styles.remoteVideoPlaceholder}>
          <View style={styles.placeholderAvatar}>
            <Text style={styles.placeholderAvatarText}>
              {(callerName || "?").charAt(0).toUpperCase()}
            </Text>
          </View>
          <Text style={styles.waitingText}>Waiting for video...</Text>
        </View>
      )}

      {/* Local Video PiP */}
      {localStream && RTCView && !isCameraOff && (
        <Animated.View
          style={[
            styles.localPreview,
            {
              borderColor: glowAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [
                  "rgba(253, 214, 61, 0.3)",
                  "rgba(253, 214, 61, 0.7)",
                ],
              }),
            },
          ]}
        >
          <RTCView
            streamURL={localStream.toURL()}
            style={styles.localVideo}
            objectFit="cover"
            mirror={true}
            zOrder={1}
          />
        </Animated.View>
      )}
    </View>
  );

  // ─── Render: Control Button ────────────────────────────────────────────────
  const ControlButton = ({
    icon,
    label,
    active,
    danger,
    onPress,
    style: customStyle,
  }) => (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.controlBtn,
        active && styles.controlBtnActive,
        danger && styles.controlBtnDanger,
        customStyle,
      ]}
      activeOpacity={0.7}
    >
      <Text
        style={[
          styles.controlIcon,
          active && styles.controlIconActive,
          danger && styles.controlIconDanger,
        ]}
      >
        {icon}
      </Text>
      {label && (
        <Text
          style={[
            styles.controlLabel,
            active && styles.controlLabelActive,
            danger && styles.controlLabelDanger,
          ]}
        >
          {label}
        </Text>
      )}
    </TouchableOpacity>
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

      {/* ─── Top Bar (Gradient Overlay) ─────────────────────────────── */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.topBarContent}>
          <View style={styles.topLeft}>
            {isConnected && renderQualityBars()}
          </View>
          <View style={styles.topCenter}>
            <Text style={styles.topCallerName}>{callerName || "Unknown"}</Text>
            <Text
              style={[
                styles.topStatus,
                callState === CALL_STATES.RECONNECTING && {
                  color: colors.warning,
                },
              ]}
            >
              {getStatusText()}
            </Text>
          </View>
          <View style={styles.topRight}>
            {isAudioOnly && isConnected && (
              <View style={styles.audioOnlyBadge}>
                <Text style={styles.audioOnlyBadgeText}>🎤</Text>
              </View>
            )}
          </View>
        </View>
      </View>

      {/* ─── Stats Overlay ──────────────────────────────────────────── */}
      {renderStatsOverlay()}

      {/* ─── Bottom Controls (Glassmorphic) ─────────────────────────── */}
      <Animated.View
        style={[
          styles.controlBar,
          {
            paddingBottom: insets.bottom + 12,
            transform: [
              {
                translateY: controlsAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [120, 0],
                }),
              },
            ],
          },
        ]}
      >
        <View style={styles.controlBarInner}>
          {/* Row 1: Media Controls */}
          <View style={styles.controlRow}>
            <ControlButton
              icon={isMuted ? "🔇" : "🎙️"}
              label={isMuted ? "Unmute" : "Mute"}
              active={isMuted}
              onPress={toggleMute}
            />
            <ControlButton
              icon={isCameraOff ? "📷" : "📹"}
              label={isCameraOff ? "Camera On" : "Camera Off"}
              active={isCameraOff}
              onPress={toggleCamera}
            />
            <ControlButton icon="🔄" label="Flip" onPress={switchCamera} />
          </View>

          {/* End Call Button */}
          <Animated.View
            style={[
              styles.endCallWrapper,
              { transform: [{ scale: pulseAnim }] },
            ]}
          >
            <TouchableOpacity
              style={styles.endCallBtn}
              onPress={() => handleCallEnd("user_hangup")}
              activeOpacity={0.8}
            >
              <Text style={styles.endCallIcon}>📞</Text>
              <Text style={styles.endCallLabel}>End</Text>
            </TouchableOpacity>
          </Animated.View>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#050508",
  },

  // ─── Top Bar ───────────────────────────────────────────────────────
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 20,
    paddingBottom: 16,
    // Gradient overlay implemented via background + opacity
    backgroundColor: "rgba(5, 5, 16, 0.65)",
  },
  topBarContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  topLeft: { flex: 1, alignItems: "flex-start" },
  topCenter: { flex: 2, alignItems: "center" },
  topRight: { flex: 1, alignItems: "flex-end" },
  topCallerName: {
    ...typography.body,
    fontWeight: "600",
    color: "#fff",
    fontSize: 15,
  },
  topStatus: {
    fontSize: 13,
    color: "rgba(255,255,255,0.6)",
    marginTop: 2,
    fontWeight: "500",
  },

  // ─── Quality ──────────────────────────────────────────────────────
  qualityContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  qualityBars: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    height: 20,
  },
  qualityBar: {
    width: 4,
    borderRadius: 2,
  },
  qualityLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  // ─── Audio-Only Badge ─────────────────────────────────────────────
  audioOnlyBadge: {
    backgroundColor: "rgba(249, 115, 22, 0.2)",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: "rgba(249, 115, 22, 0.3)",
  },
  audioOnlyBadgeText: {
    fontSize: 14,
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
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(253, 214, 61, 0.1)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "rgba(253, 214, 61, 0.2)",
  },
  placeholderAvatarText: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.primary,
  },
  waitingText: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 14,
    marginTop: 16,
    fontWeight: "500",
  },

  // ─── Local PiP ────────────────────────────────────────────────────
  localPreview: {
    position: "absolute",
    top: 100,
    right: 16,
    width: 110,
    height: 155,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 2.5,
    ...shadows.lg,
  },
  localVideo: {
    width: "100%",
    height: "100%",
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
    backgroundColor: "rgba(253, 214, 61, 0.08)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "rgba(253, 214, 61, 0.2)",
    marginBottom: 20,
  },
  avatarInitial: {
    fontSize: 40,
    fontWeight: "800",
    color: colors.primary,
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
    backgroundColor: colors.primary,
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
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#050508",
  },
  pulseRing: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: colors.primary,
  },
  audioAvatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "rgba(253, 214, 61, 0.1)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "rgba(253, 214, 61, 0.25)",
    marginBottom: 16,
    zIndex: 1,
  },
  audioAvatarText: {
    fontSize: 40,
    fontWeight: "800",
    color: colors.primaryLight,
  },
  audioCallerName: {
    fontSize: 22,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 24,
    letterSpacing: -0.3,
  },
  waveform: {
    flexDirection: "row",
    alignItems: "center",
    height: 50,
    gap: 4,
  },
  waveBar: {
    width: 5,
    height: 40,
    borderRadius: 2.5,
  },
  audioModeLabel: {
    fontSize: 13,
    color: "rgba(255,255,255,0.35)",
    marginTop: 20,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
  },

  // ─── Control Bar (Glassmorphic) ───────────────────────────────────
  controlBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingTop: 16,
    paddingHorizontal: 16,
    backgroundColor: "rgba(10, 10, 15, 0.85)",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  controlBarInner: {
    alignItems: "center",
    gap: 16,
  },
  controlRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 20,
  },

  // ─── Control Buttons ──────────────────────────────────────────────
  controlBtn: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  controlBtnActive: {
    backgroundColor: "rgba(253, 214, 61, 0.15)",
    borderColor: "rgba(253, 214, 61, 0.3)",
  },
  controlBtnDanger: {
    backgroundColor: "rgba(239, 68, 68, 0.2)",
    borderColor: "rgba(239, 68, 68, 0.3)",
  },
  controlIcon: {
    fontSize: 22,
  },
  controlIconActive: {},
  controlIconDanger: {},
  controlLabel: {
    fontSize: 10,
    color: "rgba(255,255,255,0.55)",
    marginTop: 4,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  controlLabelActive: {
    color: colors.primaryLight,
  },
  controlLabelDanger: {
    color: colors.errorLight,
  },

  // ─── End Call Button ──────────────────────────────────────────────
  endCallWrapper: {
    marginTop: 4,
    marginBottom: 8,
  },
  endCallBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#ef4444",
    justifyContent: "center",
    alignItems: "center",
    ...shadows.lg,
    shadowColor: "#ef4444",
    shadowOpacity: 0.45,
    shadowRadius: 16,
  },
  endCallIcon: {
    fontSize: 24,
    transform: [{ rotate: "135deg" }],
  },
  endCallLabel: {
    fontSize: 10,
    color: "#fff",
    fontWeight: "700",
    marginTop: 2,
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
    color: colors.primaryLight,
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
});
