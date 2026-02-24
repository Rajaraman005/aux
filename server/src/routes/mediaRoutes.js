/**
 * Media Routes — Signed Upload & Validation.
 *
 * ★ Architecture: Signed Direct Upload
 *   POST /api/media/sign     — Generate signed upload params (client → Cloudinary direct)
 *   POST /api/media/validate — Validate uploaded media URL + run moderation
 *
 * Flow:
 *   1. Client calls POST /sign → gets { signature, uploadUrl, ... }
 *   2. Client uploads file DIRECTLY to Cloudinary (zero server load)
 *   3. Client calls POST /validate with the resulting URL → moderation runs
 *   4. Client sends WebSocket message with validated media_url
 */
const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimiter");
const {
  generateSignedUpload,
  isValidCloudinaryUrl,
  getThumbnailUrl,
} = require("../services/cloudinary");
const { moderate } = require("../services/moderation");

const router = express.Router();
router.use(authenticateToken);

// ─── POST /api/media/sign — Generate signed upload params ───────────────────
router.post("/sign", apiLimiter, async (req, res) => {
  try {
    const { mediaType, fileSize, mimeType } = req.body;

    // Validate mediaType
    if (!mediaType || !["image", "video", "audio"].includes(mediaType)) {
      return res.status(400).json({
        error: 'mediaType must be "image", "video", or "audio"',
        code: "INVALID_MEDIA_TYPE",
      });
    }

    // Pre-flight moderation (check size + MIME before generating signature)
    const preCheck = await moderate({
      mediaType,
      size: fileSize,
      mimeType,
      userId: req.user.id,
    });

    if (!preCheck.allowed) {
      return res.status(413).json({
        error: preCheck.reason,
        code: "MODERATION_REJECTED",
        flags: preCheck.flags,
      });
    }

    // Generate signed upload params
    const signedParams = generateSignedUpload(req.user.id, mediaType);

    res.json({
      ...signedParams,
      maxFileSize: mediaType === "video" ? 50 * 1024 * 1024 : 10 * 1024 * 1024,
    });
  } catch (err) {
    console.error("Sign upload error:", err.message);
    res.status(500).json({
      error: "Failed to generate upload signature",
      code: "SIGN_ERROR",
    });
  }
});

// ─── POST /api/media/validate — Validate an uploaded media URL ──────────────
router.post("/validate", apiLimiter, async (req, res) => {
  try {
    const { url, mediaType, width, height, duration, size, mimeType } =
      req.body;

    if (!url) {
      return res.status(400).json({
        error: "Media URL is required",
        code: "MISSING_URL",
      });
    }

    // Verify URL belongs to our Cloudinary account
    if (!isValidCloudinaryUrl(url)) {
      return res.status(400).json({
        error: "Invalid media URL",
        code: "INVALID_URL",
      });
    }

    // Post-upload moderation
    const modResult = await moderate({
      url,
      mediaType: mediaType || "image",
      size,
      mimeType,
      userId: req.user.id,
      width,
      height,
    });

    if (!modResult.allowed) {
      return res.status(403).json({
        error: modResult.reason,
        code: "MODERATION_REJECTED",
        flags: modResult.flags,
      });
    }

    // Generate thumbnail URL
    const thumbnailUrl = getThumbnailUrl(url);

    res.json({
      validated: true,
      url,
      thumbnailUrl,
      mediaType: mediaType || "image",
      width: width || null,
      height: height || null,
      duration: duration || null,
      flags: modResult.flags,
    });
  } catch (err) {
    console.error("Validate media error:", err.message);
    res.status(500).json({
      error: "Failed to validate media",
      code: "VALIDATE_ERROR",
    });
  }
});

module.exports = router;
