const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// ─── Metrics ────────────────────────────────────────────────────────────────
const expoMetrics = {
  sent: 0,
  failed: 0,
  ticketErrors: 0,
  getStats() {
    return {
      expo_push_sent: this.sent,
      expo_push_failed: this.failed,
      expo_push_ticket_errors: this.ticketErrors,
    };
  },
};

/**
 * Send push notification to multiple Expo Push tokens.
 *
 * @param {Array<{push_token: string, device_id?: string}>} devices
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.body
 * @param {object} options.data
 * @param {string} options.priority - 'high' | 'normal' | 'default'
 * @param {string} options.channelId
 * @param {boolean} options.dataOnly
 * @param {function} onInvalidToken - callback for invalid token cleanup
 * @returns {Array<{success: boolean, error?: string}>}
 */
async function sendToDevices(devices, options, onInvalidToken) {
  if (!devices || devices.length === 0) return [];

  // Build Expo push messages
  const messages = devices
    .filter((d) => d.push_token && d.push_token.startsWith("ExponentPushToken"))
    .map((device) => {
      const msg = {
        to: device.push_token,
        sound: "default",
        priority: options.priority === "high" ? "high" : "default",
        channelId: options.channelId || "default",
        data: options.data || {},
      };

      // Add notification payload unless data-only
      if (!options.dataOnly) {
        msg.title = options.title;
        msg.body = options.body;
      }

      return { device, msg };
    });

  if (messages.length === 0) return [];

  // Batch send (Expo supports up to 100 per request)
  const BATCH_SIZE = 100;
  const results = [];

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const batchMessages = batch.map((b) => b.msg);

    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batchMessages),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`Expo Push API error (${response.status}):`, errText);
        expoMetrics.failed += batch.length;
        results.push(
          ...batch.map(() => ({
            success: false,
            error: `HTTP_${response.status}`,
          })),
        );
        continue;
      }

      const responseData = await response.json();
      const tickets = responseData.data || [];

      for (let j = 0; j < tickets.length; j++) {
        const ticket = tickets[j];
        const device = batch[j]?.device;

        if (ticket.status === "ok") {
          expoMetrics.sent++;
          results.push({ success: true, ticketId: ticket.id });
        } else {
          expoMetrics.failed++;
          expoMetrics.ticketErrors++;

          const errorType = ticket.details?.error;
          console.error(
            `Expo push ticket error for ${device?.push_token?.slice(0, 30)}:`,
            errorType,
            ticket.message,
          );

          // Clean up invalid tokens
          if (errorType === "DeviceNotRegistered" && onInvalidToken && device) {
            try {
              await onInvalidToken(device.push_token, device.device_id);
              console.log(
                `🧹 Expo: Deactivated invalid token: ${device.push_token.slice(0, 30)}...`,
              );
            } catch (err) {
              console.error("Expo token cleanup error:", err.message);
            }
          }

          results.push({
            success: false,
            error: errorType || "UNKNOWN",
            shouldCleanToken: errorType === "DeviceNotRegistered",
          });
        }
      }
    } catch (err) {
      console.error("Expo Push network error:", err.message);
      expoMetrics.failed += batch.length;
      results.push(
        ...batch.map(() => ({ success: false, error: "NETWORK_ERROR" })),
      );
    }
  }

  return results;
}

/**
 * Check if a token is an Expo Push token.
 */
function isExpoToken(token) {
  return token && token.startsWith("ExponentPushToken");
}

module.exports = {
  sendToDevices,
  isExpoToken,
  expoMetrics,
};
