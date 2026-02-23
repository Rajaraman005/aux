/**
 * Sound Service — Manages ringtone and notification sounds.
 * Uses expo-av for audio playback.
 *
 * Usage:
 *   import SoundService from '../services/sounds';
 *   await SoundService.playRingtone();   // loops until stopped
 *   SoundService.stopRingtone();
 *   await SoundService.playMessage();    // plays once
 */
import { Audio } from "expo-av";

// Pre-load sound references
const RINGTONE_ASSET = require("../../assets/call-ringtone.mp3");
const MESSAGE_ASSET = require("../../assets/message.wav");

class SoundService {
  constructor() {
    this._ringtone = null;
    this._message = null;
    this._initialized = false;
  }

  /**
   * Configure audio mode for playback (call once at app start).
   */
  async init() {
    if (this._initialized) return;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
      });
      this._initialized = true;
    } catch (err) {
      console.warn("SoundService init error:", err);
    }
  }

  /**
   * Play the ringtone (loops until stopRingtone is called).
   */
  async playRingtone() {
    try {
      await this.init();
      // Stop any existing ringtone first
      await this.stopRingtone();

      const { sound } = await Audio.Sound.createAsync(RINGTONE_ASSET, {
        isLooping: true,
        volume: 1.0,
        shouldPlay: true,
      });
      this._ringtone = sound;
    } catch (err) {
      console.warn("SoundService playRingtone error:", err);
    }
  }

  /**
   * Stop the ringtone.
   */
  async stopRingtone() {
    try {
      if (this._ringtone) {
        await this._ringtone.stopAsync();
        await this._ringtone.unloadAsync();
        this._ringtone = null;
      }
    } catch (err) {
      console.warn("SoundService stopRingtone error:", err);
    }
  }

  /**
   * Play the message notification sound (plays once).
   */
  async playMessage() {
    try {
      await this.init();
      // Unload previous message sound if still loaded
      if (this._message) {
        try {
          await this._message.unloadAsync();
        } catch (_) {}
        this._message = null;
      }

      const { sound } = await Audio.Sound.createAsync(MESSAGE_ASSET, {
        volume: 0.8,
        shouldPlay: true,
      });
      this._message = sound;

      // Auto-cleanup after playback finishes
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          this._message = null;
        }
      });
    } catch (err) {
      console.warn("SoundService playMessage error:", err);
    }
  }

  /**
   * Cleanup all sounds (call on app unmount).
   */
  async cleanup() {
    await this.stopRingtone();
    if (this._message) {
      try {
        await this._message.unloadAsync();
      } catch (_) {}
      this._message = null;
    }
  }
}

// Export singleton
export default new SoundService();
