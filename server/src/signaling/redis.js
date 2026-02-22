/**
 * Redis Pub/Sub Bridge for Horizontal Signaling.
 * Enables multiple signaling server pods to route messages
 * to users connected on different instances.
 *
 * Architecture:
 *   User A → Pod 1 → Redis Pub/Sub → Pod 3 → User B
 *
 * Falls back to in-memory if Redis is unavailable (dev mode).
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
   */
  async subscribe(userId, callback) {
    const channel = `signaling:${userId}`;

    if (this.isConnected) {
      await this.sub.subscribe(channel);
      this.on("message", (ch, data) => {
        if (ch === channel) callback(data);
      });
    } else {
      // Local fallback
      this.localEmitter.on(channel, callback);
    }
  }

  /**
   * Unsubscribe from user's channel.
   */
  async unsubscribe(userId) {
    const channel = `signaling:${userId}`;

    if (this.isConnected) {
      await this.sub.unsubscribe(channel);
    }
    this.localEmitter.removeAllListeners(channel);
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
   */
  async setPresence(userId, data) {
    if (this.isConnected) {
      const key = `presence:${userId}`;
      await this.pub.hmset(key, {
        podId: this.podId,
        status: data.status || "online",
        connectedAt: data.connectedAt || Date.now().toString(),
      });
      await this.pub.expire(key, 60); // 60s TTL, refreshed by heartbeat
    }
  }

  /**
   * Get user's presence data.
   */
  async getPresence(userId) {
    if (this.isConnected) {
      const data = await this.pub.hgetall(`presence:${userId}`);
      return Object.keys(data).length > 0 ? data : null;
    }
    return null;
  }

  /**
   * Remove presence (disconnect).
   */
  async removePresence(userId) {
    if (this.isConnected) {
      await this.pub.del(`presence:${userId}`);
    }
  }

  /**
   * Refresh presence TTL (heartbeat).
   */
  async refreshPresence(userId) {
    if (this.isConnected) {
      await this.pub.expire(`presence:${userId}`, 60);
    }
  }

  /**
   * Get all online user IDs (for presence list).
   */
  async getOnlineUsers() {
    if (this.isConnected) {
      const keys = await this.pub.keys("presence:*");
      return keys.map((k) => k.replace("presence:", ""));
    }
    return [];
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
