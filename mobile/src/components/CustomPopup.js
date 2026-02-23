/**
 * CustomPopup — Beautiful modal popup replacing system alerts.
 * Features: peace symbol icon, title, message, configurable buttons.
 *
 * Usage:
 *   <CustomPopup
 *     visible={showPopup}
 *     title="Friend request sent!"
 *     message="They'll be notified right away."
 *     buttons={[
 *       { text: "OK", onPress: () => setShowPopup(false), primary: true },
 *     ]}
 *     onClose={() => setShowPopup(false)}
 *   />
 */
import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Animated,
  StyleSheet,
  Image,
  Dimensions,
} from "react-native";

const peaceIcon = require("../../assets/pease-symbol.png");
const { width: SCREEN_WIDTH } = Dimensions.get("window");

export default function CustomPopup({
  visible = false,
  title = "",
  message = "",
  buttons = [],
  onClose,
}) {
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          damping: 18,
          stiffness: 280,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      scaleAnim.setValue(0);
      opacityAnim.setValue(0);
    }
  }, [visible]);

  // Default to a single OK button if none provided
  const finalButtons =
    buttons.length > 0
      ? buttons
      : [{ text: "OK", onPress: onClose, primary: true }];

  if (!visible) return null;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="none"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={styles.overlay}
        activeOpacity={1}
        onPress={onClose}
      >
        <Animated.View
          style={[
            styles.card,
            {
              opacity: opacityAnim,
              transform: [
                {
                  scale: scaleAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.85, 1],
                  }),
                },
              ],
            },
          ]}
        >
          {/* Icon */}
          <Image source={peaceIcon} style={styles.icon} resizeMode="contain" />

          {/* Title */}
          {title ? <Text style={styles.title}>{title}</Text> : null}

          {/* Message */}
          {message ? <Text style={styles.message}>{message}</Text> : null}

          {/* Buttons */}
          <View style={styles.buttonRow}>
            {finalButtons.map((btn, i) => (
              <TouchableOpacity
                key={i}
                style={[
                  styles.button,
                  btn.primary && styles.buttonPrimary,
                  btn.danger && styles.buttonDanger,
                  finalButtons.length === 1 && styles.buttonFull,
                ]}
                onPress={btn.onPress || onClose}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.buttonText,
                    btn.primary && styles.buttonTextPrimary,
                    btn.danger && styles.buttonTextDanger,
                  ]}
                >
                  {btn.text}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Animated.View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  card: {
    width: SCREEN_WIDTH * 0.82,
    maxWidth: 320,
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingTop: 28,
    paddingBottom: 20,
    paddingHorizontal: 24,
    alignItems: "center",
  },
  iconContainer: {
    marginBottom: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  icon: {
    width: 120,
    height: 120,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1A2E",
    textAlign: "center",
    marginBottom: 6,
  },
  message: {
    fontSize: 14,
    color: "#8E8E93",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 20,
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 10,
    width: "100%",
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#E5E5EA",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  buttonPrimary: {
    backgroundColor: "#1A1A2E",
    borderColor: "#1A1A2E",
  },
  buttonDanger: {
    backgroundColor: "rgba(239,68,68,0.08)",
    borderColor: "#EF4444",
  },
  buttonText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#1A1A2E",
  },
  buttonTextPrimary: {
    color: "#fff",
  },
  buttonTextDanger: {
    color: "#EF4444",
  },
  buttonFull: {
    flex: 0,
    paddingHorizontal: 40,
  },
});
