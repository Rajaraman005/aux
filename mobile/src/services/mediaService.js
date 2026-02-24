/**
 * Media Service — Signed Direct Upload with Retry Logic.
 *
 * ★ Enterprise Architecture:
 *   1. Client gets signed upload params from server (POST /api/media/sign)
 *   2. Client uploads file DIRECTLY to Cloudinary (zero server load)
 *   3. Client validates result with server (POST /api/media/validate)
 *   4. Client sends message via WebSocket with the CDN URL
 *
 * ★ Retry Logic:
 *   - Auto-retry on network failure (exponential backoff, max 3 attempts)
 *   - Manual retry exposed via retryUpload()
 *   - Cancel support via AbortController
 *   - Upload progress tracking
 *
 * ★ Media Picker:
 *   - Uses expo-image-picker for gallery/camera access
 *   - Configurable compression quality
 *   - Video duration limit (60s)
 */
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import apiClient from "./api";
import { endpoints } from "../config/api";

// ─── Constants ──────────────────────────────────────────────────────────────
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_VIDEO_DURATION = 60; // seconds
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000; // ms

// ─── Active Uploads Registry (for cancel support) ───────────────────────────
const activeUploads = new Map(); // uploadId -> AbortController

/**
 * Pick an image from gallery or camera.
 * @param {'gallery'|'camera'} source - Where to pick from
 * @returns {Promise<{uri, width, height, fileSize, mimeType}|null>}
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
    if (status !== "granted") {
      throw new Error("Camera permission denied");
    }
    result = await ImagePicker.launchCameraAsync(options);
  } else {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      throw new Error("Gallery permission denied");
    }
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
 * @param {'gallery'|'camera'} source
 * @returns {Promise<{uri, width, height, fileSize, duration, mimeType}|null>}
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
    if (status !== "granted") {
      throw new Error("Camera permission denied");
    }
    result = await ImagePicker.launchCameraAsync(options);
  } else {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      throw new Error("Gallery permission denied");
    }
    result = await ImagePicker.launchImageLibraryAsync(options);
  }

  if (result.canceled || !result.assets?.length) return null;

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    width: asset.width,
    height: asset.height,
    fileSize: asset.fileSize || 0,
    duration: asset.duration ? asset.duration / 1000 : 0, // ms -> seconds
    mimeType: asset.mimeType || "video/mp4",
  };
}

/**
 * Upload media to Cloudinary via signed direct upload.
 *
 * @param {Object} params
 * @param {string} params.uri - Local file URI
 * @param {'image'|'video'} params.mediaType
 * @param {number} [params.fileSize]
 * @param {string} [params.mimeType]
 * @param {Function} [params.onProgress] - (progress: 0-1) => void
 * @param {string} [params.uploadId] - Unique ID for cancel support
 * @returns {Promise<{url, thumbnailUrl, width, height, duration}>}
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
  // Validate size client-side
  const maxSize = mediaType === "video" ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
  if (fileSize && fileSize > maxSize) {
    const limitMB = Math.round(maxSize / (1024 * 1024));
    throw new Error(`File too large (max ${limitMB}MB)`);
  }

  // Step 1: Get signed upload params from server
  const signedParams = await apiClient.post(endpoints.media.sign, {
    mediaType,
    fileSize,
    mimeType,
  });

  // Step 2: Build multipart form data for Cloudinary direct upload
  const formData = new FormData();
  formData.append("file", {
    uri: Platform.OS === "ios" ? uri.replace("file://", "") : uri,
    type: mimeType || (mediaType === "video" ? "video/mp4" : "image/jpeg"),
    name: `upload.${mediaType === "video" ? "mp4" : "jpg"}`,
  });
  formData.append("api_key", signedParams.apiKey);
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

  // Step 3: Upload directly to Cloudinary (with retry logic)
  const abortController = new AbortController();
  if (uploadId) {
    activeUploads.set(uploadId, abortController);
  }

  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (abortController.signal.aborted) {
        throw new Error("Upload cancelled");
      }

      const response = await uploadWithProgress(
        signedParams.uploadUrl,
        formData,
        onProgress,
        abortController.signal,
      );

      // Step 4: Validate with server
      const thumbnailUrl =
        response.eager?.[0]?.secure_url ||
        response.secure_url.replace(
          "/upload/",
          "/upload/c_fill,w_200,h_200,q_auto:low,f_auto/",
        );

      const validated = await apiClient.post(endpoints.media.validate, {
        url: response.secure_url,
        mediaType,
        width: response.width || width,
        height: response.height || height,
        duration: response.duration || duration,
        size: response.bytes || fileSize,
        mimeType: response.format
          ? `${mediaType}/${response.format}`
          : mimeType,
      });

      // Cleanup
      if (uploadId) activeUploads.delete(uploadId);

      return {
        url: response.secure_url,
        thumbnailUrl: validated.thumbnailUrl || thumbnailUrl,
        width: response.width || width,
        height: response.height || height,
        duration: response.duration || duration,
        size: response.bytes || fileSize,
        mimeType: response.format
          ? `${mediaType}/${response.format}`
          : mimeType,
      };
    } catch (err) {
      lastError = err;

      if (
        err.message === "Upload cancelled" ||
        abortController.signal.aborted
      ) {
        if (uploadId) activeUploads.delete(uploadId);
        throw new Error("Upload cancelled");
      }

      // Don't retry on validation errors (upload succeeded but moderation failed)
      if (err.message?.includes("MODERATION_REJECTED")) {
        if (uploadId) activeUploads.delete(uploadId);
        throw err;
      }

      // Exponential backoff
      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        console.log(
          `📤 Upload retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // All retries exhausted
  if (uploadId) activeUploads.delete(uploadId);
  throw lastError || new Error("Upload failed after retries");
}

/**
 * Cancel an active upload.
 * @param {string} uploadId
 */
export function cancelUpload(uploadId) {
  const controller = activeUploads.get(uploadId);
  if (controller) {
    controller.abort();
    activeUploads.delete(uploadId);
    console.log(`📤 Upload ${uploadId} cancelled`);
  }
}

/**
 * Retry a failed upload (caller must supply original params).
 */
export async function retryUpload(params) {
  return uploadMedia(params);
}

// ─── XMLHttpRequest Upload with Progress ────────────────────────────────────
function uploadWithProgress(url, formData, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    // Abort support
    if (signal) {
      signal.addEventListener("abort", () => {
        xhr.abort();
        reject(new Error("Upload cancelled"));
      });
    }

    xhr.open("POST", url);

    // Progress tracking
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(event.loaded / event.total);
        }
      };
    }

    xhr.onload = () => {
      try {
        const response = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(response);
        } else {
          reject(
            new Error(
              response.error?.message || `Upload failed (${xhr.status})`,
            ),
          );
        }
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    xhr.timeout = 120000; // 2 minutes

    xhr.send(formData);
  });
}
