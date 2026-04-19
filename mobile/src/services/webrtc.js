/**
 * Audio-First WebRTC Engine — FAANG-Grade.
 *
 * Design:
 * 1. Formal Call State Machine (IDLE→CONNECTED→RECONNECTING→ENDED)
 * 2. Audio ALWAYS gets priority over video
 * 3. Opus codec forced at 8-24kbps with FEC+DTX
 * 4. ICE restart for seamless WiFi↔LTE handoff
 * 5. Background mode — camera pauses, audio continues
 * 6. Battery optimization — stats polling pauses when not needed
 * 7. InCallManager for proper audio routing
 */

// ─── Conditional WebRTC Import ───────────────────────────────────────────────
let RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, mediaDevices;
let WEBRTC_AVAILABLE = false;

try {
  if (Platform.OS !== "web") {
    const webrtcModule = require("react-native-webrtc");
    RTCPeerConnection = webrtcModule.RTCPeerConnection;
    RTCSessionDescription = webrtcModule.RTCSessionDescription;
    RTCIceCandidate = webrtcModule.RTCIceCandidate;
    mediaDevices = webrtcModule.mediaDevices;
    WEBRTC_AVAILABLE = true;
  }
} catch (err) {
  console.warn(
    "⚠️  react-native-webrtc not available. Call features disabled.",
  );
}

// ─── InCallManager for audio routing ─────────────────────────────────────────
let InCallManager = null;
try {
  if (Platform.OS !== "web") {
    InCallManager = require("react-native-incall-manager").default;
  }
} catch (err) {
  console.warn("⚠️  InCallManager not available.");
}

import { AppState, Platform } from "react-native";
import signalingClient from "./socket";
import { endpoints } from "../config/api";
import apiClient from "./api";
import crashLogger, { CATEGORIES } from "./CrashLogger";

// ─── Call State Machine ──────────────────────────────────────────────────────
export const CALL_STATES = {
  IDLE: "idle",
  CALLING: "calling",
  RINGING: "ringing",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  RECONNECTING: "reconnecting",
  ENDING: "ending",
  ENDED: "ended",
  FAILED: "failed",
};

// ─── ICE Server Config ──────────────────────────────────────────────────────
const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
];

const RTC_CONFIG = {
  iceServers: DEFAULT_ICE_SERVERS,
  iceTransportPolicy: "all",
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
  iceCandidatePoolSize: 5,
};

// ─── Media Constraints ───────────────────────────────────────────────────────
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  autoGainControl: true,
  noiseSuppression: true,
  sampleRate: 48000,
  channelCount: 1,
};

const VIDEO_CONSTRAINTS = {
  facingMode: "user",
  width: { ideal: 640, max: 1280 },
  height: { ideal: 480, max: 720 },
  frameRate: { ideal: 24, max: 30 },
};

class WebRTCEngine {
  constructor() {
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.callId = null;
    this.isCaller = false;
    this.isAudioOnly = false;
    this.iceCandidateQueue = [];
    this.iceServers = DEFAULT_ICE_SERVERS;

    // ★ Queued signaling (for race condition: offer arrives before PC is ready)
    this._pendingOffer = null;
    this._pendingAnswer = null;
    this._initialized = false;
    this._remoteDescriptionSet = false; // ★ Guard: ICE candidates only after setRemoteDescription

    // ★ Call State Machine
    this._callState = CALL_STATES.IDLE;
    this.onCallStateChange = null;

    // Event callbacks
    this.onRemoteStream = null;
    this.onLocalStream = null;
    this.onConnectionStateChange = null;
    this.onIceConnectionStateChange = null;
    this.onIceCandidate = null; // Added for world video
    this.onOffer = null; // ★ World video: intercept offer to route via world signaling
    this.onAnswer = null; // ★ World video: intercept answer to route via world signaling
    this.onStats = null;
    this.onModeSwitch = null;
    this.onRemoteCameraState = null; // ★ Bug 5: track remote camera on/off
    this.onRemoteVideoFirstFrame = null; // ★ First frame decoded (prevents initial black screen)

    // Stats polling
    this.statsInterval = null;
    this._statsActive = true;

    // Background handling
    this._appStateSubscription = null;
    this._isBackgrounded = false;
    this._videoWasEnabled = true;

    // ICE restart tracking
    this._iceRestartAttempts = 0;
    this._maxIceRestarts = 3;
    this._iceRestartTimer = null;

    // First-frame detection (remote video warmup)
    this._firstFrameTimer = null;

    // ★ Cleanup guard — prevents recursive re-entry
    this._isCleaningUp = false;
    this._speakerOn = false;

    // Persisted user intent (must survive stream re-creation / rematch)
    this._micMuted = false;
    this._cameraOff = false;
  }

