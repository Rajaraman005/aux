/**
 * MediaService — Production-Grade Upload Orchestration.
 *
 * Pipeline: compress → sign → upload (single multipart) → validate
 * Exports pure functions. Receives callbacks. No circular dependencies.
 *
 * ★ Architecture: Direct URI Upload via React Native FormData
 *   - Zero Base64 — files stream from disk via native layer
 *   - Zero JS thread blocking — no readAsStringAsync calls
 *   - Zero chunked upload — Cloudinary single multipart handles up to plan limit
 *   - Complete MIME coverage — HEIC, 3GP, M4A, MOV, WebM, etc.
 *   - Structured error logging — no more [object Object]
 *   - Instant preview — local URI passed directly to UI, no conversion
 */

import * as ImagePicker from "expo-image-picker";
import analytics from "./analytics";
import { compressForUpload, estimateFileSize, validateVideoConstraints } from "./compressionService";
import apiClient from "./api";
import { endpoints } from "../config/api";

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
const MAX_AUDIO_SIZE = 5 * 1024 * 1024;
const MAX_VIDEO_DURATION = 60;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;

// ─── Complete MIME Type Map ─────────────────────────────────────────────────
// Covers: JPEG, PNG, GIF, WebP, HEIC/HEIF (iPhone native), BMP, SVG,
//         MP4, MOV, M4V, 3GP, AVI, MKV, WebM,
//         M4A, MP3, AAC, WAV, OGG
// Extensions are lowercased and stripped of query params (?) and fragments (#).

const MIME_TYPE_MAP = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", heic: "image/heic",
  heif: "image/heif", bmp: "image/bmp", svg: "image/svg+xml",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v",
  "3gp": "video/3gpp", avi: "video/x-msvideo", mkv: "video/x-matroska",
  webm: "video/webm",
  m4a: "audio/mp4", mp3: "audio/mpeg", aac: "audio/aac",
  wav: "audio/wav", ogg: "audio/ogg",
};

function inferMimeType(uri) {
  const ext = uri.split(".").pop()?.toLowerCase().split("?")[0].split("#")[0] || "";
  return MIME_TYPE_MAP[ext] || "application/octet-stream";
}

function buildFileName(uri, mimeType) {
  const ext = uri.split(".").pop()?.toLowerCase().split("?")[0].split("#")[0] || "jpg";
  const typeToExt = {
    "video/mp4": "mp4", "video/quicktime": "mov", "video/3gpp": "3gp",
    "audio/mp4": "m4a", "audio/mpeg": "mp3",
  };
  const resolvedExt = typeToExt[mimeType] || ext;
  return `upload.${resolvedExt}`;
}

function normalizeUri(uri) {
  if (!uri || typeof uri !== "string") {
    throw new UploadError("Invalid file URI", "INVALID_FILE", "uploading", false);
  }
  return uri;
}

function serializeError(err) {
  if (!err) return "null";
  if (err instanceof Error) {
    return JSON.stringify({
      name: err.name,
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.stage ? { stage: err.stage } : {}),
      ...(err.retryable !== undefined ? { retryable: err.retryable } : {}),
      stack: err.stack?.split("\n")?.slice(0, 3).join("\n"),
    });
  }
  return JSON.stringify(err, Object.getOwnPropertyNames(err), 2);
}

// ─── UploadError ─────────────────────────────────────────────────────────────

/**
 * Custom error class for upload pipeline failures.
 * @property {string} code - Error code (INVALID_FILE, NETWORK_ERROR, SERVER_ERROR, TIMEOUT, CANCELLED, MODERATION_REJECTED)
 * @property {string} stage - Pipeline stage where error occurred (compressing, signing, uploading, validating)
 * @property {boolean} retryable - Whether the operation can be retried
 */
export class UploadError extends Error {
  constructor(message, code, stage, retryable) {
    super(message);
    this.name = "UploadError";
    this.code = code;
    this.stage = stage;
    this.retryable = retryable;
  }
}

// ─── Main Upload Pipeline ──────────────────────────────────────────────────

