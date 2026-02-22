/**
 * Design System — World-Class Theme.
 * Apple-level minimalism with glassmorphism depth.
 * Deep indigo-violet gradient palette, soft shadows, spring animations.
 */
import { StyleSheet, Dimensions } from "react-native";

const { width, height } = Dimensions.get("window");

// ─── Color Palette ───────────────────────────────────────────────────────────
export const colors = {
  // Primary gradient
  primary: "#6366f1",
  primaryLight: "#818cf8",
  primaryDark: "#4f46e5",
  accent: "#8b5cf6",
  accentLight: "#a78bfa",

  // Backgrounds (deep dark)
  bg: "#0a0a1a",
  bgCard: "#12122a",
  bgElevated: "#1a1a3e",
  bgGlass: "rgba(26, 26, 62, 0.7)",
  bgGlassBorder: "rgba(99, 102, 241, 0.15)",

  // Text
  textPrimary: "#f0f0ff",
  textSecondary: "#9999b3",
  textMuted: "#666680",
  textInverse: "#0a0a1a",

  // Status
  success: "#10b981",
  successLight: "#34d399",
  warning: "#f59e0b",
  error: "#ef4444",
  errorLight: "#f87171",
  info: "#3b82f6",

  // Online indicator
  online: "#10b981",
  offline: "#666680",
  busy: "#f59e0b",

  // Overlay
  overlay: "rgba(0, 0, 0, 0.6)",
  overlayLight: "rgba(0, 0, 0, 0.3)",
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
    color: "#fff",
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

// ─── Shadows (4-Level Elevation System) ──────────────────────────────────────
export const shadows = {
  sm: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  lg: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 8,
  },
  xl: {
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 24,
    elevation: 12,
  },
  glow: {
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 10,
  },
};

// ─── Animation Configs (Spring-based for Material 3 fluidity) ────────────────
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

  // Glassmorphism card
  glassCard: {
    backgroundColor: colors.bgGlass,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.bgGlassBorder,
    padding: spacing.lg,
    ...shadows.md,
  },

  // Primary gradient button
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.xl,
  },
  primaryButtonText: {
    ...typography.button,
    color: "#ffffff",
  },
  primaryButtonDisabled: {
    backgroundColor: colors.bgElevated,
    ...shadows.sm,
  },

  // Input field
  input: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "rgba(99, 102, 241, 0.1)",
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    color: colors.textPrimary,
  },
  inputFocused: {
    borderColor: colors.primary,
    backgroundColor: colors.bgCard,
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
    backgroundColor: "rgba(255, 255, 255, 0.06)",
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
    color: "#fff",
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
