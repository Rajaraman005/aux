/**
 * Centralized configuration loader with validation.
 * All environment variables are validated at startup — fail fast on misconfiguration.
 */
require("dotenv").config();

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  env: process.env.NODE_ENV || "development",
  isDev: (process.env.NODE_ENV || "development") === "development",

  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

  jwt: {
    accessSecret:
      process.env.JWT_ACCESS_SECRET ||
      "dev-access-secret-change-in-production-32chars",
    refreshSecret:
      process.env.JWT_REFRESH_SECRET ||
      "dev-refresh-secret-change-in-production-32chars",
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || "15m",
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || "7d",
  },

  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },

  resend: {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM || "Aux <onboarding@resend.dev>",
  },

  turn: {
    url: process.env.TURN_SERVER_URL || "turn:localhost:3478",
    secret: process.env.TURN_SERVER_SECRET || "dev-turn-secret",
    ttl: 86400, // 24 hours
  },

  sfu: {
    listenIp: process.env.SFU_LISTEN_IP || "0.0.0.0",
    announcedIp: process.env.SFU_ANNOUNCED_IP || "127.0.0.1",
    minPort: parseInt(process.env.SFU_MIN_PORT, 10) || 40000,
    maxPort: parseInt(process.env.SFU_MAX_PORT, 10) || 49999,
  },

  metrics: {
    enabled: process.env.METRICS_ENABLED === "true",
  },

  rateLimit: {
    auth: { windowMs: 15 * 60 * 1000, max: 5 },
    api: { windowMs: 60 * 1000, max: 100 },
    call: { windowMs: 60 * 1000, max: 10 },
  },
};

/**
 * Validate critical config at startup.
 * In production, missing Supabase or JWT secrets = hard crash.
 */
function validateConfig() {
  const errors = [];

  if (!config.isDev) {
    if (!config.supabase.url) errors.push("SUPABASE_URL is required");
    if (!config.supabase.serviceRoleKey)
      errors.push("SUPABASE_SERVICE_ROLE_KEY is required");
    if (config.jwt.accessSecret.includes("dev-"))
      errors.push("JWT_ACCESS_SECRET must be changed for production");
    if (config.jwt.refreshSecret.includes("dev-"))
      errors.push("JWT_REFRESH_SECRET must be changed for production");
  }

  if (errors.length > 0) {
    console.error("❌ Configuration errors:");
    errors.forEach((e) => console.error(`   - ${e}`));
    process.exit(1);
  }
}

validateConfig();

module.exports = config;
