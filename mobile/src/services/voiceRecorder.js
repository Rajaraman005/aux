/**
 * Voice Recorder Service — FAANG-quality voice message recording.
 *
 * ★ Features:
 *   - Hold-to-record using expo-av Audio.Recording
 *   - Real-time duration tracking
 *   - Metering (amplitude) for waveform visualization
 *   - Auto-stop at 120s max duration
 *   - Upload via existing mediaService (signed direct upload)
 *   - Cancel support (slide to cancel gesture handled by UI)
 *
 * ★ Audio Config:
 *   - M4A (AAC codec) — best quality/size on mobile
 *   - 44.1kHz sample rate, 128kbps bitrate
 *   - Mono channel (voice doesn't need stereo)
 */
import { Audio } from "expo-av";
import { Platform } from "react-native";
import { uploadMedia, cancelUpload } from "./mediaService";

// ─── Constants ──────────────────────────────────────────────────────────────
const MAX_DURATION_MS = 120000; // 2 minutes
const MIN_DURATION_MS = 500; // 0.5s minimum to avoid accidental taps
const METERING_INTERVAL_MS = 100; // 100ms for smooth waveform

// ─── Recording Config ───────────────────────────────────────────────────────
const RECORDING_OPTIONS = {
  isMeteringEnabled: true,
  android: {
    extension: ".m4a",
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  ios: {
    extension: ".m4a",
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: "audio/webm",
    bitsPerSecond: 128000,
  },
};

// ─── State ──────────────────────────────────────────────────────────────────
let activeRecording = null;
let recordingStartTime = null;
let meteringCallback = null;
let durationCallback = null;
let durationInterval = null;
let maxDurationTimeout = null;
let onAutoStopCallback = null;

/**
 * Request microphone permission.
 * @returns {Promise<boolean>}
 */
export async function requestMicPermission() {
  const { status } = await Audio.requestPermissionsAsync();
  return status === "granted";
}

/**
 * Start recording a voice message.
 *
 * @param {Object} options
 * @param {Function} [options.onMetering] - (dbLevel: number) => void, called every 100ms
 * @param {Function} [options.onDuration] - (durationMs: number) => void, called every 100ms
 * @param {Function} [options.onAutoStop] - () => void, called when max duration reached
 * @returns {Promise<boolean>} true if recording started
 */
export async function startRecording({
  onMetering,
  onDuration,
  onAutoStop,
} = {}) {
  if (activeRecording) {
    console.warn("⚠️ Recording already in progress");
    return false;
  }

  const hasPermission = await requestMicPermission();
  if (!hasPermission) {
    throw new Error("Microphone permission denied");
  }

  // Configure audio mode for recording
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
  });

  // Create and start recording
  const recording = new Audio.Recording();
  await recording.prepareToRecordAsync(RECORDING_OPTIONS);
  recording.setOnRecordingStatusUpdate((status) => {
    if (status.metering !== undefined && meteringCallback) {
      // Normalize dB level (typically -160 to 0) to 0-1 range
      const normalized = Math.max(0, Math.min(1, (status.metering + 60) / 60));
      meteringCallback(normalized);
    }
  });

  await recording.startAsync();

  // Store state
  activeRecording = recording;
  recordingStartTime = Date.now();
  meteringCallback = onMetering || null;
  durationCallback = onDuration || null;
  onAutoStopCallback = onAutoStop || null;

  // Duration tracking
  if (durationCallback) {
    durationInterval = setInterval(() => {
      const elapsed = Date.now() - recordingStartTime;
      durationCallback(elapsed);
    }, METERING_INTERVAL_MS);
  }

  // Auto-stop at max duration
  maxDurationTimeout = setTimeout(() => {
    console.log("🎤 Max duration reached, auto-stopping");
    if (onAutoStopCallback) onAutoStopCallback();
  }, MAX_DURATION_MS);

  return true;
}

/**
 * Stop recording and return the recorded file info.
 *
 * @returns {Promise<{ uri: string, durationMs: number, fileSize: number, mimeType: string } | null>}
 *          null if recording was too short
 */
export async function stopRecording() {
  if (!activeRecording) return null;

  // Clear timers
  if (durationInterval) clearInterval(durationInterval);
  if (maxDurationTimeout) clearTimeout(maxDurationTimeout);
  durationInterval = null;
  maxDurationTimeout = null;

  const durationMs = Date.now() - recordingStartTime;
  const recording = activeRecording;

  // Reset state
  activeRecording = null;
  recordingStartTime = null;
  meteringCallback = null;
  durationCallback = null;
  onAutoStopCallback = null;

  try {
    await recording.stopAndUnloadAsync();

    // Reset audio mode for playback
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
    });

    // Too short — discard
    if (durationMs < MIN_DURATION_MS) {
      console.log("🎤 Recording too short, discarded");
      return null;
    }

    const uri = recording.getURI();
    if (!uri) return null;

    return {
      uri,
      durationMs,
      duration: durationMs / 1000,
      fileSize: 0, // expo-av doesn't expose file size easily; server validates
      mimeType: Platform.OS === "ios" ? "audio/m4a" : "audio/mp4",
    };
  } catch (err) {
    console.error("Stop recording error:", err);
    return null;
  }
}

/**
 * Cancel an active recording — discards the file.
 */
export async function cancelRecording() {
  if (!activeRecording) return;

  if (durationInterval) clearInterval(durationInterval);
  if (maxDurationTimeout) clearTimeout(maxDurationTimeout);

  try {
    await activeRecording.stopAndUnloadAsync();
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
    });
  } catch (err) {
    console.error("Cancel recording error:", err);
  }

  activeRecording = null;
  recordingStartTime = null;
  meteringCallback = null;
  durationCallback = null;
  durationInterval = null;
  maxDurationTimeout = null;
  onAutoStopCallback = null;
}

/**
 * Upload a voice recording via the existing media pipeline.
 *
 * @param {Object} params
 * @param {string} params.uri - Local file URI
 * @param {number} params.duration - Duration in seconds
 * @param {string} params.mimeType
 * @param {Function} [params.onProgress] - (progress: 0-1) => void
 * @returns {Promise<{ url, duration, size, mimeType }>}
 */
export async function uploadVoiceMessage({
  uri,
  duration,
  mimeType,
  onProgress,
}) {
  const uploadId = `voice_${Date.now()}`;
  const result = await uploadMedia({
    uri,
    mediaType: "audio",
    mimeType: mimeType || "audio/m4a",
    width: null,
    height: null,
    duration,
    uploadId,
    onProgress,
  });

  return {
    url: result.url,
    duration: result.duration || duration,
    size: result.size,
    mimeType: result.mimeType || mimeType,
  };
}

/**
 * Check if a recording is active.
 */
export function isRecording() {
  return activeRecording !== null;
}
