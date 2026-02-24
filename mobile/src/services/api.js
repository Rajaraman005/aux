/**
 * HTTP API Client with automatic token refresh.
 * Handles: request retries, token rotation, error normalization.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { endpoints } from "../config/api";

const STORAGE_KEYS = {
  ACCESS_TOKEN: "@aux_access_token",
  REFRESH_TOKEN: "@aux_refresh_token",
  USER: "@aux_user",
  DEVICE_ID: "@aux_device_id",
};

class ApiClient {
  constructor() {
    this.accessToken = null;
    this.refreshToken = null;
    this.isRefreshing = false;
    this.refreshQueue = [];
  }

  async init() {
    this.accessToken = await AsyncStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    this.refreshToken = await AsyncStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
  }

  async setTokens(accessToken, refreshToken) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    await AsyncStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
    if (refreshToken) {
      await AsyncStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
    }
  }

  async clearTokens() {
    this.accessToken = null;
    this.refreshToken = null;
    await AsyncStorage.multiRemove([
      STORAGE_KEYS.ACCESS_TOKEN,
      STORAGE_KEYS.REFRESH_TOKEN,
      STORAGE_KEYS.USER,
    ]);
  }

  async saveUser(user) {
    await AsyncStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
  }

  async getStoredUser() {
    const data = await AsyncStorage.getItem(STORAGE_KEYS.USER);
    return data ? JSON.parse(data) : null;
  }

  async getDeviceId() {
    let deviceId = await AsyncStorage.getItem(STORAGE_KEYS.DEVICE_ID);
    if (!deviceId) {
      deviceId = `device_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
      await AsyncStorage.setItem(STORAGE_KEYS.DEVICE_ID, deviceId);
    }
    return deviceId;
  }

  /**
   * Make an authenticated API request.
   * Automatically refreshes token on 401.
   */
  async request(url, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...options.headers,
    };

    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    console.log(`📡 API ${options.method || "GET"} ${url}`);

    try {
      // Timeout after 30 seconds (signup involves argon2 hashing + email)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      console.log(
        `📡 API ${options.method || "GET"} ${url} → ${response.status}`,
      );

      const data = await response.json();

      // Token expired — try refresh
      if (
        response.status === 401 &&
        data.code === "TOKEN_EXPIRED" &&
        this.refreshToken
      ) {
        const refreshed = await this.attemptTokenRefresh();
        if (refreshed) {
          // Retry original request with new token
          headers["Authorization"] = `Bearer ${this.accessToken}`;
          const retryResponse = await fetch(url, { ...options, headers });
          const retryData = await retryResponse.json();
          if (!retryResponse.ok)
            throw { status: retryResponse.status, ...retryData };
          return retryData;
        }
        throw {
          status: 401,
          error: "Session expired",
          code: "SESSION_EXPIRED",
        };
      }

      if (!response.ok) {
        throw { status: response.status, ...data };
      }

      return data;
    } catch (err) {
      if (err.status) throw err;

      // Distinguish timeout from other network errors
      const isTimeout = err.name === "AbortError";
      const errorMsg = isTimeout
        ? "Request timed out. Server may be busy."
        : "Network error. Check your connection and server IP.";

      console.error(`❌ API Error: ${url}`, err.name, err.message);

      throw {
        status: 0,
        error: errorMsg,
        code: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
        details: err.message,
      };
    }
  }

  /**
   * Token refresh with de-duplication.
   * Multiple concurrent 401s only trigger one refresh.
   */
  async attemptTokenRefresh() {
    if (this.isRefreshing) {
      return new Promise((resolve) => this.refreshQueue.push(resolve));
    }

    this.isRefreshing = true;

    try {
      const deviceId = await this.getDeviceId();
      const response = await fetch(endpoints.auth.refresh, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: this.refreshToken, deviceId }),
      });

      if (!response.ok) {
        await this.clearTokens();
        this.refreshQueue.forEach((resolve) => resolve(false));
        this.refreshQueue = [];
        return false;
      }

      const data = await response.json();
      await this.setTokens(data.accessToken, data.refreshToken);

      this.refreshQueue.forEach((resolve) => resolve(true));
      this.refreshQueue = [];
      return true;
    } catch {
      await this.clearTokens();
      this.refreshQueue.forEach((resolve) => resolve(false));
      this.refreshQueue = [];
      return false;
    } finally {
      this.isRefreshing = false;
    }
  }

  // ─── Convenience methods ──────────────────────────────────────────────────
  get(url) {
    return this.request(url, { method: "GET" });
  }

  post(url, body) {
    return this.request(url, { method: "POST", body: JSON.stringify(body) });
  }

  put(url, body) {
    return this.request(url, { method: "PUT", body: JSON.stringify(body) });
  }

  delete(url) {
    return this.request(url, { method: "DELETE" });
  }

  /**
   * Upload a file via multipart/form-data.
   * Does NOT set Content-Type — lets fetch auto-set the boundary.
   */
  async uploadFile(url, formData) {
    const headers = {};
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    console.log(`📡 API UPLOAD ${url}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s for uploads
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      console.log(`📡 API UPLOAD ${url} → ${response.status}`);
      const data = await response.json();

      if (!response.ok) {
        throw { status: response.status, ...data };
      }

      return data;
    } catch (err) {
      if (err.status) throw err;

      const isTimeout = err.name === "AbortError";
      throw {
        status: 0,
        error: isTimeout
          ? "Upload timed out. Try a smaller image."
          : "Network error. Check your connection.",
        code: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      };
    }
  }

  /**
   * Upload with progress tracking via XMLHttpRequest.
   * Returns { promise, abort } — call abort() to cancel.
   *
   * @param {string} url - Upload endpoint
   * @param {FormData} formData - Multipart form data
   * @param {function} onProgress - Called with 0-1 progress value
   * @returns {{ promise: Promise<object>, abort: function }}
   */
  uploadWithProgress(url, formData, onProgress) {
    const self = this;

    const doUpload = (token) => {
      const xhr = new XMLHttpRequest();

      const promise = new Promise((resolve, reject) => {
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable && onProgress) {
            onProgress(e.loaded / e.total);
          }
        });

        xhr.addEventListener("load", async () => {
          try {
            const data = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(data);
            } else if (xhr.status === 401 && self.refreshToken) {
              // Token expired — attempt refresh and retry
              try {
                const refreshed = await self.attemptTokenRefresh();
                if (refreshed) {
                  // Retry with new token
                  const retryResult = doUpload(self.accessToken);
                  retryResult.promise.then(resolve).catch(reject);
                } else {
                  reject({
                    status: 401,
                    error: "Session expired",
                    code: "SESSION_EXPIRED",
                  });
                }
              } catch {
                reject({
                  status: 401,
                  error: "Session expired",
                  code: "SESSION_EXPIRED",
                });
              }
            } else {
              reject({ status: xhr.status, ...data });
            }
          } catch {
            reject({
              status: xhr.status,
              error: "Invalid server response",
              code: "PARSE_ERROR",
            });
          }
        });

        xhr.addEventListener("error", () => {
          reject({
            status: 0,
            error: "Network error. Check your connection.",
            code: "NETWORK_ERROR",
          });
        });

        xhr.addEventListener("timeout", () => {
          reject({
            status: 0,
            error: "Upload timed out. Try a smaller image.",
            code: "TIMEOUT",
          });
        });

        xhr.addEventListener("abort", () => {
          reject({
            status: 0,
            error: "Upload cancelled.",
            code: "CANCELLED",
          });
        });

        xhr.open("POST", url);
        xhr.timeout = 60000;

        if (token) {
          xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        }

        xhr.send(formData);
      });

      return {
        promise,
        abort: () => xhr.abort(),
      };
    };

    return doUpload(this.accessToken);
  }
}

// Singleton
const apiClient = new ApiClient();
export { STORAGE_KEYS };
export default apiClient;
