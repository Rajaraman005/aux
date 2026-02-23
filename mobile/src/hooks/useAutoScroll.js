/**
 * useAutoScroll — Elite scroll management for chat screens.
 *
 * Tracks distanceFromBottom = contentHeight - (scrollOffset + layoutHeight)
 * to determine if user is near the bottom of the list.
 *
 * Auto-scrolls only when near bottom.
 * Counts new messages when scrolled up for "New Messages" indicator.
 */
import { useRef, useState, useCallback } from "react";

const NEAR_BOTTOM_THRESHOLD = 150; // px

export default function useAutoScroll(flatListRef) {
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [newMessageCount, setNewMessageCount] = useState(0);

  // Track scroll metrics
  const scrollMetricsRef = useRef({
    contentHeight: 0,
    scrollOffset: 0,
    layoutHeight: 0,
  });

  const computeDistanceFromBottom = () => {
    const { contentHeight, scrollOffset, layoutHeight } =
      scrollMetricsRef.current;
    return contentHeight - (scrollOffset + layoutHeight);
  };

  /**
   * Attach to FlatList onScroll.
   */
  const onScroll = useCallback((event) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    scrollMetricsRef.current = {
      contentHeight: contentSize.height,
      scrollOffset: contentOffset.y,
      layoutHeight: layoutMeasurement.height,
    };

    const distance =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const nearBottom = distance <= NEAR_BOTTOM_THRESHOLD;
    setIsNearBottom(nearBottom);

    // Clear count when user scrolls back to bottom
    if (nearBottom) {
      setNewMessageCount(0);
    }
  }, []);

  /**
   * Smooth scroll to the very bottom.
   */
  const scrollToBottom = useCallback(
    (animated = true) => {
      if (flatListRef.current) {
        flatListRef.current.scrollToEnd({ animated });
        setNewMessageCount(0);
      }
    },
    [flatListRef],
  );

  /**
   * Call when a new message is received or sent.
   * Auto-scrolls if near bottom, otherwise increments count.
   */
  const onNewMessage = useCallback(
    (isMine = false) => {
      if (isMine || isNearBottom) {
        // Small delay to let FlatList render the new item
        setTimeout(() => scrollToBottom(true), 100);
      } else {
        setNewMessageCount((prev) => prev + 1);
      }
    },
    [isNearBottom, scrollToBottom],
  );

  /**
   * Attach to FlatList onContentSizeChange.
   * Updates content height tracking.
   */
  const onContentSizeChange = useCallback((_width, height) => {
    scrollMetricsRef.current.contentHeight = height;
  }, []);

  /**
   * Attach to FlatList onLayout.
   * Updates layout height tracking.
   */
  const onLayout = useCallback((event) => {
    scrollMetricsRef.current.layoutHeight = event.nativeEvent.layout.height;
  }, []);

  return {
    isNearBottom,
    newMessageCount,
    scrollToBottom,
    onNewMessage,
    onScroll,
    onContentSizeChange,
    onLayout,
  };
}
