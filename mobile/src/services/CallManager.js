/**
 * CallManager — Enterprise-Grade Centralized Call Lifecycle Controller.
 *
 * ★ Single Source of Truth for ALL call state.
 * ★ Deterministic State Machine with explicit transitions.
 * ★ Idempotent endCall() — safe to call multiple times.
 * ★ Timeout watchdog — auto-terminate stale calls.
 * ★ Network reconciliation — verify call status on WS reconnect.
 * ★ Crash-safe — AppState background auto-cleanup.
 * ★ Listener deduplication — one set of signaling listeners per call.
 *
 * Architecture:
 *   UI (CallScreen, IncomingCallOverlay, Navigation)
 *     ↓ subscribes via callManager.on('stateChange', cb)
 *   CallManager (this file) — owns session + state machine
 *     ↓ controls
 *   WebRTC Engine, Signaling Client, Network Monitor, Audio Engine
 */

import { AppState } from "react-native";
import signalingClient from "./socket";
import webrtcEngine from "./webrtc";
import networkMonitor from "./networkMonitor";
import audioEngine from "./audioEngine";

// ─── Deterministic State Machine ────────────────────────────────────────────
const STATES = {
  IDLE: "idle",
  CALLING: "calling", // Outbound call initiated, waiting for server
  RINGING: "ringing", // Server confirmed, callee is ringing
  CONNECTING: "connecting", // WebRTC handshake in progress
  CONNECTED: "connected", // Media flowing
  RECONNECTING: "reconnecting", // ICE restart / network recovery
  ENDING: "ending", // Cleanup in progress
  ENDED: "ended", // Call finished, about to reset
  FAILED: "failed", // Unrecoverable failure
};

// Explicit valid transitions — anything else is rejected
const VALID_TRANSITIONS = {
  [STATES.IDLE]: [STATES.CALLING, STATES.CONNECTING], // CONNECTING for callee
  [STATES.CALLING]: [STATES.RINGING, STATES.ENDING, STATES.FAILED],
  [STATES.RINGING]: [STATES.CONNECTING, STATES.ENDING, STATES.FAILED],
  [STATES.CONNECTING]: [
    STATES.CONNECTED,
    STATES.ENDING,
    STATES.FAILED,
    STATES.RECONNECTING,
  ],
  [STATES.CONNECTED]: [STATES.RECONNECTING, STATES.ENDING, STATES.FAILED],
  [STATES.RECONNECTING]: [STATES.CONNECTED, STATES.ENDING, STATES.FAILED],
  [STATES.ENDING]: [STATES.ENDED],
  [STATES.ENDED]: [STATES.IDLE],
  [STATES.FAILED]: [STATES.ENDING, STATES.ENDED, STATES.IDLE],
};

// ─── Timeouts ───────────────────────────────────────────────────────────────
const CALLING_TIMEOUT_MS = 35000; // Max time in CALLING/RINGING before auto-fail
const CONNECTING_TIMEOUT_MS = 20000; // Max time in CONNECTING before auto-fail
const SIGNALING_WATCHDOG_MS = 15000; // If no signaling activity for 15s, check status
const BACKGROUND_AUTO_END_MS = 60000; // Auto-end if backgrounded > 60s during call

