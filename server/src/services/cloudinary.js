/**
 * Cloudinary Upload Service — Extended for Chat Media.
 *
 * ★ Architecture: Signed Direct Upload
 *   - Server generates signed upload params (timestamp + signature)
 *   - Client uploads directly to Cloudinary (no server buffer)
 *   - Zero memory pressure on server, no file proxying
 *   - Cloudinary handles compression, transcoding, CDN
 *
 * Endpoints:
 *   - uploadAvatar() — existing avatar upload (server-side, small files)
 *   - generateSignedUpload() — signed params for direct client upload
 *   - getMediaTransformUrl() — generate optimized CDN URLs
 */
const { v2: cloudinary } = require("cloudinary");
const crypto = require("crypto");

// ─── Configure Cloudinary ────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// ─── Structured Logger ──────────────────────────────────────────────────────
const log = {
  info: (msg, meta = {}) =>
    console.log(JSON.stringify({ level: "info", msg, ts: new Date().toISOString(), ...meta })),
  warn: (msg, meta = {}) =>
    console.warn(JSON.stringify({ level: "warn", msg, ts: new Date().toISOString(), ...meta })),
  error: (msg, meta = {}) =>
    console.error(JSON.stringify({ level: "error", msg, ts: new Date().toISOString(), ...meta })),
};

// ─── Public ID Generation ──────────────────────────────────────────────────
const PUBLIC_ID_MAX_LEN = 128;
const PUBLIC_ID_REGEX = /^[a-zA-Z0-9_]+$/;

function sanitizePublicId(id) {
  const str = String(id ?? "").trim();
  if (!str) return null;
  return str.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function generatePublicId(userId, mediaType) {
  if (!userId || typeof userId !== "string") {
    throw Object.assign(new Error("Invalid user ID for media upload"), { code: "INVALID_USER_ID" });
  }

  const sanitized = sanitizePublicId(userId);
  if (!sanitized || !PUBLIC_ID_REGEX.test(sanitized)) {
    throw Object.assign(new Error("Invalid user ID for media upload"), { code: "INVALID_USER_ID" });
  }

  const namespace = mediaType === "video" ? "v" : mediaType === "audio" ? "a" : "i";
  const timestamp = Date.now().toString(36);
  const uniqueId = crypto.randomBytes(8).toString("hex");

  const publicId = `${namespace}_${sanitized}_${timestamp}_${uniqueId}`;

  if (publicId.length > PUBLIC_ID_MAX_LEN) {
    const truncated = sanitized.slice(0, 32);
    const fallback = `${namespace}_${truncated}_${timestamp}_${uniqueId}`;
    if (fallback.length > PUBLIC_ID_MAX_LEN || !PUBLIC_ID_REGEX.test(fallback)) {
      throw Object.assign(new Error("Invalid public_id format"), { code: "INVALID_PUBLIC_ID" });
    }
    return fallback;
  }

  if (!PUBLIC_ID_REGEX.test(publicId)) {
    throw Object.assign(new Error("Invalid public_id format"), { code: "INVALID_PUBLIC_ID" });
  }

  return publicId;
}

// ─── Avatar Upload (Existing — Server-Side) ─────────────────────────────────

async function uploadAvatar(fileBuffer, userId) {
  const sanitized = sanitizePublicId(userId);
  if (!sanitized) {
    throw Object.assign(new Error("Invalid user ID for avatar upload"), { code: "INVALID_USER_ID" });
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "aux/avatars",
        public_id: sanitized,
        overwrite: true,
        invalidate: true,
        resource_type: "image",
      },
      (error, result) => {
        if (error) {
          log.error("Cloudinary avatar upload error", { userId: sanitized, err: error.message });
          return reject(error);
        }
        log.info("Avatar uploaded", { publicId: result.public_id });
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
        });
      },
    );

    uploadStream.end(fileBuffer);
  });
}