/**
 * Production-grade upload pipeline.
 * Pipeline: compress → sign → upload (single multipart) → validate
 *
 * @param {Object} params
 * @param {string} params.uri - Local file URI (from ImagePicker or ImageManipulator)
 * @param {"image"|"video"|"audio"} params.mediaType - Media category
 * @param {number} [params.fileSize] - File size in bytes (0 = auto-detect via estimateFileSize)
 * @param {string} [params.mimeType] - MIME type override
 * @param {number} [params.width] - Width in px
 * @param {number} [params.height] - Height in px
 * @param {number} [params.duration] - Duration in seconds (video/audio)
 * @param {string} params.uploadId - Unique upload identifier
 * @param {Object} callbacks
 * @param {Function} [callbacks.onProgress] - (progress: 0-1) => void
 * @param {AbortSignal} [callbacks.signal] - AbortController signal for cancellation
 * @returns {Promise<{ url, thumbnailUrl, width, height, duration, size, mimeType }>}
 * @throws {UploadError} With code, stage, and retryable flag
 */
export async function uploadFile(params, callbacks) {
  const startTime = Date.now();
  const {
    uri,
    mediaType,
    fileSize,
    mimeType,
    width,
    height,
    duration,
    uploadId,
  } = params;
  const { onProgress, signal } = callbacks;

  try {
    // Stage 0: Get real file size
    analytics.emit("upload_started", { uploadId, mediaType });
    const actualFileSize = fileSize || (await estimateFileSize(uri));
    if (!actualFileSize) {
      throw new UploadError(
        "Cannot determine file size",
        "INVALID_FILE",
        "compressing",
        false,
      );
    }

    // Stage 1: Compress
    analytics.emit("upload_compressing", { uploadId });
    const compressed = await compressForUpload(uri, mediaType, {
      width,
      height,
      duration,
      mimeType,
      fileSize: actualFileSize,
      source: "chat",
    });

    // Stage 2: Sign (with retry)
    analytics.emit("upload_signing", { uploadId });
    const signedParams = await retryWithBackoff(
      () => getSignedUploadParams(mediaType, compressed.fileSize, compressed.mimeType),
      {
        maxRetries: MAX_RETRIES,
        shouldRetry: (err) =>
          err.code === "NETWORK_ERROR" || err.code === "SERVER_ERROR",
      },
    );
    analytics.emit("upload_signed", { uploadId });

    // Stage 3: Upload to Cloudinary (single multipart request)
    analytics.emit("upload_progress", { uploadId, milestone: 0, progress: 0 });
    const formData = buildFormData(compressed, signedParams, mediaType);

    const uploadResult = await uploadToCloudinarySingle({
      uri: compressed.uri,
      uploadUrl: signedParams.uploadUrl,
      formData,
      signal,
      onProgress,
      timeoutMs: getUploadTimeout(compressed.fileSize, mediaType),
      mimeType: compressed.mimeType,
    });

    // Stage 4: Validate with server (idempotency key)
    analytics.emit("upload_validating", { uploadId });
    const validated = await retryWithBackoff(
      () =>
        validateWithServer(uploadId, {
          url: uploadResult.secure_url,
          mediaType,
          publicId: uploadResult.public_id,
          width: uploadResult.width || compressed.width,
          height: uploadResult.height || compressed.height,
          duration: uploadResult.duration || compressed.duration,
          fileSize: compressed.fileSize,
          mimeType: compressed.mimeType,
        }),
      {
        maxRetries: MAX_RETRIES,
        shouldRetry: (err) =>
          err.code === "NETWORK_ERROR" || err.code === "SERVER_ERROR",
      },
    );

    analytics.emit("upload_complete", {
      uploadId,
      durationMs: Date.now() - startTime,
    });

    return validated;
  } catch (error) {
    if (error instanceof UploadError) {
      analytics.emit("upload_failed", {
        uploadId,
        stage: error.stage,
        code: error.code,
      });
      if (error.code === "CANCELLED") {
        analytics.emit("upload_cancelled", { uploadId });
      }
    } else {
      analytics.emit("upload_failed", {
        uploadId,
        stage: "unknown",
        code: "UNKNOWN",
        error: serializeError(error),
      });
    }
    throw error;
  }
}

