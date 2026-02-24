/**
 * Push Token API Routes — Native FCM/APNs.
 *
 * Handles device registration and unregistration for native push tokens.
 * Replaces Expo push token management with FCM registration tokens.
 *
 * POST   /api/push/register     — Register/update a device with FCM token
 * DELETE /api/push/unregister   — Deactivate a device (on logout)
 * GET    /api/push/devices      — List user's registered devices
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
 * Register a device with a native FCM push token.
 * Supports multi-device — same user can have multiple active devices.
 *
 * Body:
 *   - token (string, required): FCM registration token
 *   - platform (string): 'android' | 'ios' (default: 'android')
 *   - deviceId (string): unique device identifier
 *   - tokenType (string): 'fcm' | 'apns' (default: 'fcm')
 *   - appVersion (string): app version, e.g. '1.0.1'
 *   - osVersion (string): OS version, e.g. 'Android 14'
 *   - deviceName (string): device name, e.g. 'Pixel 8 Pro'
 */
router.post("/register", apiLimiter, async (req, res) => {
  try {
    const {
      token,
      platform,
      deviceId,
      tokenType,
      appVersion,
      osVersion,
      deviceName,
    } = req.body;

    if (!token) {
      return res.status(400).json({
        error: "Push token is required",
        code: "MISSING_TOKEN",
      });
    }

    // Validate token is a non-empty string (FCM tokens are ~163 chars)
    if (typeof token !== "string" || token.length < 10) {
      return res.status(400).json({
        error: "Invalid push token format",
        code: "INVALID_TOKEN",
      });
    }

    await db.saveDevice(req.user.id, {
      deviceId: deviceId || "unknown",
      platform: platform || "android",
      pushToken: token,
      tokenType: tokenType || "fcm",
      appVersion: appVersion || null,
      osVersion: osVersion || null,
      deviceName: deviceName || null,
    });

    console.log(
      `📱 Device registered for ${req.user.id} (${platform || "android"}, ${tokenType || "fcm"})`,
    );

    res.json({ success: true, message: "Device registered" });
  } catch (err) {
    console.error("Push register error:", err.message);
    res.status(500).json({
      error: "Failed to register device",
      code: "PUSH_REGISTER_ERROR",
    });
  }
});

/**
 * DELETE /api/push/unregister
 * Deactivate a device (on logout or app uninstall).
 * If deviceId is provided, deactivates specific device.
 * If no deviceId, deactivates ALL devices for the user.
 */
router.delete("/unregister", apiLimiter, async (req, res) => {
  try {
    const { deviceId, token } = req.body;

    if (deviceId) {
      // Deactivate specific device
      await db.deactivateDevice(req.user.id, deviceId);
      console.log(`📱 Device deactivated: ${deviceId} for ${req.user.id}`);
    } else if (token) {
      // Deactivate by token (backward compat)
      await db.deactivateDeviceByToken(token);
      console.log(`📱 Device deactivated by token for ${req.user.id}`);
    } else {
      // Deactivate all devices (full logout)
      await db.deactivateAllDevices(req.user.id);
      console.log(`📱 All devices deactivated for ${req.user.id}`);
    }

    res.json({ success: true, message: "Device(s) deactivated" });
  } catch (err) {
    console.error("Push unregister error:", err.message);
    res.status(500).json({
      error: "Failed to unregister device",
      code: "PUSH_UNREGISTER_ERROR",
    });
  }
});

/**
 * GET /api/push/devices
 * List all registered devices for the authenticated user.
 * Used in settings to manage device sessions.
 */
router.get("/devices", async (req, res) => {
  try {
    const devices = await db.getActiveDevices(req.user.id);
    res.json({
      devices: devices.map((d) => ({
        id: d.id,
        device_id: d.device_id,
        platform: d.platform,
        device_name: d.device_name,
        app_version: d.app_version,
        os_version: d.os_version,
        last_seen_at: d.last_seen_at,
        created_at: d.created_at,
      })),
    });
  } catch (err) {
    console.error("List devices error:", err.message);
    res.status(500).json({
      error: "Failed to list devices",
      code: "DEVICES_LIST_ERROR",
    });
  }
});

module.exports = router;
