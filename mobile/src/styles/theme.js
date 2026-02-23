/**
 * Design System — Light Theme with color variables.
 * White background, black text, easily swappable accent color.
 * Change `primary` to update the accent color across the entire app.
 */
import { StyleSheet, Dimensions } from "react-native";

const { width, height } = Dimensions.get("window");

// ─── Color Palette ───────────────────────────────────────────────────────────
export const colors = {
  // Primary accent — change this one value to re-theme the app
  primary: "#000000",
  primaryLight: "#333333",
  primaryDark: "#000000",
  accent: "#000000",
  accentLight: "#333333",

  // Backgrounds (light)
  bg: "#FFFFFF",
  bgCard: "#F5F5F5",
  bgElevated: "#EBEBEB",
  bgGlass: "rgba(245, 245, 245, 0.85)",
  bgGlassBorder: "rgba(0, 0, 0, 0.08)",

  // Text (dark on light)
  textPrimary: "#000000",
  textSecondary: "#666666",
  textMuted: "#999999",
  textInverse: "#FFFFFF",

  // Borders
  border: "rgba(0, 0, 0, 0.08)",
  borderLight: "rgba(0, 0, 0, 0.04)",

  // Status
  success: "#10b981",
  successLight: "#34d399",
  warning: "#f59e0b",
  error: "#ef4444",
  errorLight: "#f87171",
  info: "#3b82f6",

  // Online indicator
  online: "#10b981",
  offline: "#CCCCCC",
  busy: "#f59e0b",

  // Chat
  chatBubbleMine: "#000000",
  chatBubbleTheirs: "#F0F0F0",
  chatBubbleTextMine: "#FFFFFF",
  chatBubbleTextTheirs: "#000000",
  tabBarBg: "#FFFFFF",
  inputBarBg: "#FFFFFF",

  // Overlay
  overlay: "rgba(0, 0, 0, 0.5)",
  overlayLight: "rgba(0, 0, 0, 0.2)",
};

// ─── Typography ──────────────────────────────────────────────────────────────
export const typography = {
  h1: {
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -0.5,
    color: colors.textPrimary,
  },
  h2: {
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.3,
    color: colors.textPrimary,
  },
  h3: { fontSize: 20, fontWeight: "600", color: colors.textPrimary },
  body: {
    fontSize: 16,
    fontWeight: "400",
    lineHeight: 24,
    color: colors.textPrimary,
  },
  bodySmall: {
    fontSize: 14,
    fontWeight: "400",
    lineHeight: 20,
    color: colors.textSecondary,
  },
  caption: {
    fontSize: 12,
    fontWeight: "500",
    letterSpacing: 0.5,
    color: colors.textMuted,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
  },
  button: {
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.3,
    color: colors.textInverse,
  },
};

// ─── Spacing (4px grid) ─────────────────────────────────────────────────────
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
};

// ─── Border Radius ───────────────────────────────────────────────────────────
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 999,
};

// ─── Shadows ─────────────────────────────────────────────────────────────────
export const shadows = {
  sm: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },
  md: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 4,
  },
  lg: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  xl: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 12,
  },
  glow: {
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 10,
  },
};

// ─── Animation Configs ───────────────────────────────────────────────────────
export const animations = {
  spring: {
    damping: 20,
    stiffness: 300,
    mass: 0.8,
  },
  springBouncy: {
    damping: 12,
    stiffness: 200,
    mass: 0.6,
  },
  springGentle: {
    damping: 25,
    stiffness: 150,
    mass: 1,
  },
  duration: {
    fast: 150,
    normal: 300,
    slow: 500,
    verySlow: 800,
  },
};

// ─── Common Styles ───────────────────────────────────────────────────────────
export const commonStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  centerContent: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
  },

  // Glass card
  glassCard: {
    backgroundColor: colors.bgGlass,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.bgGlassBorder,
    padding: spacing.lg,
    ...shadows.md,
  },

  // Primary button
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.md,
  },
  primaryButtonText: {
    ...typography.button,
    color: colors.textInverse,
  },
  primaryButtonDisabled: {
    backgroundColor: colors.bgElevated,
    ...shadows.sm,
  },

  // Input field
  input: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    color: colors.textPrimary,
  },
  inputFocused: {
    borderColor: colors.primary,
    backgroundColor: colors.bg,
  },
  inputLabel: {
    ...typography.label,
    marginBottom: spacing.xs,
  },
  inputError: {
    borderColor: colors.error,
  },
  errorText: {
    ...typography.caption,
    color: colors.error,
    marginTop: spacing.xs,
  },

  // Divider
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },

  // Badge
  badge: {
    backgroundColor: colors.primary,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    minWidth: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textInverse,
  },
});

export const SCREEN_WIDTH = width;
export const SCREEN_HEIGHT = height;

export default {
  colors,
  typography,
  spacing,
  radius,
  shadows,
  animations,
  commonStyles,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
};
