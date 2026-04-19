/**
 * useMatchmaking â€” FAANG-Grade Random Video Chat State Machine.
 *
 * State machine with explicit transitions:
 *   idle â†’ searching â†’ matched â†’ offering | answering â†’
 *   iceGathering â†’ iceChecking â†’ connected â†’ ending â†’ ended
 *
 * On 'ended' with autoRematch=true, automatically transitions to 'searching'.
 * Includes 3-minute countdown timer, ICE restart logic, and ephemeral token management.
 *
 * â˜… Reuses the existing webrtcEngine for WebRTC (does NOT create a separate peer).
 * â˜… Uses ephemeral tokens for identity â€” real userId never exposed to peer.
 * â˜… Server-enforced session timeout via Redis TTL (client timer is UX-only).
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import signalingClient from '../services/socket';
import webrtcEngine from '../services/webrtc';
import crashLogger, { CATEGORIES } from '../services/CrashLogger';
import apiClient from '../services/api';
import { endpoints } from '../config/api';

// Try to get RTCSessionDescription for proper SDP extraction
let RTCSessionDescription;
try {
  const webrtc = require('react-native-webrtc');
  RTCSessionDescription = webrtc.RTCSessionDescription;
} catch (e) {
  RTCSessionDescription = null;
}

const STATES = {
  IDLE: 'idle',
  SEARCHING: 'searching',
  MATCHED: 'matched',
  OFFERING: 'offering',
  ANSWERING: 'answering',
  ICE_GATHERING: 'iceGathering',
  ICE_CHECKING: 'iceChecking',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ENDING: 'ending',
  ENDED: 'ended',
};

// Valid state transitions (prevents illegal jumps)
const VALID_TRANSITIONS = {
  [STATES.IDLE]: [STATES.SEARCHING],
  [STATES.SEARCHING]: [STATES.MATCHED, STATES.IDLE],
  [STATES.MATCHED]: [STATES.OFFERING, STATES.ANSWERING, STATES.IDLE, STATES.ENDING],
  [STATES.OFFERING]: [STATES.ICE_GATHERING, STATES.IDLE, STATES.ENDING],
  [STATES.ANSWERING]: [STATES.ICE_GATHERING, STATES.IDLE, STATES.ENDING],
  [STATES.ICE_GATHERING]: [STATES.ICE_CHECKING, STATES.IDLE, STATES.ENDING],
  [STATES.ICE_CHECKING]: [STATES.CONNECTED, STATES.RECONNECTING, STATES.IDLE, STATES.ENDING],
  [STATES.CONNECTED]: [STATES.RECONNECTING, STATES.ENDING],
  [STATES.RECONNECTING]: [STATES.CONNECTED, STATES.ENDING],
  [STATES.ENDING]: [STATES.ENDED],
  [STATES.ENDED]: [STATES.SEARCHING, STATES.IDLE],
};

// Timeouts
const SEARCH_TIMEOUT_MS = 30000;
const MATCHED_TIMEOUT_MS = 5000;
const ICE_CHECKING_TIMEOUT_MS = 20000;
const RECONNECTING_TIMEOUT_MS = 10000;
const SESSION_DURATION_MS = 3 * 60 * 1000; // 3 minutes
const ICE_RESTART_MAX = 3;
const NEXT_COOLDOWN_MS = 3000;

export { STATES };

export default function useMatchmaking({ autoRematch = true } = {}) {
  const [state, setState] = useState(STATES.IDLE);
  const stateRef = useRef(STATES.IDLE);
  const [peerToken, setPeerToken] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const sessionIdRef = useRef(null); // â˜… Synchronous access for event handlers (avoids stale closures)
  const [role, setRole] = useState(null); // 'caller' | 'callee'
  const [expiresAt, setExpiresAt] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [nextCooldown, setNextCooldown] = useState(false);
  const [error, setError] = useState(null);
  const [remoteCameraOff, setRemoteCameraOff] = useState(false); // â˜… Bug 5: track peer camera state
  const [peerProfile, setPeerProfile] = useState(null);
  const [remoteVideoReady, setRemoteVideoReady] = useState(false);
  const remoteCameraKnownRef = useRef(false);
  const remoteStreamStartedAtRef = useRef(0);
  const remoteProbeRef = useRef({ interval: null, deadline: 0 });

  // Local media UX state (single source of truth comes from webrtcEngine intent).
  const [micMuted, setMicMuted] = useState(() =>
    typeof webrtcEngine.getMicMuted === 'function' ? webrtcEngine.getMicMuted() : false,
  );
  const [speakerOn, setSpeakerOn] = useState(() =>
    typeof webrtcEngine.getSpeakerOn === 'function' ? webrtcEngine.getSpeakerOn() : false,
  );
  const [cameraOff, setCameraOff] = useState(() =>
    typeof webrtcEngine.getCameraOff === 'function' ? webrtcEngine.getCameraOff() : false,
  );

  // Refs for timers and cleanup
  const timersRef = useRef({});
  const iceRestartCountRef = useRef(0);
  const sessionStartRef = useRef(null);
  const signalingUnsubsRef = useRef([]);
  const appStateRef = useRef('active');
  const backgroundedAtRef = useRef(null);
  const sessionGenerationRef = useRef(0); // â˜… Bug 3: generation-based stale callback prevention
  const lastEndedSessionIdRef = useRef(null); // â˜… Prevent repeated end loops (duplicate timers/events)

  // â˜… Indirection to avoid stale closures across rematches
  const handlersRef = useRef({
    handleSessionEnd: () => {},
    nextMatch: () => {},
    initWebRTC: () => {},
    joinQueue: () => {},
  });

  // â”€â”€â”€ Timer Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const clearAllTimers = useCallback(() => {
    Object.values(timersRef.current).forEach((t) => clearTimeout(t));
    timersRef.current = {};
  }, []);

  const setTimer = useCallback((name, fn, delay) => {
    clearTimeout(timersRef.current[name]);
    timersRef.current[name] = setTimeout(fn, delay);
  }, []);

  // â”€â”€â”€ State Transition â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const transition = useCallback((newState) => {
    setState((prev) => {
      const allowed = VALID_TRANSITIONS[prev];
      if (!allowed || !allowed.includes(newState)) {
        console.warn(`ðŸ”„ Matchmaking: ILLEGAL transition ${prev} â†’ ${newState} â€” REJECTED`);
        return prev;
      }
      console.log(`ðŸ”„ Matchmaking: ${prev} â†’ ${newState}`);
      stateRef.current = newState;
      return newState;
    });
  }, []);

  // â”€â”€â”€ Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const cleanup = useCallback(() => {
    clearAllTimers();
    signalingUnsubsRef.current.forEach((unsub) => { try { unsub(); } catch {} });
    signalingUnsubsRef.current = [];
    // â˜… Bug 3: Increment generation to invalidate any in-flight callbacks
    sessionGenerationRef.current++;
    console.log(`[CLEANUP] sessionId=${sessionIdRef.current} generation=${sessionGenerationRef.current}`);
    webrtcEngine.cleanup();
    setLocalStream(null);
    setRemoteStream(null);
    setPeerToken(null);
    setSessionId(null);
    setRole(null);
    setExpiresAt(null);
    setError(null);
    setRemoteCameraOff(false); // â˜… Bug 5: Reset camera state
    setPeerProfile(null);
    setRemoteVideoReady(false);
    iceRestartCountRef.current = 0;
    sessionStartRef.current = null;
    sessionIdRef.current = null; // â˜… Reset ref synchronously
    remoteCameraKnownRef.current = false;
    remoteStreamStartedAtRef.current = 0;
    if (remoteProbeRef.current.interval) {
      clearInterval(remoteProbeRef.current.interval);
      remoteProbeRef.current.interval = null;
    }
    remoteProbeRef.current.deadline = 0;
  }, [clearAllTimers]);

  // â˜… Session End Handler (idempotent, loop-safe)
  const handleSessionEnd = useCallback(
    (reason, { requeue, sessionId: incomingSessionId } = {}) => {
      const activeSessionId = sessionIdRef.current;
      const effectiveSessionId = incomingSessionId || activeSessionId;

      // No active session => ignore (prevents cleanup loops from stale timers/events)
      if (!effectiveSessionId) return;

      // Ignore duplicates after we've already ended this session
      if (
        lastEndedSessionIdRef.current === effectiveSessionId &&
        (stateRef.current === STATES.IDLE ||
          stateRef.current === STATES.SEARCHING ||
          stateRef.current === STATES.ENDED)
      ) {
        return;
      }
      lastEndedSessionIdRef.current = effectiveSessionId;

      if (stateRef.current === STATES.ENDING || stateRef.current === STATES.ENDED)
        return;

      console.log('ðŸ”š Session ended:', reason, 'sessionId=', effectiveSessionId);

      // Transition first so ENDINGâ†’ENDED remains legal even after cleanup nulls refs.
      transition(STATES.ENDING);

      clearAllTimers();
      cleanup();

      setTimer('ended', () => {
        transition(STATES.ENDED);

        const shouldRequeue =
          typeof requeue === 'boolean'
            ? requeue
            : autoRematch && reason !== 'report';

        if (!shouldRequeue) {
          transition(STATES.IDLE);
          return;
        }

        setTimer('rematch', () => {
          handlersRef.current.joinQueue();
        }, 1000);
      }, 500);
    },
    [autoRematch, clearAllTimers, cleanup, setTimer, transition],
  );

  // â”€â”€â”€ Attach Signaling Listeners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const attachSignaling = useCallback(() => {
    // Remove existing listeners
    signalingUnsubsRef.current.forEach((unsub) => { try { unsub(); } catch {} });
    signalingUnsubsRef.current = [];

    const push = (unsub) => signalingUnsubsRef.current.push(unsub);

    // Match found
    push(signalingClient.on('world-matched', (msg) => {
      console.log('ðŸ¤ Match found:', msg);
      lastEndedSessionIdRef.current = null;
      remoteCameraKnownRef.current = false;
      remoteStreamStartedAtRef.current = 0;
      setRemoteCameraOff(false);
      setPeerProfile(msg.peerProfile || null);
      setRemoteVideoReady(false);
      setSessionId(msg.sessionId);
      sessionIdRef.current = msg.sessionId; // â˜… Update ref synchronously
      setPeerToken(msg.peerToken);
      setRole(msg.role);
      setExpiresAt(msg.expiresAt);
      transition(STATES.MATCHED);

      // Start session timer (UX-only â€” server is authoritative)
      sessionStartRef.current = Date.now();
      clearAllTimers();
      setTimer('session', () => {
        handlersRef.current.handleSessionEnd('timeout', {
          requeue: true,
          sessionId: msg.sessionId,
        });
      }, SESSION_DURATION_MS);

      // Matched timeout â€” if WebRTC init doesn't start within 5s, bail
      setTimer('matched', () => {
        if (stateRef.current === STATES.MATCHED) {
          setError('Failed to establish connection');
          cleanup();
          transition(STATES.IDLE);
        }
      }, MATCHED_TIMEOUT_MS);

      // Role determines who initiates WebRTC
      if (msg.role === 'caller') {
        transition(STATES.OFFERING);
        handlersRef.current.initWebRTC(true, msg.sessionId);
      } else {
        transition(STATES.ANSWERING);
        handlersRef.current.initWebRTC(false, msg.sessionId);
      }
    }));

    // Session ended (server timeout, peer Next, partner disconnect, report)
    push(signalingClient.on('world-session-end', (msg) => {
      const currentSid = sessionIdRef.current;
      const incomingSid = msg?.sessionId;

      // Ignore stale session-end events (prevents cleanup loops).
      if (incomingSid && !currentSid) return;
      if (incomingSid && currentSid && incomingSid !== currentSid) return;

      console.log('ðŸ”— Session ended:', msg.reason, 'sessionId=', incomingSid || currentSid);
      handlersRef.current.handleSessionEnd(msg.reason, { requeue: msg.requeue, sessionId: incomingSid });
    }));

    // Peer camera state (authoritative UX signal)
    push(signalingClient.on('world-video-camera-state', (msg) => {
      const currentSid = sessionIdRef.current;
      const incomingSid = msg?.sessionId;
      if (incomingSid && !currentSid) return;
      if (incomingSid && currentSid && incomingSid !== currentSid) return;
      if (!incomingSid) return;

      remoteCameraKnownRef.current = true;
      setRemoteCameraOff(!msg.cameraOn);
      if (!msg.cameraOn) setRemoteVideoReady(false);
    }));

    // Rate limited (too many Next presses)
    push(signalingClient.on('world-rate-limited', (msg) => {
      console.warn('â±ï¸ Rate limited:', msg.retryAfter);
      setNextCooldown(true);
      setTimeout(() => setNextCooldown(false), (msg.retryAfter || 3) * 1000);
    }));

    // Error
    push(signalingClient.on('world-error', (msg) => {
      console.error('âŒ World video error:', msg);
      setError(msg.message || 'Unknown error');
      cleanup();
      transition(STATES.IDLE);
    }));

    // Queue status updates
    push(signalingClient.on('world-queue-status', (msg) => {
      console.log('ðŸ“Š Queue status:', msg.status, msg.message);
    }));

    // â”€â”€â”€ WebRTC Signaling (routed by sessionId + ephemeral tokens) â”€â”€â”€â”€â”€â”€â”€â”€
    push(signalingClient.on('world-video-offer', async (msg) => {
      const currentSid = sessionIdRef.current;
      console.log('ðŸ“¥ Received world-video-offer, sessionId:', msg.sessionId, 'currentSid:', currentSid);
      
      if (!currentSid) {
        console.log('âš ï¸ No active session, ignoring offer');
        return;
      }
      if (msg.sessionId !== currentSid) {
        console.log('âš ï¸ Offer for different session, ignoring');
        return;
      }
      
      try {
        // Fix: handleOffer expects SDP string or {type, sdp} object
        const sdp = typeof msg.sdp === 'string' ? msg.sdp : msg.sdp;
        if (!sdp) {
          console.error('âŒ Invalid offer SDP:', msg.sdp);
          handlersRef.current.nextMatch();
          return;
        }
        await webrtcEngine.handleOffer(sdp);
        transition(STATES.ICE_GATHERING);
      } catch (err) {
        console.error('âŒ Offer handle error:', err.message);
        handlersRef.current.nextMatch();
      }
    }));

    push(signalingClient.on('world-video-answer', async (msg) => {
      const currentSid = sessionIdRef.current;
      console.log('ðŸ“¥ Received world-video-answer, sessionId:', msg.sessionId, 'currentSid:', currentSid);
      
      if (!currentSid) {
        console.log('âš ï¸ No active session, ignoring answer');
        return;
      }
      if (msg.sessionId !== currentSid) {
        console.log('âš ï¸ Answer for different session, ignoring');
        return;
      }
      
      try {
        // Fix: handleAnswer expects SDP string or {type, sdp} object
        const sdp = typeof msg.sdp === 'string' ? msg.sdp : msg.sdp;
        if (!sdp) {
          console.error('âŒ Invalid answer SDP:', msg.sdp);
          handlersRef.current.nextMatch();
          return;
        }
        await webrtcEngine.handleAnswer(sdp);
        transition(STATES.ICE_GATHERING);
      } catch (err) {
        console.error('âŒ Answer handle error:', err.message);
        handlersRef.current.nextMatch();
      }
    }));

    push(signalingClient.on('world-video-ice-candidate', async (msg) => {
      const currentSid = sessionIdRef.current;
      if (msg.sessionId !== currentSid && currentSid) return;
      try {
        await webrtcEngine.handleIceCandidate(msg.candidate);
      } catch (err) {
        console.error('ICE candidate error:', err);
      }
    }));

    push(signalingClient.on('world-video-ice-restart', async (msg) => {
      const currentSid = sessionIdRef.current;
      if (msg.sessionId !== currentSid && currentSid) return;
      try {
        await webrtcEngine.handleOffer(msg.sdp);
      } catch (err) {
        console.error('ICE restart error:', err);
        handlersRef.current.nextMatch();
      }
    }));
    // â˜… Bug 5: Remote camera state from signaling
    push(signalingClient.on('world-video-camera-state', (msg) => {
      const currentSid = sessionIdRef.current;
      if (msg.sessionId !== currentSid) return;
      console.log(`[CAMERA_STATE] sessionId=${msg.sessionId} cameraOn=${msg.cameraOn} direction=remote`);
      setRemoteCameraOff(!msg.cameraOn);
    }));

  }, []); // â˜… No dependencies â€” listeners use refs for synchronous current-value access

  const initWebRTC = useCallback(async (isCaller, currentSessionId) => {
    // â˜… Bug 3: Increment generation â€” all callbacks check this to prevent
    // stale invocations from previous sessions.
    const myGeneration = ++sessionGenerationRef.current;
    console.log(`[INIT_WEBRTC] sessionId=${currentSessionId} isCaller=${isCaller} generation=${myGeneration}`);

    try {
      // â˜… All callbacks guard against stale generation
      webrtcEngine.onCallStateChange = (newState) => {
        if (sessionGenerationRef.current !== myGeneration) {
          console.log(`[STALE_CALLBACK] onCallStateChange state=${newState} generation=${myGeneration} currentGen=${sessionGenerationRef.current}`);
          return;
        }

        if (newState === 'connected' || newState === STATES.CONNECTED) {
          // â˜… Bug 4: Disarm ICE timeout â€” connection succeeded
          clearTimeout(timersRef.current['iceChecking']);
          clearAllTimers();
          transition(STATES.CONNECTED);
          iceRestartCountRef.current = 0;
          console.log(`[ICE_STATE] sessionId=${currentSessionId} state=connected`);

          // Start countdown timer (UX-only)
          const startTime = sessionStartRef.current || Date.now();
          const interval = setInterval(() => {
            if (sessionGenerationRef.current !== myGeneration) {
              clearInterval(interval);
              return;
            }
            const elapsed = Date.now() - startTime;
            const remaining = Math.max(0, SESSION_DURATION_MS - elapsed);
            setTimeRemaining(Math.ceil(remaining / 1000));
            if (remaining <= 0) {
              clearInterval(interval);
            }
          }, 1000);
          timersRef.current['countdown'] = interval;
        } else if (newState === 'reconnecting' || newState === STATES.RECONNECTING) {
          transition(STATES.RECONNECTING);
          setTimer('reconnecting', () => {
            if (sessionGenerationRef.current !== myGeneration) return;
            handlersRef.current.nextMatch();
          }, RECONNECTING_TIMEOUT_MS);
        } else if (newState === 'failed' || newState === STATES.ENDING) {
          if (iceRestartCountRef.current < ICE_RESTART_MAX) {
            iceRestartCountRef.current++;
            try {
              webrtcEngine.createOffer();
            } catch {
              handlersRef.current.nextMatch();
            }
          } else {
            handlersRef.current.nextMatch();
          }
        }
      };

      webrtcEngine.onLocalStream = (stream) => {
        if (sessionGenerationRef.current !== myGeneration) return;
        setLocalStream(stream);
        // Sync UI state to engine intent (covers rematch/re-init and early toggles).
        if (typeof webrtcEngine.getMicMuted === 'function') setMicMuted(webrtcEngine.getMicMuted());
        if (typeof webrtcEngine.getCameraOff === 'function') setCameraOff(webrtcEngine.getCameraOff());
        // Send initial camera state so peer doesn't rely on track mute/unmute (prevents "camera off for 1–2s" flash).
        try {
          const camOff = typeof webrtcEngine.getCameraOff === 'function' ? webrtcEngine.getCameraOff() : false;
          signalingClient.sendWorldVideoCameraState(currentSessionId, !camOff);
        } catch {}
      };

      webrtcEngine.onRemoteStream = (stream) => {
        if (sessionGenerationRef.current !== myGeneration) return;
        console.log(`[REMOTE_STREAM] sessionId=${currentSessionId} hasStream=${!!stream}`);
        setRemoteStream(stream);
        if (stream) remoteStreamStartedAtRef.current = Date.now();
        if (!stream) {
          // Remote stream cleared â€” peer disconnected or cleanup
          console.log(`[GHOST_VIDEO_PREVENTED] sessionId=${currentSessionId} reason=onRemoteStream_null`);
          setRemoteVideoReady(false);

          // Client-side failsafe: if server session-end is missed, don't let the user hang.
          // Only trigger when we were actively connected.
          if (stateRef.current === STATES.CONNECTED && sessionIdRef.current) {
            setTimer('peerDropFailsafe', () => {
              if (sessionGenerationRef.current !== myGeneration) return;
              if (stateRef.current !== STATES.CONNECTED) return;
              handlersRef.current.handleSessionEnd('disconnect', {
                requeue: true,
                sessionId: currentSessionId,
              });
            }, 2000);
          }

          if (remoteProbeRef.current.interval) {
            clearInterval(remoteProbeRef.current.interval);
            remoteProbeRef.current.interval = null;
          }
          remoteProbeRef.current.deadline = 0;
          return;
        }

        // Stream present: keep placeholder until first real video packets arrive (avoids black frames).
        setRemoteVideoReady(false);
        if (remoteProbeRef.current.interval) {
          clearInterval(remoteProbeRef.current.interval);
          remoteProbeRef.current.interval = null;
        }
        remoteProbeRef.current.deadline = Date.now() + 4500;

        remoteProbeRef.current.interval = setInterval(async () => {
          if (sessionGenerationRef.current !== myGeneration) return;
          if (!webrtcEngine.pc) return;
          if (remoteCameraKnownRef.current && remoteCameraOff) return;
          if (remoteProbeRef.current.deadline && Date.now() > remoteProbeRef.current.deadline) {
            clearInterval(remoteProbeRef.current.interval);
            remoteProbeRef.current.interval = null;
            remoteProbeRef.current.deadline = 0;
            return;
          }

          try {
            const stats = await webrtcEngine.pc.getStats();
            const parsed = webrtcEngine.parseStats(stats);
            const packets = parsed?.video?.packetsReceived || 0;
            const bytes = parsed?.video?.bytesReceived || 0;
            const fps = parsed?.video?.frameRate || 0;
            if (packets > 0 || bytes > 1200 || fps > 0) {
              setRemoteVideoReady(true);
              clearInterval(remoteProbeRef.current.interval);
              remoteProbeRef.current.interval = null;
              remoteProbeRef.current.deadline = 0;
            }
          } catch {}
        }, 250);
      };

      // â˜… Bug 5: Remote camera state from WebRTC track events
      webrtcEngine.onRemoteCameraState = (cameraOn) => {
        if (sessionGenerationRef.current !== myGeneration) return;
        // Prefer explicit camera-state signaling. Track mute/unmute is noisy during startup.
        if (remoteCameraKnownRef.current) return;
        const startedAt = remoteStreamStartedAtRef.current || 0;
        if (startedAt && Date.now() - startedAt < 1500) return; // warmup: ignore initial mute
        console.log(`[CAMERA_STATE] sessionId=${currentSessionId} cameraOn=${cameraOn} direction=remote_track`);
        setRemoteCameraOff(!cameraOn);
      };

      // First remote frame decoded: lift the loader immediately.
      webrtcEngine.onRemoteVideoFirstFrame = () => {
        if (sessionGenerationRef.current !== myGeneration) return;
        setRemoteVideoReady(true);
        if (remoteProbeRef.current.interval) {
          clearInterval(remoteProbeRef.current.interval);
          remoteProbeRef.current.interval = null;
        }
        remoteProbeRef.current.deadline = 0;
      };

      webrtcEngine.onIceCandidate = (candidate) => {
        if (sessionGenerationRef.current !== myGeneration) return;
        if (stateRef.current === STATES.IDLE || stateRef.current === STATES.ENDED) return;
        signalingClient.sendWorldVideoIceCandidate(currentSessionId, candidate);
      };

      // â˜… Route SDP offers through world video signaling (NOT 1:1 call signaling)
      webrtcEngine.onOffer = (offer) => {
        if (sessionGenerationRef.current !== myGeneration) return;
        if (stateRef.current === STATES.IDLE || stateRef.current === STATES.ENDED) return;
        
        // Fix: offer is RTCSessionDescription object, extract sdp properly
        const sdp = offer && (offer.sdp || (offer instanceof RTCSessionDescription ? offer.sdp : null));
        if (!sdp) {
          console.error('âŒ onOffer callback received invalid offer:', offer);
          return;
        }
        
        console.log(`[OFFER_SENT] sessionId=${currentSessionId} sdpLength=${sdp.length}`);
        signalingClient.sendWorldVideoOffer(currentSessionId, sdp);
      };

      // â˜… Route SDP answers through world video signaling (NOT 1:1 call signaling)
      webrtcEngine.onAnswer = (answer) => {
        if (sessionGenerationRef.current !== myGeneration) return;
        if (stateRef.current === STATES.IDLE || stateRef.current === STATES.ENDED) return;
        
        // Fix: answer is RTCSessionDescription object, extract sdp properly
        const sdp = answer && (answer.sdp || (answer instanceof RTCSessionDescription ? answer.sdp : null));
        if (!sdp) {
          console.error('âŒ onAnswer callback received invalid answer:', answer);
          return;
        }
        
        console.log(`[ANSWER_SENT] sessionId=${currentSessionId} sdpLength=${sdp.length}`);
        signalingClient.sendWorldVideoAnswer(currentSessionId, sdp);
      };

      await webrtcEngine.initialize(currentSessionId || 'world-video', isCaller, true);

      // â˜… Bug 3: After async initialize, verify we're still the active generation
      if (sessionGenerationRef.current !== myGeneration) {
        console.log(`[STALE_SESSION] Initialize completed but generation changed: myGen=${myGeneration} currentGen=${sessionGenerationRef.current}`);
        webrtcEngine.cleanup();
        return;
      }

      // â˜… Bug 4: ARM the ICE checking timeout
      // Belt-and-suspenders: checks iceConnectionState before acting,
      // so a connection that succeeds at 19.9s won't be killed.
      setTimer('iceChecking', () => {
        if (sessionGenerationRef.current !== myGeneration) return;
        const currentIceState = webrtcEngine.pc?.iceConnectionState;
        if (currentIceState === 'connected' || currentIceState === 'completed') {
          console.log(`[ICE_TIMEOUT_CANCELLED] sessionId=${currentSessionId} iceState=${currentIceState} â€” already connected`);
          return; // Don't kill a working connection
        }
        if (stateRef.current === STATES.ICE_CHECKING || stateRef.current === STATES.ICE_GATHERING ||
            stateRef.current === STATES.OFFERING || stateRef.current === STATES.ANSWERING) {
          console.log(`[ICE_TIMEOUT] sessionId=${currentSessionId} elapsedMs=${ICE_CHECKING_TIMEOUT_MS} iceState=${currentIceState}`);
          handlersRef.current.nextMatch();
        }
      }, ICE_CHECKING_TIMEOUT_MS);

      if (isCaller) {
        try {
          const offer = await webrtcEngine.createOffer();
          // Offer is sent via onOffer callback â€” no manual send needed
          console.log(`[OFFER_SENT] sessionId=${currentSessionId} role=caller via_callback=true`);
        } catch (offerErr) {
          if (sessionGenerationRef.current !== myGeneration) return;
          console.error('âŒ createOffer failed:', offerErr.message);
          crashLogger.log(CATEGORIES.WEBRTC_ERROR, 'World video createOffer error', offerErr);
          setError('Failed to create video offer');
          cleanup();
          transition(STATES.IDLE);
          return;
        }
      }
    } catch (err) {
      if (sessionGenerationRef.current !== myGeneration) return;
      crashLogger.log(CATEGORIES.WEBRTC_ERROR, 'World video WebRTC init error', err);
      console.error('âŒ WebRTC init error:', err.message, err.stack);
      setError('Failed to establish video connection: ' + (err.message || 'Unknown error'));
      cleanup();
      transition(STATES.IDLE);
    }
  }, [clearAllTimers, cleanup, setTimer, transition]);


  // â”€â”€â”€ Countdown Timer Update â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    if (state !== STATES.CONNECTED) {
      setTimeRemaining(0);
      return;
    }

    const startTime = sessionStartRef.current || Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, SESSION_DURATION_MS - elapsed);
      setTimeRemaining(Math.ceil(remaining / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [state, handleSessionEnd]);

  // â”€â”€â”€ AppState (background/foreground handling) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        backgroundedAtRef.current = Date.now();
      } else if (nextState === 'active' && backgroundedAtRef.current) {
        const bgDuration = Date.now() - backgroundedAtRef.current;
        backgroundedAtRef.current = null;

        if (bgDuration > 60000 && (state === STATES.CONNECTED || state === STATES.SEARCHING)) {
          // Backgrounded too long â€” end session
          handleSessionEnd('background_timeout');
        }
      }
    });

    return () => subscription.remove();
  }, [state]);

  // â”€â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const joinQueue = useCallback(() => {
    lastEndedSessionIdRef.current = null;
    cleanup();
    setError(null);
    transition(STATES.SEARCHING);

    attachSignaling();
    signalingClient.joinWorldVideo();

    // Search timeout
    setTimer('search', () => {
      if (stateRef.current === STATES.SEARCHING) {
        setError('No one available right now. Try again later.');
        cleanup();
        transition(STATES.IDLE);
      }
    }, SEARCH_TIMEOUT_MS);
  }, [cleanup, attachSignaling]);

  const leaveQueue = useCallback(() => {
    signalingClient.leaveWorldVideo(sessionIdRef.current);
    cleanup();
    transition(STATES.IDLE);
  }, [cleanup]);

  const nextMatch = useCallback(() => {
    if (nextCooldown) return;

    // Rate limit
    setNextCooldown(true);
    setTimeout(() => setNextCooldown(false), NEXT_COOLDOWN_MS);

    const currentSessionId = sessionIdRef.current; // â˜… Capture before cleanup wipes it

    // End current session and re-queue
    if (currentSessionId) {
      signalingClient.nextWorldVideo(currentSessionId);

      // Fallback: if session-end event is lost, force local cleanup and re-queue.
      setTimer('nextFallback', () => {
        if (sessionIdRef.current === currentSessionId) {
          handlersRef.current.handleSessionEnd('next_fallback', {
            requeue: true,
            sessionId: currentSessionId,
          });
        }
      }, 2000);
    } else {
      // Not in a session â€” just re-queue
      joinQueue();
    }

  }, [nextCooldown, joinQueue, setTimer]);

  const reportUser = useCallback(async (reason, metadata = {}) => {
    try {
      await apiClient.post(endpoints.worldVideo.report, {
        sessionId,
        reportedToken: peerToken,
        reason,
        metadata: {
          ...metadata,
          sessionDuration: sessionStartRef.current
            ? Math.floor((Date.now() - sessionStartRef.current) / 1000)
            : 0,
        },
      });

      // End session after report
      handleSessionEnd('report', { requeue: false, sessionId: sessionIdRef.current || sessionId });
    } catch (err) {
      console.error('Report error:', err);
      setError('Failed to submit report. Please try again.');
    }
  }, [sessionId, peerToken, handleSessionEnd]);

  const toggleMute = useCallback(() => {
    const next = webrtcEngine.toggleMute();
    setMicMuted(!!next);
    return !!next;
  }, []);

  const toggleSpeaker = useCallback(() => {
    const next = webrtcEngine.toggleSpeaker();
    setSpeakerOn(!!next);
    return !!next;
  }, []);

  const toggleCamera = useCallback(() => {
    const isOff = webrtcEngine.toggleCamera();
    setCameraOff(!!isOff);
    // â˜… Bug 5: Send camera state to peer via signaling
    const currentSessionId = sessionIdRef.current;
    if (currentSessionId) {
      console.log(`[CAMERA_STATE] sessionId=${currentSessionId} cameraOn=${!isOff} direction=local`);
      signalingClient.sendWorldVideoCameraState(currentSessionId, !isOff);
    }
    return !!isOff;
  }, []);

  const switchCamera = useCallback(() => {
    return webrtcEngine.switchCamera();
  }, []);

  // â”€â”€â”€ Cleanup on unmount â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    return () => {
      const sid = sessionIdRef.current;
      if (sid) {
        try {
          signalingClient.leaveWorldVideo(sid);
        } catch {}
      }
      cleanup();
    };
  }, []);

  // Keep handler refs hot (avoids stale closures across rematches)
  handlersRef.current.handleSessionEnd = handleSessionEnd;
  handlersRef.current.nextMatch = nextMatch;
  handlersRef.current.initWebRTC = initWebRTC;
  handlersRef.current.joinQueue = joinQueue;

  return {
    // State
    state,
    sessionId,
    peerToken,
    role,
    expiresAt,
    localStream,
    remoteStream,
    timeRemaining,
    nextCooldown,
    error,
    remoteCameraOff, // â˜… Bug 5: peer camera state
    micMuted,
    speakerOn,
    cameraOff,
    peerProfile,
    remoteVideoReady,

    // Actions
    joinQueue,
    leaveQueue,
    nextMatch,
    reportUser,
    toggleSpeaker,
    toggleMute,
    toggleCamera,
    switchCamera,

    // Utilities
    isSearching: state === STATES.SEARCHING,
    isConnected: state === STATES.CONNECTED,
    isActive: state !== STATES.IDLE && state !== STATES.ENDED,
    isVideoActive: [STATES.CONNECTED, STATES.ICE_CHECKING, STATES.ICE_GATHERING, STATES.OFFERING, STATES.ANSWERING].includes(state),
  };
}
