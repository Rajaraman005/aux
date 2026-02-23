/**
 * Signaling Context — Global WebSocket connection and presence.
 * Manages: online users, incoming calls, real-time chat events.
 * Ensures signaling works across all tabs.
 *
 * ★ Auto-clears zombie incoming calls on call-ended / call-rejected / call-failed.
 * ★ Exposes callManager for centralized call lifecycle control.
 */
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import signalingClient from "../services/socket";
import callManager from "../services/CallManager";
import SoundService from "../services/sounds";
import { useAuth } from "./AuthContext";

const SignalingContext = createContext(null);

export function SignalingProvider({ children }) {
  const { accessToken } = useAuth();
  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const [incomingCall, setIncomingCall] = useState(null);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  // Track which conversation the user is currently viewing (set by ChatScreen)
  const activeConversationRef = useRef(null);

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

    // Listen for incoming calls — play ringtone
    const unsubCall = signalingClient.on("incoming-call", (data) => {
      // Don't show incoming call if already in a call
      if (callManager.isActive) {
        signalingClient.rejectCall(data.callId, "busy");
        return;
      }
      setIncomingCall(data);
      SoundService.playRingtone();
    });

    // ★ Auto-clear zombie incoming calls
    const autoClearIncoming = (msg) => {
      setIncomingCall((prev) => {
        if (prev && prev.callId === msg.callId) {
          SoundService.stopRingtone();
          return null;
        }
        return prev;
      });
    };
    const unsubAutoEnd = signalingClient.on("call-ended", autoClearIncoming);
    const unsubAutoReject = signalingClient.on(
      "call-rejected",
      autoClearIncoming,
    );
    const unsubAutoFail = signalingClient.on("call-failed", autoClearIncoming);

    // Listen for new notifications
    const unsubNotif = signalingClient.on("notification:new", () => {
      setUnreadNotifCount((prev) => prev + 1);
    });

    // Listen for incoming messages — play message sound
    const unsubMsg = signalingClient.on("message-received", (data) => {
      // Don't play sound if user is viewing this conversation
      if (
        activeConversationRef.current &&
        data.conversationId === activeConversationRef.current
      ) {
        return;
      }
      SoundService.playMessage();
    });

    return () => {
      unsubPresence();
      unsubList();
      unsubCall();
      unsubAutoEnd();
      unsubAutoReject();
      unsubAutoFail();
      unsubNotif();
      unsubMsg();
      SoundService.cleanup();
      signalingClient.disconnect();
    };
  }, [accessToken]);

  const clearIncomingCall = useCallback(() => {
    setIncomingCall(null);
    SoundService.stopRingtone();
  }, []);

  const setActiveConversation = useCallback((conversationId) => {
    activeConversationRef.current = conversationId;
  }, []);

  const value = {
    onlineUsers,
    incomingCall,
    clearIncomingCall,
    signalingClient,
    callManager,
    unreadNotifCount,
    setUnreadNotifCount,
    setActiveConversation,
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
