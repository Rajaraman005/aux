/**
 * SplashScreen — Swipeable onboarding with 3 pages.
 * Each page has different tagline text. Dots indicate current page.
 * "Get Started" → Signup, "Log In" → Login.
 */
import React, { useRef, useState, useEffect } from "react";
import {
  View,
  Text,
  Image,
  Animated,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  StatusBar,
  FlatList,
} from "react-native";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

const PAGES = [
  {
    tagline: "The App\nThat Lets You\nSpeak",
    subtitle: "Crystal-clear calls, anywhere in the world.",
  },
  {
    tagline: "Connect\nWith Anyone\nAnytime",
    subtitle: "High-quality audio and video, even on slow networks.",
  },
  {
    tagline: "Private.\nSecure.\nYours.",
    subtitle: "End-to-end encrypted calls that stay between you.",
  },
];

export default function SplashScreen({ navigation }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const imageScale = useRef(new Animated.Value(0.5)).current;
  const imageSlide = useRef(new Animated.Value(30)).current;
  const buttonFade = useRef(new Animated.Value(0)).current;
  const buttonSlide = useRef(new Animated.Value(40)).current;
  const textFade = useRef(new Animated.Value(1)).current;
  const carouselFade = useRef(new Animated.Value(0)).current;
  const carouselSlide = useRef(new Animated.Value(25)).current;
  const flatListRef = useRef(null);
  const autoScrollTimer = useRef(null);

  useEffect(() => {
    // Phase 1: Image entrance (scale + slide up)
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 800,
        useNativeDriver: true,
      }),
      Animated.spring(imageScale, {
        toValue: 1,
        damping: 12,
        stiffness: 100,
        mass: 0.8,
        useNativeDriver: true,
      }),
      Animated.timing(imageSlide, {
        toValue: 0,
        duration: 800,
        useNativeDriver: true,
      }),
    ]).start();

    // Phase 2: Carousel text (delayed fade+slide)
    setTimeout(() => {
      Animated.parallel([
        Animated.timing(carouselFade, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(carouselSlide, {
          toValue: 0,
          duration: 600,
          useNativeDriver: true,
        }),
      ]).start();
    }, 400);

    // Phase 3: Buttons (last to appear)
    setTimeout(() => {
      Animated.parallel([
        Animated.timing(buttonFade, {
          toValue: 1,
          duration: 500,
          useNativeDriver: true,
        }),
        Animated.spring(buttonSlide, {
          toValue: 0,
          damping: 18,
          stiffness: 180,
          useNativeDriver: true,
        }),
      ]).start();
    }, 700);
  }, []);

  // Auto-advance carousel every 3.5 seconds
  useEffect(() => {
    autoScrollTimer.current = setInterval(() => {
      const nextIndex = (activeIndex + 1) % PAGES.length;
      // Fade out, scroll, fade in
      Animated.timing(textFade, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start(() => {
        flatListRef.current?.scrollToIndex({
          index: nextIndex,
          animated: true,
        });
        Animated.timing(textFade, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }).start();
      });
    }, 3500);

    return () => clearInterval(autoScrollTimer.current);
  }, [activeIndex]);

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems.length > 0) {
      setActiveIndex(viewableItems[0].index);
    }
  }).current;

  const viewabilityConfig = useRef({
    viewAreaCoveragePercentThreshold: 50,
  }).current;

  const renderPage = ({ item }) => (
    <View style={styles.page}>
      <Animated.View style={{ opacity: textFade }}>
        <Text style={styles.tagline}>
          {item.tagline.split("\n").map((line, i, arr) => (
            <React.Fragment key={i}>
              {i === arr.length - 1 ? (
                <Text style={styles.taglineAccent}>{line}</Text>
              ) : (
                line
              )}
              {i < arr.length - 1 ? "\n" : ""}
            </React.Fragment>
          ))}
        </Text>
        <Text style={styles.subtitle}>{item.subtitle}</Text>
      </Animated.View>
    </View>
  );

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FAFAFA" />

      <Animated.View
        style={[
          styles.topSection,
          { opacity: fadeAnim, transform: [{ translateY: imageSlide }] },
        ]}
      >
        {/* Hero Image */}
        <Animated.View
          style={[
            styles.imageContainer,
            { transform: [{ scale: imageScale }] },
          ]}
        >
          <View style={styles.imageRing}>
            <Image
              source={require("../../assets/login-logo.jpeg")}
              style={styles.heroImage}
            />
          </View>
          <View style={styles.waveBadge}>
            <Image
              source={require("../../assets/sound-wave_9380640.png")}
              style={styles.waveBadgeIcon}
            />
          </View>
        </Animated.View>
      </Animated.View>

      {/* Swipeable Pages */}
      <Animated.View
        style={[
          styles.carouselSection,
          { opacity: carouselFade, transform: [{ translateY: carouselSlide }] },
        ]}
      >
        <FlatList
          ref={flatListRef}
          data={PAGES}
          renderItem={renderPage}
          keyExtractor={(_, i) => i.toString()}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          bounces={false}
        />

        {/* Dots */}
        <View style={styles.dotsRow}>
          {PAGES.map((_, i) => (
            <View
              key={i}
              style={[styles.dot, activeIndex === i && styles.dotActive]}
            />
          ))}
        </View>
      </Animated.View>

      {/* Bottom Section */}
      <Animated.View
        style={[
          styles.bottomSection,
          { opacity: buttonFade, transform: [{ translateY: buttonSlide }] },
        ]}
      >
        <TouchableOpacity
          style={styles.getStartedButton}
          onPress={() => navigation.navigate("Signup")}
          activeOpacity={0.85}
        >
          <Text style={styles.getStartedText}>Get Started</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => navigation.navigate("Login")}
          style={styles.loginLink}
        >
          <Text style={styles.loginLinkText}>
            Already have an account?{" "}
            <Text style={styles.loginLinkBold}>Log In</Text>
          </Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FAFAFA",
  },
  topSection: {
    alignItems: "center",
    paddingTop: 70,
  },

  // Hero Image
  imageContainer: {
    alignItems: "center",
    position: "relative",
  },
  imageRing: {
    width: 180,
    height: 180,
    borderRadius: 90,
    overflow: "hidden",
    backgroundColor: "#E8E4DF",
    borderWidth: 6,
    borderColor: "#E8E4DF",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
  },
  heroImage: {
    width: "100%",
    height: "100%",
    borderRadius: 90,
  },
  waveBadge: {
    position: "absolute",
    bottom: 6,
    right: -2,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#1A1A2E",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 5,
  },
  waveBadgeIcon: {
    width: 20,
    height: 20,
    tintColor: "#fff",
  },

  // Carousel
  carouselSection: {
    flex: 1,
    justifyContent: "center",
  },
  page: {
    width: SCREEN_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 36,
  },
  tagline: {
    fontSize: 38,
    fontWeight: "800",
    color: "#1A1A2E",
    textAlign: "center",
    lineHeight: 46,
    letterSpacing: -0.8,
    marginBottom: 14,
  },
  taglineAccent: {
    color: "#fdd63d",
  },
  subtitle: {
    fontSize: 16,
    color: "#8E8E93",
    textAlign: "center",
    lineHeight: 24,
    fontWeight: "400",
  },

  // Dots
  dotsRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    paddingBottom: 16,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#D1D1D6",
  },
  dotActive: {
    backgroundColor: "#1A1A2E",
    width: 24,
    borderRadius: 4,
  },

  // Bottom
  bottomSection: {
    paddingHorizontal: 28,
    paddingBottom: 50,
    alignItems: "center",
  },
  getStartedButton: {
    backgroundColor: "#1A1A2E",
    borderRadius: 16,
    height: 56,
    width: "100%",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#1A1A2E",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
    marginBottom: 16,
  },
  getStartedText: {
    fontSize: 17,
    fontWeight: "700",
    color: "#FFFFFF",
    letterSpacing: 0.3,
  },
  loginLink: {
    paddingVertical: 8,
  },
  loginLinkText: {
    fontSize: 15,
    color: "#8E8E93",
    fontWeight: "400",
  },
  loginLinkBold: {
    color: "#fdd63d",
    fontWeight: "700",
  },
});
