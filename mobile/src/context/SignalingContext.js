/**
 * Signaling Context — Global WebSocket connection and presence.
 * Manages: online users, incoming calls, real-time chat events.
 * Ensures signaling works across all tabs.
 */
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import signalingClient from "../services/socket";
import { useAuth } from "./AuthContext";

const SignalingContext = createContext(null);

export function SignalingProvider({ children }) {
  const { accessToken } = useAuth();
  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const [incomingCall, setIncomingCall] = useState(null);

  useEffect(() => {
    if (!accessToken) return;

    signalingClient.connect(accessToken);

    // Listen for presence updates
    const unsubPresence = signalingClient.on("presence", (data) => {
      setOnlineUsers((prev) => {
        const next = new Set(prev);
        if (data.status === "online") next.add(data.userId);
        else next.delete(data.userId);
        return next;
      });
    });

    // Listen for presence list
    const unsubList = signalingClient.on("presence-list", (data) => {
      setOnlineUsers(new Set(data.users));
    });

    // Listen for incoming calls
    const unsubCall = signalingClient.on("incoming-call", (data) => {
      setIncomingCall(data);
    });

    return () => {
      unsubPresence();
      unsubList();
      unsubCall();
      signalingClient.disconnect();
    };
  }, [accessToken]);

  const clearIncomingCall = useCallback(() => {
    setIncomingCall(null);
  }, []);

  const value = {
    onlineUsers,
    incomingCall,
    clearIncomingCall,
    signalingClient,
  };

  return (
    <SignalingContext.Provider value={value}>
      {children}
    </SignalingContext.Provider>
  );
}

export function useSignaling() {
  const context = useContext(SignalingContext);
  if (!context)
    throw new Error("useSignaling must be used within SignalingProvider");
  return context;
}

export default SignalingContext;
