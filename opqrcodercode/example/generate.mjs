/**
 * generate.mjs — Minimal OPQR Code generation example (Node.js, no bundler)
 *
 * Usage:
 *   node example/generate.mjs
 *
 * Output:
 *   example/output.txt  — ASCII-art preview of the generated QR code
 *
 * Dependencies: none (uses built-in Node.js APIs only)
 *
 * The example uses a grayscale image approximated by a simple gradient pattern.
 * In a real application, supply actual image pixels via an image library.
 */

import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the core QR encoder (CommonJS module)
const qrcodeFactory = require('../src/core/qrcode.js');

// ── Minimal inline implementations of ImageService helpers ───────────────────
// (In a full project, import from ../src/services/ImageService.ts after tsc)

function otsuThreshold(gray) {
  const hist = new Float64Array(256);
  for (const v of gray) hist[v]++;
  const N = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, max = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue;
    const wF = N - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > max) { max = between; threshold = t; }
  }
  return threshold;
}

function floydSteinbergDither(gray, width, height) {
  const JITTER = 15;
  const threshold = otsuThreshold(gray);
  const buf = new Float32Array(gray);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const ltr = y % 2 === 0;
    const xs = ltr
      ? Array.from({ length: width }, (_, i) => i)
      : Array.from({ length: width }, (_, i) => width - 1 - i);
    for (const x of xs) {
      const idx = y * width + x;
      const jitter = (Math.random() * 2 - 1) * JITTER;
      const t = Math.max(1, Math.min(254, threshold + jitter));
      const old = buf[idx];
      const nw = old < t ? 0 : 255;
      out[idx] = nw === 0 ? 1 : 0;   // 1 = dark module
      const err = old - nw;
      const fwd = ltr ? 1 : -1;
      if (x + fwd >= 0 && x + fwd < width)               buf[idx + fwd]               += err * 7 / 16;
      if (y + 1 < height) {
        if (x - fwd >= 0 && x - fwd < width)             buf[(y+1)*width + x - fwd]   += err * 3 / 16;
                                                          buf[(y+1)*width + x]          += err * 5 / 16;
        if (x + fwd >= 0 && x + fwd < width)             buf[(y+1)*width + x + fwd]   += err * 1 / 16;
      }
    }
  }
  return out;
}

// ── Example: generate OPQR Code ──────────────────────────────────────────────

const TEXT = 'OPQR code';
const VERSION = 7;
const ECL = 'L';
const NOISE = 0.05;   // 5% noise insertion

// Create a synthetic grayscale image (45×45 gradient for demonstration)
const QR_SIZE = 45;
const imagePixels = new Uint8Array(QR_SIZE * QR_SIZE);
for (let y = 0; y < QR_SIZE; y++) {
  for (let x = 0; x < QR_SIZE; x++) {
    // Diagonal gradient 0→255
    imagePixels[y * QR_SIZE + x] = Math.round(((x + y) / (2 * (QR_SIZE - 1))) * 255);
  }
}

// Binarize with serpentine+jitter Floyd-Steinberg
const binary = floydSteinbergDither(imagePixels, QR_SIZE, QR_SIZE);

// Build QR code
const qr = qrcodeFactory(VERSION, ECL);
qr.addData(TEXT, 'Byte');
qr.make();

const appliedMask = qr.__get_mask_pattern();
const bitmapper = qr.get_bitmapper();
const size = qr.__get_size();

// Embed image into padding codewords
for (let row = 0; row < size; row++) {
  for (let col = 0; col < size; col++) {
    const imgRow = Math.floor((row * QR_SIZE) / size);
    const imgCol = Math.floor((col * QR_SIZE) / size);
    bitmapper.plot_pixel(row, col, binary[imgRow * QR_SIZE + imgCol]);
  }
}

// Optional: noise insertion (simplified uniform version for the example)
if (NOISE > 0) {
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (Math.random() < NOISE) bitmapper.flip_pixel(row, col);
    }
  }
}

// Recompute ECC
qr.__clearCache();
qr.make(appliedMask);

// Render as ASCII art
const lines = [];
lines.push(`OPQR Code — text: "${TEXT}", version: ${VERSION}, ECL: ${ECL}, noise: ${NOISE * 100}%`);
lines.push(`Module count: ${qr.getModuleCount()}, mask pattern: ${qr.__get_mask_pattern()}`);
lines.push('');
for (let row = 0; row < qr.getModuleCount(); row++) {
  let line = '';
  for (let col = 0; col < qr.getModuleCount(); col++) {
    line += qr.isDark(row, col) ? '██' : '  ';
  }
  lines.push(line);
}

const outPath = path.join(__dirname, 'output.txt');
writeFileSync(outPath, lines.join('\n'));
console.log(`Generated ${qr.getModuleCount()}×${qr.getModuleCount()} OPQR Code`);
console.log(`ASCII preview written to ${outPath}`);
console.log('');
console.log('First 5 rows:');
lines.slice(3, 8).forEach(l => console.log(l));
