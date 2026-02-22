/**
 * Network Adaptation Engine.
 * Monitors real-time call quality and dynamically adjusts bitrate.
 *
 * Adaptive Tiers:
 *   > 200kbps  → Full video (30fps, 640p)
 *   100-200kbps → Reduced video (15fps, 240p)
 *   50-100kbps  → Minimal video (5fps, 160p)
 *   < 50kbps   → AUDIO-ONLY (video dropped entirely)
 *
 * Golden Rule: Audio NEVER degrades before video is fully dropped.
 */
import webrtcEngine from "./webrtc";
import signalingClient from "./socket";

// ─── Quality Tiers ───────────────────────────────────────────────────────────
const QUALITY_TIERS = {
  EXCELLENT: {
    name: "excellent",
    level: 5,
    minBandwidth: 200000,
    videoBitrate: 500000,
    videoFramerate: 30,
  },
  GOOD: {
    name: "good",
    level: 4,
    minBandwidth: 100000,
    videoBitrate: 200000,
    videoFramerate: 15,
  },
  FAIR: {
    name: "fair",
    level: 3,
    minBandwidth: 50000,
    videoBitrate: 80000,
    videoFramerate: 5,
  },
  AUDIO_ONLY: {
    name: "audio_only",
    level: 2,
    minBandwidth: 0,
    videoBitrate: 0,
    videoFramerate: 0,
  },
  CRITICAL: {
    name: "critical",
    level: 1,
    minBandwidth: 0,
    videoBitrate: 0,
    videoFramerate: 0,
  },
};

// Packet loss thresholds
const PACKET_LOSS_FEC_THRESHOLD = 5; // > 5% → Enable FEC, reduce video
const PACKET_LOSS_AUDIO_ONLY = 15; // > 15% → Force audio-only + max FEC

// ─── Network Monitor ─────────────────────────────────────────────────────────
class NetworkMonitor {
  constructor() {
    this.currentTier = QUALITY_TIERS.EXCELLENT;
    this.previousStats = null;
    this.averagedStats = {
      packetLoss: 0,
      jitter: 0,
      rtt: 0,
      bandwidth: 0,
    };

    // Smoothing factor (EMA — exponential moving average)
    this.alpha = 0.3;

    // Callbacks
    this.onQualityChange = null;
    this.onModeSwitch = null;
    this.onStatsUpdate = null;

    // Metrics reporting
    this.metricsInterval = null;
    this.modeSwitchCount = 0;
  }

  /**
   * Start monitoring. Call after WebRTC stats polling begins.
   */
  start(callId) {
    this.callId = callId;

    // Attach to WebRTC engine stats
    webrtcEngine.onStats = (stats) => this.processStats(stats);

    // Report metrics to server every 10s
    this.metricsInterval = setInterval(() => {
      this.reportMetrics();
    }, 10000);
  }

