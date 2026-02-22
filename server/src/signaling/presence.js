/**
 * Distributed Presence System.
 * Tracks online/offline status across multiple signaling pods.
 * Uses Redis for cross-pod presence and local Map for this pod's connections.
 */
const redisBridge = require("./redis");

class PresenceManager {
  constructor() {
    // Local connections on this pod: userId -> WebSocket
    this.localConnections = new Map();
    // Presence listeners (for broadcasting online/offline events)
    this.listeners = new Set();
  }

  /**
   * Register a user as online on this pod.
   */
  async userConnected(userId, ws) {
    // Disconnect existing connection for this user (if any)
    const existingWs = this.localConnections.get(userId);
    if (existingWs && existingWs !== ws && existingWs.readyState === 1) {
      existingWs.close(4001, "Connected from another device");
    }

    this.localConnections.set(userId, ws);

    // Set presence in Redis
    await redisBridge.setPresence(userId, {
      status: "online",
      connectedAt: Date.now().toString(),
    });

    // Subscribe to messages for this user
    await redisBridge.subscribe(userId, (message) => {
      this.deliverToLocal(userId, message);
    });

    // Broadcast online status
    this.broadcastPresence(userId, "online");
  }

  /**
   * Handle user disconnect.
   */
  async userDisconnected(userId) {
    this.localConnections.delete(userId);

    await redisBridge.removePresence(userId);
    await redisBridge.unsubscribe(userId);

    // Broadcast offline status
    this.broadcastPresence(userId, "offline");
  }

  /**
   * Refresh heartbeat for a user.
   */
  async heartbeat(userId) {
    await redisBridge.refreshPresence(userId);
  }

  /**
   * Send a message to a user (may be on this pod or another).
   */
  async sendToUser(userId, message) {
    // Try local first (same pod)
    const localWs = this.localConnections.get(userId);
    if (localWs && localWs.readyState === 1) {
      localWs.send(JSON.stringify(message));
      return true;
    }

    // Route through Redis to other pods
    await redisBridge.publish(userId, message);
    return true;
  }

  /**
   * Deliver a message from Redis to a local WebSocket.
   */
  deliverToLocal(userId, message) {
    const ws = this.localConnections.get(userId);
    if (ws && ws.readyState === 1) {
      // Strip internal fields before sending to client
      const { _podId, ...clean } = message;
      ws.send(JSON.stringify(clean));
    }
  }

  /**
   * Check if a user is online (any pod).
   */
  async isOnline(userId) {
    // Check local first
    if (this.localConnections.has(userId)) return true;

    // Check Redis
    const presence = await redisBridge.getPresence(userId);
    return presence !== null;
  }

  /**
   * Get all online user IDs.
   */
  async getOnlineUserIds() {
    const redisOnline = await redisBridge.getOnlineUsers();
    const localOnline = Array.from(this.localConnections.keys());

    return [...new Set([...redisOnline, ...localOnline])];
  }

  /**
   * Get WebSocket for a locally connected user.
   */
  getLocalConnection(userId) {
    return this.localConnections.get(userId) || null;
  }

  /**
   * Broadcast presence change to all local connections.
   */
  broadcastPresence(userId, status) {
    const message = JSON.stringify({
      type: "presence",
      userId,
      status,
      timestamp: Date.now(),
    });

    this.localConnections.forEach((ws, connectedUserId) => {
      if (connectedUserId !== userId && ws.readyState === 1) {
        ws.send(message);
      }
    });
  }

  /**
   * Get count of local connections (for metrics).
   */
  getLocalConnectionCount() {
    return this.localConnections.size;
  }
}

// Singleton
const presenceManager = new PresenceManager();

module.exports = presenceManager;
