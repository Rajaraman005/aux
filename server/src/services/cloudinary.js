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

// ─── Avatar Upload (Existing — Server-Side) ─────────────────────────────────

/**
 * Upload an avatar image to Cloudinary.
 * Server-side upload (avatars are small, <2MB).
 */
async function uploadAvatar(fileBuffer, userId) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "aux/avatars",
        public_id: userId,
        overwrite: true,
        invalidate: true,
        resource_type: "image",
        transformation: [
          {
            width: 400,
            height: 400,
            crop: "fill",
            gravity: "face",
            quality: "auto:good",
            fetch_format: "auto",
          },
        ],
      },
      (error, result) => {
        if (error) {
          console.error("Cloudinary upload error:", error);
          return reject(error);
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
        });
      },
    );

    uploadStream.end(fileBuffer);
  });
}

/**
 * Delete an avatar from Cloudinary.
 */
async function deleteAvatar(userId) {
  try {
    await cloudinary.uploader.destroy(`aux/avatars/${userId}`, {
      invalidate: true,
    });
  } catch (err) {
    console.error("Cloudinary delete error:", err);
  }
}

// ─── Signed Direct Upload (Client-Side) ─────────────────────────────────────

/**
 * Generate signed upload parameters for DIRECT client → Cloudinary upload.
 * Server never touches the file. Zero memory, zero bandwidth cost.
 *
 * @param {string} userId - Authenticated user ID
 * @param {string} mediaType - 'image' | 'video'
 * @returns {{ cloudName, apiKey, timestamp, signature, folder, publicId, eager, uploadUrl }}
 */
function generateSignedUpload(userId, mediaType) {
  const timestamp = Math.round(Date.now() / 1000);
  const uniqueId = crypto.randomBytes(8).toString("hex");
  const folder = "aux/chat-media";
  const publicId = `${userId}_${timestamp}_${uniqueId}`;

  // Build params to sign
  const paramsToSign = {
    timestamp,
    folder,
    public_id: publicId,
  };

  // Image-specific transformations
  if (mediaType === "image") {
    paramsToSign.transformation = "c_limit,w_1920,h_1920,q_auto:good,f_auto";
    paramsToSign.eager = "c_fill,w_200,h_200,q_auto:low,f_auto"; // thumbnail
  }

  // Video-specific transformations
  if (mediaType === "video") {
    paramsToSign.eager = "c_fill,w_320,h_320,q_auto:low,f_jpg,so_0"; // video thumbnail (first frame)
    paramsToSign.eager_async = "true";
  }

  // Audio — Cloudinary stores audio under resource_type "video" (so no eager transformations)
  if (mediaType === "audio") {
    // No extras for audio
  }

  // Generate signature
  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    process.env.CLOUDINARY_API_SECRET,
  );

  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    timestamp,
    signature,
    folder,
    publicId,
    resourceType: mediaType === "image" ? "image" : "video",
    transformation:
      mediaType === "image"
        ? "c_limit,w_1920,h_1920,q_auto:good,f_auto"
        : undefined,
    eager:
      mediaType === "image"
        ? "c_fill,w_200,h_200,q_auto:low,f_auto"
        : mediaType === "video"
          ? "c_fill,w_320,h_320,q_auto:low,f_jpg,so_0"
          : undefined,
    eagerAsync: mediaType === "video",
    uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${mediaType === "image" ? "image" : "video"}/upload`,
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
  return (
    url.startsWith(`https://res.cloudinary.com/${cloudName}/`) ||
    url.startsWith(`https://res.cloudinary.com/${cloudName}/`)
  );
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
  isValidCloudinaryUrl,
  getThumbnailUrl,
};
