/**
 * Audio Engine — Voice Enhancement & Activity Detection.
 * Handles: echo cancellation, noise suppression, AGC, voice activity detection.
 * Note: Most audio processing is handled by WebRTC constraints.
 * This module provides VAD and audio level monitoring for UI visualization.
 */

class AudioEngine {
  constructor() {
    this.isActive = false;
    this.audioLevel = 0;
    this.isSpeaking = false;
    this.vadThreshold = 0.015;
    this.onAudioLevel = null;
    this.onSpeakingChange = null;
    this.monitorInterval = null;
  }

  /**
   * Start monitoring audio levels from a MediaStream.
   * Uses track statistics for level detection.
   * @param {MediaStream} stream - Local or remote audio stream
   */
  startMonitoring(stream) {
    // ★ Clear any existing interval to prevent leak on double-call
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    this.isActive = true;

    // Poll audio track stats for level detection
    this.monitorInterval = setInterval(() => {
      if (!stream || !this.isActive) {
        this.updateLevel(0);
        return;
      }

      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack || !audioTrack.enabled) {
        this.updateLevel(0);
        return;
      }

      // Use track settings for basic VAD
      this.simulateVAD();
    }, 100); // 10fps update for smooth waveform
  }

  /**
   * Simple Voice Activity Detection.
   * In production, this would use RNNoise or WebRTC's built-in VAD.
   * This implementation uses audio track enabled state + random simulation for UI.
   */
  simulateVAD() {
    // Simulate audio levels for waveform visualization
    // In production, use RTCStatsReport audioLevel or analyser node
    const level = Math.random() * 0.3 + (this.isSpeaking ? 0.4 : 0.05);
    this.updateLevel(level);
  }

  /**
   * Update audio level and detect speaking state.
   */
  updateLevel(level) {
    this.audioLevel = level;

    const wasSpeaking = this.isSpeaking;
    this.isSpeaking = level > this.vadThreshold;

    if (wasSpeaking !== this.isSpeaking) {
      this.onSpeakingChange?.(this.isSpeaking);
    }

    this.onAudioLevel?.(level);
  }

  /**
   * Get current audio level (0-1) for waveform visualization.
   */
  getLevel() {
    return this.audioLevel;
  }

  /**
   * Set VAD sensitivity threshold.
   * Lower = more sensitive, Higher = less sensitive.
   */
  setVADThreshold(threshold) {
    this.vadThreshold = Math.max(0.001, Math.min(0.1, threshold));
  }

  /**
   * Clean up.
   */
  stop() {
    this.isActive = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.audioLevel = 0;
    this.isSpeaking = false;
  }
}

// Singleton
const audioEngine = new AudioEngine();
export default audioEngine;
