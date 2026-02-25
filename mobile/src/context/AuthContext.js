/**
 * Auth Context — Global Authentication State.
 * Manages: login/signup/verify flow, token persistence, auto-refresh.
 */
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import apiClient, { STORAGE_KEYS } from "../services/api";
import { endpoints } from "../config/api";
import {
  registerPushNotifications,
  unregisterPushNotifications,
} from "../services/notifications";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [pendingVerification, setPendingVerification] = useState(null); // { userId, email }

  // ─── Initialize from stored tokens ────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        await apiClient.init();
        const storedUser = await apiClient.getStoredUser();

        if (storedUser && apiClient.accessToken) {
          setUser(storedUser);
          setIsAuthenticated(true);

          // Verify token is still valid
          try {
            const fresh = await apiClient.get(endpoints.users.me);
            setUser(fresh);
            await apiClient.saveUser(fresh);
            // Register push token on app startup if authenticated
            // ★ FIX: Retry registration with backoff — a single failure
            // on cold start means no notifications until re-login
            registerPushNotificationsWithRetry();
          } catch (err) {
            // Token invalid — clear state
            if (err.code === "SESSION_EXPIRED") {
              await apiClient.clearTokens();
              setUser(null);
              setIsAuthenticated(false);
            }
          }
        }
      } catch (err) {
        console.error("Auth init error:", err);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // ─── Signup ───────────────────────────────────────────────────────────────
  const signup = useCallback(
    async ({ name, email, phone, password, confirmPassword }) => {
      const result = await apiClient.post(endpoints.auth.signup, {
        name,
        email,
        phone,
        password,
        confirmPassword,
      });
      setPendingVerification({ userId: result.userId, email });
      return result;
    },
    [],
  );

  // ─── Verify Email ─────────────────────────────────────────────────────────
  const verifyEmail = useCallback(
    async (code) => {
      if (!pendingVerification) throw { error: "No pending verification" };
      const result = await apiClient.post(endpoints.auth.verify, {
        userId: pendingVerification.userId,
        code,
      });
      setPendingVerification(null);

      // Auto-login: the verify endpoint now returns tokens + user
      if (result.accessToken && result.user) {
        await apiClient.setTokens(result.accessToken, result.refreshToken);
        await apiClient.saveUser(result.user);
        setUser(result.user);
        setIsAuthenticated(true);
      }

      return result;
    },
    [pendingVerification],
  );

  // ─── Resend Code ──────────────────────────────────────────────────────────
  const resendCode = useCallback(async () => {
    if (!pendingVerification) throw { error: "No pending verification" };
    return apiClient.post(endpoints.auth.resendCode, {
      userId: pendingVerification.userId,
    });
  }, [pendingVerification]);

  // ─── Login ────────────────────────────────────────────────────────────────
  const login = useCallback(async (email, password) => {
    const deviceId = await apiClient.getDeviceId();
    const result = await apiClient.post(endpoints.auth.login, {
      email,
      password,
      deviceId,
    });

    // Handle unverified email
    if (result.code === "EMAIL_NOT_VERIFIED") {
      setPendingVerification({ userId: result.userId, email });
      throw result;
    }

    await apiClient.setTokens(result.accessToken, result.refreshToken);
    await apiClient.saveUser(result.user);

    setUser(result.user);
    setIsAuthenticated(true);

    // Register push token after login with retry
    registerPushNotificationsWithRetry();

    return result;
  }, []);

  // ─── Logout ───────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    try {
      // Unregister push token before logout
      await unregisterPushNotifications();
    } catch {
      // Continue logout even if push unregister fails
    }
    try {
      const deviceId = await apiClient.getDeviceId();
      await apiClient.post(endpoints.auth.logout, { deviceId });
    } catch {
      // Logout even if server call fails
    }
    await apiClient.clearTokens();
    setUser(null);
    setIsAuthenticated(false);
    setPendingVerification(null);
  }, []);

  // ─── Refresh Profile ──────────────────────────────────────────────────────
  const refreshProfile = useCallback(async () => {
    try {
      const fresh = await apiClient.get(endpoints.users.me);
      setUser(fresh);
      await apiClient.saveUser(fresh);
      return fresh;
    } catch (err) {
      console.error("Profile refresh error:", err);
      throw err;
    }
  }, []);

  const value = {
    user,
    setUser,
    isLoading,
    isAuthenticated,
    pendingVerification,
    signup,
    verifyEmail,
    resendCode,
    login,
    logout,
    refreshProfile,
    accessToken: apiClient.accessToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}

export default AuthContext;

// ★ Push registration with retry — ensures token is always registered
async function registerPushNotificationsWithRetry(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const token = await registerPushNotifications();
      if (token) {
        console.log(`📱 Push token registered (attempt ${attempt})`);
        return token;
      }
    } catch (err) {
      console.warn(
        `📱 Push registration attempt ${attempt}/${maxRetries} failed:`,
        err.message || err,
      );
    }
    if (attempt < maxRetries) {
      // Wait 2^attempt seconds before retrying
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  console.error("📱 Push registration failed after all retries");
  return null;
}
