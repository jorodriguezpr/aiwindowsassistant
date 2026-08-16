#!/usr/bin/env node
/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */
/**
 * Generates assets/icon.ico (32x32, 32bpp) programmatically — no binary assets needed.
 * Draws an indigo rounded square with a white "A" (AiWindowsAssistant).
 * Usable standalone (node scripts/generate-icon.js) or via require() from the app.
 */
const fs = require('fs');
const path = require('path');

const SIZE = 32;

// 5x7 bitmap for letter "A"
const GLYPH_A = [
  '01110',
  '10001',
  '10001',
  '10001',
  '11111',
  '10001',
  '10001',
];

function buildPixels() {
  // BGRA pixel buffer, top-down logical layout (flipped when written, BMP is bottom-up)
  const px = new Uint8Array(SIZE * SIZE * 4);
  const indigo = [0x4f, 0x46, 0xe5]; // RGB
  const white = [0xff, 0xff, 0xff];
  const radius = 7;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      // Rounded-rect test
      const inX = x >= 2 && x < SIZE - 2;
      const inY = y >= 2 && y < SIZE - 2;
      let inside = inX && inY;
      if (inside) {
        // Corner rounding
        const cx = x < 2 + radius ? 2 + radius : x > SIZE - 3 - radius ? SIZE - 3 - radius : x;
        const cy = y < 2 + radius ? 2 + radius : y > SIZE - 3 - radius ? SIZE - 3 - radius : y;
        const dx = x - cx;
        const dy = y - cy;
        inside = dx * dx + dy * dy <= radius * radius;
      }
      if (!inside) {
        px[i + 3] = 0; // transparent
        continue;
      }
      px[i] = indigo[2]; // B
      px[i + 1] = indigo[1]; // G
      px[i + 2] = indigo[0]; // R
      px[i + 3] = 255; // A
    }
  }

  // Draw "A" scaled 3x (15x21), centered
  const scale = 3;
  const w = 5 * scale;
  const h = 7 * scale;
  const ox = Math.floor((SIZE - w) / 2);
  const oy = Math.floor((SIZE - h) / 2);
  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 5; gx++) {
      if (GLYPH_A[gy][gx] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const x = ox + gx * scale + sx;
          const y = oy + gy * scale + sy;
          const i = (y * SIZE + x) * 4;
          px[i] = white[2];
          px[i + 1] = white[1];
          px[i + 2] = white[0];
          px[i + 3] = 255;
        }
      }
    }
  }
  return px;
}

function generateIcon(outPath) {
  const px = buildPixels();

  // BITMAPINFOHEADER (height = 2 * SIZE: XOR bitmap + AND mask)
  const bih = Buffer.alloc(40);
  bih.writeUInt32LE(40, 0); // biSize
  bih.writeInt32LE(SIZE, 4); // biWidth
  bih.writeInt32LE(SIZE * 2, 8); // biHeight
  bih.writeUInt16LE(1, 12); // biPlanes
  bih.writeUInt16LE(32, 14); // biBitCount
  bih.writeUInt32LE(0, 16); // biCompression (BI_RGB)
  bih.writeUInt32LE(SIZE * SIZE * 4, 20); // biSizeImage

  // Pixel data bottom-up
  const xor = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    const srcRow = y * SIZE * 4;
    const dstRow = (SIZE - 1 - y) * SIZE * 4;
    Buffer.from(px.buffer, srcRow, SIZE * 4).copy(xor, dstRow);
  }

  // AND mask: 1bpp, rows padded to 32 bits -> 32px = 4 bytes/row * 32 rows
  const and = Buffer.alloc(SIZE * 4); // all zero = opaque where XOR alpha set; transparent pixels already alpha 0

  const image = Buffer.concat([bih, xor, and]);

  // ICONDIR + ICONDIRENTRY
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count

  const entry = Buffer.alloc(16);
  entry.writeUInt8(SIZE === 256 ? 0 : SIZE, 0); // width
  entry.writeUInt8(SIZE === 256 ? 0 : SIZE, 1); // height
  entry.writeUInt8(0, 2); // color count
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(image.length, 8); // bytes in resource
  entry.writeUInt32LE(6 + 16, 12); // offset

  const ico = Buffer.concat([header, entry, image]);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, ico);
  return outPath;
}

if (require.main === module) {
  const out = path.join(__dirname, '..', 'assets', 'icon.ico');
  generateIcon(out);
  console.log('Icon written to ' + out);
}

module.exports = { generateIcon };
