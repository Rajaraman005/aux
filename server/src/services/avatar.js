/**
 * Auto-Generated Avatar Service.
 * Creates unique, deterministic SVG avatars from a seed string.
 * Geometric patterns with consistent color palettes per user.
 */

const COLORS = [
  ["#6366f1", "#818cf8"], // Indigo
  ["#8b5cf6", "#a78bfa"], // Violet
  ["#ec4899", "#f472b6"], // Pink
  ["#14b8a6", "#2dd4bf"], // Teal
  ["#f59e0b", "#fbbf24"], // Amber
  ["#ef4444", "#f87171"], // Red
  ["#3b82f6", "#60a5fa"], // Blue
  ["#10b981", "#34d399"], // Emerald
  ["#f97316", "#fb923c"], // Orange
  ["#06b6d4", "#22d3ee"], // Cyan
];

/**
 * Simple hash function for deterministic color selection.
 */
function hashSeed(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Generate an SVG avatar string.
 * @param {string} seed - Unique seed (user's avatar_seed)
 * @param {string} name - User's display name (for initials)
 * @param {number} size - Avatar size in pixels
 * @returns {string} SVG markup
 */
function generateAvatar(seed, name, size = 128) {
  const hash = hashSeed(seed);
  const [bgColor, accentColor] = COLORS[hash % COLORS.length];

  // Get initials (max 2 characters)
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // Generate geometric pattern based on hash
  const patternElements = [];
  for (let i = 0; i < 5; i++) {
    const subHash = hashSeed(seed + i.toString());
    const cx = 20 + (subHash % 88);
    const cy = 20 + ((subHash >> 4) % 88);
    const r = 8 + (subHash % 20);
    const opacity = 0.1 + (subHash % 15) / 100;
    patternElements.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${accentColor}" opacity="${opacity}"/>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
    <defs>
      <linearGradient id="bg-${seed}" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:${bgColor}"/>
        <stop offset="100%" style="stop-color:${accentColor}"/>
      </linearGradient>
    </defs>
    <rect width="128" height="128" rx="64" fill="url(#bg-${seed})"/>
    ${patternElements.join("\n    ")}
    <text x="64" y="64" text-anchor="middle" dominant-baseline="central"
          font-family="Inter, -apple-system, sans-serif" font-size="48" font-weight="700"
          fill="rgba(255,255,255,0.95)">${initials}</text>
  </svg>`;
}

/**
 * Generate avatar as Data URI (for embedding in responses).
 */
function generateAvatarDataUri(seed, name, size = 128) {
  const svg = generateAvatar(seed, name, size);
  const encoded = Buffer.from(svg).toString("base64");
  return `data:image/svg+xml;base64,${encoded}`;
}

module.exports = { generateAvatar, generateAvatarDataUri };
