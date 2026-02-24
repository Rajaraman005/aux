/**
 * Supabase client initialization.
 * Uses service-role key for backend (bypasses RLS).
 * In dev mode without Supabase config, falls back to in-memory store.
 */
const { createClient } = require("@supabase/supabase-js");
const config = require("../config");

let supabase = null;

if (config.supabase.url && config.supabase.serviceRoleKey) {
  supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: "public" },
  });
  console.log("✅ Supabase client initialized");
} else {
  console.warn(
    "⚠️  Supabase not configured — using in-memory fallback (dev only)",
  );
}

// ─── In-Memory Fallback Store (Dev Only) ─────────────────────────────────────
const memoryStore = {
  users: [],
  verification_codes: [],
  refresh_tokens: [],
  call_logs: [],
  abuse_log: [],
  conversations: [],
  conversation_participants: [],
  messages: [],
  world_messages: [],
  push_tokens: [],
  friend_requests: [],
  notifications: [],
  user_devices: [],
  notification_preferences: [],
};

/**
 * Database abstraction layer.
 * Provides consistent API whether using Supabase or in-memory.
 */
const db = {
  // ─── Users ──────────────────────────────────────────────────────────────────
  async createUser({ id, name, email, phone, password_hash, avatar_seed }) {
    if (supabase) {
      const { data, error } = await supabase
        .from("users")
        .insert({ id, name, email, phone, password_hash, avatar_seed })
        .select()
        .single();
      if (error) throw error;
      return data;
    }
    const user = {
      id,
      name,
      email,
      phone,
      password_hash,
      avatar_seed,
      email_verified: false,
      is_private: false,
      secret_name: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    memoryStore.users.push(user);
    return user;
  },

  async getUserByEmail(email) {
    if (supabase) {
      const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("email", email.toLowerCase())
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return data;
    }
    return (
      memoryStore.users.find((u) => u.email === email.toLowerCase()) || null
    );
  },

  async getUserById(id) {
    if (supabase) {
      const { data, error } = await supabase
        .from("users")
        .select(
          "id, name, email, phone, bio, avatar_seed, avatar_url, email_verified, is_private, secret_name, created_at",
        )
        .eq("id", id)
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return data;
    }
    const user = memoryStore.users.find((u) => u.id === id);
    if (!user) return null;
    const { password_hash, ...safe } = user;
    return safe;
  },

  async verifyUserEmail(userId) {
    if (supabase) {
      const { error } = await supabase
        .from("users")
        .update({ email_verified: true, updated_at: new Date().toISOString() })
        .eq("id", userId);
      if (error) throw error;
      return;
    }
    const user = memoryStore.users.find((u) => u.id === userId);
    if (user) {
      user.email_verified = true;
      user.updated_at = new Date().toISOString();
    }
  },

  async searchUsers(query, limit = 20, offset = 0) {
    if (supabase) {
      // First, try exact secret_name match (for private users)
      const { data: secretMatch } = await supabase
        .from("users")
        .select(
          "id, name, email, bio, avatar_seed, email_verified, is_private, secret_name, created_at",
        )
        .eq("email_verified", true)
        .eq("secret_name", query)
        .limit(1);

      // Then search public users by name/email (excluding private users)
      const { data, error } = await supabase
        .from("users")
        .select(
          "id, name, email, bio, avatar_seed, email_verified, is_private, secret_name, created_at",
        )
        .eq("email_verified", true)
        .or("is_private.is.null,is_private.eq.false")
        .or(`name.ilike.%${query}%,email.ilike.%${query}%`)
        .range(offset, offset + limit - 1)
        .order("name");
      if (error) throw error;

      // Merge: secret_name matches + public matches (deduplicate)
      const results = [...(secretMatch || [])];
      const ids = new Set(results.map((u) => u.id));
      for (const u of data || []) {
        if (!ids.has(u.id)) results.push(u);
      }
      return results;
    }
    const q = query.toLowerCase();
    return memoryStore.users
      .filter(
        (u) =>
          u.email_verified &&
          // Exact secret_name match (private users)
          ((u.secret_name && u.secret_name === query) ||
            // Public user name/email match
            (!u.is_private &&
              (u.name.toLowerCase().includes(q) ||
                u.email.toLowerCase().includes(q)))),
      )
      .slice(offset, offset + limit)
      .map(({ password_hash, ...safe }) => safe);
  },

  async listVerifiedUsers(limit = 20, offset = 0) {
    if (supabase) {
      const { data, error } = await supabase
        .from("users")
        .select(
          "id, name, email, bio, avatar_seed, avatar_url, is_private, created_at",
        )
        .eq("email_verified", true)
        .or("is_private.is.null,is_private.eq.false")
        .range(offset, offset + limit - 1)
        .order("name");
      if (error) throw error;
      return data || [];
    }
    return memoryStore.users
      .filter((u) => u.email_verified && !u.is_private)
      .slice(offset, offset + limit)
      .map(({ password_hash, ...safe }) => safe);
  },

  // ─── Verification Codes ────────────────────────────────────────────────────
  async createVerificationCode({ id, user_id, code, expires_at }) {
    if (supabase) {
      const { error } = await supabase
        .from("verification_codes")
        .insert({ id, user_id, code, expires_at });
      if (error) throw error;
      return;
    }
    memoryStore.verification_codes.push({
      id,
      user_id,
      code,
      expires_at,
      used: false,
    });
  },

  async getVerificationCode(userId, code) {
    if (supabase) {
      const { data, error } = await supabase
        .from("verification_codes")
        .select("*")
        .eq("user_id", userId)
        .eq("code", code)
        .eq("used", false)
        .gte("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return data;
    }
    return (
      memoryStore.verification_codes.find(
        (vc) =>
          vc.user_id === userId &&
          vc.code === code &&
          !vc.used &&
          new Date(vc.expires_at) > new Date(),
      ) || null
    );
  },

  async markVerificationCodeUsed(id) {
    if (supabase) {
      const { error } = await supabase
        .from("verification_codes")
        .update({ used: true })
        .eq("id", id);
      if (error) throw error;
      return;
    }
    const code = memoryStore.verification_codes.find((c) => c.id === id);
    if (code) code.used = true;
  },

  // ─── Refresh Tokens ────────────────────────────────────────────────────────
  async storeRefreshToken({
    id,
    user_id,
    token_hash,
    device_id,
    ip_address,
    expires_at,
  }) {
    if (supabase) {
      const { error } = await supabase
        .from("refresh_tokens")
        .insert({ id, user_id, token_hash, device_id, ip_address, expires_at });
      if (error) throw error;
      return;
    }
    memoryStore.refresh_tokens.push({
      id,
      user_id,
      token_hash,
      device_id,
      ip_address,
      expires_at,
      created_at: new Date().toISOString(),
    });
  },

  async getRefreshToken(tokenHash) {
    if (supabase) {
      const { data, error } = await supabase
        .from("refresh_tokens")
        .select("*")
        .eq("token_hash", tokenHash)
        .gte("expires_at", new Date().toISOString())
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return data;
    }
    return (
      memoryStore.refresh_tokens.find(
        (rt) =>
          rt.token_hash === tokenHash && new Date(rt.expires_at) > new Date(),
      ) || null
    );
  },

  async deleteRefreshToken(tokenHash) {
    if (supabase) {
      const { error } = await supabase
        .from("refresh_tokens")
        .delete()
        .eq("token_hash", tokenHash);
      if (error) throw error;
      return;
    }
    memoryStore.refresh_tokens = memoryStore.refresh_tokens.filter(
      (rt) => rt.token_hash !== tokenHash,
    );
  },

  async deleteAllUserRefreshTokens(userId, deviceId) {
    if (supabase) {
      let query = supabase
        .from("refresh_tokens")
        .delete()
        .eq("user_id", userId);
      if (deviceId) query = query.eq("device_id", deviceId);
      const { error } = await query;
      if (error) throw error;
      return;
    }
    memoryStore.refresh_tokens = memoryStore.refresh_tokens.filter(
      (rt) =>
        !(rt.user_id === userId && (!deviceId || rt.device_id === deviceId)),
    );
  },

  // ─── Call Logs ──────────────────────────────────────────────────────────────
  async createCallLog(log) {
    if (supabase) {
      const { data, error } = await supabase
        .from("call_logs")
        .insert(log)
        .select()
        .single();
      if (error) throw error;
      return data;
    }
    memoryStore.call_logs.push({
      ...log,
      created_at: new Date().toISOString(),
    });
    return log;
  },

  async updateCallLog(id, updates) {
    if (supabase) {
      const { error } = await supabase
        .from("call_logs")
        .update(updates)
        .eq("id", id);
      if (error) throw error;
      return;
    }
    const log = memoryStore.call_logs.find((l) => l.id === id);
    if (log) Object.assign(log, updates);
  },

  // ─── Abuse Log ──────────────────────────────────────────────────────────────
  async logAbuse({ ip_address, user_id, action }) {
    const entry = {
      id: require("uuid").v4(),
      ip_address,
      user_id,
      action,
      created_at: new Date().toISOString(),
    };
    if (supabase) {
      await supabase.from("abuse_log").insert(entry);
    } else {
      memoryStore.abuse_log.push(entry);
    }
  },

  async getRecentAbuseCount(ipAddress, action, windowMs) {
    const since = new Date(Date.now() - windowMs).toISOString();
    if (supabase) {
      const { count, error } = await supabase
        .from("abuse_log")
        .select("*", { count: "exact", head: true })
        .eq("ip_address", ipAddress)
        .eq("action", action)
        .gte("created_at", since);
      if (error) throw error;
      return count || 0;
    }
    return memoryStore.abuse_log.filter(
      (a) =>
        a.ip_address === ipAddress &&
        a.action === action &&
        a.created_at >= since,
    ).length;
  },

  // ─── Conversations ──────────────────────────────────────────────────────────
  async createConversation(participantIds) {
    const { v4: uuidv4 } = require("uuid");
    const convId = uuidv4();

    if (supabase) {
      const { data: conv, error: convErr } = await supabase
        .from("conversations")
        .insert({ id: convId })
        .select()
        .single();
      if (convErr) throw convErr;

      const participants = participantIds.map((uid) => ({
        conversation_id: convId,
        user_id: uid,
      }));
      const { error: partErr } = await supabase
        .from("conversation_participants")
        .insert(participants);
      if (partErr) throw partErr;

      return { id: convId, created_at: conv.created_at };
    }

    const conv = {
      id: convId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    memoryStore.conversations.push(conv);
    for (const uid of participantIds) {
      memoryStore.conversation_participants.push({
        id: uuidv4(),
        conversation_id: convId,
        user_id: uid,
        joined_at: new Date().toISOString(),
      });
    }
    return { id: convId, created_at: conv.created_at };
  },

  async getConversationBetweenUsers(userIdA, userIdB) {
    if (supabase) {
      const { data, error } = await supabase.rpc("find_conversation_between", {
        user_a: userIdA,
        user_b: userIdB,
      });
      // If RPC doesn't exist, fall back to manual query
      if (error) {
        const { data: convs, error: err2 } = await supabase
          .from("conversation_participants")
          .select("conversation_id")
          .in("user_id", [userIdA, userIdB]);
        if (err2) throw err2;
        // Find conversation_id that appears twice (both users)
        const counts = {};
        for (const row of convs || []) {
          counts[row.conversation_id] = (counts[row.conversation_id] || 0) + 1;
        }
        for (const [cid, count] of Object.entries(counts)) {
          if (count === 2) return cid;
        }
        return null;
      }
      return data?.[0]?.conversation_id || null;
    }

    // In-memory: find conversation with both users
    const convIds = new Map();
    for (const p of memoryStore.conversation_participants) {
      if (p.user_id === userIdA || p.user_id === userIdB) {
        convIds.set(
          p.conversation_id,
          (convIds.get(p.conversation_id) || 0) + 1,
        );
      }
    }
    for (const [cid, count] of convIds) {
      if (count === 2) return cid;
    }
    return null;
  },

  async getConversationsForUser(userId, limit = 20, offset = 0) {
    if (supabase) {
      // Get conversation IDs for this user
      const { data: myConvs, error: err1 } = await supabase
        .from("conversation_participants")
        .select("conversation_id")
        .eq("user_id", userId);
      if (err1) throw err1;
      if (!myConvs || myConvs.length === 0) return [];

      const convIds = myConvs.map((c) => c.conversation_id);

      // Get other participants for these conversations
      const { data: allParts, error: err2 } = await supabase
        .from("conversation_participants")
        .select("conversation_id, user_id")
        .in("conversation_id", convIds)
        .neq("user_id", userId);
      if (err2) throw err2;

      // Get user info for other participants
      const otherUserIds = [...new Set((allParts || []).map((p) => p.user_id))];
      const { data: otherUsers, error: err3 } = await supabase
        .from("users")
        .select("id, name, avatar_seed, avatar_url")
        .in("id", otherUserIds);
      if (err3) throw err3;

      const userMap = {};
      for (const u of otherUsers || []) userMap[u.id] = u;

      // Build conversation list with last message
      const results = [];
      for (const convId of convIds) {
        const otherPart = (allParts || []).find(
          (p) => p.conversation_id === convId,
        );
        if (!otherPart) continue;
        const otherUser = userMap[otherPart.user_id];
        if (!otherUser) continue;

        // Get last message
        const { data: msgs } = await supabase
          .from("messages")
          .select("content, created_at, sender_id, media_type")
          .eq("conversation_id", convId)
          .order("created_at", { ascending: false })
          .limit(1);

        // Get unread count
        const { count: unreadCount } = await supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .eq("conversation_id", convId)
          .neq("sender_id", userId)
          .is("read_at", null);

        const lastMsg = msgs?.[0] || null;
        results.push({
          id: convId,
          other_user_id: otherUser.id,
          other_user_name: otherUser.name,
          other_user_avatar: otherUser.avatar_seed,
          other_user_avatar_url: otherUser.avatar_url || null,
          last_message: lastMsg?.content || null,
          last_message_media_type: lastMsg?.media_type || null,
          last_message_at: lastMsg?.created_at || null,
          last_message_sender: lastMsg?.sender_id || null,
          unread_count: unreadCount || 0,
        });
      }

      // Sort by last message time (newest first)
      results.sort((a, b) => {
        const timeA = a.last_message_at || "1970-01-01";
        const timeB = b.last_message_at || "1970-01-01";
        return timeB.localeCompare(timeA);
      });

      return results.slice(offset, offset + limit);
    }

    // In-memory fallback
    const myConvIds = memoryStore.conversation_participants
      .filter((p) => p.user_id === userId)
      .map((p) => p.conversation_id);

    const results = [];
    for (const convId of myConvIds) {
      const otherPart = memoryStore.conversation_participants.find(
        (p) => p.conversation_id === convId && p.user_id !== userId,
      );
      if (!otherPart) continue;
      const otherUser = memoryStore.users.find(
        (u) => u.id === otherPart.user_id,
      );
      if (!otherUser) continue;

      const convMsgs = memoryStore.messages
        .filter((m) => m.conversation_id === convId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const lastMsg = convMsgs[0] || null;
      const unreadCount = convMsgs.filter(
        (m) => m.sender_id !== userId && !m.read_at,
      ).length;

      results.push({
        id: convId,
        other_user_id: otherUser.id,
        other_user_name: otherUser.name,
        other_user_avatar: otherUser.avatar_seed,
        other_user_avatar_url: otherUser.avatar_url || null,
        last_message: lastMsg?.content || null,
        last_message_media_type: lastMsg?.media_type || null,
        last_message_at: lastMsg?.created_at || null,
        last_message_sender: lastMsg?.sender_id || null,
        unread_count: unreadCount,
      });
    }

    results.sort((a, b) => {
      const timeA = a.last_message_at || "1970-01-01";
      const timeB = b.last_message_at || "1970-01-01";
      return timeB.localeCompare(timeA);
    });

    return results.slice(offset, offset + limit);
  },

  async getMessages(conversationId, limit = 50, offset = 0) {
    if (supabase) {
      const { data, error } = await supabase
        .from("messages")
        .select(
          "id, conversation_id, sender_id, content, created_at, read_at, media_url, media_type, media_thumbnail, media_width, media_height, media_duration, media_size, media_mime_type",
        )
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return data || [];
    }
    return memoryStore.messages
      .filter((m) => m.conversation_id === conversationId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(offset, offset + limit);
  },

  async createMessage({
    conversation_id,
    sender_id,
    content,
    media_url,
    media_type,
    media_thumbnail,
    media_width,
    media_height,
    media_duration,
    media_size,
    media_mime_type,
  }) {
    const { v4: uuidv4 } = require("uuid");
    const msgId = uuidv4();
    const now = new Date().toISOString();

    // Base row (always works even without media columns)
    const row = {
      id: msgId,
      conversation_id,
      sender_id,
      content: content || null,
    };

    // Only add media fields if media is actually present
    if (media_url) {
      row.media_url = media_url;
      row.media_type = media_type || null;
      row.media_thumbnail = media_thumbnail || null;
      row.media_width = media_width || null;
      row.media_height = media_height || null;
      row.media_duration = media_duration || null;
      row.media_size = media_size || null;
      row.media_mime_type = media_mime_type || null;
    }

    if (supabase) {
      const { data, error } = await supabase
        .from("messages")
        .insert(row)
        .select()
        .single();
      if (error) throw error;

      // Update conversation timestamp
      await supabase
        .from("conversations")
        .update({ updated_at: now })
        .eq("id", conversation_id);

      return data;
    }

    const msg = { ...row, created_at: now, read_at: null };
    memoryStore.messages.push(msg);

    const conv = memoryStore.conversations.find(
      (c) => c.id === conversation_id,
    );
    if (conv) conv.updated_at = now;

    return msg;
  },

  async markMessagesRead(conversationId, userId) {
    if (supabase) {
      const { error } = await supabase
        .from("messages")
        .update({ read_at: new Date().toISOString() })
        .eq("conversation_id", conversationId)
        .neq("sender_id", userId)
        .is("read_at", null);
      if (error) throw error;
      return;
    }
    const now = new Date().toISOString();
    for (const msg of memoryStore.messages) {
      if (
        msg.conversation_id === conversationId &&
        msg.sender_id !== userId &&
        !msg.read_at
      ) {
        msg.read_at = now;
      }
    }
  },

  async getConversationParticipants(conversationId) {
    if (supabase) {
      const { data, error } = await supabase
        .from("conversation_participants")
        .select("user_id")
        .eq("conversation_id", conversationId);
      if (error) throw error;
      return (data || []).map((p) => p.user_id);
    }
    return memoryStore.conversation_participants
      .filter((p) => p.conversation_id === conversationId)
      .map((p) => p.user_id);
  },

  // ─── World Chat ──────────────────────────────────────────────────────────────
  async createWorldMessage({
    sender_id,
    sender_name,
    sender_avatar,
    content,
    media_url,
    media_type,
    media_thumbnail,
    media_width,
    media_height,
    media_duration,
    media_size,
    media_mime_type,
  }) {
    const { v4: uuidv4 } = require("uuid");
    const msgId = uuidv4();
    const now = new Date().toISOString();

    // Base row
    const row = {
      id: msgId,
      sender_id,
      sender_name,
      sender_avatar,
      content: content || null,
    };

    // Only add media fields if media is actually present
    if (media_url) {
      row.media_url = media_url;
      row.media_type = media_type || null;
      row.media_thumbnail = media_thumbnail || null;
      row.media_width = media_width || null;
      row.media_height = media_height || null;
      row.media_duration = media_duration || null;
      row.media_size = media_size || null;
      row.media_mime_type = media_mime_type || null;
    }

    if (supabase) {
      const { data, error } = await supabase
        .from("world_messages")
        .insert(row)
        .select()
        .single();
      if (error) throw error;
      return data;
    }

    const msg = { ...row, created_at: now };
    memoryStore.world_messages.push(msg);
    if (memoryStore.world_messages.length > 500) {
      memoryStore.world_messages = memoryStore.world_messages.slice(-500);
    }
    return msg;
  },

  async getWorldMessages(limit = 50, before = null) {
    if (supabase) {
      let query = supabase
        .from("world_messages")
        .select(
          "id, sender_id, sender_name, sender_avatar, content, created_at, media_url, media_type, media_thumbnail, media_width, media_height, media_duration, media_size, media_mime_type",
        )
        .order("created_at", { ascending: false })
        .limit(limit);
      if (before) query = query.lt("created_at", before);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).reverse();
    }
    let msgs = [...memoryStore.world_messages];
    if (before) msgs = msgs.filter((m) => m.created_at < before);
    return msgs.slice(-limit);
  },

  async isConversationParticipant(conversationId, userId) {
    if (supabase) {
      const { data, error } = await supabase
        .from("conversation_participants")
        .select("id")
        .eq("conversation_id", conversationId)
        .eq("user_id", userId)
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return !!data;
    }
    return memoryStore.conversation_participants.some(
      (p) => p.conversation_id === conversationId && p.user_id === userId,
    );
  },

  // ─── Push Tokens ────────────────────────────────────────────────────────────
  async savePushToken(userId, token, platform, deviceId) {
    if (supabase) {
      const { data, error } = await supabase.from("push_tokens").upsert(
        {
          user_id: userId,
          token,
          platform: platform || "android",
          device_id: deviceId || "unknown",
          last_used_at: new Date().toISOString(),
        },
        { onConflict: "token" },
      );
      if (error) throw error;
      return data;
    }
    // In-memory fallback
    const existing = memoryStore.push_tokens.find((t) => t.token === token);
    if (existing) {
      existing.last_used_at = new Date().toISOString();
      return existing;
    }
    const entry = {
      id: require("uuid").v4(),
      user_id: userId,
      token,
      platform: platform || "android",
      device_id: deviceId || "unknown",
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    };
    memoryStore.push_tokens.push(entry);
    return entry;
  },

  async deletePushToken(token) {
    if (supabase) {
      const { error } = await supabase
        .from("push_tokens")
        .delete()
        .eq("token", token);
      if (error) throw error;
      return;
    }
    memoryStore.push_tokens = memoryStore.push_tokens.filter(
      (t) => t.token !== token,
    );
  },

  async deleteUserTokens(userId) {
    if (supabase) {
      const { error } = await supabase
        .from("push_tokens")
        .delete()
        .eq("user_id", userId);
      if (error) throw error;
      return;
    }
    memoryStore.push_tokens = memoryStore.push_tokens.filter(
      (t) => t.user_id !== userId,
    );
  },

  async getPushTokens(userId) {
    if (supabase) {
      const { data, error } = await supabase
        .from("push_tokens")
        .select("*")
        .eq("user_id", userId);
      if (error) throw error;
      return data || [];
    }
    return memoryStore.push_tokens.filter((t) => t.user_id === userId);
  },

  async updateTokenLastUsed(token) {
    if (supabase) {
      await supabase
        .from("push_tokens")
        .update({ last_used_at: new Date().toISOString() })
        .eq("token", token);
      return;
    }
    const entry = memoryStore.push_tokens.find((t) => t.token === token);
    if (entry) entry.last_used_at = new Date().toISOString();
  },

  // ─── User Devices (Native FCM/APNs) ─────────────────────────────────────

  /**
   * Register or update a device for a user.
   * Upserts on (user_id, device_id) — supports multi-device.
   */
  async saveDevice(
    userId,
    {
      deviceId,
      platform,
      pushToken,
      tokenType,
      appVersion,
      osVersion,
      deviceName,
    },
  ) {
    const now = new Date().toISOString();
    if (supabase) {
      const { data, error } = await supabase.from("user_devices").upsert(
        {
          user_id: userId,
          device_id: deviceId || "unknown",
          platform: platform || "android",
          push_token: pushToken,
          token_type: tokenType || "fcm",
          app_version: appVersion || null,
          os_version: osVersion || null,
          device_name: deviceName || null,
          is_active: true,
          last_seen_at: now,
          updated_at: now,
        },
        { onConflict: "user_id,device_id" },
      );
      if (error) throw error;
      return data;
    }
    // In-memory fallback
    const existing = memoryStore.user_devices.find(
      (d) => d.user_id === userId && d.device_id === (deviceId || "unknown"),
    );
    if (existing) {
      existing.push_token = pushToken;
      existing.token_type = tokenType || "fcm";
      existing.is_active = true;
      existing.last_seen_at = now;
      existing.updated_at = now;
      if (appVersion) existing.app_version = appVersion;
      if (osVersion) existing.os_version = osVersion;
      if (deviceName) existing.device_name = deviceName;
      return existing;
    }
    const entry = {
      id: require("uuid").v4(),
      user_id: userId,
      device_id: deviceId || "unknown",
      platform: platform || "android",
      push_token: pushToken,
      token_type: tokenType || "fcm",
      app_version: appVersion || null,
      os_version: osVersion || null,
      device_name: deviceName || null,
      is_active: true,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    };
    memoryStore.user_devices.push(entry);
    return entry;
  },

  /**
   * Get all active devices for a user (for push fan-out).
   */
  async getActiveDevices(userId) {
    if (supabase) {
      const { data, error } = await supabase
        .from("user_devices")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true);
      if (error) throw error;
      return data || [];
    }
    return memoryStore.user_devices.filter(
      (d) => d.user_id === userId && d.is_active,
    );
  },

  /**
   * Deactivate a specific device (on logout from that device).
   */
  async deactivateDevice(userId, deviceId) {
    if (supabase) {
      const { error } = await supabase
        .from("user_devices")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("device_id", deviceId);
      if (error) throw error;
      return;
    }
    const device = memoryStore.user_devices.find(
      (d) => d.user_id === userId && d.device_id === deviceId,
    );
    if (device) {
      device.is_active = false;
      device.updated_at = new Date().toISOString();
    }
  },

  /**
   * Deactivate ALL devices for a user (full logout / account deletion).
   */
  async deactivateAllDevices(userId) {
    if (supabase) {
      const { error } = await supabase
        .from("user_devices")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("is_active", true);
      if (error) throw error;
      return;
    }
    memoryStore.user_devices
      .filter((d) => d.user_id === userId)
      .forEach((d) => {
        d.is_active = false;
        d.updated_at = new Date().toISOString();
      });
  },

  /**
   * Deactivate device by push token (for invalid token cleanup).
   */
  async deactivateDeviceByToken(token) {
    if (supabase) {
      const { error } = await supabase
        .from("user_devices")
        .update({
          is_active: false,
          push_token: null,
          updated_at: new Date().toISOString(),
        })
        .eq("push_token", token);
      if (error) throw error;
      return;
    }
    const device = memoryStore.user_devices.find((d) => d.push_token === token);
    if (device) {
      device.is_active = false;
      device.push_token = null;
      device.updated_at = new Date().toISOString();
    }
  },

  /**
   * Update last_seen for a device (heartbeat / app foreground).
   */
  async touchDevice(userId, deviceId) {
    if (supabase) {
      await supabase
        .from("user_devices")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("device_id", deviceId);
      return;
    }
    const device = memoryStore.user_devices.find(
      (d) => d.user_id === userId && d.device_id === deviceId,
    );
    if (device) device.last_seen_at = new Date().toISOString();
  },

  // ─── Notification Preferences ──────────────────────────────────────────────

  /**
   * Get a specific notification preference for a user+type.
   */
  async getNotificationPreference(userId, type) {
    if (supabase) {
      const { data, error } = await supabase
        .from("notification_preferences")
        .select("*")
        .eq("user_id", userId)
        .eq("type", type)
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return data;
    }
    return (
      memoryStore.notification_preferences.find(
        (p) => p.user_id === userId && p.type === type,
      ) || null
    );
  },

  /**
   * Get ALL notification preferences for a user.
   */
  async getNotificationPreferences(userId) {
    if (supabase) {
      const { data, error } = await supabase
        .from("notification_preferences")
        .select("*")
        .eq("user_id", userId)
        .order("type");
      if (error) throw error;
      return data || [];
    }
    return memoryStore.notification_preferences.filter(
      (p) => p.user_id === userId,
    );
  },

  /**
   * Create or update a notification preference.
   */
  async upsertNotificationPreference(userId, type, settings) {
    const now = new Date().toISOString();
    if (supabase) {
      const { data, error } = await supabase
        .from("notification_preferences")
        .upsert(
          {
            user_id: userId,
            type,
            push_enabled: settings.push_enabled ?? true,
            in_app_enabled: settings.in_app_enabled ?? true,
            sound_enabled: settings.sound_enabled ?? true,
            vibrate_enabled: settings.vibrate_enabled ?? true,
            updated_at: now,
          },
          { onConflict: "user_id,type" },
        )
        .select()
        .single();
      if (error) throw error;
      return data;
    }
    // In-memory
    const existing = memoryStore.notification_preferences.find(
      (p) => p.user_id === userId && p.type === type,
    );
    if (existing) {
      if (settings.push_enabled !== undefined)
        existing.push_enabled = settings.push_enabled;
      if (settings.in_app_enabled !== undefined)
        existing.in_app_enabled = settings.in_app_enabled;
      if (settings.sound_enabled !== undefined)
        existing.sound_enabled = settings.sound_enabled;
      if (settings.vibrate_enabled !== undefined)
        existing.vibrate_enabled = settings.vibrate_enabled;
      existing.updated_at = now;
      return existing;
    }
    const pref = {
      id: require("uuid").v4(),
      user_id: userId,
      type,
      push_enabled: settings.push_enabled ?? true,
      in_app_enabled: settings.in_app_enabled ?? true,
      sound_enabled: settings.sound_enabled ?? true,
      vibrate_enabled: settings.vibrate_enabled ?? true,
      created_at: now,
      updated_at: now,
    };
    memoryStore.notification_preferences.push(pref);
    return pref;
  },

  // ─── Profile Updates ──────────────────────────────────────────────────────
  async updateUserProfile(
    userId,
    { name, bio, is_private, secret_name, avatar_url },
  ) {
    const updates = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name.trim();
    if (bio !== undefined) updates.bio = bio || null;
    if (is_private !== undefined) updates.is_private = is_private;
    if (secret_name !== undefined) updates.secret_name = secret_name || null;
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;

    if (supabase) {
      const { data, error } = await supabase
        .from("users")
        .update(updates)
        .eq("id", userId)
        .select(
          "id, name, email, phone, bio, avatar_seed, avatar_url, email_verified, is_private, secret_name, created_at",
        )
        .single();
      if (error) throw error;
      return data;
    }
    const user = memoryStore.users.find((u) => u.id === userId);
    if (user) Object.assign(user, updates);
    const { password_hash, ...safe } = user;
    return safe;
  },

  async updateUserPassword(userId, passwordHash) {
    if (supabase) {
      const { error } = await supabase
        .from("users")
        .update({
          password_hash: passwordHash,
          updated_at: new Date().toISOString(),
        })
        .eq("id", userId);
      if (error) throw error;
      return;
    }
    const user = memoryStore.users.find((u) => u.id === userId);
    if (user) {
      user.password_hash = passwordHash;
      user.updated_at = new Date().toISOString();
    }
  },

  async getUserBySecretName(secretName) {
    if (supabase) {
      const { data, error } = await supabase
        .from("users")
        .select(
          "id, name, email, avatar_seed, avatar_url, email_verified, is_private, secret_name, created_at",
        )
        .eq("secret_name", secretName)
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return data;
    }
    const user = memoryStore.users.find((u) => u.secret_name === secretName);
    if (!user) return null;
    const { password_hash, ...safe } = user;
    return safe;
  },

  async getUserWithPassword(id) {
    if (supabase) {
      const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("id", id)
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return data;
    }
    return memoryStore.users.find((u) => u.id === id) || null;
  },

  // ─── Friend Requests ──────────────────────────────────────────────────────
  async sendFriendRequest(senderId, receiverId) {
    const { v4: uuidv4 } = require("uuid");
    const id = uuidv4();
    const now = new Date().toISOString();

    if (supabase) {
      // Check if request already exists (in either direction)
      const { data: existing } = await supabase
        .from("friend_requests")
        .select("id, status")
        .or(
          `and(sender_id.eq.${senderId},receiver_id.eq.${receiverId}),and(sender_id.eq.${receiverId},receiver_id.eq.${senderId})`,
        )
        .limit(1);
      if (existing && existing.length > 0) {
        if (existing[0].status === "accepted") return { alreadyFriends: true };
        if (existing[0].status === "pending") return { alreadyPending: true };
      }

      const { data, error } = await supabase
        .from("friend_requests")
        .insert({ id, sender_id: senderId, receiver_id: receiverId })
        .select()
        .single();
      if (error) throw error;
      return data;
    }
    // In-memory
    const existing = memoryStore.friend_requests.find(
      (r) =>
        (r.sender_id === senderId && r.receiver_id === receiverId) ||
        (r.sender_id === receiverId && r.receiver_id === senderId),
    );
    if (existing) {
      if (existing.status === "accepted") return { alreadyFriends: true };
      if (existing.status === "pending") return { alreadyPending: true };
    }
    const req = {
      id,
      sender_id: senderId,
      receiver_id: receiverId,
      status: "pending",
      created_at: now,
      updated_at: now,
    };
    memoryStore.friend_requests.push(req);
    return req;
  },

  async withdrawFriendRequest(senderId, targetUserId) {
    if (supabase) {
      const { data, error } = await supabase
        .from("friend_requests")
        .delete()
        .eq("sender_id", senderId)
        .eq("receiver_id", targetUserId)
        .eq("status", "pending")
        .select()
        .single();
      if (error && error.code === "PGRST116") return null; // not found
      if (error) throw error;
      return data;
    }
    // In-memory
    const idx = memoryStore.friend_requests.findIndex(
      (r) =>
        r.sender_id === senderId &&
        r.receiver_id === targetUserId &&
        r.status === "pending",
    );
    if (idx === -1) return null;
    const [removed] = memoryStore.friend_requests.splice(idx, 1);
    return removed;
  },

  async respondFriendRequest(requestId, userId, status) {
    if (supabase) {
      const { data, error } = await supabase
        .from("friend_requests")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", requestId)
        .eq("receiver_id", userId)
        .select()
        .single();
      if (error) throw error;
      return data;
    }
    const req = memoryStore.friend_requests.find(
      (r) => r.id === requestId && r.receiver_id === userId,
    );
    if (req) {
      req.status = status;
      req.updated_at = new Date().toISOString();
    }
    return req;
  },

  async getFriendRequests(userId) {
    if (supabase) {
      const { data, error } = await supabase
        .from("friend_requests")
        .select("id, sender_id, status, created_at")
        .eq("receiver_id", userId)
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      if (error) throw error;

      // Enrich with sender info
      const enriched = [];
      for (const req of data || []) {
        const { data: sender } = await supabase
          .from("users")
          .select("id, name, avatar_seed")
          .eq("id", req.sender_id)
          .single();
        enriched.push({
          ...req,
          sender_name: sender?.name || "Unknown",
          sender_avatar: sender?.avatar_seed || sender?.name || "?",
        });
      }
      return enriched;
    }
    return memoryStore.friend_requests
      .filter((r) => r.receiver_id === userId && r.status === "pending")
      .map((r) => {
        const sender = memoryStore.users.find((u) => u.id === r.sender_id);
        return {
          ...r,
          sender_name: sender?.name || "Unknown",
          sender_avatar: sender?.avatar_seed || sender?.name || "?",
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async areFriends(userA, userB) {
    if (supabase) {
      const { data, error } = await supabase
        .from("friend_requests")
        .select("id")
        .eq("status", "accepted")
        .or(
          `and(sender_id.eq.${userA},receiver_id.eq.${userB}),and(sender_id.eq.${userB},receiver_id.eq.${userA})`,
        )
        .limit(1);
      if (error) throw error;
      return (data || []).length > 0;
    }
    return memoryStore.friend_requests.some(
      (r) =>
        r.status === "accepted" &&
        ((r.sender_id === userA && r.receiver_id === userB) ||
          (r.sender_id === userB && r.receiver_id === userA)),
    );
  },

  async getFriends(userId) {
    if (supabase) {
      const { data, error } = await supabase
        .from("friend_requests")
        .select("sender_id, receiver_id")
        .eq("status", "accepted")
        .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`);
      if (error) throw error;

      const friendIds = (data || []).map((r) =>
        r.sender_id === userId ? r.receiver_id : r.sender_id,
      );
      if (friendIds.length === 0) return [];

      const { data: friends } = await supabase
        .from("users")
        .select(
          "id, name, email, bio, avatar_seed, avatar_url, is_private, created_at",
        )
        .in("id", friendIds);
      return friends || [];
    }
    const friendIds = memoryStore.friend_requests
      .filter(
        (r) =>
          r.status === "accepted" &&
          (r.sender_id === userId || r.receiver_id === userId),
      )
      .map((r) => (r.sender_id === userId ? r.receiver_id : r.sender_id));
    return memoryStore.users
      .filter((u) => friendIds.includes(u.id))
      .map(({ password_hash, ...safe }) => safe);
  },

  async getFriendRequestStatus(senderId, receiverId) {
    if (supabase) {
      const { data, error } = await supabase
        .from("friend_requests")
        .select("id, sender_id, receiver_id, status")
        .or(
          `and(sender_id.eq.${senderId},receiver_id.eq.${receiverId}),and(sender_id.eq.${receiverId},receiver_id.eq.${senderId})`,
        )
        .limit(1);
      if (error) throw error;
      return data?.[0] || null;
    }
    return (
      memoryStore.friend_requests.find(
        (r) =>
          (r.sender_id === senderId && r.receiver_id === receiverId) ||
          (r.sender_id === receiverId && r.receiver_id === senderId),
      ) || null
    );
  },

  // ─── Notifications ────────────────────────────────────────────────────────

  /**
   * Create a notification with deduplication.
   * If a matching group_key exists within the aggregation window, update instead of insert.
   */
  async createNotification({
    user_id,
    type,
    title,
    body,
    data = {},
    priority = 0,
    group_key = null,
  }) {
    const AGGREGATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

    if (supabase) {
      // Check for existing notification with same group_key within window
      if (group_key) {
        const windowStart = new Date(
          Date.now() - AGGREGATION_WINDOW_MS,
        ).toISOString();
        const { data: existing } = await supabase
          .from("notifications")
          .select("id, data")
          .eq("group_key", group_key)
          .eq("user_id", user_id)
          .is("deleted_at", null)
          .gte("created_at", windowStart)
          .order("created_at", { ascending: false })
          .limit(1);

        if (existing && existing.length > 0) {
          const prev = existing[0];
          const count = (prev.data?.count || 1) + 1;
          const { data: updated, error } = await supabase
            .from("notifications")
            .update({
              body,
              data: { ...prev.data, ...data, count },
              read: false,
              created_at: new Date().toISOString(),
            })
            .eq("id", prev.id)
            .select()
            .single();
          if (error) throw error;
          return updated;
        }
      }

      const { data: row, error } = await supabase
        .from("notifications")
        .insert({
          user_id,
          type,
          title,
          body,
          data: { ...data, count: 1 },
          priority,
          group_key,
        })
        .select()
        .single();
      if (error) throw error;
      return row;
    }

    // In-memory fallback
    if (group_key) {
      const windowStart = Date.now() - AGGREGATION_WINDOW_MS;
      const existing = memoryStore.notifications.find(
        (n) =>
          n.group_key === group_key &&
          n.user_id === user_id &&
          !n.deleted_at &&
          new Date(n.created_at).getTime() >= windowStart,
      );
      if (existing) {
        const count = (existing.data?.count || 1) + 1;
        existing.body = body;
        existing.data = { ...existing.data, ...data, count };
        existing.read = false;
        existing.created_at = new Date().toISOString();
        return existing;
      }
    }
    const notif = {
      id: require("crypto").randomUUID(),
      user_id,
      type,
      title,
      body,
      data: { ...data, count: 1 },
      priority,
      read: false,
      group_key,
      deleted_at: null,
      created_at: new Date().toISOString(),
    };
    memoryStore.notifications.push(notif);
    return notif;
  },

  /**
   * Get notifications with cursor-based pagination.
   * Returns { notifications, unread_count, next_cursor }.
   */
  async getNotifications(
    userId,
    { unreadOnly = false, cursor = null, limit = 20 } = {},
  ) {
    if (supabase) {
      let query = supabase
        .from("notifications")
        .select("*")
        .eq("user_id", userId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(limit + 1); // fetch one extra for next_cursor

      if (unreadOnly) query = query.eq("read", false);
      if (cursor) query = query.lt("created_at", cursor);

      const { data: rows, error } = await query;
      if (error) throw error;

      // Unread count
      const { count } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("read", false)
        .is("deleted_at", null);

      const hasMore = rows.length > limit;
      const notifications = hasMore ? rows.slice(0, limit) : rows;
      const next_cursor = hasMore
        ? notifications[notifications.length - 1].created_at
        : null;

      return { notifications, unread_count: count || 0, next_cursor };
    }

    // In-memory
    let items = memoryStore.notifications
      .filter((n) => n.user_id === userId && !n.deleted_at)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (unreadOnly) items = items.filter((n) => !n.read);
    if (cursor) items = items.filter((n) => n.created_at < cursor);

    const unread_count = memoryStore.notifications.filter(
      (n) => n.user_id === userId && !n.deleted_at && !n.read,
    ).length;

    const hasMore = items.length > limit;
    const notifications = items.slice(0, limit);
    const next_cursor = hasMore
      ? notifications[notifications.length - 1].created_at
      : null;

    return { notifications, unread_count, next_cursor };
  },

  /**
   * Mark a single notification as read (validates ownership).
   */
  async markNotificationRead(notifId, userId) {
    if (supabase) {
      const { data, error } = await supabase
        .from("notifications")
        .update({ read: true })
        .eq("id", notifId)
        .eq("user_id", userId)
        .select()
        .single();
      if (error) throw error;
      return data;
    }
    const n = memoryStore.notifications.find(
      (n) => n.id === notifId && n.user_id === userId,
    );
    if (n) n.read = true;
    return n || null;
  },

  /**
   * Mark all notifications as read for a user.
   */
  async markAllRead(userId) {
    if (supabase) {
      const { error } = await supabase
        .from("notifications")
        .update({ read: true })
        .eq("user_id", userId)
        .eq("read", false)
        .is("deleted_at", null);
      if (error) throw error;
      return true;
    }
    memoryStore.notifications
      .filter((n) => n.user_id === userId && !n.deleted_at)
      .forEach((n) => (n.read = true));
    return true;
  },

  /**
   * Fast unread count for badge.
   */
  async getUnreadCount(userId) {
    if (supabase) {
      const { count, error } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("read", false)
        .is("deleted_at", null);
      if (error) throw error;
      return count || 0;
    }
    return memoryStore.notifications.filter(
      (n) => n.user_id === userId && !n.deleted_at && !n.read,
    ).length;
  },

  /**
   * Cleanup: hard-delete soft-deleted rows older than `days`
   * and auto-expire notifications older than `days`.
   */
  async cleanupExpiredNotifications(days = 90) {
    const cutoff = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();
    if (supabase) {
      // Hard-delete soft-deleted rows
      await supabase
        .from("notifications")
        .delete()
        .not("deleted_at", "is", null)
        .lt("deleted_at", cutoff);
      // Soft-delete ancient active rows
      await supabase
        .from("notifications")
        .update({ deleted_at: new Date().toISOString() })
        .is("deleted_at", null)
        .lt("created_at", cutoff);
      return true;
    }
    memoryStore.notifications = memoryStore.notifications.filter(
      (n) =>
        !(n.deleted_at && n.deleted_at < cutoff) && !(n.created_at < cutoff),
    );
    return true;
  },
};

module.exports = { supabase, db };