class CallManager {
  constructor() {
    // ─── Session ──────────────────────────────────────────────────────
    this._session = null;
    this._state = STATES.IDLE;

    // ─── Event Subscribers ────────────────────────────────────────────
    this._listeners = new Map(); // event -> Set<callback>

    // ─── Signaling Unsub Handles ──────────────────────────────────────
    this._signalingUnsubs = [];

    // ─── Timers ───────────────────────────────────────────────────────
    this._callingTimer = null;
    this._connectingTimer = null;
    this._watchdogTimer = null;
    this._lastSignalingActivity = 0;
    this._durationTimer = null;
    this._durationSeconds = 0;

    // ─── AppState ─────────────────────────────────────────────────────
    this._appStateSubscription = null;
    this._backgroundedAt = null;

    // ─── Reconnect listener ───────────────────────────────────────────
    this._reconnectUnsub = null;

    // ─── Bind methods ─────────────────────────────────────────────────
    this._onAppStateChange = this._onAppStateChange.bind(this);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  /** Current call session (read-only snapshot) */
  get session() {
    if (!this._session) return null;
    return {
      ...this._session,
      state: this._state,
      duration: this._durationSeconds,
    };
  }

  /** Current state */
  get state() {
    return this._state;
  }

  /** Whether a call is active (not IDLE) */
  get isActive() {
    return this._state !== STATES.IDLE;
  }

  /** Whether the manager is in a terminal state that can be force-reset */
  get isTerminal() {
    return this._state === STATES.ENDED || this._state === STATES.FAILED;
  }

  /**
   * Force-reset to IDLE from any terminal state.
   * Safely clears stale session data so a new call can begin.
   */
  forceReset() {
    if (this._state === STATES.IDLE) return;
    console.log(`📞 CallManager: forceReset from ${this._state}`);

    // Clear all timers and listeners
    this._clearCallingTimeout();
    this._clearConnectingTimeout();
    this._stopWatchdog();
    this._stopDurationTimer();
    this._stopAppStateMonitor();
    this._removeSignalingListeners();

    // Reset state
    this._state = STATES.IDLE;
    this._session = null;
    this._durationSeconds = 0;

    this._emit("stateChange", {
      state: STATES.IDLE,
      prevState: STATES.IDLE,
      session: null,
    });
  }

  /** Whether media is flowing */
  get isLive() {
    return (
      this._state === STATES.CONNECTED || this._state === STATES.RECONNECTING
    );
  }

  // ─── Initiate Outbound Call ─────────────────────────────────────────────
  startCall(targetUserId, targetName, callType = "video") {
    // ★ Auto-recover from terminal states (ENDED/FAILED)
    //   This handles the race where the 1500ms ENDED→IDLE auto-transition
    //   hasn't completed yet when the user tries to make a new call.
    if (this.isTerminal) {
      console.log(
        `📞 CallManager: Auto-resetting from terminal state: ${this._state}`,
      );
      this.forceReset();
    }

    if (this.isActive) {
      console.warn("📞 CallManager: Cannot start call — already in a call");
      return false;
    }

    this._session = {
      callId: null, // Assigned by server via call-ringing
      role: "caller",
      remoteName: targetName,
      remoteUserId: targetUserId,
      callType, // "voice" or "video"
      startedAt: null,
      hasEnded: false,
    };

    this._transition(STATES.CALLING);
    this._attachSignalingListeners();
    this._startAppStateMonitor();
    this._startCallingTimeout();

    // Request call via signaling
    signalingClient.requestCall(targetUserId, callType);
    this._touchWatchdog();

    return true;
  }

  // ─── Accept Incoming Call ───────────────────────────────────────────────
  acceptIncomingCall(callData) {
    // ★ Auto-recover from terminal states
    if (this.isTerminal) {
      this.forceReset();
    }

    if (this.isActive) {
      console.warn("📞 CallManager: Cannot accept — already in a call");
      signalingClient.rejectCall(callData.callId, "busy");
      return false;
    }

    this._session = {
      callId: callData.callId,
      role: "callee",
      remoteName: callData.callerName,
      remoteUserId: callData.callerId,
      callType: callData.callType || "video",
      startedAt: null,
      hasEnded: false,
    };

    this._transition(STATES.CONNECTING);
    this._attachSignalingListeners();
    this._startAppStateMonitor();
    this._startConnectingTimeout();

    // Accept via signaling
    signalingClient.acceptCall(callData.callId);

    // Initialize WebRTC as callee (offer will arrive via signaling)
    this._initWebRTC(false);
    this._touchWatchdog();

    return true;
  }

  // ─── Reject Incoming Call ───────────────────────────────────────────────
  rejectIncomingCall(callId) {
    signalingClient.rejectCall(callId);
  }

  // ─── End Call (Idempotent) ──────────────────────────────────────────────
  endCall(reason = "user_hangup") {
    if (!this._session || this._session.hasEnded) {
      console.log(
        "📞 CallManager: endCall ignored — already ended or no session",
      );
      return;
    }

    if (
      this._state === STATES.ENDING ||
      this._state === STATES.ENDED ||
      this._state === STATES.IDLE
    ) {
      return;
    }

    console.log(`📞 CallManager: endCall(${reason}) — ${this._state}`);
    this._session.hasEnded = true;

    // Only send hang-up to server if WE initiated the end
    if (reason === "user_hangup" && this._session.callId) {
      signalingClient.hangUp(this._session.callId);
    }

    this._transition(STATES.ENDING);
    this._performCleanup(reason);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to CallManager events.
   * Events: 'stateChange', 'localStream', 'remoteStream', 'stats',
   *         'modeSwitch', 'qualityChange', 'durationTick', 'incomingCall'
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const listeners = this._listeners.get(event);
    if (listeners) listeners.delete(callback);
  }

  _emit(event, data) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.forEach((cb) => {
        try {
          cb(data);
        } catch (err) {
          console.error(`📞 CallManager listener error [${event}]:`, err);
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE MACHINE
  // ═══════════════════════════════════════════════════════════════════════════

  _transition(newState) {
    const currentState = this._state;
    if (currentState === newState) return false;

    const allowed = VALID_TRANSITIONS[currentState];
    if (!allowed || !allowed.includes(newState)) {
      console.warn(
        `📞 CallManager: ILLEGAL transition ${currentState} → ${newState} — REJECTED`,
      );
      return false;
    }

    this._state = newState;
    console.log(`📞 CallManager: ${currentState} → ${newState}`);

    this._emit("stateChange", {
      state: newState,
      prevState: currentState,
      session: this.session,
    });

    // Auto-transition ENDED → IDLE after a brief delay
    if (newState === STATES.ENDED) {
      setTimeout(() => {
        if (this._state === STATES.ENDED) {
          this._state = STATES.IDLE;
          this._session = null;
          this._durationSeconds = 0;
          this._emit("stateChange", {
            state: STATES.IDLE,
            prevState: STATES.ENDED,
            session: null,
          });
        }
      }, 1500); // Give UI time to show "Call Ended"
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SIGNALING LISTENERS (deduplicated — one set per call)
  // ═══════════════════════════════════════════════════════════════════════════

  _attachSignalingListeners() {
    // ★ Deduplication: remove any existing listeners first
    this._removeSignalingListeners();

    const callId = () => this._session?.callId;

    // Server confirms call is ringing (caller receives callId here)
    this._pushUnsub(
      signalingClient.on("call-ringing", (msg) => {
        this._touchWatchdog();
        if (
          this._session &&
          this._session.role === "caller" &&
          !this._session.callId
        ) {
          this._session.callId = msg.callId;
          this._clearCallingTimeout();
          this._transition(STATES.RINGING);
          this._startCallingTimeout(); // Restart timeout for ringing phase
        }
      }),
    );

    // Callee accepted (caller receives this)
    this._pushUnsub(
      signalingClient.on("call-accepted", async (msg) => {
        this._touchWatchdog();
        if (msg.callId === callId() && this._session?.role === "caller") {
          this._clearCallingTimeout();
          this._transition(STATES.CONNECTING);
          this._startConnectingTimeout();
          await this._initWebRTC(true);
        }
      }),
    );

    // WebRTC Offer
    this._pushUnsub(
      signalingClient.on("offer", async (msg) => {
        this._touchWatchdog();
        if (msg.callId === callId()) {
          await webrtcEngine.handleOffer(msg.sdp);
        }
      }),
    );

    // WebRTC Answer
    this._pushUnsub(
      signalingClient.on("answer", async (msg) => {
        this._touchWatchdog();
        if (msg.callId === callId()) {
          await webrtcEngine.handleAnswer(msg.sdp);
        }
      }),
    );

    // ICE Candidate
    this._pushUnsub(
      signalingClient.on("ice-candidate", async (msg) => {
        this._touchWatchdog();
        if (msg.callId === callId()) {
          await webrtcEngine.handleIceCandidate(msg.candidate);
        }
      }),
    );

    // ICE Restart
    this._pushUnsub(
      signalingClient.on("ice-restart", async (msg) => {
        this._touchWatchdog();
        if (msg.callId === callId()) {
          await webrtcEngine.handleOffer(msg.sdp);
        }
      }),
    );

    // ★ Remote peer switched call mode (voice↔video)
    this._pushUnsub(
      signalingClient.on("call-mode-switch", (msg) => {
        if (msg.callId === callId() && this._session) {
          const newMode = msg.mode;
          this._session.callType = newMode;
          if (newMode === "voice") {
            webrtcEngine.switchToAudioOnly();
            this._emit("modeSwitch", {
              mode: "audio_only",
              reason: "remote_switched",
            });
          } else {
            // ★ Use enableLocalVideo() instead of switchToVideoMode() to avoid
            // glare — the remote peer will send a renegotiation offer with
            // their new video track, so we just need to enable our own camera.
            webrtcEngine.enableLocalVideo();
            this._emit("modeSwitch", {
              mode: "video",
              reason: "remote_switched",
            });
          }
        }
      }),
    );

    // Remote hung up
    this._pushUnsub(
      signalingClient.on("call-ended", (msg) => {
        if (msg.callId === callId()) {
          this.endCall("remote_hangup");
        }
      }),
    );

    // Also listen for raw hang-up from server
    this._pushUnsub(
      signalingClient.on("hang-up", (msg) => {
        if (msg.callId === callId()) {
          this.endCall("remote_hangup");
        }
      }),
    );

    // Call rejected by callee
    this._pushUnsub(
      signalingClient.on("call-rejected", (msg) => {
        if (msg.callId === callId()) {
          this.endCall("rejected");
        }
      }),
    );

    // Call failed (user offline, busy, etc.)
    this._pushUnsub(
      signalingClient.on("call-failed", (msg) => {
        if (!callId() || msg.callId === callId()) {
          this._transition(STATES.FAILED);
          setTimeout(() => this.endCall("failed"), 1500);
        }
      }),
    );

    // ★ Network reconciliation: on WS reconnect, verify call is still valid
    this._reconnectUnsub = signalingClient.on("connected", () => {
      if (this.isActive && callId()) {
        console.log("📞 CallManager: WS reconnected — verifying call status");
        this._reconcileWithServer();
      }
    });

    // Call status response (for reconciliation)
    this._pushUnsub(
      signalingClient.on("call-status-response", (msg) => {
        if (msg.callId === callId() && !msg.active) {
          console.warn(
            "📞 CallManager: Server says call is stale — force ending",
          );
          this.endCall("stale_session");
        }
      }),
    );
  }

  _pushUnsub(unsub) {
    this._signalingUnsubs.push(unsub);
  }

  _removeSignalingListeners() {
    this._signalingUnsubs.forEach((unsub) => {
      try {
        unsub?.();
      } catch (e) {}
    });
    this._signalingUnsubs = [];

    if (this._reconnectUnsub) {
      try {
        this._reconnectUnsub();
      } catch (e) {}
      this._reconnectUnsub = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WEBRTC INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  async _initWebRTC(isCaller) {
    try {
      // Wire up callbacks BEFORE initialize
      webrtcEngine.onCallStateChange = (newState) => {
        // Map WebRTC engine states to CallManager states
        // (WebRTC uses same string values: "connected", "reconnecting", "failed")
        if (newState === STATES.CONNECTED || newState === "connected") {
          this._clearConnectingTimeout();
          this._session.startedAt = Date.now();
          this._transition(STATES.CONNECTED);
          this._startDurationTimer();
          this._startWatchdog();
        } else if (
          newState === STATES.RECONNECTING ||
          newState === "reconnecting"
        ) {
          this._transition(STATES.RECONNECTING);
        } else if (newState === STATES.FAILED || newState === "failed") {
          this._transition(STATES.FAILED);
          setTimeout(() => this.endCall("webrtc_failed"), 2000);
        }
      };

      webrtcEngine.onLocalStream = (stream) => {
        this._emit("localStream", stream);
      };

      webrtcEngine.onRemoteStream = (stream) => {
        this._emit("remoteStream", stream);
      };

      webrtcEngine.onModeSwitch = (mode, reason) => {
        this._emit("modeSwitch", { mode, reason });
      };

      webrtcEngine.onStats = (stats) => {
        this._emit("stats", stats);
      };

      // Network monitor callbacks
      networkMonitor.onQualityChange = (newTier) => {
        this._emit("qualityChange", newTier);
      };
      networkMonitor.onStatsUpdate = (data) => {
        this._emit("statsUpdate", data);
      };

      const videoEnabled = this._session.callType === "video";
      await webrtcEngine.initialize(
        this._session.callId,
        isCaller,
        videoEnabled,
      );
      networkMonitor.start(this._session.callId);

      if (isCaller) {
        await webrtcEngine.createOffer();
      }
    } catch (err) {
      console.error("📞 CallManager: WebRTC init error:", err);
      this._transition(STATES.FAILED);
      setTimeout(() => this.endCall("init_failed"), 2000);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  _performCleanup(reason) {
    console.log(`📞 CallManager: Cleanup — reason: ${reason}`);

    // Clear all timers
    this._clearCallingTimeout();
    this._clearConnectingTimeout();
    this._stopWatchdog();
    this._stopDurationTimer();
    this._stopAppStateMonitor();

    // Cleanup subsystems
    webrtcEngine.cleanup();
    networkMonitor.stop();
    audioEngine.stop();

    // Remove signaling listeners
    this._removeSignalingListeners();

    // Transition to ENDED (UI will see this and navigate)
    this._transition(STATES.ENDED);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MEDIA CONTROLS (delegated to WebRTC engine)
  // ═══════════════════════════════════════════════════════════════════════════

  toggleMute() {
    return webrtcEngine.toggleMute();
  }

  toggleCamera() {
    return webrtcEngine.toggleCamera();
  }

  switchCamera() {
    return webrtcEngine.switchCamera();
  }

  /**
   * Switch call mode mid-call (voice↔video).
   * @param {"voice"|"video"} newType
   */
  switchCallType(newType) {
    if (!this._session || !this.isActive) return false;
    if (this._session.callType === newType) return false;

    this._session.callType = newType;

    if (newType === "voice") {
      webrtcEngine.switchToAudioOnly();
      this._emit("modeSwitch", { mode: "audio_only", reason: "user_switched" });
    } else {
      webrtcEngine.switchToVideoMode();
      this._emit("modeSwitch", { mode: "video", reason: "user_switched" });
    }

    // Notify remote peer via signaling
    signalingClient.sendCallModeSwitch(this._session.callId, newType);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIMEOUT WATCHDOG
  // ═══════════════════════════════════════════════════════════════════════════

  _startCallingTimeout() {
    this._clearCallingTimeout();
    this._callingTimer = setTimeout(() => {
      if (this._state === STATES.CALLING || this._state === STATES.RINGING) {
        console.warn("📞 CallManager: Calling timeout — no answer");
        this.endCall("timeout");
      }
    }, CALLING_TIMEOUT_MS);
  }

  _clearCallingTimeout() {
    if (this._callingTimer) {
      clearTimeout(this._callingTimer);
      this._callingTimer = null;
    }
  }

  _startConnectingTimeout() {
    this._clearConnectingTimeout();
    this._connectingTimer = setTimeout(() => {
      if (this._state === STATES.CONNECTING) {
        console.warn(
          "📞 CallManager: Connecting timeout — WebRTC handshake failed",
        );
        this.endCall("connecting_timeout");
      }
    }, CONNECTING_TIMEOUT_MS);
  }

  _clearConnectingTimeout() {
    if (this._connectingTimer) {
      clearTimeout(this._connectingTimer);
      this._connectingTimer = null;
    }
  }

  // ─── Signaling Watchdog (active during CONNECTED) ──────────────────────
  _touchWatchdog() {
    this._lastSignalingActivity = Date.now();
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdogTimer = setInterval(() => {
      if (!this.isLive) return;

      const silence = Date.now() - this._lastSignalingActivity;
      if (silence > SIGNALING_WATCHDOG_MS) {
        console.warn(
          `📞 CallManager: No signaling for ${Math.round(silence / 1000)}s — checking server`,
        );
        this._reconcileWithServer();
        this._touchWatchdog(); // Prevent repeated checks
      }
    }, 5000);
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // ─── Duration Timer ────────────────────────────────────────────────────
  _startDurationTimer() {
    this._stopDurationTimer();
    this._durationSeconds = 0;
    this._durationTimer = setInterval(() => {
      this._durationSeconds++;
      this._emit("durationTick", this._durationSeconds);
    }, 1000);
  }

  _stopDurationTimer() {
    if (this._durationTimer) {
      clearInterval(this._durationTimer);
      this._durationTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NETWORK RECONCILIATION
  // ═══════════════════════════════════════════════════════════════════════════

  _reconcileWithServer() {
    if (this._session?.callId) {
      signalingClient.send({
        type: "call-status",
        callId: this._session.callId,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APPSTATE CRASH-SAFE HANDLING
  // ═══════════════════════════════════════════════════════════════════════════

  _startAppStateMonitor() {
    this._stopAppStateMonitor();
    this._backgroundedAt = null;
    this._appStateSubscription = AppState.addEventListener(
      "change",
      this._onAppStateChange,
    );
  }

  _stopAppStateMonitor() {
    if (this._appStateSubscription) {
      this._appStateSubscription.remove();
      this._appStateSubscription = null;
    }
    this._backgroundedAt = null;
  }

  _onAppStateChange(nextState) {
    if (nextState === "background" || nextState === "inactive") {
      this._backgroundedAt = Date.now();
      console.log("📞 CallManager: App backgrounded during call");
    } else if (nextState === "active" && this._backgroundedAt) {
      const bgDuration = Date.now() - this._backgroundedAt;
      this._backgroundedAt = null;
      console.log(
        `📞 CallManager: App foregrounded after ${Math.round(bgDuration / 1000)}s`,
      );

      if (bgDuration > BACKGROUND_AUTO_END_MS && this.isActive) {
        console.warn(
          "📞 CallManager: Backgrounded too long — auto-ending call",
        );
        this.endCall("background_timeout");
      } else if (this.isActive) {
        // Reconcile with server after foregrounding
        this._reconcileWithServer();
      }
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────
const callManager = new CallManager();

// Re-export states for convenience
export { STATES as CALL_MANAGER_STATES };
export default callManager;
