/**
 * Call Screen — Full-screen video/audio-only with premium design.
 * Features: remote video, self-preview, mute/camera toggle, end call,
 * network quality indicator, auto audio-only switch, waveform animation.
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Animated,
  StyleSheet,
  Dimensions,
  StatusBar,
  SafeAreaView,
} from "react-native";
import { RTCView } from "react-native-webrtc";
import webrtcEngine from "../services/webrtc";
import networkMonitor, { QUALITY_TIERS } from "../services/networkMonitor";
import audioEngine from "../services/audioEngine";
import signalingClient from "../services/socket";
import { colors, typography, spacing, radius, shadows } from "../styles/theme";

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

// Quality tier → color mapping
const QUALITY_COLORS = {
  excellent: colors.success,
  good: colors.successLight,
  fair: colors.warning,
  audio_only: colors.warning,
  critical: colors.error,
};

// Signal strength bars
const QUALITY_BARS = {
  excellent: 5,
  good: 4,
  fair: 3,
  audio_only: 2,
  critical: 1,
};

export default function CallScreen({ route, navigation }) {
  const {
    callId,
    targetUser,
    isCaller,
    callState: initialState,
  } = route.params;

  const [callState, setCallState] = useState(initialState || "connecting");
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isAudioOnly, setIsAudioOnly] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [qualityTier, setQualityTier] = useState(QUALITY_TIERS.EXCELLENT);
  const [stats, setStats] = useState(null);
  const [showStats, setShowStats] = useState(false);

  // Animations
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const waveAnims = useRef(
    [...Array(5)].map(() => new Animated.Value(0.3)),
  ).current;

  const durationTimer = useRef(null);
  const controlsTimer = useRef(null);

  // ─── Initialize WebRTC Call ───────────────────────────────────────────
  useEffect(() => {
    let mounted = true;

    const setupCall = async () => {
      // WebRTC engine callbacks
      webrtcEngine.onLocalStream = (stream) =>
        mounted && setLocalStream(stream);
      webrtcEngine.onRemoteStream = (stream) =>
        mounted && setRemoteStream(stream);
      webrtcEngine.onConnectionStateChange = (state) => {
        if (!mounted) return;
        if (state === "connected") {
          setCallState("connected");
          startDurationTimer();
        } else if (state === "failed" || state === "closed") {
          handleCallEnd("connection_failed");
        }
      };
      webrtcEngine.onModeSwitch = (mode, reason) => {
        if (!mounted) return;
        setIsAudioOnly(mode === "audio_only");
      };

      // Initialize WebRTC
      await webrtcEngine.initialize(callId, isCaller);

      // Start network monitoring
      networkMonitor.onQualityChange = (tier) =>
        mounted && setQualityTier(tier);
      networkMonitor.onStatsUpdate = (s) => mounted && setStats(s);
      networkMonitor.start(callId);

      // If caller, create offer
      if (isCaller) {
        // Wait for call-accepted signal
        signalingClient.on("call-accepted", async (data) => {
          if (data.callId === callId) {
            setCallState("connecting");
            await webrtcEngine.createOffer();
          }
        });
      }
    };

    // Signaling listeners
    const cleanups = [];

    cleanups.push(
      signalingClient.on("offer", async (data) => {
        if (data.callId === callId) {
          await webrtcEngine.handleOffer(data.sdp);
        }
      }),
    );

    cleanups.push(
      signalingClient.on("answer", async (data) => {
        if (data.callId === callId) {
          await webrtcEngine.handleAnswer(data.sdp);
        }
      }),
    );

    cleanups.push(
      signalingClient.on("ice-candidate", async (data) => {
        if (data.callId === callId) {
          await webrtcEngine.handleIceCandidate(data.candidate);
        }
      }),
    );

    cleanups.push(
      signalingClient.on("ice-restart", async (data) => {
        if (data.callId === callId) {
          await webrtcEngine.handleOffer(data.sdp);
        }
      }),
    );

    cleanups.push(
      signalingClient.on("call-ended", (data) => {
        if (data.callId === callId) {
          handleCallEnd("remote_hangup");
        }
      }),
    );

    cleanups.push(
      signalingClient.on("call-rejected", (data) => {
        if (data.callId === callId) {
          handleCallEnd("rejected");
        }
      }),
    );

    setupCall();

    return () => {
      mounted = false;
      cleanups.forEach((unsub) => unsub());
      webrtcEngine.cleanup();
      networkMonitor.stop();
      audioEngine.stop();
      if (durationTimer.current) clearInterval(durationTimer.current);
    };
  }, [callId]);

  // ─── Audio Waveform Animation (for audio-only mode) ──────────────────
  useEffect(() => {
    if (isAudioOnly && callState === "connected") {
      audioEngine.startMonitoring(remoteStream);

      // Animate waveform bars
      const animations = waveAnims.map((anim, i) => {
        return Animated.loop(
          Animated.sequence([
            Animated.timing(anim, {
              toValue: 0.3 + Math.random() * 0.7,
              duration: 200 + Math.random() * 300,
              useNativeDriver: true,
            }),
            Animated.timing(anim, {
              toValue: 0.1 + Math.random() * 0.3,
              duration: 200 + Math.random() * 300,
              useNativeDriver: true,
            }),
          ]),
        );
      });
      animations.forEach((a) => a.start());

      return () => {
        animations.forEach((a) => a.stop());
        audioEngine.stop();
      };
    }
  }, [isAudioOnly, callState, remoteStream]);

  // ─── Connecting Pulse Animation ──────────────────────────────────────
  useEffect(() => {
    if (callState === "ringing" || callState === "connecting") {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [callState]);

  // ─── Call Duration Timer ─────────────────────────────────────────────
  const startDurationTimer = () => {
    durationTimer.current = setInterval(() => {
      setCallDuration((prev) => prev + 1);
    }, 1000);
  };

  const formatDuration = (secs) => {
    const m = Math.floor(secs / 60)
      .toString()
      .padStart(2, "0");
    const s = (secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  // ─── Controls Auto-Hide ─────────────────────────────────────────────
  const toggleControls = () => {
    const visible = controlsOpacity._value > 0.5;
    Animated.timing(controlsOpacity, {
      toValue: visible ? 0 : 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  };

  // ─── Call Actions ────────────────────────────────────────────────────
  const handleMuteToggle = () => {
    const muted = webrtcEngine.toggleMute();
    setIsMuted(muted);
  };

  const handleCameraToggle = () => {
    const off = webrtcEngine.toggleCamera();
    setIsCameraOff(off);
  };

  const handleSwitchCamera = async () => {
    await webrtcEngine.switchCamera();
  };

  const handleCallEnd = useCallback(
    (reason = "user_hangup") => {
      signalingClient.hangUp(callId);
      webrtcEngine.cleanup();
      networkMonitor.stop();
      audioEngine.stop();
      if (durationTimer.current) clearInterval(durationTimer.current);
      navigation.goBack();
    },
    [callId, navigation],
  );

  // ─── Render Quality Indicator ────────────────────────────────────────
  const renderQualityBars = () => {
    const bars = QUALITY_BARS[qualityTier.name] || 3;
    const color = QUALITY_COLORS[qualityTier.name] || colors.textMuted;

    return (
      <TouchableOpacity
        style={styles.qualityContainer}
        onPress={() => setShowStats(!showStats)}
      >
        <View style={styles.qualityBars}>
          {[1, 2, 3, 4, 5].map((i) => (
            <View
              key={i}
              style={[
                styles.qualityBar,
                {
                  height: 4 + i * 3,
                  backgroundColor: i <= bars ? color : "rgba(255,255,255,0.15)",
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

  // ─── Render Stats Overlay ────────────────────────────────────────────
  const renderStatsOverlay = () => {
    if (!showStats || !stats) return null;
    const { averaged } = stats;

    return (
      <View style={styles.statsOverlay}>
        <Text style={styles.statsTitle}>Network Stats</Text>
        <Text style={styles.statLine}>
          📉 Packet Loss: {averaged.packetLoss.toFixed(1)}%
        </Text>
        <Text style={styles.statLine}>
          📊 Jitter: {averaged.jitter.toFixed(1)}ms
        </Text>
        <Text style={styles.statLine}>⏱ RTT: {averaged.rtt.toFixed(0)}ms</Text>
        <Text style={styles.statLine}>
          📶 Bandwidth: {(averaged.bandwidth / 1000).toFixed(0)}kbps
        </Text>
        <Text style={styles.statLine}>🎯 Tier: {qualityTier.name}</Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar hidden />

      {/* Remote Video (Full Screen) */}
      {remoteStream && !isAudioOnly ? (
        <TouchableOpacity
          style={styles.remoteVideo}
          activeOpacity={1}
          onPress={toggleControls}
        >
          <RTCView
            streamURL={remoteStream.toURL()}
            style={styles.rtcView}
            objectFit="cover"
            zOrder={0}
          />
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={styles.audioOnlyContainer}
          activeOpacity={1}
          onPress={toggleControls}
        >
          {/* Audio-Only Mode — Premium Waveform */}
          <View style={styles.audioOnlyContent}>
            <View style={styles.callerAvatar}>
              <Text style={styles.callerAvatarText}>
                {targetUser?.name?.charAt(0)?.toUpperCase() || "?"}
              </Text>
            </View>
            <Text style={styles.callerName}>
              {targetUser?.name || "Unknown"}
            </Text>

            {callState === "connected" ? (
              <>
                {isAudioOnly && (
                  <View style={styles.audioOnlyBadge}>
                    <Text style={styles.audioOnlyBadgeText}>🎙 Audio Only</Text>
                  </View>
                )}
                <View style={styles.waveform}>
                  {waveAnims.map((anim, i) => (
                    <Animated.View
                      key={i}
                      style={[
                        styles.waveBar,
                        {
                          transform: [{ scaleY: anim }],
                        },
                      ]}
                    />
                  ))}
                </View>
              </>
            ) : (
              <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                <Text style={styles.connectingText}>
                  {callState === "ringing" ? "Ringing..." : "Connecting..."}
                </Text>
              </Animated.View>
            )}
          </View>
        </TouchableOpacity>
      )}

      {/* Local Video Preview (Picture-in-Picture) */}
      {localStream && !isAudioOnly && !isCameraOff && (
        <View style={styles.localPreview}>
          <RTCView
            streamURL={localStream.toURL()}
            style={styles.localRtcView}
            objectFit="cover"
            mirror
            zOrder={1}
          />
        </View>
      )}

      {/* Top Bar — Duration + Quality */}
      <Animated.View style={[styles.topBar, { opacity: controlsOpacity }]}>
        <SafeAreaView style={styles.topBarInner}>
          {callState === "connected" ? (
            <View style={styles.durationContainer}>
              <View style={styles.liveDot} />
              <Text style={styles.durationText}>
                {formatDuration(callDuration)}
              </Text>
            </View>
          ) : (
            <View />
          )}
          {renderQualityBars()}
        </SafeAreaView>
      </Animated.View>

      {/* Stats Overlay */}
      {renderStatsOverlay()}

      {/* Bottom Controls */}
      <Animated.View
        style={[styles.bottomControls, { opacity: controlsOpacity }]}
      >
        <SafeAreaView style={styles.controlsRow}>
          {/* Mute Button */}
          <TouchableOpacity
            style={[styles.controlBtn, isMuted && styles.controlBtnActive]}
            onPress={handleMuteToggle}
          >
            <Text style={styles.controlIcon}>{isMuted ? "🔇" : "🎤"}</Text>
            <Text style={styles.controlLabel}>
              {isMuted ? "Unmute" : "Mute"}
            </Text>
          </TouchableOpacity>

          {/* End Call Button */}
          <TouchableOpacity
            style={styles.endCallBtn}
            onPress={() => handleCallEnd()}
          >
            <Text style={styles.endCallIcon}>📞</Text>
          </TouchableOpacity>

          {/* Camera Toggle */}
          <TouchableOpacity
            style={[
              styles.controlBtn,
              (isCameraOff || isAudioOnly) && styles.controlBtnActive,
            ]}
            onPress={isAudioOnly ? undefined : handleCameraToggle}
            disabled={isAudioOnly}
          >
            <Text style={styles.controlIcon}>
              {isCameraOff || isAudioOnly ? "📷" : "📹"}
            </Text>
            <Text style={styles.controlLabel}>
              {isCameraOff ? "Camera On" : "Camera Off"}
            </Text>
          </TouchableOpacity>

          {/* Switch Camera */}
          {!isAudioOnly && !isCameraOff && (
            <TouchableOpacity
              style={styles.controlBtn}
              onPress={handleSwitchCamera}
            >
              <Text style={styles.controlIcon}>🔄</Text>
              <Text style={styles.controlLabel}>Flip</Text>
            </TouchableOpacity>
          )}
        </SafeAreaView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },

  // Remote Video
  remoteVideo: { flex: 1 },
  rtcView: { flex: 1, width: SCREEN_W, height: SCREEN_H },

  // Audio-Only Mode
  audioOnlyContainer: { flex: 1, backgroundColor: colors.bg },
  audioOnlyContent: { flex: 1, justifyContent: "center", alignItems: "center" },
  callerAvatar: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.primary,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: spacing.lg,
    ...shadows.glow,
  },
  callerAvatarText: { fontSize: 48, fontWeight: "800", color: "#fff" },
  callerName: { ...typography.h2, marginBottom: spacing.md },
  connectingText: { ...typography.bodySmall, marginTop: spacing.md },
  audioOnlyBadge: {
    backgroundColor: "rgba(245, 158, 11, 0.15)",
    borderRadius: radius.full,
    paddingHorizontal: 16,
    paddingVertical: 6,
    marginBottom: spacing.lg,
  },
  audioOnlyBadgeText: { ...typography.caption, color: colors.warning },
  waveform: {
    flexDirection: "row",
    alignItems: "center",
    height: 60,
    gap: 6,
    marginTop: spacing.md,
  },
  waveBar: {
    width: 6,
    height: 40,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },

  // Local Preview (PiP)
  localPreview: {
    position: "absolute",
    top: 60,
    right: 16,
    width: 100,
    height: 140,
    borderRadius: radius.md,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.2)",
    ...shadows.lg,
  },
  localRtcView: { flex: 1 },

  // Top Bar
  topBar: { position: "absolute", top: 0, left: 0, right: 0 },
  topBarInner: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  durationContainer: { flexDirection: "row", alignItems: "center" },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.error,
    marginRight: 8,
  },
  durationText: { ...typography.body, fontWeight: "600", color: "#fff" },

  // Quality Indicator
  qualityContainer: { flexDirection: "row", alignItems: "center" },
  qualityBars: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    marginRight: 6,
  },
  qualityBar: { width: 4, borderRadius: 2 },
  qualityLabel: { ...typography.caption },

  // Stats Overlay
  statsOverlay: {
    position: "absolute",
    top: 100,
    left: spacing.lg,
    backgroundColor: "rgba(0,0,0,0.8)",
    borderRadius: radius.md,
    padding: spacing.md,
    ...shadows.md,
  },
  statsTitle: {
    ...typography.label,
    marginBottom: spacing.sm,
    color: colors.primary,
  },
  statLine: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: 4,
  },

  // Bottom Controls
  bottomControls: { position: "absolute", bottom: 0, left: 0, right: 0 },
  controlsRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: spacing.lg,
    gap: 24,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  controlBtn: {
    alignItems: "center",
    justifyContent: "center",
    width: 60,
    height: 72,
  },
  controlBtnActive: { opacity: 0.5 },
  controlIcon: { fontSize: 28, marginBottom: 4 },
  controlLabel: { ...typography.caption, color: "#fff", fontSize: 10 },
  endCallBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.error,
    justifyContent: "center",
    alignItems: "center",
    transform: [{ rotate: "135deg" }],
    ...shadows.md,
  },
  endCallIcon: { fontSize: 28 },
});
