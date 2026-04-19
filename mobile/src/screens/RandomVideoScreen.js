/**
 * RandomVideoScreen â€” FAANG-Grade Random Video Chat UI.
 *
 * States:
 *   idle â†’ searching â†’ connecting â†’ connected â†’ ended â†’ (auto-rematch â†’ searching)
 *
 * Features:
 *   - Permission gate (camera + mic)
 *   - ToS acknowledgment gate
 *   - Pulsing radar animation while searching
 *   - Split view video (remote large, local PIP)
 *   - Next button with 3s cooldown
 *   - Report button with confirmation modal
 *   - Mute / camera / switch camera controls
 *   - 3:00 countdown timer
 *   - Auto-rematch with seamless transition
 *   - Graceful handling of all failure states
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Dimensions,
  Modal,
  PanResponder,
  Platform,
  StatusBar,
  Image,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import useMatchmaking, { STATES } from '../hooks/useMatchmaking';
import useMediaPermissions from '../hooks/useMediaPermissions';
import WorldVideoTosModal from '../components/WorldVideoTosModal';
import apiClient from '../services/api';
import { endpoints } from '../config/api';
import { colors, typography, spacing, radius, shadows } from '../styles/theme';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const SESSION_DURATION_S = 180; // 3 minutes
const WORLD_ANON_LOGO = require('../../assets/icon.png');

// â”€â”€â”€ Conditional WebRTC Import â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let RTCView = null;
let WEBRTC_AVAILABLE = false;
if (Platform.OS !== 'web') {
  try {
    RTCView = require('react-native-webrtc').RTCView;
    WEBRTC_AVAILABLE = true;
  } catch {}
}

export default function RandomVideoScreen({ navigation, onActiveChange, onBack }) {
  const insets = useSafeAreaInsets();
  const topInset = Math.max(insets.top, 12);
  const bottomInset = Math.max(insets.bottom, 12);

  const [tosAccepted, setTosAccepted] = useState(false);
  const [tosChecked, setTosChecked] = useState(false);
  const [showTosModal, setShowTosModal] = useState(true);
  const [showReportModal, setShowReportModal] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [selectedReportReason, setSelectedReportReason] = useState(null);
  const radarAnim = useRef(new Animated.Value(0)).current;
  const controlsAnim = useRef(new Animated.Value(1)).current;
  const hideTimerRef = useRef(null);

  const {
    state,
    sessionId,
    peerToken,
    role,
    localStream,
    remoteStream,
    timeRemaining,
    nextCooldown,
    error,
    micMuted: muted,
    speakerOn,
    cameraOff,
    joinQueue,
    leaveQueue,
    nextMatch,
    reportUser,
    toggleSpeaker,
    toggleMute,
    toggleCamera,
    switchCamera,
    isSearching,
    isConnected,
    isActive,
    isVideoActive,
    remoteCameraOff, // â˜… peer camera state
    peerProfile,
    remoteVideoReady,
  } = useMatchmaking({ autoRematch: true });

  const peerDisplayName = "Anonymous";
  const peerAvatarSource =
    peerProfile?.avatarUrl && peerProfile.avatarUrl.startsWith("http")
      ? { uri: peerProfile.avatarUrl }
      : WORLD_ANON_LOGO;

  const {
    cameraStatus,
    micStatus,
    isReady: permissionsReady,
    isPermanentlyDenied,
    requestPermissions,
    openSettings,
  } = useMediaPermissions();

  useEffect(() => {
    if (onActiveChange) {
      onActiveChange(state !== STATES.IDLE);
    }
  }, [state, onActiveChange]);

  const handleGoBack = useCallback(() => {
    if (onBack) onBack();
    else navigation?.goBack();
  }, [onBack, navigation]);

  // â”€â”€â”€ Tap-to-hide controls (like private CallScreen) â”€â”€â”€
  const scheduleControlsAutoHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (!isActive) return;
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 3500);
  }, [isActive]);

  useEffect(() => {
    Animated.timing(controlsAnim, {
      toValue: controlsVisible ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [controlsVisible, controlsAnim]);

  useEffect(() => {
    scheduleControlsAutoHide();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [scheduleControlsAutoHide]);

  const toggleControls = useCallback(() => {
    setControlsVisible((v) => {
      const next = !v;
      if (next) setTimeout(() => scheduleControlsAutoHide(), 0);
      return next;
    });
  }, [scheduleControlsAutoHide]);

  // â”€â”€â”€ Draggable PiP with spring + edge snap (reused from CallScreen) â”€â”€â”€
  const pipPan = useRef(new Animated.ValueXY()).current;
  const pipScale = useRef(new Animated.Value(1)).current;
  const panValue = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const listener = pipPan.addListener((value) => {
      panValue.current = value;
    });
    return () => pipPan.removeListener(listener);
  }, [pipPan]);

  const pipPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        pipPan.setOffset({ x: panValue.current.x, y: panValue.current.y });
        pipPan.setValue({ x: 0, y: 0 });
        Animated.spring(pipScale, {
          toValue: 0.96,
          friction: 7,
          useNativeDriver: false,
        }).start();
      },
      onPanResponderMove: Animated.event([null, { dx: pipPan.x, dy: pipPan.y }], {
        useNativeDriver: false,
      }),
      onPanResponderRelease: (e, gestureState) => {
        pipPan.flattenOffset();

        const velocityX = gestureState.vx || 0;
        const velocityY = gestureState.vy || 0;

        const pipWidth = 120;
        const pipHeight = 168;
        const margin = 16;

        const controlsSpace = 170 + bottomInset;
        const minY = 0;
        const maxY = Math.max(0, SCREEN_H - pipHeight - controlsSpace - topInset);

        let projectedY = panValue.current.y + velocityY * 140;
        let finalY = projectedY;
        if (finalY < minY) finalY = minY;
        if (finalY > maxY) finalY = maxY;

        const leftX = 0;
        const rightX = Math.max(0, SCREEN_W - pipWidth - margin * 2);
        let projectedX = panValue.current.x + velocityX * 140;
        const finalX = projectedX > rightX / 2 ? rightX : leftX;

        Animated.parallel([
          Animated.spring(pipPan, {
            toValue: { x: finalX, y: finalY },
            damping: 15,
            stiffness: 160,
            mass: 0.8,
            useNativeDriver: false,
          }),
          Animated.spring(pipScale, {
            toValue: 1,
            friction: 7,
            useNativeDriver: false,
          }),
        ]).start();
      },
    }),
  ).current;

  // â”€â”€â”€ Check ToS on mount â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    if (!tosChecked) {
      checkTos();
    }
  }, []);

  const checkTos = async () => {
    try {
      const data = await apiClient.get(endpoints.worldVideo.tosStatus);
      if (data.accepted) {
        setTosAccepted(true);
        setShowTosModal(false);
      }
    } catch {
      // Not accepted yet â€” show modal
    }
    setTosChecked(true);
  };

  const handleTosAccept = async () => {
    try {
      await apiClient.post(endpoints.worldVideo.acceptTos, { version: '1.0' });
      setTosAccepted(true);
      setShowTosModal(false);
    } catch (err) {
      console.error('ToS accept error:', err);
    }
  };

  // â”€â”€â”€ Radar pulse animation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    if (!isSearching) return;

    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(radarAnim, { toValue: 1, duration: 1500, useNativeDriver: true }),
        Animated.timing(radarAnim, { toValue: 0, duration: 1500, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [isSearching]);

  // â”€â”€â”€ Handle Next â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleNext = useCallback(() => {
    if (nextCooldown) return;
    nextMatch();
  }, [nextMatch, nextCooldown]);

  // â”€â”€â”€ Mute toggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleMute = useCallback(() => {
    toggleMute();
  }, [toggleMute]);

  const handleSpeaker = useCallback(() => {
    toggleSpeaker();
  }, [toggleSpeaker]);

  // â”€â”€â”€ Camera toggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleCameraToggle = useCallback(() => {
    toggleCamera();
  }, [toggleCamera]);

  // â”€â”€â”€ Report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleReport = useCallback(async (reason) => {
    setShowReportModal(false);
    await reportUser(reason);
  }, [reportUser]);

  // â”€â”€â”€ Format time â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // â”€â”€â”€ Loading Gate with Timeout Failsafe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // â˜… Prevents infinite spinner: if permission check or ToS API hangs, the
  // gate automatically falls through after 3 seconds so the user always sees
  // actionable UI (permission request button or ToS modal) instead of a dead spinner.
  const [gateTimeout, setGateTimeout] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setGateTimeout(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  const isGateBlocked = !gateTimeout && (cameraStatus === 'undetermined' || !tosChecked);

  if (isGateBlocked) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  // â”€â”€â”€ Permission Gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!permissionsReady && !isPermanentlyDenied) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
        <View style={styles.centerContent}>
          <View style={styles.iconCircle}>
            <Icon name="camera" size={48} color={colors.primary} />
          </View>
          <Text style={styles.title}>Camera & Microphone</Text>
          <Text style={styles.subtitle}>
            Video chat requires camera and microphone access to connect you with others.
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={requestPermissions}>
            <Text style={styles.primaryButtonText}>Enable Permissions</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (isPermanentlyDenied) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
        <View style={styles.centerContent}>
          <View style={styles.iconCircle}>
            <Icon name="camera-off" size={48} color={colors.error} />
          </View>
          <Text style={styles.title}>Permissions Denied</Text>
          <Text style={styles.subtitle}>
            Camera and microphone permissions are required for video chat.
            Please enable them in your device Settings.
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={openSettings}>
            <Text style={styles.primaryButtonText}>Open Settings</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={handleGoBack}>
            <Text style={styles.secondaryButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // â”€â”€â”€ ToS Gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!tosAccepted) {
    return (
      <>
        <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
          <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
        </SafeAreaView>
        <WorldVideoTosModal
          visible={showTosModal}
          onAccept={handleTosAccept}
          onDecline={handleGoBack}
        />
      </>
    );
  }

  // â”€â”€â”€ Idle State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (state === STATES.IDLE) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
        <View style={styles.centerContent}>
          <View style={styles.radarCircle}>
            <Animated.View
              style={[
                styles.radarPulse,
                {
                  transform: [{ scale: radarAnim }],
                },
              ]}
            />
            <Icon name="globe" size={56} color={colors.primary} />
          </View>
          <Text style={styles.title}>Random Video Chat</Text>
          <Text style={styles.subtitle}>
            Connect instantly with someone new.{"\n"}Tap below to start.
          </Text>

          {error && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <TouchableOpacity style={styles.primaryButton} onPress={joinQueue}>
            <Icon name="video" size={22} color="#fff" />
            <Text style={styles.primaryButtonText}>Start Video Chat</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryButton} onPress={handleGoBack}>
            <Text style={styles.secondaryButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // â”€â”€â”€ Searching State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (isSearching) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
        <View style={styles.centerContent}>
          <View style={styles.radarCircle}>
            <Animated.View
              style={[
                styles.radarPulse,
                { transform: [{ scale: radarAnim }] },
              ]}
            />
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
          <Text style={styles.title}>Finding someone...</Text>
          <Text style={styles.subtitle}>
            Connecting you with a random person
          </Text>
          <TouchableOpacity style={styles.cancelButton} onPress={leaveQueue}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // â”€â”€â”€ Connecting / Video Active State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const isConnecting = [STATES.MATCHED, STATES.OFFERING, STATES.ANSWERING, STATES.ICE_GATHERING, STATES.ICE_CHECKING, STATES.RECONNECTING].includes(state);
  const showPeerCameraOff = !!remoteCameraOff;
  const showPeerPlaceholder = !remoteStream || showPeerCameraOff;

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <StatusBar translucent barStyle="light-content" backgroundColor="transparent" />

      {/* â”€â”€â”€ Remote Video (Full Screen) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <Pressable style={styles.remoteVideoContainer} onPress={toggleControls}>
        {showPeerPlaceholder ? (
          <View style={styles.remotePlaceholder}>
            <View style={styles.remotePlaceholderAvatar}>
              <Image source={peerAvatarSource} style={styles.remotePlaceholderAvatarImg} />
            </View>
            <Text style={styles.remotePlaceholderName} numberOfLines={1}>
              {peerDisplayName}
            </Text>
            {showPeerCameraOff ? (
              <View style={styles.remotePlaceholderStatusRow}>
                <Icon name="camera-off" size={18} color="rgba(255,255,255,0.8)" />
                <Text style={styles.remotePlaceholderStatusText}>Camera off</Text>
              </View>
            ) : isConnecting ? (
              <View style={styles.remotePlaceholderStatusRow}>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.remotePlaceholderStatusText}>Connecting…</Text>
              </View>
            ) : isConnected ? (
              <View style={styles.remotePlaceholderStatusRow}>
                <Icon name="user-x" size={18} color="rgba(255,255,255,0.8)" />
                <Text style={styles.remotePlaceholderStatusText}>Waiting for video…</Text>
              </View>
            ) : (
              <View style={styles.remotePlaceholderStatusRow}>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.remotePlaceholderStatusText}>Waiting…</Text>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.remoteVideo}>
            <RTCView
              key={`remote-${sessionId || "na"}-${showPeerCameraOff ? "off" : "on"}`}
              streamURL={remoteStream.toURL()}
              style={styles.remoteVideo}
              objectFit="cover"
              mirror={false}
              zOrder={0}
            />
            {!remoteVideoReady && (
              <View style={styles.remoteWarmupOverlay} pointerEvents="none">
                <View style={styles.remoteWarmupCard}>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.remoteWarmupText}>
                    Loading video…
                  </Text>
                </View>
              </View>
            )}
          </View>
        )}

        {/* â”€â”€â”€ Local Video (PIP) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {localStream && (
          <Animated.View
            {...pipPanResponder.panHandlers}
            style={[
              styles.localPip,
              {
                top: topInset + 12,
                transform: [
                  { translateX: pipPan.x },
                  { translateY: pipPan.y },
                  { scale: pipScale },
                ],
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
            {/* PIP top-left mute: stays visible when muted even if controls are hidden */}
            <Animated.View
              pointerEvents={controlsVisible ? 'auto' : 'none'}
              style={[
                styles.pipTopLeft,
                { opacity: muted ? 1 : controlsAnim },
              ]}
            >
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={muted ? "Unmute microphone" : "Mute microphone"}
                style={[styles.pipIconBtn, muted && styles.pipIconBtnDanger]}
                onPress={handleMute}
                disabled={!isVideoActive}
              >
                <Icon name={muted ? "mic-off" : "mic"} size={16} color="#fff" />
              </TouchableOpacity>
            </Animated.View>

            {/* PIP bottom-right quick action (flip camera) */}
            <Animated.View
              pointerEvents={controlsVisible ? 'auto' : 'none'}
              style={[styles.pipBottomRight, { opacity: controlsAnim }]}
            >
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Flip camera"
                style={styles.pipIconBtn}
                onPress={switchCamera}
                disabled={!isVideoActive}
              >
                <Icon name="refresh-ccw" size={16} color="#fff" />
              </TouchableOpacity>
            </Animated.View>
            {cameraOff && (
              <View style={styles.cameraOffOverlay}>
                <Icon name="camera-off" size={24} color="#fff" />
              </View>
            )}
            {cameraOff && (
              <View style={styles.localBadges}>
                {cameraOff && (
                  <View style={[styles.badge, styles.badgeMuted]}>
                    <Icon name="camera-off" size={14} color="#fff" />
                  </View>
                )}
              </View>
            )}
          </Animated.View>
        )}

        {/* â”€â”€â”€ Timer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {isConnected && timeRemaining > 0 && (
          <Animated.View
            pointerEvents={controlsVisible ? 'auto' : 'none'}
            style={[
              styles.timerBadge,
              { top: topInset + 8, right: 16 },
              { opacity: controlsAnim },
            ]}
          >
            <Icon name="clock" size={14} color="#fff" />
            <Text style={styles.timerText}>{formatTime(timeRemaining)}</Text>
          </Animated.View>
        )}

        {/* â”€â”€â”€ Mute Indicator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {/* Mute/camera state badges are anchored to local PIP (prevents floating indicators). */}

        {/* Report button: always visible (do not hide with controls) */}
        <View
          style={[
            styles.reportFab,
            {
              top: isConnected && timeRemaining > 0 ? topInset + 54 : topInset + 12,
              right: 16,
            },
          ]}
        >
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Report user"
            style={styles.reportFabBtn}
            onPress={() => setShowReportModal(true)}
            disabled={!isActive}
          >
            <Icon name="flag" size={18} color="#fff" />
          </TouchableOpacity>
        </View>

      </Pressable>

      {/* â”€â”€â”€ Bottom Controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <Animated.View
        pointerEvents={controlsVisible ? 'auto' : 'none'}
        style={[
          styles.controlsWrap,
          { paddingBottom: 12 + bottomInset },
          {
            opacity: controlsAnim,
            transform: [
              {
                translateY: controlsAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [18, 0],
                }),
              },
            ],
          },
        ]}
      >
        <View style={styles.controlsPill}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={speakerOn ? "Speaker off" : "Speaker on"}
            style={[styles.pillButton, speakerOn && styles.pillButtonActive]}
            onPress={handleSpeaker}
            disabled={!isVideoActive}
          >
            <Icon name={speakerOn ? "volume-2" : "volume-1"} size={20} color="#fff" />
          </TouchableOpacity>

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={muted ? "Unmute microphone" : "Mute microphone"}
            style={[styles.pillButton, muted && styles.pillButtonDanger]}
            onPress={handleMute}
            disabled={!isVideoActive}
          >
            <Icon name={muted ? "mic-off" : "mic"} size={20} color="#fff" />
          </TouchableOpacity>

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="End call"
            style={[
              styles.pillButton,
              styles.pillButtonEnd,
              !isActive && styles.pillButtonDisabled,
            ]}
            onPress={leaveQueue}
            disabled={!isActive}
          >
            <Icon name="phone-off" size={20} color="#fff" />
          </TouchableOpacity>

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={cameraOff ? "Show camera" : "Hide camera"}
            style={[styles.pillButton, cameraOff && styles.pillButtonDangerMuted]}
            onPress={handleCameraToggle}
            disabled={!isVideoActive}
          >
            <Icon name={cameraOff ? "camera-off" : "camera"} size={20} color="#fff" />
          </TouchableOpacity>

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Next match"
            style={[
              styles.pillButton,
              styles.pillButtonPrimary,
              (nextCooldown || !isActive) && styles.pillButtonDisabled,
            ]}
            onPress={handleNext}
            disabled={nextCooldown || !isActive}
          >
            <Icon name="skip-forward" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* â”€â”€â”€ Report Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <Modal visible={showReportModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <Text style={styles.modalTitle}>Report User</Text>
            <Text style={styles.modalSubtitle}>
              This will end the session and block further matches with this person.
            </Text>

            {['inappropriate', 'harassment', 'spam', 'underage', 'violence', 'other'].map((reason) => (
              <TouchableOpacity
                key={reason}
                style={[
                  styles.reportOption,
                  selectedReportReason === reason && styles.reportOptionSelected,
                ]}
                onPress={() => setSelectedReportReason(reason)}
              >
                <Text style={[
                  styles.reportOptionText,
                  selectedReportReason === reason && styles.reportOptionTextSelected,
                ]}>
                  {reason.charAt(0).toUpperCase() + reason.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => { setShowReportModal(false); setSelectedReportReason(null); }}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalConfirmButton, !selectedReportReason && styles.modalConfirmDisabled]}
                disabled={!selectedReportReason}
                onPress={() => selectedReportReason && handleReport(selectedReportReason)}
              >
                <Text style={styles.modalConfirmText}>Report & End</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xl,
  },
  iconCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: colors.bgElevated,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    ...typography.h2,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: spacing.xl,
    lineHeight: 22,
  },
  radarCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.bgElevated,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xl,
    position: 'relative',
  },
  radarPulse: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: `${colors.primary}20`,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    paddingVertical: 16,
    paddingHorizontal: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    width: '100%',
    maxWidth: 320,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  secondaryButton: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: '500',
  },
  cancelButton: {
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelButtonText: {
    color: colors.textSecondary,
    fontSize: 16,
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: '#fef2f2',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
    width: '100%',
    maxWidth: 320,
  },
  errorText: {
    color: colors.error || '#ef4444',
    fontSize: 14,
    textAlign: 'center',
  },
  // â”€â”€â”€ Video Layout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  remoteVideoContainer: {
    flex: 1,
    position: 'relative',
  },
  remoteVideo: {
    flex: 1,
    backgroundColor: '#111',
  },
  noRemoteVideo: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111',
  },
  remotePlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0b0b0b',
    paddingHorizontal: 28,
  },
  remotePlaceholderAvatar: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 14,
    overflow: 'hidden',
  },
  remotePlaceholderAvatarImg: {
    width: 92,
    height: 92,
  },
  remotePlaceholderName: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 10,
    maxWidth: '90%',
    textAlign: 'center',
  },
  remotePlaceholderStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  remotePlaceholderStatusText: {
    color: 'rgba(255,255,255,0.80)',
    fontSize: 14,
    fontWeight: '600',
  },
  remoteWarmupOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.22)',
    zIndex: 3,
  },
  remoteWarmupCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  remoteWarmupText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    fontWeight: '600',
  },
  connectingText: {
    color: '#aaa',
    fontSize: 16,
    marginTop: spacing.md,
  },
  localPip: {
    position: 'absolute',
    left: 16,
    width: 120,
    height: 168,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#222',
    ...shadows.md,
    zIndex: 2,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  localVideo: {
    flex: 1,
  },
  cameraOffOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  timerBadge: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    zIndex: 3,
  },
  timerText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  localBadges: {
    position: 'absolute',
    top: 8,
    right: 8,
    gap: 6,
    zIndex: 4,
  },
  badge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  badgeDanger: {
    backgroundColor: 'rgba(239,68,68,0.92)',
  },
  badgeMuted: {
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  pipTopLeft: {
    position: 'absolute',
    top: 8,
    left: 8,
    zIndex: 5,
  },
  pipBottomRight: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    zIndex: 5,
  },
  pipTopRow: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 5,
  },
  pipIconBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  pipIconBtnDanger: {
    backgroundColor: 'rgba(239,68,68,0.85)',
    borderColor: 'rgba(239,68,68,0.70)',
  },
  reportFab: {
    position: 'absolute',
    zIndex: 5,
  },
  reportFabBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  // â˜… Bug 5: Remote camera off overlay
  remoteCameraOffOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 2,
  },
  cameraOffText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 12,
  },
  // â”€â”€â”€ Controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(12,12,12,0.92)',
    paddingTop: 14,
    paddingHorizontal: 18,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  controlButton: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: 'rgba(255,255,255,0.10)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  controlLabel: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
    marginTop: 2,
  },
  controlActive: {
    backgroundColor: 'rgba(239,68,68,0.65)',
    borderColor: 'rgba(239,68,68,0.6)',
  },
  controlDisabled: {
    opacity: 0.4,
  },
  nextButton: {
    backgroundColor: colors.primary,
    borderColor: `${colors.primary}AA`,
  },
  reportButton: {
    backgroundColor: 'rgba(239,68,68,0.16)',
    borderColor: 'rgba(239,68,68,0.40)',
  },
  endButton: {
    backgroundColor: '#ff3b30',
    borderColor: 'rgba(255,59,48,0.75)',
  },
  // Premium Controls (reference-style pill)
  controlsWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  controlsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 28,
    backgroundColor: 'rgba(18,18,18,0.88)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  pillButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  pillButtonActive: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderColor: 'rgba(255,255,255,0.18)',
  },
  pillButtonPrimary: {
    backgroundColor: `${colors.primary}CC`,
    borderColor: `${colors.primary}DD`,
  },
  pillButtonEnd: {
    backgroundColor: '#ff3b30',
    borderColor: 'rgba(255,59,48,0.75)',
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  pillButtonDanger: {
    backgroundColor: 'rgba(239,68,68,0.65)',
    borderColor: 'rgba(239,68,68,0.55)',
  },
  pillButtonDangerMuted: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderColor: 'rgba(255,255,255,0.14)',
  },
  pillButtonDisabled: {
    opacity: 0.45,
  },
  // â”€â”€â”€ Report Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  modalContainer: {
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    padding: spacing.xl,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: {
    ...typography.h3,
    marginBottom: spacing.sm,
  },
  modalSubtitle: {
    ...typography.bodySmall,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  reportOption: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  reportOptionSelected: {
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}10`,
  },
  reportOptionText: {
    ...typography.body,
    color: colors.textSecondary,
  },
  reportOptionTextSelected: {
    color: colors.primary,
    fontWeight: '600',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
  },
  modalCancelButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  modalCancelText: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: '600',
  },
  modalConfirmButton: {
    backgroundColor: '#ef4444',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: radius.md,
  },
  modalConfirmDisabled: {
    opacity: 0.4,
  },
  modalConfirmText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