  // ─── State Machine ─────────────────────────────────────────────────────────
  get callState() {
    return this._callState;
  }

  _setState(newState) {
    const prev = this._callState;
    if (prev === newState) return;
    this._callState = newState;
    console.log(`📱 Call state: ${prev} → ${newState}`);
    this.onCallStateChange?.(newState, prev);
  }

  get isAvailable() {
    return WEBRTC_AVAILABLE;
  }

  getMicMuted() {
    return !!this._micMuted;
  }

  getCameraOff() {
    return !!this._cameraOff;
  }

  getSpeakerOn() {
    return !!this._speakerOn;
  }

  _applyMicMuted() {
    const muted = !!this._micMuted;

    // Best-effort OS-level mic mute (prevents some OEM audio pipeline leaks)
    if (InCallManager && typeof InCallManager.setMicrophoneMute === "function") {
      try {
        InCallManager.setMicrophoneMute(muted);
      } catch (e) {}
    }

    const tracks = this.localStream?.getAudioTracks?.() || [];
    tracks.forEach((t) => {
      try {
        t.enabled = !muted;
      } catch (e) {}
    });
  }

  _applyCameraOff() {
    const off = !!this._cameraOff;
    const tracks = this.localStream?.getVideoTracks?.() || [];
    tracks.forEach((t) => {
      try {
        t.enabled = !off;
      } catch (e) {}
    });
  }

  setMicMuted(muted) {
    this._micMuted = !!muted;
    this._applyMicMuted();
    return this.getMicMuted();
  }

  setCameraOff(off) {
    this._cameraOff = !!off;
    this._applyCameraOff();
    return this.getCameraOff();
  }

  _clearFirstFrameTimer() {
    if (this._firstFrameTimer) {
      clearInterval(this._firstFrameTimer);
      this._firstFrameTimer = null;
    }
  }

  _armFirstFrameDetector(track) {
    this._clearFirstFrameTimer();

    if (!this.pc || !track || track.kind !== "video") return;

    const startedAt = Date.now();
    this._firstFrameTimer = setInterval(async () => {
      try {
        if (!this.pc) {
          this._clearFirstFrameTimer();
          return;
        }

        // Stop trying after ~6s (avoid infinite timers)
        if (Date.now() - startedAt > 6000) {
          this._clearFirstFrameTimer();
          return;
        }

        const stats = await this.pc.getStats(track);
        let framesDecoded = 0;
        let framesReceived = 0;

        stats.forEach((report) => {
          if (
            report.type === "inbound-rtp" &&
            (report.kind === "video" || report.mediaType === "video")
          ) {
            framesDecoded = Math.max(framesDecoded, report.framesDecoded || 0);
            framesReceived = Math.max(framesReceived, report.framesReceived || 0);
          }
        });

        if (framesDecoded > 0 || framesReceived > 0) {
          this._clearFirstFrameTimer();
          this.onRemoteVideoFirstFrame?.();
        }
      } catch (e) {
        // Ignore transient getStats failures
      }
    }, 250);
  }

  // ─── Fetch TURN Credentials ────────────────────────────────────────────────
  async fetchIceServers() {
    try {
      const data = await apiClient.get(endpoints.turn);
      this.iceServers = data.iceServers;
      return data.iceServers;
    } catch (err) {
      console.warn("Failed to fetch TURN, using STUN only:", err.message);
      return DEFAULT_ICE_SERVERS;
    }
  }

