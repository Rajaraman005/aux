/**
 * Push Token API Routes.
 * Handles registration and unregistration of push tokens.
 */
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimiter");
const { db } = require("../db/supabase");

// All routes require authentication
router.use(authenticateToken);

/**
 * POST /api/push/register
 * Register a push token for the authenticated user.
 * Supports multi-device — same user can have multiple tokens.
 */
router.post("/register", apiLimiter, async (req, res) => {
  try {
    const { token, platform, deviceId } = req.body;

    if (!token) {
      return res.status(400).json({
        error: "Push token is required",
        code: "MISSING_TOKEN",
      });
    }

    // Validate Expo push token format
    if (
      !token.startsWith("ExponentPushToken[") &&
      !token.startsWith("ExpoPushToken[")
    ) {
      return res.status(400).json({
        error: "Invalid Expo push token format",
        code: "INVALID_TOKEN",
      });
    }

    await db.savePushToken(
      req.user.id,
      token,
      platform || "android",
      deviceId || "unknown",
    );

    console.log(
      `📱 Push token registered for ${req.user.id} (${platform || "android"})`,
    );

    res.json({ success: true, message: "Push token registered" });
  } catch (err) {
    console.error("Push register error:", err.message);
    res.status(500).json({
      error: "Failed to register push token",
      code: "PUSH_REGISTER_ERROR",
    });
  }
});

/**
 * DELETE /api/push/unregister
 * Remove a push token (on logout or token refresh).
 */
router.delete("/unregister", apiLimiter, async (req, res) => {
  try {
    const { token } = req.body;

    if (token) {
      // Remove specific token
      await db.deletePushToken(token);
      console.log(`📱 Push token removed (specific)`);
    } else {
      // Remove all tokens for user (full logout)
      await db.deleteUserTokens(req.user.id);
      console.log(`📱 All push tokens removed for ${req.user.id}`);
    }

    res.json({ success: true, message: "Push token(s) removed" });
  } catch (err) {
    console.error("Push unregister error:", err.message);
    res.status(500).json({
      error: "Failed to unregister push token",
      code: "PUSH_UNREGISTER_ERROR",
    });
  }
});

module.exports = router;
