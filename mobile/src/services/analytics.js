/**
 * Analytics — Structured event emitter for upload pipeline.
 *
 * Events:
 *   upload_started, upload_compressing, upload_compressed,
 *   upload_signing, upload_signed, upload_progress,
 *   upload_validating, upload_complete, upload_failed,
 *   upload_cancelled, upload_retried, upload_offline_queued,
 *   upload_offline_resumed
 *
 * Thin wrapper: logs to CrashLogger with MEDIA_UPLOAD category,
 * notifies real-time subscribers via .on()/.off().
 */

import crashLogger, { CATEGORIES } from "./CrashLogger";

class Analytics {
  constructor() {
    this.listeners = new Map();
  }

  emit(eventName, dimensions = {}) {
    const event = {
      event: eventName,
      timestamp: Date.now(),
      ...dimensions,
    };

    crashLogger.log(CATEGORIES.MEDIA_UPLOAD, eventName, event);

    const handlers = this.listeners.get(eventName);
    if (handlers) {
      for (const cb of handlers) {
        try {
          cb(event);
        } catch (err) {
          console.error(`Analytics listener error for ${eventName}:`, err);
        }
      }
    }
  }

  on(eventName, callback) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName).add(callback);
    return () => this.off(eventName, callback);
  }

  off(eventName, callback) {
    const handlers = this.listeners.get(eventName);
    if (handlers) {
      handlers.delete(callback);
    }
  }
}

export default new Analytics();