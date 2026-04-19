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
    password: `${API_BASE}/api/users/me/password`,
    avatar: `${API_BASE}/api/users/me/avatar`,
    profile: (id) => `${API_BASE}/api/users/${id}`,
  },
  friends: {
    list: `${API_BASE}/api/friends`,
    request: `${API_BASE}/api/friends/request`,
    withdraw: (targetUserId) =>
      `${API_BASE}/api/friends/request/${targetUserId}`,
    requests: `${API_BASE}/api/friends/requests`,
    respond: (id) => `${API_BASE}/api/friends/${id}`,
  },
  conversations: {
    list: `${API_BASE}/api/conversations`,
    create: `${API_BASE}/api/conversations`,
    messages: (id) => `${API_BASE}/api/conversations/${id}/messages`,
    send: (id) => `${API_BASE}/api/conversations/${id}/messages`,
    read: (id) => `${API_BASE}/api/conversations/${id}/read`,
  },
  world: `${API_BASE}/api/world`,
  notifications: {
    list: `${API_BASE}/api/notifications`,
    count: `${API_BASE}/api/notifications/count`,
    read: (id) => `${API_BASE}/api/notifications/${id}/read`,
    readAll: `${API_BASE}/api/notifications/read-all`,
    preferences: `${API_BASE}/api/notifications/preferences`,
  },
  turn: `${API_BASE}/api/turn-credentials`,
  metrics: `${API_BASE}/api/metrics/call`,
  health: `${API_BASE}/health`,
  media: {
    sign: `${API_BASE}/api/media/sign`,
    validate: `${API_BASE}/api/media/validate`,
  },
  push: {
    register: `${API_BASE}/api/push/register`,
    unregister: `${API_BASE}/api/push/unregister`,
  },
  calls: {
    reject: `${API_BASE}/api/calls/reject`,
  },
  worldVideo: {
    report: `${API_BASE}/api/world-video/report`,
    blocklist: `${API_BASE}/api/world-video/blocklist`,
    block: (userId) => `${API_BASE}/api/world-video/block/${userId}`,
    tosStatus: `${API_BASE}/api/world-video/tos-status`,
    acceptTos: `${API_BASE}/api/world-video/accept-tos`,
    status: `${API_BASE}/api/world-video/status`,
    moderate: `${API_BASE}/api/world-video/moderate`,
  },
  oauth: {
    googleUrl: `${API_BASE}/api/oauth/google/url`,
    connections: `${API_BASE}/api/oauth/connections`,
    disconnect: (provider) => `${API_BASE}/api/oauth/${provider}`,
  },
  feed: {
    list: `${API_BASE}/api/feed`,
    refresh: `${API_BASE}/api/feed/refresh`,
    sources: `${API_BASE}/api/feed/sources`,
  },
};

export { API_BASE, WS_BASE, endpoints };
export default endpoints;