  /**
   * Process incoming stats and adapt quality.
   */
  processStats(stats) {
    // ─── Calculate Derived Metrics ────────────────────────────────────
    const bandwidth = stats.connection.availableOutgoingBitrate;
    const audioPacketLoss = stats.audio.packetLoss || 0;
    const videoPacketLoss = stats.video.packetLoss || 0;
    const maxPacketLoss = Math.max(audioPacketLoss, videoPacketLoss);
    const rtt = stats.connection.rtt;
    const jitter = stats.audio.jitter;

    // ─── Exponential Moving Average (smooth out spikes) ──────────────
    this.averagedStats.packetLoss = this.ema(
      this.averagedStats.packetLoss,
      maxPacketLoss,
    );
    this.averagedStats.jitter = this.ema(this.averagedStats.jitter, jitter);
    this.averagedStats.rtt = this.ema(this.averagedStats.rtt, rtt);
    this.averagedStats.bandwidth =
      bandwidth > 0
        ? this.ema(this.averagedStats.bandwidth, bandwidth)
        : this.averagedStats.bandwidth;

    // ─── Determine Quality Tier ──────────────────────────────────────
    let newTier;

    // Packet loss overrides bandwidth-based decisions
    if (this.averagedStats.packetLoss > PACKET_LOSS_AUDIO_ONLY) {
      newTier = QUALITY_TIERS.CRITICAL;
    } else if (this.averagedStats.packetLoss > PACKET_LOSS_FEC_THRESHOLD) {
      // High packet loss — reduce to fair or audio-only
      if (this.averagedStats.bandwidth < 100000) {
        newTier = QUALITY_TIERS.AUDIO_ONLY;
      } else {
        newTier = QUALITY_TIERS.FAIR;
      }
    } else if (
      this.averagedStats.bandwidth >= QUALITY_TIERS.EXCELLENT.minBandwidth
    ) {
      newTier = QUALITY_TIERS.EXCELLENT;
    } else if (
      this.averagedStats.bandwidth >= QUALITY_TIERS.GOOD.minBandwidth
    ) {
      newTier = QUALITY_TIERS.GOOD;
    } else if (
      this.averagedStats.bandwidth >= QUALITY_TIERS.FAIR.minBandwidth
    ) {
      newTier = QUALITY_TIERS.FAIR;
    } else {
      newTier = QUALITY_TIERS.AUDIO_ONLY;
    }

    // ─── Apply Changes ───────────────────────────────────────────────
    if (newTier.name !== this.currentTier.name) {
      this.applyTier(newTier);
    }

    // ─── Emit stats update ──────────────────────────────────────────
    this.onStatsUpdate?.({
      tier: this.currentTier,
      raw: stats,
      averaged: { ...this.averagedStats },
      timestamp: stats.timestamp,
    });

    this.previousStats = stats;
  }

  /**
   * Apply quality tier changes.
   */
  async applyTier(newTier) {
    const previousTier = this.currentTier;
    this.currentTier = newTier;

    console.log(`📊 Quality: ${previousTier.name} → ${newTier.name}`);

    // Adjust video bitrate/framerate
    if (newTier.videoBitrate > 0) {
      await webrtcEngine.adjustVideoBitrate(
        newTier.videoBitrate,
        newTier.videoFramerate,
      );

      // Restore video if coming from audio-only
      if (
        previousTier === QUALITY_TIERS.AUDIO_ONLY ||
        previousTier === QUALITY_TIERS.CRITICAL
      ) {
        await webrtcEngine.switchToVideoMode();
        this.modeSwitchCount++;
      }
    } else {
      // Switch to audio-only
      await webrtcEngine.switchToAudioOnly();
      this.modeSwitchCount++;
      this.onModeSwitch?.("audio_only");
    }

    // Emit quality change
    this.onQualityChange?.(newTier, previousTier);
  }

  /**
   * Exponential Moving Average for stat smoothing.
   */
  ema(previous, current) {
    if (previous === 0) return current;
    return this.alpha * current + (1 - this.alpha) * previous;
  }

  /**
   * Report metrics to server for telemetry.
   */
  reportMetrics() {
    if (!this.callId) return;

    signalingClient.sendCallMetrics(this.callId, {
      packetLoss: Math.round(this.averagedStats.packetLoss * 100) / 100,
      jitter: Math.round(this.averagedStats.jitter * 100) / 100,
      rtt: Math.round(this.averagedStats.rtt * 100) / 100,
      audioBitrate: this.previousStats?.audio?.bitrate || 0,
      videoBitrate: this.previousStats?.video?.bitrate || 0,
      modeSwitches: this.modeSwitchCount,
      tier: this.currentTier.name,
    });
  }

  /**
   * Get current quality level (1-5) for UI display.
   */
  getQualityLevel() {
    return this.currentTier.level;
  }

  /**
   * Get human-readable quality label.
   */
  getQualityLabel() {
    const labels = {
      excellent: "Excellent",
      good: "Good",
      fair: "Fair",
      audio_only: "Audio Only",
      critical: "Poor Connection",
    };
    return labels[this.currentTier.name] || "Unknown";
  }

  /**
   * Clean up.
   */
  stop() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    this.previousStats = null;
    this.averagedStats = { packetLoss: 0, jitter: 0, rtt: 0, bandwidth: 0 };
    this.currentTier = QUALITY_TIERS.EXCELLENT;
    this.modeSwitchCount = 0;
    webrtcEngine.onStats = null;
  }
}

// Singleton
const networkMonitor = new NetworkMonitor();
export { QUALITY_TIERS };
export default networkMonitor;
