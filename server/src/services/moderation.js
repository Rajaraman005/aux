/**
 * Media Moderation Service — Pluggable Content Moderation.
 *
 * ★ Enterprise Architecture:
 *   - Hook-based pipeline: register multiple moderators
 *   - Each moderator returns { allowed, reason, flags[] }
 *   - ALL moderators run (parallel) — any rejection = blocked
 *   - Built-in: file size, MIME type, basic NSFW flag structure
 *   - Future: plug in AI moderation (AWS Rekognition, Google Vision, etc.)
 *
 * Usage:
 *   const { moderate } = require('./moderation');
 *   const result = await moderate({ url, mediaType, size, mimeType, userId });
 *   if (!result.allowed) { // reject }
 */

// ─── Moderator Registry ─────────────────────────────────────────────────────
const moderators = [];

/**
 * Register a moderation hook.
 * @param {string} name - Moderator name (for logging)
 * @param {Function} fn - async (media) => { allowed: bool, reason?: string, flags?: string[] }
 */
function registerModerator(name, fn) {
  moderators.push({ name, fn });
  console.log(`🛡️  Moderator registered: ${name}`);
}

/**
 * Run all registered moderators against a media upload.
 * @param {Object} media - { url, mediaType, size, mimeType, userId, width, height }
 * @returns {Promise<{ allowed: boolean, reason?: string, flags: string[] }>}
 */
async function moderate(media) {
  if (moderators.length === 0) {
    return { allowed: true, flags: [] };
  }

  const results = await Promise.allSettled(
    moderators.map(async ({ name, fn }) => {
      try {
        const result = await fn(media);
        return { name, ...result };
      } catch (err) {
        console.error(`Moderator "${name}" error:`, err.message);
        // Moderator failure = allow (fail-open, don't block users on service errors)
        return { name, allowed: true, flags: [], error: err.message };
      }
    }),
  );

  const allFlags = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      const { name, allowed, reason, flags = [] } = result.value;
      allFlags.push(...flags);
      if (!allowed) {
        console.log(`🛡️  Media blocked by "${name}": ${reason}`);
        return { allowed: false, reason, flags: allFlags, blockedBy: name };
      }
    }
  }

  return { allowed: true, flags: allFlags };
}

// ─── Built-in Moderators ────────────────────────────────────────────────────

// 1. File size limits
registerModerator("file-size", async ({ mediaType, size }) => {
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
  const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB
  const MAX_AUDIO_SIZE = 5 * 1024 * 1024; // 5MB
  const limits = {
    image: MAX_IMAGE_SIZE,
    video: MAX_VIDEO_SIZE,
    audio: MAX_AUDIO_SIZE,
  };
  const limit = limits[mediaType] || MAX_IMAGE_SIZE;

  if (size && size > limit) {
    const limitMB = Math.round(limit / (1024 * 1024));
    return {
      allowed: false,
      reason: `File too large (max ${limitMB}MB for ${mediaType})`,
      flags: ["oversized"],
    };
  }
  return { allowed: true, flags: [] };
});

// 2. MIME type validation
registerModerator("mime-type", async ({ mimeType, mediaType }) => {
  const ALLOWED_IMAGE_TYPES = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/gif",
  ];
  const ALLOWED_VIDEO_TYPES = [
    "video/mp4",
    "video/quicktime",
    "video/x-m4v",
    "video/3gpp",
  ];
  const ALLOWED_AUDIO_TYPES = [
    "audio/m4a",
    "audio/x-m4a",
    "audio/mp4",
    "audio/aac",
    "audio/mpeg",
    "audio/mp3",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
  ];

  if (!mimeType) return { allowed: true, flags: ["no-mime"] };

  let allowed;
  if (mediaType === "video") allowed = ALLOWED_VIDEO_TYPES.includes(mimeType);
  else if (mediaType === "audio")
    allowed = ALLOWED_AUDIO_TYPES.includes(mimeType);
  else allowed = ALLOWED_IMAGE_TYPES.includes(mimeType);

  if (!allowed) {
    return {
      allowed: false,
      reason: `Unsupported file type: ${mimeType}`,
      flags: ["invalid-mime"],
    };
  }
  return { allowed: true, flags: [] };
});

// 3. Rate limiting (max uploads per user per hour)
const uploadCounts = new Map();
const MAX_UPLOADS_PER_HOUR = 50;
const redisBridge = require("../signaling/redis");

registerModerator("rate-limit", async ({ userId }) => {
  if (!userId) return { allowed: true, flags: [] };

  if (redisBridge.isConnected) {
    try {
      const key = `upload_rate:${userId}`;
      const count = await redisBridge.pub.incr(key);
      if (count === 1) {
        await redisBridge.pub.expire(key, 3600);
      }
      if (count > MAX_UPLOADS_PER_HOUR) {
        return {
          allowed: false,
          reason: "Too many uploads. Try again later.",
          flags: ["rate-limited"],
        };
      }
      return { allowed: true, flags: [] };
    } catch (err) {
      console.error("Rate limit Redis error — failing closed:", err.message);
      return {
        allowed: false,
        reason: "Service temporarily unavailable. Please try again.",
        flags: ["rate-limit-error"],
      };
    }
  }

  if (process.env.NODE_ENV === "production") {
    console.error("Rate limiter: No Redis in production — failing closed");
    return {
      allowed: false,
      reason: "Service temporarily unavailable. Please try again.",
      flags: ["rate-limit-error"],
    };
  }

  const now = Date.now();
  let entry = uploadCounts.get(userId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 3600000 };
    uploadCounts.set(userId, entry);
  }
  entry.count++;
  if (entry.count > MAX_UPLOADS_PER_HOUR) {
    return {
      allowed: false,
      reason: "Too many uploads. Try again later.",
      flags: ["rate-limited"],
    };
  }
  return { allowed: true, flags: [] };
});

// ─── Placeholder: AI Moderation (uncomment when ready) ──────────────────────
// registerModerator('ai-nsfw', async ({ url, mediaType }) => {
//   // Call AWS Rekognition / Google Vision / custom model
//   // const result = await nsfwDetector.analyze(url);
//   // if (result.isNSFW) return { allowed: false, reason: 'NSFW content', flags: ['nsfw'] };
//   return { allowed: true, flags: [] };
// });

module.exports = { moderate, registerModerator };
