/**
 * Media Routes — Signed Upload & Validation.
 *
 * ★ Architecture: Signed Direct Upload
 *   POST /api/media/sign     — Generate signed upload params (client → Cloudinary direct)
 *   POST /api/media/validate — Validate uploaded media URL + run moderation
 *
 * ★ Idempotency: POST /validate accepts Idempotency-Key header.
 *   Redis-backed cache with 10-minute TTL. Fail-open if Redis down.
 *
 * ★ Security: Sign endpoint includes max_file_size and timestamp expiry.
 */
const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimiter");
const {
  generateSignedUpload,
  isValidCloudinaryUrl,
  getThumbnailUrl,
  log,
} = require("../services/cloudinary");
const { moderate } = require("../services/moderation");
const redisBridge = require("../signaling/redis");

const router = express.Router();
router.use(authenticateToken);

const ERROR_RESPONSES = {
  INVALID_MEDIA_TYPE: { status: 400, code: "INVALID_MEDIA_TYPE" },
  INVALID_USER_ID: { status: 400, code: "INVALID_USER_ID" },
  INVALID_PUBLIC_ID: { status: 400, code: "INVALID_PUBLIC_ID" },
  CONFIG_ERROR: { status: 503, code: "SERVICE_CONFIG_ERROR" },
  MODERATION_REJECTED: { status: 413, code: "MODERATION_REJECTED" },
  SIGN_ERROR: { status: 500, code: "SIGN_ERROR" },
};

function errorResponse(err, context = {}) {
  const code = err.code || "SIGN_ERROR";

  if (err.code === "INVALID_MEDIA_TYPE") {
    return { status: 400, body: { error: err.message, code } };
  }
  if (err.code === "INVALID_USER_ID" || err.code === "INVALID_PUBLIC_ID") {
    log.error("Upload sign validation failed", { ...context, code });
    return { status: 400, body: { error: "Upload signing failed: invalid identifier", code } };
  }
  if (err.code === "CONFIG_ERROR") {
    log.error("Cloudinary configuration error", { ...context, err: err.message });
    return { status: 503, body: { error: "Upload service temporarily unavailable", code: "SERVICE_CONFIG_ERROR" } };
  }

  log.error("Sign upload error", { ...context, err: err.message, stack: err.stack });
  return { status: 500, body: { error: "Failed to generate upload signature", code: "SIGN_ERROR" } };
}

// ─── POST /api/media/sign — Generate signed upload params ───────────────────
router.post("/sign", apiLimiter, async (req, res) => {
  const context = { userId: req.user?.id, mediaType: req.body?.mediaType };

  try {
    const { mediaType, fileSize, mimeType } = req.body;

    if (!mediaType || !["image", "video", "audio"].includes(mediaType)) {
      const err = Object.assign(
        new Error('mediaType must be "image", "video", or "audio"'),
        { code: "INVALID_MEDIA_TYPE" },
      );
      throw err;
    }

    if (!req.user?.id) {
      const err = Object.assign(new Error("Invalid user ID"), { code: "INVALID_USER_ID" });
      throw err;
    }

    const preCheck = await moderate({
      mediaType,
      size: fileSize,
      mimeType,
      userId: req.user.id,
    });

    if (!preCheck.allowed) {
      log.info("Upload rejected by moderation", { userId: req.user.id, mediaType, flags: preCheck.flags });
      return res.status(413).json({
        error: preCheck.reason,
        code: "MODERATION_REJECTED",
        flags: preCheck.flags,
      });
    }

    const signedParams = generateSignedUpload(req.user.id, mediaType);

    log.info("Signed upload params generated", { userId: req.user.id, mediaType, publicId: signedParams.publicId });

    res.json({
      ...signedParams,
      maxFileSize: signedParams.maxFileSize,
      expiresAt: signedParams.expiresAt,
    });
  } catch (err) {
    const { status, body } = errorResponse(err, context);
    res.status(status).json(body);
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

    if (!isValidCloudinaryUrl(url)) {
      return res.status(400).json({
        error: "Invalid media URL",
        code: "INVALID_URL",
      });
    }

    const idempotencyKey = req.headers["idempotency-key"] || req.body?.idempotencyKey;

    if (idempotencyKey && redisBridge.isConnected) {
      try {
        const cached = await redisBridge.pub.get(`idem:${idempotencyKey}`);
        if (cached) {
          return res.json(JSON.parse(cached));
        }
      } catch (err) {
        log.error("Idempotency cache read error", { err: err.message });
      }
    }

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
      log.info("Validation rejected by moderation", { userId: req.user.id, mediaType, flags: modResult.flags });
      return res.status(403).json({
        error: modResult.reason,
        code: "MODERATION_REJECTED",
        flags: modResult.flags,
      });
    }

    const thumbnailUrl = getThumbnailUrl(url);

    const result = {
      validated: true,
      url,
      thumbnailUrl,
      mediaType: mediaType || "image",
      width: width || null,
      height: height || null,
      duration: duration || null,
      flags: modResult.flags,
    };

    if (idempotencyKey && redisBridge.isConnected) {
      try {
        await redisBridge.pub.set(
          `idem:${idempotencyKey}`,
          JSON.stringify(result),
          "EX",
          600,
        );
      } catch (err) {
        log.error("Idempotency cache write error", { err: err.message });
      }
    }

    log.info("Media validated", { userId: req.user.id, mediaType });
    res.json(result);
  } catch (err) {
    log.error("Validate media error", { userId: req.user?.id, err: err.message, stack: err.stack });
    res.status(500).json({
      error: "Failed to validate media",
      code: "VALIDATE_ERROR",
    });
  }
});

module.exports = router;