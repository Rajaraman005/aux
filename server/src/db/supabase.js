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
        .select("id, name, email, avatar_seed, email_verified, created_at")
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
      const { data, error } = await supabase
        .from("users")
        .select("id, name, email, avatar_seed, email_verified, created_at")
        .eq("email_verified", true)
        .or(`name.ilike.%${query}%,email.ilike.%${query}%`)
        .range(offset, offset + limit - 1)
        .order("name");
      if (error) throw error;
      return data || [];
    }
    return memoryStore.users
      .filter(
        (u) =>
          u.email_verified &&
          (u.name.toLowerCase().includes(query.toLowerCase()) ||
            u.email.toLowerCase().includes(query.toLowerCase())),
      )
      .slice(offset, offset + limit)
      .map(({ password_hash, ...safe }) => safe);
  },

  async listVerifiedUsers(limit = 20, offset = 0) {
    if (supabase) {
      const { data, error } = await supabase
        .from("users")
        .select("id, name, email, avatar_seed, created_at")
        .eq("email_verified", true)
        .range(offset, offset + limit - 1)
        .order("name");
      if (error) throw error;
      return data || [];
    }
    return memoryStore.users
      .filter((u) => u.email_verified)
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
        .select("id, name, avatar_seed")
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
          .select("content, created_at, sender_id")
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
          last_message: lastMsg?.content || null,
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
        last_message: lastMsg?.content || null,
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
        .select("id, conversation_id, sender_id, content, created_at, read_at")
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

  async createMessage({ conversation_id, sender_id, content }) {
    const { v4: uuidv4 } = require("uuid");
    const msgId = uuidv4();
    const now = new Date().toISOString();

    if (supabase) {
      const { data, error } = await supabase
        .from("messages")
        .insert({ id: msgId, conversation_id, sender_id, content })
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

    const msg = {
      id: msgId,
      conversation_id,
      sender_id,
      content,
      created_at: now,
      read_at: null,
    };
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
};

module.exports = { supabase, db };
