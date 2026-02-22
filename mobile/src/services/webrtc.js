/**
 * Audio-First WebRTC Engine.
 * THE MOST CRITICAL FILE IN THE ENTIRE APP.
 *
 * Design Principles:
 * 1. Audio ALWAYS gets priority over video
 * 2. Opus codec forced at 8-24kbps with FEC+DTX
 * 3. Video degrades first, audio never degrades until video is fully dropped
 * 4. ICE restart for seamless WiFi↔LTE handoff
 * 5. SDP munging for Opus optimization
 *
 * Call Cascade: P2P → SFU → TURN relay
 */
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
} from "react-native-webrtc";
import signalingClient from "./socket";
import { endpoints } from "../config/api";
import apiClient from "./api";

// ─── ICE Server Config ──────────────────────────────────────────────────────
const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
];

// ─── RTC Configuration ──────────────────────────────────────────────────────
const RTC_CONFIG = {
  iceServers: DEFAULT_ICE_SERVERS,
  iceTransportPolicy: "all", // Try P2P first, then relay
  bundlePolicy: "max-bundle", // Bundle audio+video on single transport
  rtcpMuxPolicy: "require", // Reduce port usage
  iceCandidatePoolSize: 5, // Pre-gather ICE candidates for faster connection
};

// ─── Media Constraints ───────────────────────────────────────────────────────
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  autoGainControl: true,
  noiseSuppression: true,
  sampleRate: 48000,
  channelCount: 1, // Mono — saves bandwidth
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

    // Event callbacks
    this.onRemoteStream = null;
    this.onLocalStream = null;
    this.onConnectionStateChange = null;
    this.onIceConnectionStateChange = null;
    this.onStats = null;
    this.onModeSwitch = null;

    // Stats polling
    this.statsInterval = null;
  }

  /**
   * Fetch TURN credentials from server (time-limited HMAC).
   */
  async fetchIceServers() {
    try {
      const data = await apiClient.get(endpoints.turn);
      this.iceServers = data.iceServers;
      return data.iceServers;
    } catch (err) {
      console.warn(
        "Failed to fetch TURN credentials, using STUN only:",
        err.message,
      );
      return DEFAULT_ICE_SERVERS;
    }
  }

  /**
   * Initialize a call — get media, create peer connection.
   * @param {string} callId
   * @param {boolean} isCaller
   * @param {boolean} videoEnabled
   */
  async initialize(callId, isCaller, videoEnabled = true) {
    this.callId = callId;
    this.isCaller = isCaller;
    this.isAudioOnly = !videoEnabled;

    // Fetch fresh TURN credentials
    const iceServers = await this.fetchIceServers();

    // Create RTCPeerConnection
    this.pc = new RTCPeerConnection({
      ...RTC_CONFIG,
      iceServers,
    });

    // ─── Get Local Media (Audio FIRST, then video) ────────────────────
    try {
      // Always get audio first
      this.localStream = await mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
        video: videoEnabled ? VIDEO_CONSTRAINTS : false,
      });

      // Add tracks to peer connection
      this.localStream.getTracks().forEach((track) => {
        const sender = this.pc.addTrack(track, this.localStream);

        // ★ CRITICAL: Set audio to HIGH priority, video to LOW
        if (track.kind === "audio") {
          this.setTrackPriority(sender, "high");
        } else {
          this.setTrackPriority(sender, "low");
        }
      });

      this.onLocalStream?.(this.localStream);
    } catch (err) {
      // If video fails, fall back to audio-only
      if (videoEnabled) {
        console.warn(
          "Video capture failed, falling back to audio-only:",
          err.message,
        );
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
        signalingClient.sendIceCandidate(this.callId, event.candidate);
      }
    };

    // ─── Connection State Monitoring ──────────────────────────────────
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      console.log(`📡 Connection state: ${state}`);
      this.onConnectionStateChange?.(state);

      if (state === "failed") {
        this.attemptIceRestart();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      console.log(`🧊 ICE state: ${state}`);
      this.onIceConnectionStateChange?.(state);

      if (state === "disconnected") {
        // Wait 3s before attempting ICE restart (may recover)
        setTimeout(() => {
          if (this.pc?.iceConnectionState === "disconnected") {
            this.attemptIceRestart();
          }
        }, 3000);
      }
    };

    // ─── Start Stats Polling ──────────────────────────────────────────
    this.startStatsPolling();

    // ─── Process queued ICE candidates ────────────────────────────────
    while (this.iceCandidateQueue.length > 0) {
      const candidate = this.iceCandidateQueue.shift();
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  /**
   * Set transceiver priority for bandwidth allocation.
   * Audio = high, Video = low → audio never degrades before video.
   */
  setTrackPriority(sender, priority) {
    try {
      const params = sender.getParameters();
      if (params.encodings && params.encodings.length > 0) {
        params.encodings[0].networkPriority = priority;
        params.encodings[0].priority = priority;

        // For audio: set optimal Opus bitrate
        if (sender.track?.kind === "audio") {
          params.encodings[0].maxBitrate = 24000; // 24kbps max
        }

        // For video: cap bitrate
        if (sender.track?.kind === "video") {
          params.encodings[0].maxBitrate = 500000; // 500kbps max
          params.encodings[0].maxFramerate = 24;
        }

        sender.setParameters(params);
      }
    } catch (err) {
      console.warn("Failed to set track priority:", err.message);
    }
  }

  /**
   * Create and send an SDP offer.
   * Munges SDP to optimize Opus codec parameters.
   */
  async createOffer() {
    const offer = await this.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: !this.isAudioOnly,
    });

    // ★ Munge SDP for Opus optimization
    offer.sdp = this.mungeOpusSDP(offer.sdp);

    await this.pc.setLocalDescription(offer);
    signalingClient.sendOffer(this.callId, offer);
  }

  /**
   * Handle incoming SDP offer.
   */
  async handleOffer(sdp) {
    const desc = new RTCSessionDescription(sdp);
    await this.pc.setRemoteDescription(desc);

    const answer = await this.pc.createAnswer();
    answer.sdp = this.mungeOpusSDP(answer.sdp);

    await this.pc.setLocalDescription(answer);
    signalingClient.sendAnswer(this.callId, answer);
  }

  /**
   * Handle incoming SDP answer.
   */
  async handleAnswer(sdp) {
    const desc = new RTCSessionDescription(sdp);
    await this.pc.setRemoteDescription(desc);
  }

  /**
   * Handle incoming ICE candidate.
   */
  async handleIceCandidate(candidate) {
    if (!this.pc || !this.pc.remoteDescription) {
      // Queue if remote description not set yet
      this.iceCandidateQueue.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  /**
   * ★ SDP Munging — Optimize Opus Codec for Low-Bandwidth Audio
   *
   * Forces the following Opus parameters:
   * - maxaveragebitrate: 24000 (24kbps — clear voice on low networks)
   * - useinbandfec: 1 (Forward Error Correction — survives packet loss)
   * - usedtx: 1 (Discontinuous Transmission — saves bandwidth in silence)
   * - stereo: 0 (Mono — 50% bandwidth reduction)
   * - cbr: 0 (Variable Bitrate — adapts to network)
   * - minptime: 10 (Minimum packet time)
   * - maxptime: 60 (Maximum packet time — larger packets = fewer headers)
   */
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

    // Find Opus fmtp line and append parameters
    const lines = sdp.split("\r\n");
    const munged = lines.map((line) => {
      // Find Opus payload type
      if (
        line.startsWith("a=rtpmap:") &&
        line.toLowerCase().includes("opus/48000")
      ) {
        const payloadType = line.split(":")[1].split(" ")[0];
        // Mark for fmtp addition
        this._opusPayloadType = payloadType;
      }

      // Modify or add fmtp for Opus
      if (
        this._opusPayloadType &&
        line.startsWith(`a=fmtp:${this._opusPayloadType}`)
      ) {
        // Append our params to existing fmtp
        if (line.includes(";")) {
          return `${line};${opusParams}`;
        }
        return `${line} ${opusParams}`;
      }

      return line;
    });

    // If no fmtp line existed for Opus, add one
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

  /**
   * ICE Restart — seamless recovery on network change (WiFi↔LTE).
   */
  async attemptIceRestart() {
    if (!this.pc) return;

    console.log("🔄 Attempting ICE restart...");
    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      offer.sdp = this.mungeOpusSDP(offer.sdp);
      await this.pc.setLocalDescription(offer);
      signalingClient.sendIceRestart(this.callId, offer);
    } catch (err) {
      console.error("ICE restart failed:", err);
    }
  }

  /**
   * Switch to audio-only mode (drop video track).
   */
  async switchToAudioOnly() {
    if (this.isAudioOnly) return;
    this.isAudioOnly = true;

    // Remove video track from local stream
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.stop();
      this.localStream.removeTrack(videoTrack);

      // Remove from peer connection
      const senders = this.pc.getSenders();
      const videoSender = senders.find((s) => s.track?.kind === "video");
      if (videoSender) {
        this.pc.removeTrack(videoSender);
      }
    }

    this.onModeSwitch?.("audio_only", "bandwidth_low");
    console.log("🔇 Switched to audio-only mode");
  }

  /**
   * Restore video after audio-only mode.
   */
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
      this.onModeSwitch?.("video", "bandwidth_recovered");
      console.log("📹 Restored video mode");
    } catch (err) {
      console.warn("Failed to restore video:", err.message);
    }
  }

  /**
   * Toggle microphone mute.
   */
  toggleMute() {
    const audioTrack = this.localStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      return !audioTrack.enabled; // true = muted
    }
    return false;
  }

  /**
   * Toggle camera on/off.
   */
  toggleCamera() {
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      return !videoTrack.enabled; // true = camera off
    }
    return true; // No video track = camera off
  }

  /**
   * Switch front/back camera.
   */
  async switchCamera() {
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack && typeof videoTrack._switchCamera === "function") {
      videoTrack._switchCamera();
    }
  }

  /**
   * Adjust video bitrate dynamically.
   * Called by NetworkMonitor based on bandwidth estimation.
   */
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

  /**
   * Start polling WebRTC stats for network monitoring.
   */
  startStatsPolling() {
    this.statsInterval = setInterval(async () => {
      if (!this.pc) return;

      try {
        const stats = await this.pc.getStats();
        const parsed = this.parseStats(stats);
        this.onStats?.(parsed);
      } catch (err) {
        // Stats may fail during renegotiation — non-critical
      }
    }, 2000);
  }

  /**
   * Parse RTCStatsReport into usable metrics.
   */
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
          result.audio.jitter = (report.jitter || 0) * 1000; // Convert to ms
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
        if (kind === "audio") {
          result.audio.bytesSent = report.bytesSent || 0;
        } else if (kind === "video") {
          result.video.bytesSent = report.bytesSent || 0;
        }
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

  /**
   * Clean up everything.
   */
  cleanup() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
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
      this.pc.close();
      this.pc = null;
    }

    this.callId = null;
    this.iceCandidateQueue = [];
    this.isAudioOnly = false;
    this._opusPayloadType = null;
  }
}

// Singleton
const webrtcEngine = new WebRTCEngine();
export default webrtcEngine;
