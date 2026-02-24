/**
 * Notification Preferences Routes.
 *
 * GET  /api/notifications/preferences       — Get all notification preferences
 * PUT  /api/notifications/preferences       — Update a notification preference
 *
 * Allows users to control which notification types they receive
 * and through which channels (push, in-app, sound, vibration).
 */
const express = require("express");
const { db } = require("../db/supabase");
const { authenticateToken } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimiter");

const router = express.Router();
router.use(authenticateToken);
router.use(apiLimiter);

// Valid notification types
const VALID_TYPES = [
  "message",
  "call",
  "missed_call",
  "friend_request",
  "world_mention",
  "system",
];

// Default preferences (returned if user hasn't customized)
const DEFAULT_PREFERENCES = VALID_TYPES.map((type) => ({
  type,
  push_enabled: true,
  in_app_enabled: true,
  sound_enabled: true,
  vibrate_enabled: true,
}));

/**
 * GET /api/notifications/preferences
 * Returns user's notification preferences, with defaults for unconfigured types.
 */
router.get("/", async (req, res) => {
  try {
    const savedPrefs = await db.getNotificationPreferences(req.user.id);

    // Merge saved preferences with defaults
    const prefsMap = {};
    for (const pref of DEFAULT_PREFERENCES) {
      prefsMap[pref.type] = { ...pref };
    }
    for (const pref of savedPrefs) {
      prefsMap[pref.type] = {
        type: pref.type,
        push_enabled: pref.push_enabled,
        in_app_enabled: pref.in_app_enabled,
        sound_enabled: pref.sound_enabled,
        vibrate_enabled: pref.vibrate_enabled,
      };
    }

    res.json({
      preferences: Object.values(prefsMap),
    });
  } catch (err) {
    console.error("Get preferences error:", err.message);
    res.status(500).json({
      error: "Failed to fetch preferences",
      code: "SERVER_ERROR",
    });
  }
});

/**
 * PUT /api/notifications/preferences
 * Update a single notification preference.
 *
 * Body:
 *   - type (string, required): notification type
 *   - push_enabled (boolean)
 *   - in_app_enabled (boolean)
 *   - sound_enabled (boolean)
 *   - vibrate_enabled (boolean)
 */
router.put("/", async (req, res) => {
  try {
    const {
      type,
      push_enabled,
      in_app_enabled,
      sound_enabled,
      vibrate_enabled,
    } = req.body;

    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({
        error: `Invalid notification type. Valid types: ${VALID_TYPES.join(", ")}`,
        code: "INVALID_TYPE",
      });
    }

    const result = await db.upsertNotificationPreference(req.user.id, type, {
      push_enabled,
      in_app_enabled,
      sound_enabled,
      vibrate_enabled,
    });

    res.json({ preference: result });
  } catch (err) {
    console.error("Update preference error:", err.message);
    res.status(500).json({
      error: "Failed to update preference",
      code: "SERVER_ERROR",
    });
  }
});

module.exports = router;