// ─── Signed Upload Params ─────────────────────────────────────────────────

async function getSignedUploadParams(mediaType, fileSize, mimeType) {
  try {
    const response = await apiClient.post(endpoints.media.sign, {
      mediaType,
      fileSize,
      mimeType,
    });
    return response;
  } catch (err) {
    if (err.response?.status >= 400 && err.response?.status < 500) {
      throw new UploadError(
        err.response?.data?.error || "Sign request failed",
        "SERVER_ERROR",
        "signing",
        false,
      );
    }
    throw new UploadError(
      err.message || "Network error during sign",
      "NETWORK_ERROR",
      "signing",
      true,
    );
  }
}

// ─── Build FormData (signature fields only — file appended in upload step) ──

function buildFormData(compressed, signedParams, mediaType) {
  const formData = new FormData();
  formData.append("api_key", String(signedParams.apiKey));
  formData.append("timestamp", String(signedParams.timestamp));
  formData.append("signature", signedParams.signature);
  formData.append("folder", signedParams.folder);
  formData.append("public_id", signedParams.publicId);

  if (signedParams.transformation) {
    formData.append("transformation", signedParams.transformation);
  }
  if (signedParams.eager) {
    formData.append("eager", signedParams.eager);
  }
  if (signedParams.eagerAsync) {
    formData.append("eager_async", "true");
  }

  return formData;
}

// ─── Single Upload (Direct URI — Zero Base64) ───────────────────────────────

/**
 * Upload a file to Cloudinary via single multipart POST request.
 * React Native FormData streams the file from disk — zero Base64,
 * zero memory spike, zero JS thread blocking.
 */
function uploadToCloudinarySingle({ uri, uploadUrl, formData, signal, onProgress, timeoutMs, mimeType }) {
  const fileName = buildFileName(uri, mimeType);
  const contentType = mimeType || inferMimeType(uri);

  formData.append("file", {
    uri: normalizeUri(uri),
    type: contentType,
    name: fileName,
  });

  return uploadWithProgress(uploadUrl, formData, onProgress, signal, timeoutMs);
}

// ─── Validate with Server ───────────────────────────────────────────────────

async function validateWithServer(uploadId, params) {
  try {
    return await apiClient.post(endpoints.media.validate, params, {
      headers: { "Idempotency-Key": uploadId },
    });
  } catch (err) {
    if (err.response?.status === 403) {
      throw new UploadError(
        err.response?.data?.error || "Content rejected by moderation",
        "MODERATION_REJECTED",
        "validating",
        false,
      );
    }
    if (err.response?.status >= 400 && err.response?.status < 500) {
      throw new UploadError(
        err.response?.data?.error || "Validation failed",
        "SERVER_ERROR",
        "validating",
        false,
      );
    }
    throw new UploadError(
      err.message || "Network error during validation",
      "NETWORK_ERROR",
      "validating",
      true,
    );
  }
}

// ─── Retry with Exponential Backoff ─────────────────────────────────────────

async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = MAX_RETRIES,
    baseDelay = RETRY_BASE_DELAY,
    shouldRetry = () => true,
  } = options;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!shouldRetry(err) || attempt === maxRetries - 1) throw err;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── XHR Upload with Progress & Milestone Analytics ────────────────────────