  // ─── Initialize Call ───────────────────────────────────────────────────────
  async initialize(callId, isCaller, videoEnabled = true) {
    this.callId = callId;
    this.isCaller = isCaller;
    this.isAudioOnly = !videoEnabled;
    this._iceRestartAttempts = 0;

    this._setState(isCaller ? CALL_STATES.CALLING : CALL_STATES.CONNECTING);

    // ★ Start InCallManager for proper audio routing
    if (InCallManager) {
      try {
        InCallManager.start({ media: videoEnabled ? "video" : "audio" });
        InCallManager.setForceSpeakerphoneOn(videoEnabled);
        InCallManager.setKeepScreenOn(true);
      } catch (err) {
        console.warn("InCallManager start failed:", err.message);
      }
    }

    // Fetch TURN credentials
    const iceServers = await this.fetchIceServers();

    // Create RTCPeerConnection
    this.pc = new RTCPeerConnection({ ...RTC_CONFIG, iceServers });

    // ─── Get Local Media (Audio FIRST, then video) ────────────────────
    try {
      this.localStream = await mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
        video: videoEnabled ? VIDEO_CONSTRAINTS : false,
      });

      this.localStream.getTracks().forEach((track) => {
        const sender = this.pc.addTrack(track, this.localStream);
        if (track.kind === "audio") {
          this.setTrackPriority(sender, "high");
        } else {
          this.setTrackPriority(sender, "low");
        }
      });

