/**
 * Matchmaking Service — World Video Chat.
 *
 * Atomic matchmaking via Redis Lua scripts.
 * Manages: queue, sessions, ephemeral tokens, rate limiting, blocklists.
 *
 * Architecture:
 *   - Redis Lua script guarantees atomic match (no race conditions across pods)
 *   - Blocklist skip keys prevent infinite retry loops
 *   - Ephemeral tokens hide real userIds from peers
 *   - Three-layer session timer: Redis TTL (authoritative) + Node setTimeout (best-effort) + client countdown (UX)
 *   - Rate limiting for world-next (1 per 3s per user)
 *
 * ★ This module is the single source of truth for matchmaking state.
 *   The signaling handler delegates all world-video state changes here.
 */

const fs = require("fs");
const path = require("path");
const redisBridge = require("../signaling/redis");
const presence = require("../signaling/presence");
const { db } = require("../db/supabase");
const guaranteedDelivery = require("./guaranteedDelivery");

// ─── Constants ──────────────────────────────────────────────────────────────────
const SESSION_DURATION_MS = 3 * 60 * 1000; // 3 minutes
const SESSION_TTL_S = 210; // 3.5 min (buffer beyond session)
const EPHEMERAL_TTL_S = 210; // Same as session
const SKIP_KEY_TTL_S = 60; // Blocklist skip key TTL
const NEXT_RATE_LIMIT_S = 3; // Min seconds between world-next
const MAX_QUEUE_RETRIES = 10; // Max match attempts per tick
const MATCH_RETRY_INTERVAL_MS = 500; // Delay between retry attempts

// ─── Lua Script ─────────────────────────────────────────────────────────────────
let MATCH_SCRIPT_SHA = null;
const MATCH_SCRIPT = fs.readFileSync(
  path.join(__dirname, "matchmaking.lua"),
  "utf8"
);

