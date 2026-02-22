/**
 * API Configuration.
 * Central endpoint definitions and base URL.
 */

// ─── Your computer's LAN IP (from Expo output) ─────────────
// Change this if your network IP changes
const DEV_SERVER_IP = "192.168.1.3";

const API_BASE = __DEV__
  ? `http://${DEV_SERVER_IP}:3000`
  : "https://your-production-url.com";

const WS_BASE = __DEV__
  ? `ws://${DEV_SERVER_IP}:3000/ws`
  : "wss://your-production-url.com/ws";

const endpoints = {
  auth: {
    signup: `${API_BASE}/api/auth/signup`,
    verify: `${API_BASE}/api/auth/verify`,
    login: `${API_BASE}/api/auth/login`,
    refresh: `${API_BASE}/api/auth/refresh`,
    logout: `${API_BASE}/api/auth/logout`,
    resendCode: `${API_BASE}/api/auth/resend-code`,
  },
  users: {
    list: `${API_BASE}/api/users`,
    search: `${API_BASE}/api/users/search`,
    me: `${API_BASE}/api/users/me`,
    profile: (id) => `${API_BASE}/api/users/${id}`,
  },
  turn: `${API_BASE}/api/turn-credentials`,
  metrics: `${API_BASE}/api/metrics/call`,
  health: `${API_BASE}/health`,
};

export { API_BASE, WS_BASE, endpoints };
export default endpoints;
