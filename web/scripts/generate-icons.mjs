#!/usr/bin/env node
/**
 * Generates the PWA icons into web/public/ — dependency-free (node:zlib
 * only): a dark square with an amber lightning bolt. Run once after changing
 * the palette/bolt; outputs are committed.
 *
 *   node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Icon palette — dark slate ground, solar-amber bolt. */
const BG = [16, 20, 24, 255]; // #101418 (matches manifest theme_color)
const BOLT = [255, 193, 7, 255]; // #FFC107

/** Lightning bolt polygon on a 1000×1000 design grid. */
const BOLT_POINTS = [
  [580, 60],
  [250, 560],
  [465, 560],
  [415, 940],
  [760, 400],
  [520, 400],
];

// --- minimal PNG encoder (8-bit RGBA, filter 0) ---------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(size, pixels) {
  // Every scanline prefixed with filter byte 0 (none).
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    pixels.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drawing --------------------------------------------------------------

/** Scanline-fill a convex-ish polygon (even-odd on sorted crossings). */
function fillPolygon(pixels, size, points, color) {
  const scale = size / 1000;
  const scaled = points.map(([x, y]) => [x * scale, y * scale]);
  const minY = Math.max(0, Math.floor(Math.min(...scaled.map(([, y]) => y))));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(...scaled.map(([, y]) => y))));
  for (let y = minY; y <= maxY; y++) {
    const crossings = [];
    for (let i = 0; i < scaled.length; i++) {
      const [x1, y1] = scaled[i];
      const [x2, y2] = scaled[(i + 1) % scaled.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.ceil(crossings[i]));
      const to = Math.min(size - 1, Math.floor(crossings[i + 1]));
      for (let x = from; x <= to; x++) {
        const idx = (y * size + x) * 4;
        pixels[idx] = color[0];
        pixels[idx + 1] = color[1];
        pixels[idx + 2] = color[2];
        pixels[idx + 3] = color[3];
      }
    }
  }
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = BG[0];
    pixels[i + 1] = BG[1];
    pixels[i + 2] = BG[2];
    pixels[i + 3] = BG[3];
  }
  fillPolygon(pixels, size, BOLT_POINTS, BOLT);
  return encodePng(size, pixels);
}

mkdirSync(PUBLIC_DIR, { recursive: true });
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  const path = join(PUBLIC_DIR, name);
  writeFileSync(path, renderIcon(size));
  console.log(`wrote ${path} (${size}×${size})`);
}