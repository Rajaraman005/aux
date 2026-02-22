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
};

module.exports = { supabase, db };
