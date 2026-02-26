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
   * Configure audio mode for general playback (call once at app start).
   */
  async init() {
    if (this._initialized) return;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        // ★ FIX: false prevents notification sounds from ducking our audio
        shouldDuckAndroid: false,
      });
      this._initialized = true;
    } catch (err) {
      console.warn("SoundService init error:", err);
    }
  }

  async _setRingtoneMode() {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
      });
    } catch (err) {
      console.warn("SoundService _setRingtoneMode error:", err);
    }
  }

  async _restoreAudioMode() {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
      });
    } catch (err) {
      console.warn("SoundService _restoreAudioMode error:", err);
    }
  }

  async playRingtone() {
    try {
      await this.init();
      // Stop any existing ringtone first
      await this.stopRingtone();

      // ★ Set ringtone-specific audio mode BEFORE creating the sound
      await this._setRingtoneMode();

      const { sound } = await Audio.Sound.createAsync(RINGTONE_ASSET);
      this._ringtone = sound;
      await sound.setIsLoopingAsync(true);
      await sound.setVolumeAsync(1.0);
      await sound.playAsync();
      console.log("🔔 SoundService: Ringtone started (looping)");
    } catch (err) {
      console.warn("SoundService playRingtone error:", err);
    }
  }

  async stopRingtone() {
    try {
      if (this._ringtone) {
        await this._ringtone.stopAsync();
        await this._ringtone.unloadAsync();
        this._ringtone = null;
        console.log("🔕 SoundService: Ringtone stopped");
        // ★ Restore normal audio mode after stopping ringtone
        await this._restoreAudioMode();
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
