/**
 * Minimal zero-dependency PNG codec for the share card's post-processing
 * (cardimage.ts). macOS's `qlmanage -t` only emits SQUARE thumbnails, so the
 * card's non-square SVG comes back with a dead band under the content;
 * cardimage.ts uses this codec to decode that square, top-crop it back to
 * the card's true height, and re-encode — keeping the CLI at zero runtime
 * dependencies.
 *
 * Deliberately narrow: 8-bit RGBA (color type 6), non-interlaced only —
 * exactly what qlmanage emits (verified on a real thumbnail) — no palette,
 * no 16-bit, no grayscale. Anything else throws, and the caller's guard
 * path keeps the uncropped file (see cardimage.ts's cropCardPng). The
 * compression layer rides on node:zlib (PNG's IDAT is a standard zlib
 * stream); the scanline filters and chunk CRC-32 are implemented here.
 *
 * Decode handles all five standard scanline filters (None/Sub/Up/Average/
 * Paeth — real encoders mix them per row); encode writes filter 0 (None) on
 * every scanline, trading a few KB of deflate efficiency for simplicity.
 */

import { deflateSync, inflateSync } from "node:zlib";

/** The eight-byte PNG file signature. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per pixel — this codec is RGBA-only (see the module doc comment). */
const BPP = 4;

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel, exactly width*height*4 bytes. */
  pixels: Buffer;
}

// ---------------------------------------------------------------- CRC-32

/** Standard PNG CRC-32 lookup table (polynomial 0xedb88320), built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(...bufs: Buffer[]): number {
  let c = 0xffffffff;
  for (const buf of bufs) {
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- decode

/**
 * Read just the IHDR dimensions — no inflate, no unfiltering. Cheap way to
 * report/verify a PNG's pixel size. Throws if the buffer isn't a PNG whose
 * first chunk is IHDR (mandatory per the spec).
 */
export function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  if (buf.toString("latin1", 12, 16) !== "IHDR") throw new Error("IHDR is not the first chunk");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Decode an 8-bit RGBA, non-interlaced PNG to raw pixels. Ancillary chunks
 * (pHYs, iCCP, …) are skipped; multiple IDAT chunks are concatenated before
 * inflating, per the spec. Chunk CRCs are not verified — corruption surfaces
 * as an inflate/length error instead, which callers treat the same way.
 * Throws on anything outside the supported shape (see module doc comment).
 */
export function decodePng(buf: Buffer): RgbaImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = -1;
  let colorType = -1;
  let interlace = -1;
  let sawIHDR = false;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) throw new Error("truncated PNG chunk");
    if (type === "IHDR") {
      if (len !== 13) throw new Error("bad IHDR length");
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
      sawIHDR = true;
    } else if (type === "IDAT") {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    pos = dataEnd + 4; // skip the chunk CRC
  }
  if (!sawIHDR || idat.length === 0) throw new Error("missing IHDR/IDAT");
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`unsupported PNG shape (bit depth ${bitDepth}, color type ${colorType}) — this codec is 8-bit RGBA only`);
  }
  if (interlace !== 0) throw new Error("interlaced PNG unsupported");
  if (width <= 0 || height <= 0) throw new Error("empty PNG");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * BPP;
  if (raw.length < (stride + 1) * height) throw new Error("PNG pixel data too short");

  // Un-filter: each scanline is [filterType, ...stride bytes]; filters
  // predict from the reconstructed left/up/up-left BYTES (at BPP offset).
  const out = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    switch (filter) {
      case 0: // None
        raw.copy(out, dst, src, src + stride);
        break;
      case 1: // Sub
        for (let x = 0; x < stride; x++) {
          const left = x >= BPP ? out[dst + x - BPP] : 0;
          out[dst + x] = (raw[src + x] + left) & 0xff;
        }
        break;
      case 2: // Up
        for (let x = 0; x < stride; x++) {
          const up = y > 0 ? out[prev + x] : 0;
          out[dst + x] = (raw[src + x] + up) & 0xff;
        }
        break;
      case 3: // Average
        for (let x = 0; x < stride; x++) {
          const left = x >= BPP ? out[dst + x - BPP] : 0;
          const up = y > 0 ? out[prev + x] : 0;
          out[dst + x] = (raw[src + x] + ((left + up) >> 1)) & 0xff;
        }
        break;
      case 4: // Paeth
        for (let x = 0; x < stride; x++) {
          const a = x >= BPP ? out[dst + x - BPP] : 0;
          const b = y > 0 ? out[prev + x] : 0;
          const c = x >= BPP && y > 0 ? out[prev + x - BPP] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          out[dst + x] = (raw[src + x] + pred) & 0xff;
        }
        break;
      default:
        throw new Error(`unknown PNG filter type ${filter}`);
    }
  }
  return { width, height, pixels: out };
}

// ---------------------------------------------------------------- encode

function chunk(type: string, data: Buffer): Buffer {
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(typeBuf, data), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Encode raw RGBA pixels as a valid 8-bit color-type-6 PNG: IHDR + one IDAT
 * (filter 0 on every scanline, zlib-deflated) + IEND, all with correct
 * CRC-32s. Throws if the pixel buffer doesn't match width*height*4.
 */
export function encodePng(img: RgbaImage): Buffer {
  const { width, height, pixels } = img;
  const stride = width * BPP;
  if (width <= 0 || height <= 0 || pixels.length !== stride * height) {
    throw new Error("encodePng: pixel buffer does not match dimensions");
  }
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ crop

/** The first `rows` scanlines of `img` (bounds-clamped), as a zero-copy view. */
export function cropTop(img: RgbaImage, rows: number): RgbaImage {
  const h = Math.max(0, Math.min(rows, img.height));
  return { width: img.width, height: h, pixels: img.pixels.subarray(0, img.width * BPP * h) };
}