class MatchmakingService {
  constructor() {
    this._sessionTimers = new Map(); // sessionId -> setTimeout handle
    this._initialized = false;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  async init() {
    if (this._initialized) return;

    // Load Lua script into Redis
    if (redisBridge.isConnected) {
      MATCH_SCRIPT_SHA = await redisBridge.loadLuaScript(MATCH_SCRIPT);
      if (!MATCH_SCRIPT_SHA) {
        console.error("❌ Matchmaking: Failed to load Lua script into Redis");
      }
    }

    // Subscribe to keyspace notifications for session expiry
    if (redisBridge.isConnected) {
      await redisBridge.subscribeKeyspaceNotifications(
        "__keyevent@0__:expired",
        (event, key) => {
          if (key.startsWith("world:session:")) {
            const sessionId = key.replace("world:session:", "");
            this._handleSessionExpiry(sessionId);
          }
        }
      );
    }

    this._initialized = true;
    console.log("✅ Matchmaking service initialized");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // QUEUE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Add user to matchmaking queue and attempt to find a match.
   * @returns {object|null} Match result if found, null if queued
   */
  async joinQueue(userId) {
    if (!redisBridge.isConnected) {
      console.warn("⚠️  MATCHMAKING: Redis unavailable, using in-memory fallback. DO NOT use in production.");
      return this._joinQueueMemory(userId);
    }

    const joinStartMs = Date.now();

    // Check user isn't already in queue or matched
    const currentStatus = await redisBridge.pub.hget(
      `world:user:${userId}`,
      "status"
    );
    if (currentStatus === "queued" || currentStatus === "matched") {
      // Already in queue or matched — return current status
      const userData = await redisBridge.pub.hgetall(`world:user:${userId}`);
      if (currentStatus === "matched" && userData.sessionId) {
        console.log(`[MATCH_ALREADY] userId=${userId} sessionId=${userData.sessionId}`);
        return {
          alreadyMatched: true,
          sessionId: userData.sessionId,
          role: userData.role,
          ephemeralToken: userData.ephemeralToken,
          peerToken: userData.peerToken,
          expiresAt: parseInt(userData.expiresAt || "0", 10) * 1000,
        };
      }
      console.log(`[MATCH_QUEUED] userId=${userId} (already in queue)`);
      return { alreadyQueued: true };
    }

    // Set user status to queued
    await redisBridge.pub.hmset(`world:user:${userId}`, {
      status: "queued",
      queuedAt: Date.now().toString(),
      sessionId: "",
      matchedWith: "",
      role: "",
      ephemeralToken: "",
      peerToken: "",
    });

    // Set TTL on user state (auto-cleanup if disconnected)
    await redisBridge.pub.expire(`world:user:${userId}`, 600); // 10 min cleanup

    // Add to queue
    await redisBridge.pub.rpush("world:queue", userId);

    // ★ FIX (Bug 1): Loop tryMatch until either:
    //   (a) a match involving THIS user is found → return it
    //   (b) no more matches are possible → return null (user stays queued)
    // Previously, tryMatch() could return a match between OTHER users (e.g. A↔B)
    // when user C triggered the match, leaving C in limbo.
    let safetyCounter = 0;
    while (safetyCounter++ < 10) {
      const result = await this.tryMatch();
      if (!result) {
        // Queue exhausted or no valid match — user stays queued
        const queueLen = await redisBridge.pub.llen("world:queue");
        console.log(`[MATCH_QUEUED] userId=${userId} queuePosition≈${queueLen} latencyMs=${Date.now() - joinStartMs}`);
        return null;
      }

      if (result.user1 === userId || result.user2 === userId) {
        // This user is part of the match — return it
        console.log(`[MATCH_FOUND] userId=${userId} sessionId=${result.sessionId} latencyMs=${Date.now() - joinStartMs}`);
        return result;
      }

      // Match found but involves OTHER users — notify them and keep trying
      console.log(`[MATCH_RETRY] userId=${userId} attempt=${safetyCounter} reason=match_involved_others sessionId=${result.sessionId}`);
      await this._notifyMatchedUsers(result);
    }

    // Safety limit reached — user stays queued
    console.log(`[MATCH_QUEUED] userId=${userId} reason=safety_limit_reached latencyMs=${Date.now() - joinStartMs}`);
    return null;
  }

  /**
   * Remove user from matchmaking queue.
   */
  async leaveQueue(userId) {
    if (!redisBridge.isConnected) {
      return this._leaveQueueMemory(userId);
    }

    // Remove from queue
    await redisBridge.pub.lrem("world:queue", 1, userId);

    // Clear user state
    await redisBridge.pub.del(`world:user:${userId}`);

    console.log(`🔗 Matchmaking: ${userId} left the queue`);
  }

  /**
   * Leave World Video.
   * If the user is in an active session, this ends the session for BOTH peers.
   * If the user is only queued, this removes them from the queue.
   *
   * Back-compat: older clients may omit sessionIdHint.
   */
  async leaveWorldVideo(userId, { sessionIdHint } = {}) {
    let sessionId = null;

    if (sessionIdHint) {
      const hinted = await this.getSession(sessionIdHint);
      if (hinted && (hinted.user1 === userId || hinted.user2 === userId)) {
        sessionId = sessionIdHint;
      }
    }

    if (!sessionId) {
      sessionId = (await this.getUserSession(userId))?.sessionId || null;
    }

    if (sessionId) {
      await this.endSession(sessionId, "leave", userId);
      return;
    }

    await this.leaveQueue(userId);
  }

  /**
   * Attempt to match users from the queue.
   * Runs the Lua script atomically.
   * @returns {object|null} Match result or null
   */
  async tryMatch() {
    if (!redisBridge.isConnected) {
      return this._tryMatchMemory();
    }

    if (!MATCH_SCRIPT_SHA) {
      // Script not loaded — reload
      MATCH_SCRIPT_SHA = await redisBridge.loadLuaScript(MATCH_SCRIPT);
      if (!MATCH_SCRIPT_SHA) return null;
    }

    // Run the Lua match script
    const result = await redisBridge.evalLuaSha(
      MATCH_SCRIPT_SHA,
      MATCH_SCRIPT,
      ["world:queue"],
      [Math.floor(Date.now() / 1000).toString()]
    );

    if (!result) {
      // No match available (queue too small, stale users, or blocked)
      return null;
    }

    const [sessionId, user1, user2, token1, token2] = result;

    // Get session details
    const sessionData = await redisBridge.pub.hgetall(
      `world:session:${sessionId}`
    );

    // Start server-side session timer (best-effort, Redis TTL is authoritative)
    this._startSessionTimer(sessionId, parseInt(sessionData.expiresAt || "0", 10) * 1000);

    console.log(
      `🤝 Match created: session=${sessionId}, caller=${user1}, callee=${user2}`
    );

    return {
      sessionId: sessionId.toString(),
      user1,
      user2,
      token1,
      token2,
      expiresAt: parseInt(sessionData.expiresAt || "0", 10) * 1000 || Date.now() + SESSION_DURATION_MS,
    };
  }

  /**
   * Retry matching multiple times (for stochastic queue changes).
   * Called after a failed match attempt (stale user, blocked pair).
   */
  async tryMatchWithRetries() {
    for (let i = 0; i < MAX_QUEUE_RETRIES; i++) {
      const result = await this.tryMatch();
      if (result) return result;
      // Small delay between retries to allow queue changes
      await new Promise((r) => setTimeout(r, MATCH_RETRY_INTERVAL_MS));
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SESSION MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * End a session and optionally re-queue a user.
   * @param {string} sessionId
   * @param {string} reason - 'leave' | 'next' | 'timeout' | 'report' | 'disconnect' | 'moderation_flag'
   * @param {string|null} endedBy - userId that initiated the end (for 'leave'/'next'), else null
   */
  async endSession(sessionId, reason, endedBy = null) {
    if (!redisBridge.isConnected) {
      return this._endSessionMemory(sessionId, reason, endedBy);
    }

    const sessionKey = `world:session:${sessionId}`;
    const sessionData = await redisBridge.pub.hgetall(sessionKey);

    if (!sessionData || !sessionData.user1) {
      // Session already expired or doesn't exist
      return;
    }

    const { user1, user2 } = sessionData;
    if (endedBy && endedBy !== user1 && endedBy !== user2) {
      endedBy = null;
    }

    // Clear session state in Redis
    await redisBridge.pub.del(sessionKey);

    // Clear user states
    await redisBridge.pub.del(`world:user:${user1}`);
    await redisBridge.pub.del(`world:user:${user2}`);

    // Clear ephemeral tokens
    // (These may have already expired via TTL, but clean up explicitly)
    const token1 = sessionData.token1 || "";
    const token2 = sessionData.token2 || "";
    if (token1) await redisBridge.pub.del(`world:token:${token1}`);
    if (token2) await redisBridge.pub.del(`world:token:${token2}`);

    // Clear local session timer
    this._clearSessionTimer(sessionId);

    // Log session to database (non-blocking)
    const durationSeconds = sessionData.startedAt
      ? Math.floor((Date.now() - parseInt(sessionData.startedAt, 10) * 1000) / 1000)
      : 0;

    db.createWorldVideoSession({
      user1_id: user1,
      user2_id: user2,
      status: this._mapReasonToStatus(reason),
      duration_seconds: durationSeconds,
    }).catch((err) => console.error("Session log error:", err.message));

    const shouldRequeue = (targetUserId) => {
      if (reason === "next" || reason === "timeout") return true;
      if (reason === "leave") return !!endedBy && targetUserId !== endedBy;
      return false;
    };

    // Guaranteed delivery: session-end must not be missed (prevents "stuck in call" / long waits).
    await guaranteedDelivery.sendCriticalEvent(user1, "world-session-end", {
      sessionId,
      reason,
      endedBy,
      requeue: shouldRequeue(user1),
    });

    await guaranteedDelivery.sendCriticalEvent(user2, "world-session-end", {
      sessionId,
      reason,
      endedBy,
      requeue: shouldRequeue(user2),
    });

    console.log(
      `🔗 Session ended: ${sessionId} (${reason})${
        endedBy ? ` — endedBy ${endedBy}` : ""
      }`
    );
  }

  /**
   * Handle session expiry triggered by Redis keyspace notification.
   * This is the authoritative timer — fires even if the pod restarts.
   */
  async _handleSessionExpiry(sessionId) {
    console.log(`⏰ Session TTL expired: ${sessionId}`);
    await this.endSession(sessionId, "timeout");
  }

  /**
   * Start a best-effort session timer (Node.js setTimeout).
   * Not authoritative — Redis TTL is the real timer.
   * This just provides faster cleanup when the pod is alive.
   */
  _startSessionTimer(sessionId, expiresAt) {
    this._clearSessionTimer(sessionId);

    const delay = Math.max(expiresAt - Date.now(), 0);
    if (delay <= 0) return;

    const timer = setTimeout(() => {
      this.endSession(sessionId, "timeout").catch((err) =>
        console.error("Session timer error:", err.message)
      );
    }, delay);

    this._sessionTimers.set(sessionId, timer);
  }

  _clearSessionTimer(sessionId) {
    const timer = this._sessionTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this._sessionTimers.delete(sessionId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EPHEMERAL TOKEN RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Resolve an ephemeral token to a real userId.
   * Used for report processing and signaling routing.
   * Falls back to session lookup if token has expired.
   */
  async resolveToken(token) {
    if (!redisBridge.isConnected) {
      // ★ In-memory fallback
      return this._inMemoryTokenMap.get(token) || null;
    }

    // Try ephemeral token lookup first (fast)
    const userId = await redisBridge.pub.get(`world:token:${token}`);
    if (userId) return userId;

    // Token has expired — try session lookup
    // Extract sessionId from token format: "eph_{counter}_{sessionId}"
    const parts = token.split("_");
    if (parts.length >= 3) {
      const sessionId = parts.slice(2).join("_");
      const sessionData = await redisBridge.pub.hgetall(
        `world:session:${sessionId}`
      );
      // Try to find which user this token belongs to
      if (sessionData && sessionData.token1 === token) return sessionData.user1;
      if (sessionData && sessionData.token2 === token) return sessionData.user2;
    }

    return null;
  }

  /**
   * Get session info for a user.
   * ★ CRITICAL: Must work without Redis — the WebRTC signaling relay
   * handlers call this to validate session ownership before forwarding
   * offers/answers/ICE candidates. Without this fallback, all WebRTC
   * signaling is silently dropped in no-Redis (dev) mode.
   */
  async getUserSession(userId) {
    if (!redisBridge.isConnected) {
      // ★ In-memory fallback
      const data = this._inMemoryUsers.get(userId);
      if (!data || !data.sessionId) return null;
      return {
        status: data.status,
        sessionId: data.sessionId,
        matchedWith: data.matchedWith,
        role: data.role,
        ephemeralToken: data.ephemeralToken,
        peerToken: data.peerToken,
      };
    }

    const data = await redisBridge.pub.hgetall(`world:user:${userId}`);
    if (!data || !data.sessionId) return null;

    return {
      status: data.status,
      sessionId: data.sessionId,
      matchedWith: data.matchedWith,
      role: data.role,
      ephemeralToken: data.ephemeralToken,
      peerToken: data.peerToken,
    };
  }

  /**
   * Get session details by sessionId.
   * ★ CRITICAL: Must work without Redis — every WebRTC relay handler
   * (offer/answer/ICE/restart) calls this to find the peer user.
   * Without this fallback, relay returns null → silent signaling drop.
   */
  async getSession(sessionId) {
    if (!redisBridge.isConnected) {
      // ★ In-memory fallback
      const session = this._inMemorySessions.get(sessionId);
      if (!session) return null;
      return {
        user1: session.user1,
        user2: session.user2,
        token1: session.token1,
        token2: session.token2,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
        status: session.status,
      };
    }

    const data = await redisBridge.pub.hgetall(`world:session:${sessionId}`);
    if (!data || !data.user1) return null;

    return {
      user1: data.user1,
      user2: data.user2,
      startedAt: parseInt(data.startedAt || "0", 10) * 1000,
      expiresAt: parseInt(data.expiresAt || "0", 10) * 1000,
      status: data.status,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BLOCKLIST
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Block a user (mutual — prevents future matching in both directions).
   * Adds to both Redis (fast lookup) and Supabase (persistence).
   */
  async blockUser(userId, blockedUserId) {
    // Redis blocklist (for fast query during matching)
    if (redisBridge.isConnected) {
      await redisBridge.pub.sadd(`world:blocklist:${userId}`, blockedUserId);
      await redisBridge.pub.sadd(`world:blocklist:${blockedUserId}`, userId);
    }

    // Also add to in-memory blocklist
    this._addBlockMemory(userId, blockedUserId);

    // Persist to Supabase (non-blocking)
    db.createWorldVideoBlock(userId, blockedUserId).catch((err) =>
      console.error("Block persist error:", err.message)
    );
  }

  /**
   * Get blocklist for a user (loads from Redis, falls back to DB).
   */
  async getBlocklist(userId) {
    if (redisBridge.isConnected) {
      const members = await redisBridge.pub.smembers(
        `world:blocklist:${userId}`
      );
      if (members && members.length > 0) return members;
    }

    // Fallback: load from DB and populate Redis
    try {
      const blocks = await db.getWorldVideoBlockList(userId);
      const blockedIds = blocks.map((b) => b.blocked_user_id);
      if (redisBridge.isConnected && blockedIds.length > 0) {
        await redisBridge.pub.sadd(
          `world:blocklist:${userId}`,
          ...blockedIds
        );
      }
      return blockedIds;
    } catch (err) {
      console.error("Blocklist load error:", err.message);
      return [];
    }
  }

  /**
   * Unblock a user (soft-delete in DB, remove from Redis).
   */
  async unblockUser(userId, blockedUserId) {
    if (redisBridge.isConnected) {
      await redisBridge.pub.srem(
        `world:blocklist:${userId}`,
        blockedUserId
      );
    }

    this._removeBlockMemory(userId, blockedUserId);

    // Soft-delete in DB (preserves audit trail)
    db.deleteWorldVideoBlock(userId, blockedUserId).catch((err) =>
      console.error("Unblock error:", err.message)
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RATE LIMITING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Check if a user can perform world-next (rate limited).
   * @returns {{ allowed: boolean, retryAfter: number }}
   */
  async checkNextRateLimit(userId) {
    if (!redisBridge.isConnected) return { allowed: true, retryAfter: 0 };

    const key = `world:nextlimit:${userId}`;
    const ttl = await redisBridge.pub.ttl(key);
    if (ttl > 0) {
      return { allowed: false, retryAfter: ttl };
    }
    return { allowed: true, retryAfter: 0 };
  }

  /**
   * Set the rate limit for world-next.
   */
  async setNextRateLimit(userId) {
    if (!redisBridge.isConnected) return;
    await redisBridge.pub.setex(
      `world:nextlimit:${userId}`,
      NEXT_RATE_LIMIT_S,
      "1"
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // QUEUE STATS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get queue statistics for display.
   */
  async getQueueStats() {
    if (!redisBridge.isConnected) {
      return { queueSize: 0, activeSessions: 0 };
    }

    const queueSize = await redisBridge.pub.llen("world:queue");
    const sessionKeys = await redisBridge.pub.keys("world:session:*");
    return {
      queueSize,
      activeSessions: sessionKeys.length,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // NOTIFICATION HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Notify both matched users about the new session.
   */
  async _notifyMatchedUsers(matchResult) {
    const { sessionId, user1, user2, token1, token2, expiresAt } = matchResult;

    // World video is anonymous by default: never reveal real name/avatar here.
    // We still provide a stable-ish label derived from the peer token so the UI
    // can show a name-like string without exposing identity.
    const toAnonymousPeerProfile = () => ({
      displayName: "Anonymous",
      isPrivate: true,
      avatarUrl: null,
      avatarSeed: null,
    });

    // Notify user1 (caller)
    await presence.sendToUser(user1, {
      type: "world-matched",
      sessionId,
      peerToken: token2, // User1 sees user2's token
      role: "caller",
      expiresAt: expiresAt || Date.now() + SESSION_DURATION_MS,
      peerProfile: toAnonymousPeerProfile(),
    });

    // Notify user2 (callee)
    await presence.sendToUser(user2, {
      type: "world-matched",
      sessionId,
      peerToken: token1, // User2 sees user1's token
      role: "callee",
      expiresAt: expiresAt || Date.now() + SESSION_DURATION_MS,
      peerProfile: toAnonymousPeerProfile(),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DISCONNECT HANDLER
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Clean up when a user disconnects from WebSocket.
   * Ends any active session and removes from queue.
   */
  async handleDisconnect(userId) {
    const userData = await this.getUserSession(userId);

    if (userData && userData.sessionId) {
      // User was in an active session — end it
      await this.endSession(
        userData.sessionId,
        "disconnect",
        null // Don't re-queue disconnected user
      );
    } else if (userData && userData.status === "queued") {
      // User was in queue — remove them
      await this.leaveQueue(userId);
    } else {
      // Clean up user state anyway
      if (redisBridge.isConnected) {
        await redisBridge.pub.del(`world:user:${userId}`);
        await redisBridge.pub.lrem("world:queue", 1, userId);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // IN-MEMORY FALLBACKS (dev mode without Redis)
  // ═══════════════════════════════════════════════════════════════════════

  _inMemoryQueue = [];
  _inMemoryUsers = new Map(); // userId -> { status, sessionId, matchedWith, role, ... }
  _inMemorySessions = new Map(); // sessionId -> { user1, user2, startedAt, expiresAt }
  _inMemoryBlocklist = new Map(); // userId -> Set<blockedUserId>
  _inMemoryTokenMap = new Map(); // token -> userId
  _sessionCounter = 0;

  _joinQueueMemory(userId) {
    if (this._inMemoryUsers.has(userId)) {
      const existing = this._inMemoryUsers.get(userId);
      if (existing.status === "matched") {
        return { alreadyMatched: true, ...existing };
      }
      return { alreadyQueued: true };
    }

    this._inMemoryUsers.set(userId, {
      status: "queued",
      queuedAt: Date.now(),
    });
    this._inMemoryQueue.push(userId);

    // ★ FIX (Bug 1): Loop until we find a match involving THIS user,
    // or the queue is exhausted. Matches involving other users are
    // dispatched immediately via _notifyMatchedUsers.
    let safetyCounter = 0;
    while (safetyCounter++ < 10) {
      const result = this._tryMatchMemoryOnce();
      if (!result) break; // Queue exhausted

      if (result.user1 === userId || result.user2 === userId) {
        console.log(`[MATCH_FOUND] userId=${userId} sessionId=${result.sessionId} (in-memory)`);
        return result; // This user is matched
      }

      // Match involves other users — notify them, keep trying for us
      console.log(`[MATCH_RETRY] userId=${userId} attempt=${safetyCounter} reason=match_involved_others (in-memory)`);
      this._notifyMatchedUsers(result);
    }

    console.log(`[MATCH_QUEUED] userId=${userId} queueSize=${this._inMemoryQueue.length} (in-memory)`);
    return null;
  }

  _leaveQueueMemory(userId) {
    this._inMemoryQueue = this._inMemoryQueue.filter((id) => id !== userId);
    this._inMemoryUsers.delete(userId);
  }

  /**
   * ★ Extracted single-match attempt for use in the loop.
   * Returns one match result or null if queue has <2 valid users.
   */
  _tryMatchMemoryOnce() {
    // Try up to queue length times (to skip stale/blocked pairs)
    let attempts = 0;
    const maxAttempts = this._inMemoryQueue.length;

    while (this._inMemoryQueue.length >= 2 && attempts++ < maxAttempts) {
      const user1 = this._inMemoryQueue.shift();
      const user2 = this._inMemoryQueue.shift();

      // Skip if either is no longer queued
      const state1 = this._inMemoryUsers.get(user1);
      const state2 = this._inMemoryUsers.get(user2);
      if (!state1 || state1.status !== "queued") {
        // user1 stale, put user2 back
        if (state2 && state2.status === "queued") this._inMemoryQueue.unshift(user2);
        continue;
      }
      if (!state2 || state2.status !== "queued") {
        // user2 stale, put user1 back
        this._inMemoryQueue.unshift(user1);
        continue;
      }

      // Check blocklist
      const blocked1 =
        this._inMemoryBlocklist.get(user1)?.has(user2) || false;
      const blocked2 =
        this._inMemoryBlocklist.get(user2)?.has(user1) || false;
      if (blocked1 || blocked2) {
        // Put both back (user1 at end to try different combinations)
        this._inMemoryQueue.push(user1);
        this._inMemoryQueue.unshift(user2);
        continue;
      }

      // Create session
      this._sessionCounter++;
      const sessionId = this._sessionCounter.toString();
      const token1 = `eph_${sessionId}_1`;
      const token2 = `eph_${sessionId}_2`;
      const expiresAt = Date.now() + SESSION_DURATION_MS;

      this._inMemorySessions.set(sessionId, {
        user1,
        user2,
        token1,
        token2,
        startedAt: Date.now(),
        expiresAt,
        status: "matched",
      });

      this._inMemoryUsers.set(user1, {
        status: "matched",
        sessionId,
        matchedWith: user2,
        role: "caller",
        ephemeralToken: token1,
        peerToken: token2,
        expiresAt,
      });

      this._inMemoryUsers.set(user2, {
        status: "matched",
        sessionId,
        matchedWith: user1,
        role: "callee",
        ephemeralToken: token2,
        peerToken: token1,
        expiresAt,
      });

      this._inMemoryTokenMap.set(token1, user1);
      this._inMemoryTokenMap.set(token2, user2);

      // Start local timer
      this._startSessionTimer(sessionId, expiresAt);

      return {
        sessionId,
        user1,
        user2,
        token1,
        token2,
        expiresAt,
      };
    }

    return null;
  }

  /**
   * Legacy wrapper — calls _tryMatchMemoryOnce for backward compat.
   */
  _tryMatchMemory() {
    return this._tryMatchMemoryOnce();
  }

  _endSessionMemory(sessionId, reason, endedBy) {
    const session = this._inMemorySessions.get(sessionId);
    if (!session) return;

    if (endedBy && endedBy !== session.user1 && endedBy !== session.user2) {
      endedBy = null;
    }

    this._inMemorySessions.delete(sessionId);
    this._inMemoryUsers.delete(session.user1);
    this._inMemoryUsers.delete(session.user2);
    this._inMemoryTokenMap.delete(session.token1);
    this._inMemoryTokenMap.delete(session.token2);
    this._clearSessionTimer(sessionId);

    const shouldRequeue = (targetUserId) => {
      if (reason === "next" || reason === "timeout") return true;
      if (reason === "leave") return !!endedBy && targetUserId !== endedBy;
      return false;
    };

    presence.sendToUser(session.user1, {
      type: "world-session-end",
      sessionId,
      reason,
      endedBy,
      requeue: shouldRequeue(session.user1),
    });
    presence.sendToUser(session.user2, {
      type: "world-session-end",
      sessionId,
      reason,
      endedBy,
      requeue: shouldRequeue(session.user2),
    });

    // Log session
    db.createWorldVideoSession({
      user1_id: session.user1,
      user2_id: session.user2,
      status: this._mapReasonToStatus(reason),
      duration_seconds: Math.floor(
        (Date.now() - session.startedAt) / 1000
      ),
    }).catch(() => {});

    // Client is responsible for re-joining queue based on {requeue:true}.
  }

  _addBlockMemory(userId, blockedUserId) {
    if (!this._inMemoryBlocklist.has(userId)) {
      this._inMemoryBlocklist.set(userId, new Set());
    }
    this._inMemoryBlocklist.get(userId).add(blockedUserId);

    // Mutual
    if (!this._inMemoryBlocklist.has(blockedUserId)) {
      this._inMemoryBlocklist.set(blockedUserId, new Set());
    }
    this._inMemoryBlocklist.get(blockedUserId).add(userId);
  }

  _removeBlockMemory(userId, blockedUserId) {
    this._inMemoryBlocklist.get(userId)?.delete(blockedUserId);
    this._inMemoryBlocklist.get(blockedUserId)?.delete(userId);
  }

  _mapReasonToStatus(reason) {
    const mapping = {
      timeout: "timed_out",
      leave: "left",
      next: "skipped",
      report: "reported",
      disconnect: "disconnected",
      moderation_flag: "moderation_flag",
    };
    return mapping[reason] || "completed";
  }
}

// Singleton
const matchmaking = new MatchmakingService();

module.exports = matchmaking;