function uploadWithProgress(url, formData, onProgress, signal, timeoutMs, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    const MILESTONES = [0.25, 0.5, 0.75, 0.9];
    let lastMilestoneIndex = -1;

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          xhr.abort();
          reject(new UploadError("Upload cancelled", "CANCELLED", "uploading", false));
        },
        { once: true },
      );
    }

    const timeoutId = setTimeout(() => {
      xhr.abort();
      reject(new UploadError("Upload timeout", "TIMEOUT", "uploading", true));
    }, timeoutMs || 120000);

    xhr.open("POST", url);

    Object.entries(extraHeaders).forEach(([key, value]) => {
      try {
        xhr.setRequestHeader(key, String(value));
      } catch {}
    });

    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const progress = event.loaded / event.total;
          onProgress(progress);

          const currentMilestone = MILESTONES.findIndex((m) => progress >= m);
          if (currentMilestone > lastMilestoneIndex) {
            lastMilestoneIndex = currentMilestone;
            analytics.emit("upload_progress", {
              milestone: MILESTONES[currentMilestone],
              progress,
            });
          }
        }
      };
    }

    xhr.onload = () => {
      clearTimeout(timeoutId);
      try {
        const response = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(response);
        } else if (xhr.status === 403) {
          reject(
            new UploadError(
              response.error?.message || "Content rejected",
              "MODERATION_REJECTED",
              "uploading",
              false,
            ),
          );
        } else if (xhr.status >= 500) {
          reject(
            new UploadError(
              `Server error (${xhr.status})`,
              "SERVER_ERROR",
              "uploading",
              true,
            ),
          );
        } else {
          reject(
            new UploadError(
              response.error?.message || `Upload failed (${xhr.status})`,
              "SERVER_ERROR",
              "uploading",
              false,
            ),
          );
        }
      } catch {
        reject(
          new UploadError(
            `Upload failed (${xhr.status})`,
            "SERVER_ERROR",
            "uploading",
            xhr.status >= 500,
          ),
        );
      }
    };

    xhr.onerror = () => {
      clearTimeout(timeoutId);
      reject(new UploadError("Network error", "NETWORK_ERROR", "uploading", true));
    };

    xhr.send(formData);
  });
}

function getUploadTimeout(fileSize, mediaType) {
  const BASE_MS = 30000;
  const PER_MB_MS = 12000;
  const MAX_MS = 600000;
  const sizeMB = (fileSize || 5 * 1024 * 1024) / (1024 * 1024);
  return Math.min(Math.max(BASE_MS, sizeMB * PER_MB_MS), MAX_MS);
}

// ─── Media Picker ───────────────────────────────────────────────────────────

/**
 * Pick an image from gallery or camera.
 * @param {"gallery"|"camera"} source - Image source
 * @returns {Promise<{ uri, width, height, fileSize, mimeType }|null>} Asset or null if cancelled
 */
export async function pickImage(source = "gallery") {
  const options = {
    mediaTypes: ["images"],
    allowsEditing: false,
    quality: 0.8,
    exif: false,
  };

  let result;
  if (source === "camera") {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") throw new Error("Camera permission denied");
    result = await ImagePicker.launchCameraAsync(options);
  } else {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") throw new Error("Gallery permission denied");
    result = await ImagePicker.launchImageLibraryAsync(options);
  }

  if (result.canceled || !result.assets?.length) return null;

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    width: asset.width,
    height: asset.height,
    fileSize: asset.fileSize || 0,
    mimeType: asset.mimeType || "image/jpeg",
  };
}

/**
 * Pick a video from gallery or camera.
 * @param {"gallery"|"camera"} source - Video source
 * @returns {Promise<{ uri, width, height, fileSize, duration, mimeType }|null>} Asset or null if cancelled
 */
export async function pickVideo(source = "gallery") {
  const options = {
    mediaTypes: ["videos"],
    allowsEditing: false,
    videoMaxDuration: MAX_VIDEO_DURATION,
    videoQuality: ImagePicker.UIImagePickerControllerQualityType?.Medium ?? 1,
  };

  let result;
  if (source === "camera") {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") throw new Error("Camera permission denied");
    result = await ImagePicker.launchCameraAsync(options);
  } else {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") throw new Error("Gallery permission denied");
    result = await ImagePicker.launchImageLibraryAsync(options);
  }

  if (result.canceled || !result.assets?.length) return null;

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    width: asset.width,
    height: asset.height,
    fileSize: asset.fileSize || 0,
    duration: asset.duration ? asset.duration / 1000 : 0,
    mimeType: asset.mimeType || "video/mp4",
  };
}

