import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SIZE = 128;
const pixels = new Uint8Array(SIZE * SIZE * 4);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mix = (a, b, t) => a + (b - a) * t;

function blend(x, y, r, g, b, alpha) {
  if (alpha <= 0) {
    return;
  }
  const index = (y * SIZE + x) * 4;
  const dstA = pixels[index + 3] / 255;
  const srcA = clamp(alpha, 0, 1);
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) {
    return;
  }
  pixels[index] = Math.round((r * srcA + pixels[index] * dstA * (1 - srcA)) / outA);
  pixels[index + 1] = Math.round((g * srcA + pixels[index + 1] * dstA * (1 - srcA)) / outA);
  pixels[index + 2] = Math.round((b * srcA + pixels[index + 2] * dstA * (1 - srcA)) / outA);
  pixels[index + 3] = Math.round(outA * 255);
}

function roundedRectAlpha(x, y, left, top, right, bottom, radius) {
  const cx = clamp(x + 0.5, left + radius, right - radius);
  const cy = clamp(y + 0.5, top + radius, bottom - radius);
  const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  return clamp(radius + 0.5 - distance, 0, 1);
}

function fillRoundedRect(left, top, right, bottom, radius, [r, g, b]) {
  for (let y = Math.floor(top); y < Math.ceil(bottom); y++) {
    for (let x = Math.floor(left); x < Math.ceil(right); x++) {
      blend(x, y, r, g, b, roundedRectAlpha(x, y, left, top, right, bottom, radius));
    }
  }
}

function segmentAlpha(x, y, x1, y1, x2, y2, width) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const lengthSq = vx * vx + vy * vy;
  const t = lengthSq === 0 ? 0 : clamp(((x - x1) * vx + (y - y1) * vy) / lengthSq, 0, 1);
  const px = x1 + t * vx;
  const py = y1 + t * vy;
  const distance = Math.hypot(x - px, y - py);
  return clamp(width / 2 + 0.5 - distance, 0, 1);
}

function drawLine(x1, y1, x2, y2, width, [r, g, b]) {
  const left = Math.floor(Math.min(x1, x2) - width);
  const right = Math.ceil(Math.max(x1, x2) + width);
  const top = Math.floor(Math.min(y1, y2) - width);
  const bottom = Math.ceil(Math.max(y1, y2) + width);
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      blend(x, y, r, g, b, segmentAlpha(x + 0.5, y + 0.5, x1, y1, x2, y2, width));
    }
  }
}

// Rounded dark tile with a subtle border.
fillRoundedRect(2, 2, 126, 126, 28, [48, 54, 61]);
fillRoundedRect(4, 4, 124, 124, 26, [13, 17, 23]);

// A soft green glow behind the mark.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const distance = Math.hypot(x - 64, y - 64);
    if (distance < 54) {
      const alpha = Math.pow(1 - distance / 54, 2) * 0.18;
      blend(x, y, 34, 197, 94, alpha);
    }
  }
}

// "< / >" terminal mark.
const light = [230, 237, 243];
const green = [34, 197, 94];
drawLine(50, 40, 30, 64, 8.5, light);
drawLine(30, 64, 50, 88, 8.5, light);
drawLine(78, 40, 98, 64, 8.5, green);
drawLine(98, 64, 78, 88, 8.5, green);
drawLine(54, 98, 74, 98, 7, light);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  Buffer.from(pixels.buffer, y * SIZE * 4, SIZE * 4).copy(raw, rowStart + 1);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = "assets/icon.png";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
