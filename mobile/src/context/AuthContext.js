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
    return result;
  }, []);

  // ─── Logout ───────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
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

  const value = {
    user,
    isLoading,
    isAuthenticated,
    pendingVerification,
    signup,
    verifyEmail,
    resendCode,
    login,
    logout,
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