// ─── Legacy Upload (backward compatible for voiceRecorder) ──────────────────

const activeUploads = new Map();

/**
 * Legacy upload function — prefer uploadFile via UploadQueue for new code.
 * Kept for voiceRecorder compatibility.
 *
 * @param {Object} params
 * @param {string} params.uri - Local file URI
 * @param {"image"|"video"|"audio"} params.mediaType
 * @param {number} [params.fileSize]
 * @param {string} [params.mimeType]
 * @param {Function} [params.onProgress] - (progress: 0-1) => void
 * @param {string} [params.uploadId]
 * @param {number} [params.width]
 * @param {number} [params.height]
 * @param {number} [params.duration]
 * @returns {Promise<{ url, thumbnailUrl, width, height, duration, size, mimeType }>}
 */
export async function uploadMedia({
  uri,
  mediaType,
  fileSize,
  mimeType,
  onProgress,
  uploadId,
  width,
  height,
  duration,
}) {
  const maxSize = mediaType === "video" ? MAX_VIDEO_SIZE : mediaType === "audio" ? MAX_AUDIO_SIZE : MAX_IMAGE_SIZE;
  if (fileSize && fileSize > maxSize) {
    const limitMB = Math.round(maxSize / (1024 * 1024));
    throw new Error(`File too large (max ${limitMB}MB)`);
  }

  const abortController = new AbortController();
  if (uploadId) activeUploads.set(uploadId, abortController);

  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (abortController.signal.aborted) {
        throw new Error("Upload cancelled");
      }

      const signedParams = await getSignedUploadParams(mediaType, fileSize, mimeType);
      const formData = buildFormData(
        { fileSize, mimeType, width, height },
        signedParams,
        mediaType,
      );

      const resolvedMimeType = mimeType || (mediaType === "video" ? "video/mp4" : mediaType === "audio" ? "audio/mp4" : "image/jpeg");
      formData.append("file", {
        uri: normalizeUri(uri),
        type: resolvedMimeType,
        name: `upload.${mediaType === "video" ? "mp4" : mediaType === "audio" ? "m4a" : "jpg"}`,
      });

      const response = await uploadWithProgress(
        signedParams.uploadUrl,
        formData,
        onProgress,
        abortController.signal,
        getUploadTimeout(fileSize, mediaType),
      );

      const thumbnailUrl =
        response.eager?.[0]?.secure_url ||
        response.secure_url.replace(
          "/upload/",
          "/upload/c_fill,w_200,h_200,q_auto:low,f_auto/",
        );

      const validated = await validateWithServer(uploadId || `legacy_${Date.now()}`, {
        url: response.secure_url,
        mediaType,
        width: response.width || width,
        height: response.height || height,
        duration: response.duration || duration,
        fileSize: response.bytes || fileSize,
        mimeType: response.format
          ? `${mediaType}/${response.format}`
          : mimeType,
      });

      if (uploadId) activeUploads.delete(uploadId);
      return {
        url: response.secure_url,
        thumbnailUrl: validated.thumbnailUrl || thumbnailUrl,
        width: response.width || width,
        height: response.height || height,
        duration: response.duration || duration,
        size: response.bytes || fileSize,
        mimeType: validated.mimeType || mimeType,
      };
    } catch (err) {
      lastError = err;
      if (err.message === "Upload cancelled" || abortController.signal.aborted) {
        if (uploadId) activeUploads.delete(uploadId);
        throw err;
      }
      if (err instanceof UploadError && !err.retryable) {
        if (uploadId) activeUploads.delete(uploadId);
        throw err;
      }
      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  if (uploadId) activeUploads.delete(uploadId);
  throw lastError || new Error("Upload failed after retries");
}

/**
 * Cancel an active upload by ID.
 * @param {string} uploadId - The upload ID returned from uploadMedia
 */
export function cancelUpload(uploadId) {
  const controller = activeUploads.get(uploadId);
  if (controller) {
    controller.abort();
    activeUploads.delete(uploadId);
  }
}