async function deleteAvatar(userId) {
  const sanitized = sanitizePublicId(userId);
  if (!sanitized) return;
  try {
    await cloudinary.uploader.destroy(`aux/avatars/${sanitized}`, {
      invalidate: true,
    });
    log.info("Avatar deleted", { userId: sanitized });
  } catch (err) {
    log.error("Cloudinary delete error", { userId: sanitized, err: err.message });
  }
}

// ─── Signed Direct Upload (Client-Side) ─────────────────────────────────────

// ★ Verified 2026-04-14: Cloudinary signed direct upload limit.
// Update this constant if the Cloudinary plan changes.
const MAX_SIZE = {
  image: 10 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  audio: 5 * 1024 * 1024,
};

const RESOURCE_TYPE_MAP = { image: "image", video: "video", audio: "video" };

function generateSignedUpload(userId, mediaType) {
  if (!process.env.CLOUDINARY_API_SECRET) {
    throw Object.assign(new Error("Cloudinary not configured"), { code: "CONFIG_ERROR" });
  }

  const publicId = generatePublicId(userId, mediaType);
  const timestamp = Math.round(Date.now() / 1000);
  const folder = "aux/chat-media";
  const maxFileSize = MAX_SIZE[mediaType] || MAX_SIZE.image;

  // ★ max_file_size is NOT a valid Cloudinary signed upload parameter.
  // Including it in paramsToSign causes signature mismatch — Cloudinary's
  // verification excludes it from the string-to-sign, breaking the hash.
  // Size limits are enforced client-side (compressionService size gate)
  // and server-side (moderation fileSize check).
  const paramsToSign = {
    timestamp,
    folder,
    public_id: publicId,
  };

  if (mediaType === "image") {
    paramsToSign.transformation = "c_limit,w_1920,h_1920,q_auto:good,f_auto";
    paramsToSign.eager = "c_fill,w_200,h_200,q_auto:low,f_auto";
  }

  if (mediaType === "video") {
    paramsToSign.eager = "c_fill,w_320,h_320,q_auto:low,f_jpg,so_0";
    paramsToSign.eager_async = "true";
  }

  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    process.env.CLOUDINARY_API_SECRET,
  );

  const resourceType = RESOURCE_TYPE_MAP[mediaType] || "image";
  const uploadUrl = `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;

  log.info("Signed upload generated", { userId, mediaType, publicId, maxFileSize });

  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    timestamp,
    signature,
    folder,
    publicId,
    maxFileSize,
    expiresAt: timestamp + 3600,
    resourceType,
    transformation: mediaType === "image" ? paramsToSign.transformation : undefined,
    eager: paramsToSign.eager,
    eagerAsync: mediaType === "video" ? "true" : undefined,
    uploadUrl,
  };
}

/**
 * Verify a Cloudinary upload URL belongs to our account.
 * Prevents spoofed URLs from being injected into messages.
 *
 * @param {string} url - The media URL to validate
 * @returns {boolean}
 */
function isValidCloudinaryUrl(url) {
  if (!url || typeof url !== "string") return false;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const prefix = `https://res.cloudinary.com/${cloudName}/`;
  return url.startsWith(prefix) && url.length > prefix.length + 10;
}

function isSignatureExpired(timestamp) {
  return Date.now() / 1000 - timestamp > 3600;
}

/**
 * Generate an optimized thumbnail URL from a Cloudinary URL.
 *
 * @param {string} originalUrl - Original Cloudinary URL
 * @param {number} width - Thumbnail width
 * @param {number} height - Thumbnail height
 * @returns {string} Thumbnail URL
 */
function getThumbnailUrl(originalUrl, width = 200, height = 200) {
  if (!originalUrl) return null;
  // Insert transformation before /upload/ path
  return originalUrl.replace(
    "/upload/",
    `/upload/c_fill,w_${width},h_${height},q_auto:low,f_auto/`,
  );
}

module.exports = {
  uploadAvatar,
  deleteAvatar,
  generateSignedUpload,
  generatePublicId,
  isValidCloudinaryUrl,
  isSignatureExpired,
  getThumbnailUrl,
  sanitizePublicId,
  log,
};
