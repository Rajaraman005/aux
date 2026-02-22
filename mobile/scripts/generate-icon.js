/**
 * Generate a minimal valid 1024x1024 PNG icon.
 * Uses raw PNG binary construction — no external dependencies.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const WIDTH = 1024;
const HEIGHT = 1024;

// Create raw RGBA pixel data
const rawData = Buffer.alloc(HEIGHT * (1 + WIDTH * 4)); // +1 for filter byte per row

for (let y = 0; y < HEIGHT; y++) {
  const rowOffset = y * (1 + WIDTH * 4);
  rawData[rowOffset] = 0; // No filter

  for (let x = 0; x < WIDTH; x++) {
    const px = rowOffset + 1 + x * 4;
    // Dark navy background with centered gradient circle
    const cx = x - WIDTH / 2;
    const cy = y - HEIGHT / 2;
    const dist = Math.sqrt(cx * cx + cy * cy);
    const maxDist = WIDTH * 0.35;

    if (dist < maxDist) {
      // Gradient: indigo (#6366f1) → purple (#8b5cf6)
      const t = dist / maxDist;
      rawData[px + 0] = Math.round(99 + t * (139 - 99)); // R
      rawData[px + 1] = Math.round(102 + t * (92 - 102)); // G
      rawData[px + 2] = Math.round(241 + t * (246 - 241)); // B
      rawData[px + 3] = 255; // A
    } else {
      // Background: #0a0a1a
      rawData[px + 0] = 10;
      rawData[px + 1] = 10;
      rawData[px + 2] = 26;
      rawData[px + 3] = 255;
    }
  }
}

// Compress
const compressed = zlib.deflateSync(rawData, { level: 6 });

// Build PNG
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = crc32(Buffer.concat([typeBuffer, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeBuffer, data, crcBuf]);
}

// CRC32 for PNG
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ~crc;
}

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  signature,
  chunk("IHDR", ihdr),
  chunk("IDAT", compressed),
  chunk("IEND", Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, "..", "assets", "icon.png");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(`✅ Icon generated: ${outPath} (${png.length} bytes)`);