      // Apply persisted user intent to the newly created stream/tracks.
      this._applyMicMuted();
      this._applyCameraOff();
      this.onLocalStream?.(this.localStream);
    } catch (err) {
      if (videoEnabled) {
        console.warn("Video failed, falling back to audio:", err.message);
        this.localStream = await mediaDevices.getUserMedia({
          audio: AUDIO_CONSTRAINTS,
          video: false,
        });
        this.localStream.getTracks().forEach((track) => {
          this.pc.addTrack(track, this.localStream);
        });
        this.isAudioOnly = true;
        // Apply persisted user intent to the newly created stream/tracks.
        this._applyMicMuted();
        this._applyCameraOff();
        this.onLocalStream?.(this.localStream);
        this.onModeSwitch?.("audio_only", "video_capture_failed");
      } else {
        throw err;
      }
    }

    // ─── Remote Stream Handling ────────────────────────────────────────
    this.pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        this.remoteStream = event.streams[0];
        this.onRemoteStream?.(this.remoteStream);

        // ★ Bug 2 fix: Track-level lifecycle listeners for ghost video prevention
        const track = event.track;
        const callId = this.callId; // Capture for logging

        track.onended = () => {
          console.log(`[TRACK_ENDED] callId=${callId} kind=${track.kind}`);
          if (track.kind === 'video') {
            this.onRemoteCameraState?.(false);
          }
          // If ALL tracks ended, clear stream entirely
          const activeTracks = this.remoteStream?.getTracks().filter(t => t.readyState === 'live');
          if (!activeTracks || activeTracks.length === 0) {
            console.log(`[GHOST_VIDEO_PREVENTED] callId=${callId} reason=all_tracks_ended`);
            this.onRemoteStream?.(null);
            this.remoteStream = null;
          }
        };

        track.onmute = () => {
          console.log(`[TRACK_MUTED] callId=${callId} kind=${track.kind}`);
          if (track.kind === 'video') {
            this.onRemoteCameraState?.(false);
          }
        };

        track.onunmute = () => {
          console.log(`[TRACK_UNMUTED] callId=${callId} kind=${track.kind}`);
          if (track.kind === 'video') {
            this.onRemoteCameraState?.(true);
            // Treat video track unmute as a good proxy for first frame availability
            this.onRemoteVideoFirstFrame?.();
          }
        };

        if (track.kind === 'video') {
          // Poll stats until the first frame is decoded to prevent initial black screen.
          this._armFirstFrameDetector(track);
        }
      }
    };

    // ─── ICE Candidate Handling ───────────────────────────────────────
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(
          `🧊 Sending ICE candidate: ${event.candidate.candidate.substring(0, 50)}...`,
        );
        if (this.onIceCandidate) {
          this.onIceCandidate(event.candidate);
        } else {
          signalingClient.sendIceCandidate(this.callId, event.candidate);
        }
      } else {
        console.log("🧊 ICE gathering complete");
      }
    };

    // ─── Connection State Monitoring (★ NULL-SAFE) ────────────────────
    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return; // ★ Guard against null after cleanup
      const state = this.pc.connectionState;
      console.log(`📡 Connection state: ${state}`);
      this.onConnectionStateChange?.(state);

      switch (state) {
        case "connected":
          this._setState(CALL_STATES.CONNECTED);
          this._iceRestartAttempts = 0;
          break;
        case "disconnected":
          this._setState(CALL_STATES.RECONNECTING);
          this.scheduleIceRestart(2000);
          break;
        case "failed":
          this.attemptIceRestart();
          break;
        case "closed":
          this._setState(CALL_STATES.ENDED);
          break;
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return; // ★ Guard against null after cleanup
      const state = this.pc.iceConnectionState;
      console.log(`🧊 ICE state: ${state}`);
      this.onIceConnectionStateChange?.(state);

      if (state === "disconnected") {
        this.scheduleIceRestart(3000);
      }
    };

    // ─── Start Stats Polling ──────────────────────────────────────────
    this.startStatsPolling();

    // ─── Background Mode Handling ─────────────────────────────────────
    this._setupAppStateHandler();

    // ★ FIX: Do NOT drain ICE candidates here — they must wait for setRemoteDescription.
    //    ICE candidates are drained in handleOffer()/handleAnswer() after setRemoteDescription.

    this._initialized = true;

    // ★ Process queued offer/answer (race condition fix)
    // If the offer arrived while we were still initializing, process it now
    if (!isCaller && this._pendingOffer) {
      console.log("📩 Processing queued offer (arrived before PC was ready)");
      const offer = this._pendingOffer;
      this._pendingOffer = null;
      await this.handleOffer(offer);
    }
    if (isCaller && this._pendingAnswer) {
      console.log("📩 Processing queued answer (arrived before PC was ready)");
      const answer = this._pendingAnswer;
      this._pendingAnswer = null;
      await this.handleAnswer(answer);
    }
  }

  // ─── Background Mode (App State) ───────────────────────────────────────────
  _setupAppStateHandler() {
    this._appStateSubscription = AppState.addEventListener(
      "change",
      (nextState) => {
        if (nextState === "background" || nextState === "inactive") {
          this._handleBackground();
        } else if (nextState === "active") {
          this._handleForeground();
        }
      },
    );
  }

  _handleBackground() {
    if (this._isBackgrounded) return;
    this._isBackgrounded = true;
    console.log("📱 App backgrounded — pausing video, keeping audio");

    // Pause video track to save battery
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack) {
      this._videoWasEnabled = videoTrack.enabled;
      videoTrack.enabled = false;
    }

    // ★ Stop stats polling to save battery
    this.pauseStatsPolling();
  }

  _handleForeground() {
    if (!this._isBackgrounded) return;
    this._isBackgrounded = false;
    console.log("📱 App foregrounded — restoring video");

    // Restore video track
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack && this._videoWasEnabled) {
      videoTrack.enabled = true;
    }

    // Resume stats polling
    this.resumeStatsPolling();
  }

  // ─── Track Priority ────────────────────────────────────────────────────────
  setTrackPriority(sender, priority) {
    try {
      const params = sender.getParameters();
      if (params.encodings && params.encodings.length > 0) {
        params.encodings[0].networkPriority = priority;
        params.encodings[0].priority = priority;
        if (sender.track?.kind === "audio") {
          params.encodings[0].maxBitrate = 24000;
        }
        if (sender.track?.kind === "video") {
          params.encodings[0].maxBitrate = 500000;
          params.encodings[0].maxFramerate = 24;
        }
        sender.setParameters(params);
      }
    } catch (err) {
      console.warn("Failed to set track priority:", err.message);
    }
  }

  // ─── SDP Offer/Answer ──────────────────────────────────────────────────────
  async createOffer() {
    this._setState(CALL_STATES.CONNECTING);
    const offer = await this.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true, // ★ Always receive video — let network monitor decide display
    });
    offer.sdp = this.mungeOpusSDP(offer.sdp);
    await this.pc.setLocalDescription(offer);

    // ★ Fix: Add logging for debugging SDP issues
    console.log('📤 createOffer completed, SDP length:', offer.sdp ? offer.sdp.length : 0);
    
    // ★ If onOffer callback is set (world video), use it instead of default 1:1 signaling
    if (this.onOffer) {
      console.log('📤 Calling onOffer callback');
      this.onOffer(offer);
    } else {
      signalingClient.sendOffer(this.callId, offer);
    }
    return offer; // ★ Return the offer for callers that need the SDP
  }

  async handleOffer(sdp) {
    // ★ Queue if PC isn't ready yet (race condition fix)
    if (!this.pc || !this._initialized) {
      console.log("⏳ Offer received before PC ready — queuing");
      this._pendingOffer = sdp;
      return;
    }
    // ★ Normalize SDP — accept string or {type, sdp} object
    const descInit = typeof sdp === 'string' ? { type: 'offer', sdp } : sdp;
    const desc = new RTCSessionDescription(descInit);
    await this.pc.setRemoteDescription(desc);
    this._remoteDescriptionSet = true; // ★ Now safe to add ICE candidates
    // ★ Drain queued ICE candidates now that remoteDescription is set
    await this._drainIceCandidateQueue();
    const answer = await this.pc.createAnswer();
    answer.sdp = this.mungeOpusSDP(answer.sdp);
    await this.pc.setLocalDescription(answer);
    // ★ If onAnswer callback is set (world video), use it instead of default 1:1 signaling
    if (this.onAnswer) {
      this.onAnswer(answer);
    } else {
      signalingClient.sendAnswer(this.callId, answer);
    }
  }

  async handleAnswer(sdp) {
    // ★ Queue if PC isn't ready yet
    if (!this.pc || !this._initialized) {
      console.log("⏳ Answer received before PC ready — queuing");
      this._pendingAnswer = sdp;
      return;
    }
    // ★ Normalize SDP — accept string or {type, sdp} object
    const descInit = typeof sdp === 'string' ? { type: 'answer', sdp } : sdp;
    const desc = new RTCSessionDescription(descInit);
    await this.pc.setRemoteDescription(desc);
    this._remoteDescriptionSet = true; // ★ Now safe to add ICE candidates
    // ★ Drain queued ICE candidates now that remoteDescription is set
    await this._drainIceCandidateQueue();
  }

  async handleIceCandidate(candidate) {
    // ★ FIX: Use explicit flag instead of checking remoteDescription object
    //    remoteDescription can be truthy but incomplete during negotiation
    if (!this.pc || !this._remoteDescriptionSet) {
      this.iceCandidateQueue.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn("Failed to add ICE candidate:", err.message);
    }
  }

  // ★ Drain all queued ICE candidates after remoteDescription is set
  async _drainIceCandidateQueue() {
    if (this.iceCandidateQueue.length === 0) return;
    console.log(
      `🧊 Draining ${this.iceCandidateQueue.length} queued ICE candidates`,
    );
    while (this.iceCandidateQueue.length > 0) {
      const candidate = this.iceCandidateQueue.shift();
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn("Failed to add queued ICE candidate:", err.message);
      }
    }
  }

  // ─── SDP Munging — Opus Optimization ───────────────────────────────────────
  mungeOpusSDP(sdp) {
    const opusParams = [
      "maxaveragebitrate=24000",
      "useinbandfec=1",
      "usedtx=1",
      "stereo=0",
      "cbr=0",
      "minptime=10",
      "maxptime=60",
    ].join(";");

    const lines = sdp.split("\r\n");
    const munged = lines.map((line) => {
      if (
        line.startsWith("a=rtpmap:") &&
        line.toLowerCase().includes("opus/48000")
      ) {
        const payloadType = line.split(":")[1].split(" ")[0];
        this._opusPayloadType = payloadType;
      }
      if (
        this._opusPayloadType &&
        line.startsWith(`a=fmtp:${this._opusPayloadType}`)
      ) {
        if (line.includes(";")) return `${line};${opusParams}`;
        return `${line} ${opusParams}`;
      }
      return line;
    });

    if (this._opusPayloadType) {
      const fmtpExists = munged.some((l) =>
        l.startsWith(`a=fmtp:${this._opusPayloadType}`),
      );
      if (!fmtpExists) {
        const rtpmapIndex = munged.findIndex((l) =>
          l.startsWith(`a=rtpmap:${this._opusPayloadType}`),
        );
        if (rtpmapIndex !== -1) {
          munged.splice(
            rtpmapIndex + 1,
            0,
            `a=fmtp:${this._opusPayloadType} ${opusParams}`,
          );
        }
      }
    }
    return munged.join("\r\n");
  }

  // ─── ICE Restart (WiFi↔LTE handoff) ────────────────────────────────────────
  scheduleIceRestart(delayMs) {
    if (this._iceRestartTimer) return; // Already scheduled
    this._iceRestartTimer = setTimeout(() => {
      this._iceRestartTimer = null;
      if (
        this.pc?.iceConnectionState === "disconnected" ||
        this.pc?.connectionState === "disconnected" ||
        this.pc?.connectionState === "failed"
      ) {
        this.attemptIceRestart();
      }
    }, delayMs);
  }

  async attemptIceRestart() {
    if (!this.pc) return;
    if (this._iceRestartAttempts >= this._maxIceRestarts) {
      console.error("❌ Max ICE restart attempts reached");
      this._setState(CALL_STATES.FAILED);
      return;
    }

    this._iceRestartAttempts++;
    this._setState(CALL_STATES.RECONNECTING);
    console.log(
      `🔄 ICE restart attempt ${this._iceRestartAttempts}/${this._maxIceRestarts}`,
    );

    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      offer.sdp = this.mungeOpusSDP(offer.sdp);
      await this.pc.setLocalDescription(offer);
      signalingClient.sendIceRestart(this.callId, offer);
    } catch (err) {
      console.error("ICE restart failed:", err);
      if (this._iceRestartAttempts >= this._maxIceRestarts) {
        this._setState(CALL_STATES.FAILED);
      }
    }
  }

  // ─── Media Controls ────────────────────────────────────────────────────────
  toggleMute() {
    return this.setMicMuted(!this._micMuted);
  }

  toggleCamera() {
    return this.setCameraOff(!this._cameraOff);
  }

  async switchCamera() {
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack && typeof videoTrack._switchCamera === "function") {
      videoTrack._switchCamera();
    }
  }

  /**
   * Toggle speakerphone on/off via InCallManager.
   * @returns {boolean} New speaker state (true = speaker on)
   */
  toggleSpeaker() {
    if (!InCallManager) return false;
    this._speakerOn = !this._speakerOn;
    try {
      InCallManager.setForceSpeakerphoneOn(this._speakerOn);
    } catch (e) {
      console.warn("Failed to toggle speaker:", e.message);
    }
    return this._speakerOn;
  }

  // ─── Audio/Video Mode Switching ────────────────────────────────────────────
  async switchToAudioOnly() {
    if (this.isAudioOnly) return;
    this.isAudioOnly = true;

    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.stop();
      this.localStream.removeTrack(videoTrack);
      const senders = this.pc?.getSenders() || [];
      const videoSender = senders.find((s) => s.track?.kind === "video");
      if (videoSender) this.pc.removeTrack(videoSender);
    }

    // ★ Switch InCallManager to audio mode
    if (InCallManager) {
      try {
        InCallManager.setForceSpeakerphoneOn(false);
      } catch (e) {}
    }

    // ★ Reduce stats polling frequency to save battery
    this.pauseStatsPolling();

    this.onModeSwitch?.("audio_only", "bandwidth_low");
    console.log("🔇 Switched to audio-only mode");
  }

  async switchToVideoMode() {
    if (!this.isAudioOnly) return;

    try {
      const videoStream = await mediaDevices.getUserMedia({
        video: VIDEO_CONSTRAINTS,
      });
      const videoTrack = videoStream.getVideoTracks()[0];

      this.localStream.addTrack(videoTrack);
      const sender = this.pc.addTrack(videoTrack, this.localStream);
      this.setTrackPriority(sender, "low");

      this.isAudioOnly = false;
      this._applyCameraOff();
      this.onLocalStream?.(this.localStream);

      // ★ Switch InCallManager to video mode
      if (InCallManager) {
        try {
          InCallManager.setForceSpeakerphoneOn(true);
        } catch (e) {}
      }

      // Resume full stats polling
      this.resumeStatsPolling();

      // ★ KEY FIX: Trigger SDP renegotiation so the remote peer
      // receives the new video track via ontrack event.
      // Without this, the remote side never gets the video and shows black.
      try {
        const offer = await this.pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        offer.sdp = this.mungeOpusSDP(offer.sdp);
        await this.pc.setLocalDescription(offer);
        signalingClient.sendOffer(this.callId, offer);
        console.log("📹 Renegotiation offer sent after adding video track");
      } catch (reErr) {
        console.warn("Renegotiation after video add failed:", reErr.message);
      }

      this.onModeSwitch?.("video", "bandwidth_recovered");
      console.log("📹 Restored video mode");
    } catch (err) {
      console.warn("Failed to restore video:", err.message);
    }
  }

  /**
   * Enable local video track WITHOUT triggering SDP renegotiation.
   * Used by the RECEIVING side of a call-mode-switch signal.
   * The SENDING side will trigger renegotiation via switchToVideoMode().
   */
  async enableLocalVideo() {
    if (!this.isAudioOnly) return;

    try {
      const videoStream = await mediaDevices.getUserMedia({
        video: VIDEO_CONSTRAINTS,
      });
      const videoTrack = videoStream.getVideoTracks()[0];

      this.localStream.addTrack(videoTrack);
      this.pc.addTrack(videoTrack, this.localStream);

      this.isAudioOnly = false;
      this._applyCameraOff();
      this.onLocalStream?.(this.localStream);

      if (InCallManager) {
        try {
          InCallManager.setForceSpeakerphoneOn(true);
        } catch (e) {}
      }

      this.resumeStatsPolling();
      this.onModeSwitch?.("video", "remote_switched");
      console.log(
        "📹 Enabled local video (no renegotiation — waiting for remote offer)",
      );
    } catch (err) {
      console.warn("Failed to enable local video:", err.message);
    }
  }

  // ─── Video Bitrate Adjustment ──────────────────────────────────────────────
  async adjustVideoBitrate(maxBitrate, maxFramerate) {
    const senders = this.pc?.getSenders() || [];
    const videoSender = senders.find((s) => s.track?.kind === "video");
    if (videoSender) {
      try {
        const params = videoSender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          params.encodings[0].maxBitrate = maxBitrate;
          params.encodings[0].maxFramerate = maxFramerate;
          await videoSender.setParameters(params);
        }
      } catch (err) {
        console.warn("Failed to adjust video bitrate:", err.message);
      }
    }
  }

  // ─── Stats Polling (Battery-Aware) ─────────────────────────────────────────
  startStatsPolling() {
    this._statsActive = true;
    this.statsInterval = setInterval(async () => {
      if (!this.pc || !this._statsActive) return;
      try {
        const stats = await this.pc.getStats();
        const parsed = this.parseStats(stats);
        this.onStats?.(parsed);
      } catch (err) {
        // Non-critical — may fail during renegotiation
      }
    }, 2000);
  }

  pauseStatsPolling() {
    this._statsActive = false;
  }

  resumeStatsPolling() {
    this._statsActive = true;
  }

  parseStats(stats) {
    const result = {
      audio: {
        bytesSent: 0,
        bytesReceived: 0,
        packetsReceived: 0,
        packetLoss: 0,
        jitter: 0,
        bitrate: 0,
      },
      video: {
        bytesSent: 0,
        bytesReceived: 0,
        packetsReceived: 0,
        packetLoss: 0,
        jitter: 0,
        bitrate: 0,
        frameRate: 0,
      },
      connection: { rtt: 0, availableOutgoingBitrate: 0, iceState: "" },
      timestamp: Date.now(),
    };

    stats.forEach((report) => {
      if (report.type === "inbound-rtp") {
        const kind = report.kind || report.mediaType;
        if (kind === "audio") {
          result.audio.bytesReceived = report.bytesReceived || 0;
          result.audio.packetsLost = report.packetsLost || 0;
          result.audio.packetsReceived = report.packetsReceived || 0;
          result.audio.jitter = (report.jitter || 0) * 1000;
          if (result.audio.packetsReceived > 0) {
            result.audio.packetLoss =
              (result.audio.packetsLost /
                (result.audio.packetsReceived + result.audio.packetsLost)) *
              100;
          }
        } else if (kind === "video") {
          result.video.bytesReceived = report.bytesReceived || 0;
          result.video.packetsLost = report.packetsLost || 0;
          result.video.packetsReceived = report.packetsReceived || 0;
          result.video.frameRate = report.framesPerSecond || 0;
          if (result.video.packetsReceived > 0) {
            result.video.packetLoss =
              (result.video.packetsLost /
                (result.video.packetsReceived + result.video.packetsLost)) *
              100;
          }
        }
      }
      if (report.type === "outbound-rtp") {
        const kind = report.kind || report.mediaType;
        if (kind === "audio") result.audio.bytesSent = report.bytesSent || 0;
        else if (kind === "video")
          result.video.bytesSent = report.bytesSent || 0;
      }
      if (report.type === "candidate-pair" && report.state === "succeeded") {
        result.connection.rtt = report.currentRoundTripTime
          ? report.currentRoundTripTime * 1000
          : 0;
        result.connection.availableOutgoingBitrate =
          report.availableOutgoingBitrate || 0;
      }
    });
    return result;
  }

  // ─── Cleanup (Idempotent) ──────────────────────────────────────────────────
  cleanup() {
    // ★ Prevent recursive re-entry (fixes race condition crash)
    if (this._isCleaningUp) {
      return;
    }

    // ★ Allow cleanup from any state except IDLE
    if (this._callState === CALL_STATES.IDLE) {
      return;
    }

    this._isCleaningUp = true;

    try {
      this._setState(CALL_STATES.ENDING);

      // ★ Stop InCallManager
      if (InCallManager) {
        try {
          InCallManager.stop();
          InCallManager.setKeepScreenOn(false);
        } catch (e) {}
      }

      // Remove AppState listener
      if (this._appStateSubscription) {
        this._appStateSubscription.remove();
        this._appStateSubscription = null;
      }

      // Clear timers
      if (this.statsInterval) {
        clearInterval(this.statsInterval);
        this.statsInterval = null;
      }
      if (this._iceRestartTimer) {
        clearTimeout(this._iceRestartTimer);
        this._iceRestartTimer = null;
      }
      this._clearFirstFrameTimer();

      // Stop all tracks
      if (this.localStream) {
        try {
          this.localStream.getTracks().forEach((track) => track.stop());
        } catch (e) {
          crashLogger.log(
            CATEGORIES.WEBRTC_ERROR,
            "Error stopping local tracks",
            e,
          );
        }
        // ★ Bug 2 fix: Notify React BEFORE nulling reference
        this.onLocalStream?.(null);
        this.localStream = null;
      }
      if (this.remoteStream) {
        // ★ Bug 2 fix: Notify React BEFORE nulling reference
        // This is the critical fix — without this, the RTCView keeps
        // rendering the last decoded frame (ghost video)
        console.log(`[GHOST_VIDEO_PREVENTED] callId=${this.callId} reason=cleanup`);
        this.onRemoteStream?.(null);
        this.remoteStream = null;
      }

      // Close peer connection
      if (this.pc) {
        try {
          this.pc.onconnectionstatechange = null;
          this.pc.oniceconnectionstatechange = null;
          this.pc.ontrack = null;
          this.pc.onicecandidate = null;
          this.pc.close();
        } catch (e) {
          crashLogger.log(
            CATEGORIES.WEBRTC_ERROR,
            "Error closing peer connection",
            e,
          );
        }
        this.pc = null;
      }

      this.callId = null;
      this.iceCandidateQueue = [];
      this.isAudioOnly = false;
      this._opusPayloadType = null;
      this._statsActive = true;
      this._isBackgrounded = false;
      this._iceRestartAttempts = 0;
      this._initialized = false;
      this._remoteDescriptionSet = false;
      this._pendingOffer = null;
      this._pendingAnswer = null;

      // ★ Reset world video signaling callbacks
      this.onOffer = null;
      this.onAnswer = null;
      this.onIceCandidate = null;
      this.onRemoteCameraState = null;

      this._setState(CALL_STATES.IDLE);
    } catch (err) {
      crashLogger.log(CATEGORIES.WEBRTC_ERROR, "Cleanup error", err);
    } finally {
      this._isCleaningUp = false;
    }
  }
}

// Singleton
const webrtcEngine = new WebRTCEngine();
export default webrtcEngine;
