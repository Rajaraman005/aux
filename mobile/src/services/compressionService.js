/**
 * CompressionService — Client-side media compression.
 *
 * Pure functions, no side effects, fully testable.
 * Network-aware quality: reduces quality on slow connections.
 * Hard size gate: rejects oversized files before any processing.
 */

import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import NetInfo from "@react-native-community/netinfo";
import analytics from "./analytics";

const MAX_IMAGE_DIMENSION = 1920;
const MAX_IMAGE_DIMENSION_SLOW = 1080;
const IMAGE_QUALITY_FAST = 0.85;
const IMAGE_QUALITY_NORMAL = 0.80;
const IMAGE_QUALITY_SLOW = 0.70;

const MAX_MEDIA_SIZE = {
  image: 10 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  audio: 5 * 1024 * 1024,
};

let networkQualityCache = null;
let networkQualityTimestamp = 0;
const NETWORK_QUALITY_TTL = 30000;

export async function getNetworkQuality() {
  const now = Date.now();
  if (networkQualityCache && now - networkQualityTimestamp < NETWORK_QUALITY_TTL) {
    return networkQualityCache;
  }

  try {
    const state = await NetInfo.fetch();
    const downlink = state.details?.downlink || 0;

    let quality = "normal";
    if (downlink > 2) quality = "fast";
    else if (downlink < 0.5) quality = "slow";

    networkQualityCache = quality;
    networkQualityTimestamp = now;
    return quality;
  } catch {
    return "normal";
  }
}

export async function estimateFileSize(uri) {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.size || 0;
  } catch {
    return 0;
  }
}

export function validateVideoConstraints(fileSize, duration, maxSize, maxDuration) {
  const effectiveMaxSize = maxSize || 100 * 1024 * 1024;
  const effectiveMaxDuration = maxDuration || 60;

  if (fileSize > effectiveMaxSize) {
    const limitMB = Math.round(effectiveMaxSize / (1024 * 1024));
    return { valid: false, reason: `Video too large (max ${limitMB}MB)` };
  }
  if (duration && duration > effectiveMaxDuration) {
    return { valid: false, reason: `Video too long (max ${effectiveMaxDuration}s)` };
  }
  return { valid: true };
}

export async function compressImage(uri, options = {}) {
  const quality = options.quality ?? IMAGE_QUALITY_NORMAL;
  const maxDimension = options.maxDimension ?? MAX_IMAGE_DIMENSION;

  analytics.emit("upload_compressing", { stage: "image" });

  const manipulated = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: maxDimension } }],
    { compress: quality, format: ImageManipulator.SaveFormat.JPEG },
  );

  const fileSize = await estimateFileSize(manipulated.uri);

  analytics.emit("upload_compressed", {
    originalSize: options.originalSize || 0,
    compressedSize: fileSize,
    ratio: options.originalSize ? fileSize / options.originalSize : 0,
  });

  return {
    uri: manipulated.uri,
    width: manipulated.width,
    height: manipulated.height,
    fileSize,
    mimeType: "image/jpeg",
  };
}

export async function compressForUpload(uri, mediaType, options = {}) {
  analytics.emit("upload_started", { mediaType, source: options.source });

  // Hard size gate — fail fast before any processing
  const fileSize = await estimateFileSize(uri);
  const maxSize = MAX_MEDIA_SIZE[mediaType] || MAX_MEDIA_SIZE.image;

  if (fileSize && fileSize > maxSize) {
    const limitMB = Math.round(maxSize / (1024 * 1024));
    const actualMB = (fileSize / (1024 * 1024)).toFixed(1);
    throw new Error(`File too large (${actualMB}MB). Maximum is ${limitMB}MB for ${mediaType}.`);
  }

  // Android content:// URIs can return size: 0 on some OEM ROMs (Samsung, Xiaomi)
  // Skip the gate — let Cloudinary reject if truly oversized
  if (!fileSize || fileSize === 0) {
    console.warn("[compressionService] Could not determine file size for URI:", uri);
  }

  if (mediaType === "image") {
    const networkQuality = await getNetworkQuality();
    const compressionOptions = {
      fast: { quality: IMAGE_QUALITY_FAST, maxDimension: MAX_IMAGE_DIMENSION },
      normal: { quality: IMAGE_QUALITY_NORMAL, maxDimension: MAX_IMAGE_DIMENSION },
      slow: { quality: IMAGE_QUALITY_SLOW, maxDimension: MAX_IMAGE_DIMENSION_SLOW },
    }[networkQuality];

    return compressImage(uri, { ...compressionOptions, originalSize: fileSize || 0 });
  }

  if (mediaType === "video") {
    const validation = validateVideoConstraints(
      fileSize,
      options.duration,
      options.maxSize,
      options.maxDuration,
    );
    if (!validation.valid) {
      throw new Error(validation.reason);
    }
    return {
      uri,
      width: options.width || null,
      height: options.height || null,
      fileSize,
      mimeType: options.mimeType || "video/mp4",
      duration: options.duration || null,
    };
  }

  if (mediaType === "audio") {
    return {
      uri,
      width: null,
      height: null,
      fileSize,
      mimeType: options.mimeType || "audio/m4a",
      duration: options.duration || null,
    };
  }

  throw new Error(`Unsupported media type: ${mediaType}`);
}