/**
 * Redis Pub/Sub Bridge for Horizontal Signaling.
 * Enables multiple signaling server pods to route messages
 * to users connected on different instances.
 *
 * Architecture:
 *   User A → Pod 1 → Redis Pub/Sub → Pod 3 → User B
 *
 * Falls back to in-memory if Redis is unavailable (dev mode).
 *
 * ★ Production Fixes:
 *   - Tracked listener map — no more EventEmitter leak on subscribe/unsubscribe
 *   - In-memory presence fallback — getPresence/getOnlineUsers work without Redis
 *   - Proper cleanup on unsubscribe
 */
const Redis = require("ioredis");
const config = require("../config");
const EventEmitter = require("events");

class RedisBridge extends EventEmitter {
  constructor() {
    super();
    this.pub = null;
    this.sub = null;
    this.isConnected = false;
    this.podId = `pod-${process.pid}-${Date.now()}`;

    // In-memory fallback for dev without Redis
    this.localEmitter = new EventEmitter();
    this.localEmitter.setMaxListeners(10000);

    // ★ Tracked listeners per channel — prevents EventEmitter leak
    this._channelListeners = new Map(); // channel -> bound handler fn

    // ★ In-memory presence store — fallback when Redis unavailable
    this._localPresence = new Map(); // userId -> { status, connectedAt, podId }
  }

  async connect() {
    // Skip Redis entirely if URL is empty or explicitly disabled
    if (!config.redis.url) {
      console.log("ℹ️  Redis URL not set — using in-memory signaling");
      this.isConnected = false;
      return;
    }

    try {
      const redisOpts = {
        retryStrategy: () => null, // Don't retry — fail fast, fallback to in-memory
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        connectTimeout: 3000,
        enableOfflineQueue: false,
      };

      this.pub = new Redis(config.redis.url, redisOpts);
      this.sub = new Redis(config.redis.url, redisOpts);

      // Suppress error events so they don't crash the process
      this.pub.on("error", () => {});
      this.sub.on("error", () => {});

      await Promise.all([this.pub.connect(), this.sub.connect()]);

      this.sub.on("message", (channel, message) => {
        try {
          const parsed = JSON.parse(message);
          // Don't echo messages from this pod
          if (parsed._podId !== this.podId) {
            this.emit("message", channel, parsed);
          }
        } catch (err) {
          console.error("Redis message parse error:", err);
        }
      });

      this.isConnected = true;
      console.log(`✅ Redis connected [${this.podId}]`);
    } catch (err) {
      console.warn(
        `⚠️  Redis connection failed — using in-memory fallback: ${err.message}`,
      );
      this.isConnected = false;

      // Fully disconnect to stop any retry attempts
      try {
        if (this.pub) this.pub.disconnect();
      } catch {}
      try {
        if (this.sub) this.sub.disconnect();
      } catch {}
      this.pub = null;
      this.sub = null;
    }
  }

  /**
   * Subscribe to messages for a specific user ID.
   * ★ FIX: Uses tracked listener map — unsubscribe properly removes the handler.
   */
  async subscribe(userId, callback) {
    const channel = `signaling:${userId}`;

    // ★ Remove existing listener for this channel first (prevents duplication)
    this._removeChannelListener(channel);

    if (this.isConnected) {
      await this.sub.subscribe(channel);

      // ★ Create a bound handler we can track and remove later
      const handler = (ch, data) => {
        if (ch === channel) callback(data);
      };
      this._channelListeners.set(channel, handler);
      this.on("message", handler);
    } else {
      // Local fallback — also track for cleanup
      this.localEmitter.removeAllListeners(channel);
      this.localEmitter.on(channel, callback);
      this._channelListeners.set(channel, callback);
    }
  }

  /**
   * Unsubscribe from user's channel.
   * ★ FIX: Properly removes tracked EventEmitter listener.
   */
  async unsubscribe(userId) {
    const channel = `signaling:${userId}`;

    if (this.isConnected) {
      try {
        await this.sub.unsubscribe(channel);
      } catch {}
    }

    // ★ Clean up tracked listener
    this._removeChannelListener(channel);
    this.localEmitter.removeAllListeners(channel);
  }

  /**
   * ★ Remove a tracked channel listener from the EventEmitter.
   */
  _removeChannelListener(channel) {
    const handler = this._channelListeners.get(channel);
    if (handler) {
      this.removeListener("message", handler);
      this._channelListeners.delete(channel);
    }
  }

  /**
   * Publish a signaling message to a user (potentially on another pod).
   */
  async publish(userId, message) {
    const channel = `signaling:${userId}`;
    const payload = { ...message, _podId: this.podId };

    if (this.isConnected) {
      await this.pub.publish(channel, JSON.stringify(payload));
    } else {
      // Local fallback
      this.localEmitter.emit(channel, payload);
    }
  }

  /**
   * Store presence data in Redis.
   * ★ FIX: Also stores in local memory as fallback.
   */
  async setPresence(userId, data) {
    // ★ Always update local presence map (works as fallback + fast lookup)
    this._localPresence.set(userId, {
      podId: this.podId,
      status: data.status || "online",
      connectedAt: data.connectedAt || Date.now().toString(),
    });

    if (this.isConnected) {
      const key = `presence:${userId}`;
      await this.pub.hmset(key, {
        podId: this.podId,
        status: data.status || "online",
        connectedAt: data.connectedAt || Date.now().toString(),
      });
      await this.pub.expire(key, 90); // ★ 90s TTL (3.6× safety margin over 25s heartbeat)
    }
  }

  /**
   * Get user's presence data.
   * ★ FIX: Falls back to local presence map when Redis unavailable.
   */
  async getPresence(userId) {
    if (this.isConnected) {
      const data = await this.pub.hgetall(`presence:${userId}`);
      return Object.keys(data).length > 0 ? data : null;
    }

    // ★ In-memory fallback — check local presence store
    const local = this._localPresence.get(userId);
    return local || null;
  }

  /**
   * Remove presence (disconnect).
   * ★ FIX: Also removes from local presence map.
   */
  async removePresence(userId) {
    this._localPresence.delete(userId);

    if (this.isConnected) {
      await this.pub.del(`presence:${userId}`);
    }
  }

  /**
   * Refresh presence TTL (heartbeat).
   * ★ FIX: Also refreshes local presence timestamp.
   */
  async refreshPresence(userId) {
    // ★ Touch local presence to keep it fresh
    const local = this._localPresence.get(userId);
    if (local) {
      local.lastHeartbeat = Date.now();
    }

    if (this.isConnected) {
      await this.pub.expire(`presence:${userId}`, 90); // ★ 90s TTL
    }
  }

  /**
   * Get all online user IDs (for presence list).
   * ★ FIX: Returns local presence map keys when Redis unavailable.
   */
  async getOnlineUsers() {
    if (this.isConnected) {
      const keys = await this.pub.keys("presence:*");
      return keys.map((k) => k.replace("presence:", ""));
    }

    // ★ In-memory fallback — return locally tracked users
    return Array.from(this._localPresence.keys());
  }

  async disconnect() {
    if (this.pub) this.pub.disconnect();
    if (this.sub) this.sub.disconnect();
    this.isConnected = false;
  }
}

// Singleton
const redisBridge = new RedisBridge();

module.exports = redisBridge;
