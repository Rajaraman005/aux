/**
 * uuid.js — Lightweight UUID v4 generator for React Native.
 *
 * Uses Math.random() which is sufficient for upload IDs, temp IDs,
 * and other non-cryptographic purposes. Avoids the `uuid` npm package
 * which requires crypto.getRandomValues (not available in Hermes/JSC).
 *
 * For cryptographic needs (tokens, keys), use expo-crypto instead.
 */

const HEX_CHARS = "0123456789abcdef";

export function v4() {
  let uuid = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      uuid += "-";
    } else if (i === 14) {
      uuid += "4";
    } else if (i === 19) {
      uuid += HEX_CHARS[(Math.random() * 4) | 0x8];
    } else {
      uuid += HEX_CHARS[(Math.random() * 16) | 0];
    }
  }
  return uuid;
}

export default v4;