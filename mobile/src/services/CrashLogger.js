/**
 * CrashLogger — Production Crash Journal.
 *
 * ★ Fire-and-forget: writes never block, never throw, never depend on app state.
 * ★ Dual output: AsyncStorage (persistent) + native console (captured by crash reporters).
 * ★ Circular buffer: max 200 entries to prevent storage bloat.
 * ★ Memory monitoring: tracks JS heap via Performance API when available.
 *
 * Usage:
 *   import CrashLogger from './CrashLogger';
 *   CrashLogger.log('APP_START', 'App launched');
 *   CrashLogger.log('CRASH_DETECTED', 'Unhandled error', error);
 *   const logs = await CrashLogger.getLogs();
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@aux_crash_log";
const MAX_ENTRIES = 200;

// Categories for structured logging
const CATEGORIES = {
  APP_START: "APP_START",
  APP_BACKGROUND: "APP_BACKGROUND",
  APP_FOREGROUND: "APP_FOREGROUND",
  SOCKET_CONNECTED: "SOCKET_CONNECTED",
  SOCKET_DISCONNECTED: "SOCKET_DISCONNECTED",
  SOCKET_ERROR: "SOCKET_ERROR",
  CALL_STARTED: "CALL_STARTED",
  CALL_ENDED: "CALL_ENDED",
  CALL_ERROR: "CALL_ERROR",
  WEBRTC_ERROR: "WEBRTC_ERROR",
  NOTIFICATION_ERROR: "NOTIFICATION_ERROR",
  CRASH_DETECTED: "CRASH_DETECTED",
  PROMISE_REJECTION: "PROMISE_REJECTION",
  MEMORY_WARNING: "MEMORY_WARNING",
  LIFECYCLE: "LIFECYCLE",
  ERROR_BOUNDARY: "ERROR_BOUNDARY",
};

class CrashLogger {
  constructor() {
    this._queue = [];
    this._flushing = false;
    this._flushTimer = null;
  }

  /**
   * Log an event. Fire-and-forget — never throws, never blocks.
   * @param {string} category - One of CATEGORIES
   * @param {string} message - Human-readable description
   * @param {Error|object} [error] - Optional error object
   */
  log(category, message, error) {
    const entry = {
      t: new Date().toISOString(),
      c: category,
      m: message,
    };

    if (error) {
      entry.e = error.message || String(error);
      if (error.stack) {
        // Keep only first 3 lines of stack to save space
        entry.s = error.stack.split("\n").slice(0, 3).join("\n");
      }
    }

    // ★ Always log to native console as fallback (crash reporters capture these)
    const logLine = `[${entry.c}] ${entry.m}${entry.e ? ` | Error: ${entry.e}` : ""}`;
    if (
      category === CATEGORIES.CRASH_DETECTED ||
      category === CATEGORIES.PROMISE_REJECTION ||
      category === CATEGORIES.ERROR_BOUNDARY
    ) {
      console.error(`🔴 ${logLine}`);
    } else {
      console.log(`📋 ${logLine}`);
    }

    // ★ Queue for async write (fire-and-forget)
    this._queue.push(entry);
    this._scheduleFlush();
  }

  /**
   * Debounced flush — batches writes to reduce AsyncStorage calls.
   */
  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, 500);
  }

  /**
   * Flush queued entries to AsyncStorage. Never throws.
   */
  async _flush() {
    if (this._flushing || this._queue.length === 0) return;
    this._flushing = true;

    // Grab current batch
    const batch = this._queue.splice(0);

    try {
      const existing = await AsyncStorage.getItem(STORAGE_KEY);
      let logs = [];
      try {
        logs = existing ? JSON.parse(existing) : [];
      } catch {
        logs = [];
      }

      logs.push(...batch);

      // ★ Circular buffer: trim to MAX_ENTRIES
      if (logs.length > MAX_ENTRIES) {
        logs = logs.slice(logs.length - MAX_ENTRIES);
      }

      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
    } catch {
      // ★ Fire-and-forget: if AsyncStorage fails, entries are lost
      // but we already logged to native console above
    } finally {
      this._flushing = false;
      // If more entries arrived during flush, schedule another
      if (this._queue.length > 0) {
        this._scheduleFlush();
      }
    }
  }

  /**
   * Force immediate flush (call before app exit if possible).
   */
  async flushNow() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    await this._flush();
  }

  /**
   * Get all stored crash logs.
   * @returns {Promise<Array>}
   */
  async getLogs() {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  /**
   * Get formatted crash log as string (for display/sharing).
   * @returns {Promise<string>}
   */
  async getFormattedLogs() {
    const logs = await this.getLogs();
    return logs
      .map((e) => `[${e.t}] [${e.c}] ${e.m}${e.e ? ` | ${e.e}` : ""}`)
      .join("\n");
  }

  /**
   * Clear all stored crash logs.
   */
  async clearLogs() {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      // Fire-and-forget
    }
  }

  /**
   * Log memory usage (if available).
   * React Native on Hermes exposes global.HermesInternal for memory info.
   */
  logMemoryUsage() {
    try {
      if (global.HermesInternal?.getRuntimeProperties) {
        const props = global.HermesInternal.getRuntimeProperties();
        const heapUsed = props["js_heapSize"] || 0;
        const heapLimit = props["js_heapSizeLimit"] || 0;
        const usageMB = (heapUsed / (1024 * 1024)).toFixed(1);
        const limitMB = (heapLimit / (1024 * 1024)).toFixed(1);
        const pct =
          heapLimit > 0 ? ((heapUsed / heapLimit) * 100).toFixed(0) : "?";

        this.log("LIFECYCLE", `Memory: ${usageMB}MB / ${limitMB}MB (${pct}%)`);

        // ★ Warn if memory usage > 70%
        if (heapLimit > 0 && heapUsed / heapLimit > 0.7) {
          this.log(
            CATEGORIES.MEMORY_WARNING,
            `High memory usage: ${usageMB}MB / ${limitMB}MB (${pct}%)`,
          );
        }
      }
    } catch {
      // Fire-and-forget
    }
  }
}

// Singleton
const crashLogger = new CrashLogger();
export { CATEGORIES };
export default crashLogger;
