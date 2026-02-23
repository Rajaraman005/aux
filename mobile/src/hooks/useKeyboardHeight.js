/**
 * useKeyboardHeight — Cross-platform keyboard height tracking.
 *
 * iOS:  Uses keyboardWillShow/WillHide for 1:1 animation sync.
 * Android: Uses keyboardDidShow/DidHide (adjustResize handles layout).
 *
 * Returns { keyboardHeight, keyboardVisible, keyboardAnimDuration }
 */
import { useState, useEffect, useRef } from "react";
import { Keyboard, Platform } from "react-native";

const IS_IOS = Platform.OS === "ios";
const SHOW_EVENT = IS_IOS ? "keyboardWillShow" : "keyboardDidShow";
const HIDE_EVENT = IS_IOS ? "keyboardWillHide" : "keyboardDidHide";

export default function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardAnimDuration, setKeyboardAnimDuration] = useState(250);

  // Track latest values for cleanup safety
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const onShow = (event) => {
      if (!mountedRef.current) return;
      const { endCoordinates, duration } = event;
      setKeyboardHeight(endCoordinates.height);
      setKeyboardVisible(true);
      if (duration) {
        setKeyboardAnimDuration(duration);
      }
    };

    const onHide = (event) => {
      if (!mountedRef.current) return;
      setKeyboardHeight(0);
      setKeyboardVisible(false);
      if (event?.duration) {
        setKeyboardAnimDuration(event.duration);
      }
    };

    const showSub = Keyboard.addListener(SHOW_EVENT, onShow);
    const hideSub = Keyboard.addListener(HIDE_EVENT, onHide);

    return () => {
      mountedRef.current = false;
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return { keyboardHeight, keyboardVisible, keyboardAnimDuration };
}
