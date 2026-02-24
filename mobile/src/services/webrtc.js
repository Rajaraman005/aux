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
  const webrtcModule = require("react-native-webrtc");
  RTCPeerConnection = webrtcModule.RTCPeerConnection;
  RTCSessionDescription = webrtcModule.RTCSessionDescription;
  RTCIceCandidate = webrtcModule.RTCIceCandidate;
  mediaDevices = webrtcModule.mediaDevices;
  WEBRTC_AVAILABLE = true;
} catch (err) {
  console.warn(
    "⚠️  react-native-webrtc not available. Call features disabled.",
  );
}

// ─── InCallManager for audio routing ─────────────────────────────────────────
let InCallManager = null;
try {
  InCallManager = require("react-native-incall-manager").default;
} catch (err) {
  console.warn("⚠️  InCallManager not available.");
}

import { AppState } from "react-native";
import signalingClient from "./socket";
import { endpoints } from "../config/api";
import apiClient from "./api";

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
    this.onStats = null;
    this.onModeSwitch = null;

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
      }
    };

    // ─── ICE Candidate Handling ───────────────────────────────────────
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(
          `🧊 Sending ICE candidate: ${event.candidate.candidate.substring(0, 50)}...`,
        );
        signalingClient.sendIceCandidate(this.callId, event.candidate);
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
    signalingClient.sendOffer(this.callId, offer);
  }

  async handleOffer(sdp) {
    // ★ Queue if PC isn't ready yet (race condition fix)
    if (!this.pc || !this._initialized) {
      console.log("⏳ Offer received before PC ready — queuing");
      this._pendingOffer = sdp;
      return;
    }
    const desc = new RTCSessionDescription(sdp);
    await this.pc.setRemoteDescription(desc);
    this._remoteDescriptionSet = true; // ★ Now safe to add ICE candidates
    // ★ Drain queued ICE candidates now that remoteDescription is set
    await this._drainIceCandidateQueue();
    const answer = await this.pc.createAnswer();
    answer.sdp = this.mungeOpusSDP(answer.sdp);
    await this.pc.setLocalDescription(answer);
    signalingClient.sendAnswer(this.callId, answer);
  }

  async handleAnswer(sdp) {
    // ★ Queue if PC isn't ready yet
    if (!this.pc || !this._initialized) {
      console.log("⏳ Answer received before PC ready — queuing");
      this._pendingAnswer = sdp;
      return;
    }
    const desc = new RTCSessionDescription(sdp);
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
    const audioTrack = this.localStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      return !audioTrack.enabled;
    }
    return false;
  }

  toggleCamera() {
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      return !videoTrack.enabled;
    }
    return true;
  }

  async switchCamera() {
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack && typeof videoTrack._switchCamera === "function") {
      videoTrack._switchCamera();
    }
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
      this.onLocalStream?.(this.localStream);

      // ★ Switch InCallManager to video mode
      if (InCallManager) {
        try {
          InCallManager.setForceSpeakerphoneOn(true);
        } catch (e) {}
      }

      // Resume full stats polling
      this.resumeStatsPolling();

      this.onModeSwitch?.("video", "bandwidth_recovered");
      console.log("📹 Restored video mode");
    } catch (err) {
      console.warn("Failed to restore video:", err.message);
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
        packetLoss: 0,
        jitter: 0,
        bitrate: 0,
      },
      video: {
        bytesSent: 0,
        bytesReceived: 0,
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
    // ★ Idempotent guard — prevent re-entrant cleanup
    if (
      this._callState === CALL_STATES.IDLE ||
      this._callState === CALL_STATES.ENDING
    ) {
      return;
    }
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

    // Stop all tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.remoteStream) {
      this.remoteStream = null;
    }

    // Close peer connection
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.close();
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

    this._setState(CALL_STATES.IDLE);
  }
}

// Singleton
const webrtcEngine = new WebRTCEngine();
export default webrtcEngine;
