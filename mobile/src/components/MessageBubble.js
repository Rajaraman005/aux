/**
 * MessageBubble — Memoized chat message bubble component.
 *
 * Prevents re-renders of all bubbles on state changes (typing, sending, etc.).
 * Only re-renders when the message content, status, or identity changes.
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Icon from "react-native-vector-icons/Feather";
import { colors, spacing } from "../styles/theme";

function formatMessageTime(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function MessageBubble({ item, isMine }) {
  return (
    <View
      style={[
        styles.bubbleRow,
        isMine ? styles.bubbleRowRight : styles.bubbleRowLeft,
      ]}
    >
      <View
        style={[
          styles.bubble,
          isMine ? styles.bubbleMine : styles.bubbleTheirs,
        ]}
      >
        <Text
          style={[
            styles.bubbleText,
            isMine ? styles.bubbleTextMine : styles.bubbleTextTheirs,
          ]}
        >
          {item.content}
        </Text>
        <View style={styles.bubbleFooter}>
          <Text style={[styles.bubbleTime, isMine && styles.bubbleTimeMine]}>
            {formatMessageTime(item.created_at)}
          </Text>
          {item.pending && (
            <Icon
              name="clock"
              size={10}
              color={colors.textMuted}
              style={styles.pendingIcon}
            />
          )}
        </View>
      </View>
    </View>
  );
}

// Custom equality check — only re-render when these fields change
function areEqual(prevProps, nextProps) {
  const p = prevProps.item;
  const n = nextProps.item;
  return (
    p.id === n.id &&
    p.tempId === n.tempId &&
    p.pending === n.pending &&
    p.content === n.content &&
    prevProps.isMine === nextProps.isMine
  );
}

export default React.memo(MessageBubble, areEqual);

const styles = StyleSheet.create({
  bubbleRow: {
    marginBottom: 6,
  },
  bubbleRowRight: {
    alignItems: "flex-end",
  },
  bubbleRowLeft: {
    alignItems: "flex-start",
  },
  bubble: {
    maxWidth: "78%",
    borderRadius: 18,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  bubbleMine: {
    backgroundColor: colors.chatBubbleMine,
    borderBottomRightRadius: 4,
  },
  bubbleTheirs: {
    backgroundColor: colors.chatBubbleTheirs,
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 21,
  },
  bubbleTextMine: {
    color: colors.chatBubbleTextMine,
  },
  bubbleTextTheirs: {
    color: colors.chatBubbleTextTheirs,
  },
  bubbleFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 4,
  },
  bubbleTime: {
    fontSize: 11,
    color: colors.textMuted,
  },
  bubbleTimeMine: {
    color: "rgba(255, 255, 255, 0.6)",
  },
  pendingIcon: {
    marginLeft: 4,
  },
});
