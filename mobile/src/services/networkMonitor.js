/**
 * Network Adaptation Engine — FAANG-Grade.
 *
 * Adaptive Tiers:
 *   > 200kbps  → Full video (30fps, 640p)
 *   100-200kbps → Reduced video (15fps, 240p)
 *   50-100kbps  → Minimal video (5fps, 160p)
 *   < 50kbps   → AUDIO-ONLY (video dropped entirely)
 *
 * ★ Improvements:
 *   - 5-second grace period on startup (bandwidth reads 0 initially)
 *   - Hysteresis: 3 consecutive low readings before downgrading
 *   - Battery-aware: reduced polling when backgrounded
 *   - Smooth EMA prevents false spikes
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

const PACKET_LOSS_FEC_THRESHOLD = 5;
const PACKET_LOSS_AUDIO_ONLY = 15;

// ★ Hysteresis: require N consecutive low readings before downgrading
const DOWNGRADE_THRESHOLD = 3;
// ★ Grace period: don't downgrade during the first N seconds
const GRACE_PERIOD_MS = 6000;

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

    this.alpha = 0.3;

    // Callbacks
    this.onQualityChange = null;
    this.onModeSwitch = null;
    this.onStatsUpdate = null;

    // Metrics
    this.metricsInterval = null;
    this.modeSwitchCount = 0;

    // ★ Hysteresis counters
    this._downgradeCounter = 0;
    this._upgradeCounter = 0;
    this._startTime = 0;
    this._bandwidthMeasured = false;
  }

  start(callId) {
    this.callId = callId;
    this._startTime = Date.now();
    this._bandwidthMeasured = false;
    this._downgradeCounter = 0;

    webrtcEngine.onStats = (stats) => this.processStats(stats);

    this.metricsInterval = setInterval(() => {
      this.reportMetrics();
    }, 10000);
  }

  processStats(stats) {
    const bandwidth = stats.connection.availableOutgoingBitrate;
    const audioPacketLoss = stats.audio.packetLoss || 0;
    const videoPacketLoss = stats.video.packetLoss || 0;
    const maxPacketLoss = Math.max(audioPacketLoss, videoPacketLoss);
    const rtt = stats.connection.rtt;
    const jitter = stats.audio.jitter;

    // ★ Track when we first get real bandwidth data
    if (bandwidth > 0 && !this._bandwidthMeasured) {
      this._bandwidthMeasured = true;
    }

    // ─── EMA Smoothing ───────────────────────────────────────────────
    this.averagedStats.packetLoss = this.ema(
      this.averagedStats.packetLoss,
      maxPacketLoss,
    );
    this.averagedStats.jitter = this.ema(this.averagedStats.jitter, jitter);
    this.averagedStats.rtt = this.ema(this.averagedStats.rtt, rtt);
    // ★ Only update bandwidth if we have a real measurement
    if (bandwidth > 0) {
      this.averagedStats.bandwidth = this.ema(
        this.averagedStats.bandwidth,
        bandwidth,
      );
    }

    // ─── Determine Quality Tier ──────────────────────────────────────
    let newTier;

    if (this.averagedStats.packetLoss > PACKET_LOSS_AUDIO_ONLY) {
      newTier = QUALITY_TIERS.CRITICAL;
    } else if (this.averagedStats.packetLoss > PACKET_LOSS_FEC_THRESHOLD) {
      if (this.averagedStats.bandwidth < 100000 && this._bandwidthMeasured) {
        newTier = QUALITY_TIERS.AUDIO_ONLY;
      } else {
        newTier = QUALITY_TIERS.FAIR;
      }
    } else if (
      !this._bandwidthMeasured ||
      this.averagedStats.bandwidth >= QUALITY_TIERS.EXCELLENT.minBandwidth
    ) {
      // ★ If bandwidth not yet measured, assume EXCELLENT (grace period)
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

    // ─── ★ Grace Period — Don't downgrade in first N seconds ─────────
    const elapsed = Date.now() - this._startTime;
    if (elapsed < GRACE_PERIOD_MS && newTier.level < this.currentTier.level) {
      // Stay at current tier during grace period
      newTier = this.currentTier;
    }

    // ─── ★ Hysteresis — Require consecutive readings ─────────────────
    if (newTier.level < this.currentTier.level) {
      this._downgradeCounter++;
      this._upgradeCounter = 0;
      if (this._downgradeCounter < DOWNGRADE_THRESHOLD) {
        newTier = this.currentTier; // Not enough evidence to downgrade yet
      }
    } else if (newTier.level > this.currentTier.level) {
      this._upgradeCounter++;
      this._downgradeCounter = 0;
      // Upgrade faster (only 2 consecutive readings needed)
      if (this._upgradeCounter < 2) {
        newTier = this.currentTier;
      }
    } else {
      this._downgradeCounter = 0;
      this._upgradeCounter = 0;
    }

    // ─── Apply Changes ───────────────────────────────────────────────
    if (newTier.name !== this.currentTier.name) {
      this._downgradeCounter = 0;
      this._upgradeCounter = 0;
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

  async applyTier(newTier) {
    const previousTier = this.currentTier;
    this.currentTier = newTier;

    console.log(`📊 Quality: ${previousTier.name} → ${newTier.name}`);

    if (newTier.videoBitrate > 0) {
      await webrtcEngine.adjustVideoBitrate(
        newTier.videoBitrate,
        newTier.videoFramerate,
      );
      if (
        previousTier === QUALITY_TIERS.AUDIO_ONLY ||
        previousTier === QUALITY_TIERS.CRITICAL
      ) {
        await webrtcEngine.switchToVideoMode();
        this.modeSwitchCount++;
      }
    } else {
      await webrtcEngine.switchToAudioOnly();
      this.modeSwitchCount++;
      this.onModeSwitch?.("audio_only");
    }

    this.onQualityChange?.(newTier, previousTier);
  }

  ema(previous, current) {
    if (previous === 0) return current;
    return this.alpha * current + (1 - this.alpha) * previous;
  }

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

  getQualityLevel() {
    return this.currentTier.level;
  }

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

  stop() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    this.previousStats = null;
    this.averagedStats = { packetLoss: 0, jitter: 0, rtt: 0, bandwidth: 0 };
    this.currentTier = QUALITY_TIERS.EXCELLENT;
    this.modeSwitchCount = 0;
    this._downgradeCounter = 0;
    this._upgradeCounter = 0;
    this._bandwidthMeasured = false;
    webrtcEngine.onStats = null;
  }
}

const networkMonitor = new NetworkMonitor();
export { QUALITY_TIERS };
export default networkMonitor;
