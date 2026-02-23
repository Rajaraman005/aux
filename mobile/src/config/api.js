/**
 * API Configuration.
 * Central endpoint definitions and base URL.
 */

// ─── Your computer's LAN IP (from Expo output) ─────────────
// Change this if your network IP changes
const DEV_SERVER_IP = "192.168.1.5";

const API_BASE = __DEV__
  ? `http://${DEV_SERVER_IP}:3000`
  : "https://aux-server.onrender.com";

const WS_BASE = __DEV__
  ? `ws://${DEV_SERVER_IP}:3000/ws`
  : "wss://aux-server.onrender.com/ws";

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
  conversations: {
    list: `${API_BASE}/api/conversations`,
    create: `${API_BASE}/api/conversations`,
    messages: (id) => `${API_BASE}/api/conversations/${id}/messages`,
    send: (id) => `${API_BASE}/api/conversations/${id}/messages`,
    read: (id) => `${API_BASE}/api/conversations/${id}/read`,
  },
  world: `${API_BASE}/api/world`,
  turn: `${API_BASE}/api/turn-credentials`,
  metrics: `${API_BASE}/api/metrics/call`,
  health: `${API_BASE}/health`,
};

export { API_BASE, WS_BASE, endpoints };
export default endpoints;
