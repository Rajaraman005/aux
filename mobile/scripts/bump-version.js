#!/usr/bin/env node
/**
 * Auto-increment patch version in both app.json and package.json.
 * Also updates the version string shown in SettingsScreen.
 *
 * Runs automatically before every build via the "prebuild" npm script.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function bump(filePath, setter) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const json = JSON.parse(raw);
  setter(json);
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + "\n", "utf-8");
  return json.version ?? json.expo?.version;
}

// ── Bump package.json ──────────────────────────────────────────
const newVersion = bump(path.join(ROOT, "package.json"), (pkg) => {
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  pkg.version = `${major}.${minor}.${patch + 1}`;
});

// ── Sync app.json ──────────────────────────────────────────────
bump(path.join(ROOT, "app.json"), (cfg) => {
  cfg.expo.version = newVersion;
});

// ── Sync SettingsScreen version text ───────────────────────────
const settingsPath = path.join(ROOT, "src", "screens", "SettingsScreen.js");
if (fs.existsSync(settingsPath)) {
  let src = fs.readFileSync(settingsPath, "utf-8");
  src = src.replace(/Aux v[\d.]+/, `Aux v${newVersion}`);
  fs.writeFileSync(settingsPath, src, "utf-8");
}

console.log(`✅ Version bumped to ${newVersion}`);
