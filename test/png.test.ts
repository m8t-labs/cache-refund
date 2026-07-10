/**
 * Zero-dependency PNG codec tests (src/png.ts) — pure buffer work: no
 * qlmanage, no file IO, no spawned processes. The decoder must handle all
 * five standard scanline filters (real encoders mix them per row, and
 * qlmanage's output exercises them heavily); the round-trip and crop paths
 * are what cardimage.ts's thumbnail post-processing rides on.
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { cropTop, decodePng, encodePng, pngDimensions, type RgbaImage } from "../src/png.js";

// ---------------------------------------------------------------- helpers

/** Deterministic pseudo-random RGBA image (tiny LCG — no Math.random). */
function syntheticImage(width: number, height: number, seed = 42): RgbaImage {
  const pixels = Buffer.allocUnsafe(width * height * 4);
  let state = seed >>> 0;
  for (let i = 0; i < pixels.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    pixels[i] = state & 0xff;
  }
  return { width, height, pixels };
}

/** Solid-fill RGBA image. */
function solidImage(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const pixels = Buffer.allocUnsafe(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set(rgba, i * 4);
  return { width, height, pixels };
}

// Independent PNG builder with per-row filter control — deliberately NOT
// reusing src/png.ts's encoder (which only emits filter 0), so the decoder's
// Sub/Up/Average/Paeth paths are exercised against bytes this suite
// forward-filtered itself, with its own CRC-32 implementation.
const TEST_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function testCrc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TEST_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function testChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(testCrc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Forward-filter `img` with the given per-row filter types and wrap as a full PNG. */
function buildPngWithFilters(img: RgbaImage, filters: number[], overrides?: { colorType?: number; bitDepth?: number; interlace?: number }): Buffer {
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    const f = filters[y % filters.length];
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const cur = img.pixels[y * stride + x];
      const left = x >= 4 ? img.pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? img.pixels[(y - 1) * stride + x] : 0;
      const ul = x >= 4 && y > 0 ? img.pixels[(y - 1) * stride + x - 4] : 0;
      let v: number;
      switch (f) {
        case 0:
          v = cur;
          break;
        case 1:
          v = cur - left;
          break;
        case 2:
          v = cur - up;
          break;
        case 3:
          v = cur - ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - ul;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - ul);
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
          v = cur - pred;
          break;
        }
        default:
          throw new Error(`test builder: bad filter ${f}`);
      }
      raw[y * (stride + 1) + 1 + x] = v & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = overrides?.bitDepth ?? 8;
  ihdr[9] = overrides?.colorType ?? 6;
  ihdr[12] = overrides?.interlace ?? 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, testChunk("IHDR", ihdr), testChunk("IDAT", deflateSync(raw)), testChunk("IEND", Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ tests

describe("png codec (src/png.ts)", () => {
  it("encode -> decode round-trip preserves dimensions and every pixel byte", () => {
    const img = syntheticImage(9, 7);
    const decoded = decodePng(encodePng(img));
    expect(decoded.width).toBe(9);
    expect(decoded.height).toBe(7);
    expect(decoded.pixels.equals(img.pixels)).toBe(true);
  });

  it("decodes all five standard scanline filters (None/Sub/Up/Average/Paeth)", () => {
    const img = syntheticImage(8, 10);
    const png = buildPngWithFilters(img, [0, 1, 2, 3, 4, 4, 3, 2, 1, 0]);
    const decoded = decodePng(png);
    expect(decoded.pixels.equals(img.pixels)).toBe(true);
  });

  it("decodes multiple IDAT chunks as one zlib stream", () => {
    const img = syntheticImage(6, 6);
    const whole = encodePng(img);
    // split the single IDAT into two chunks byte-for-byte
    const idatLen = whole.readUInt32BE(8 + 12 + 13); // after signature+IHDR chunk
    const idatStart = 8 + 12 + 13 + 8;
    const idatData = whole.subarray(idatStart, idatStart + idatLen);
    const half = Math.floor(idatData.length / 2);
    const rebuilt = Buffer.concat([
      whole.subarray(0, 8 + 12 + 13), // signature + IHDR chunk
      testChunk("IDAT", Buffer.from(idatData.subarray(0, half))),
      testChunk("IDAT", Buffer.from(idatData.subarray(half))),
      testChunk("IEND", Buffer.alloc(0)),
    ]);
    expect(decodePng(rebuilt).pixels.equals(img.pixels)).toBe(true);
  });

  it("pngDimensions reads IHDR without decoding, and matches the encoder's output", () => {
    const png = encodePng(syntheticImage(31, 17));
    expect(pngDimensions(png)).toEqual({ width: 31, height: 17 });
    expect(() => pngDimensions(Buffer.from("not a png at all"))).toThrow();
  });

  it("cropTop: a 20x20 two-tone image cropped to 10 keeps only the top tone (full re-encode round trip)", () => {
    const top: [number, number, number, number] = [200, 30, 30, 255];
    const bottom: [number, number, number, number] = [30, 30, 200, 255];
    const img = solidImage(20, 20, top);
    for (let i = 20 * 10; i < 20 * 20; i++) img.pixels.set(bottom, i * 4);

    const cropped = decodePng(encodePng(cropTop(decodePng(encodePng(img)), 10)));
    expect(cropped.width).toBe(20);
    expect(cropped.height).toBe(10);
    for (let i = 0; i < 20 * 10; i++) {
      expect([cropped.pixels[i * 4], cropped.pixels[i * 4 + 1], cropped.pixels[i * 4 + 2], cropped.pixels[i * 4 + 3]]).toEqual(top);
    }
  });

  it("cropTop clamps out-of-range row counts instead of corrupting", () => {
    const img = syntheticImage(5, 5);
    expect(cropTop(img, 99).height).toBe(5);
    expect(cropTop(img, 0).height).toBe(0);
    expect(cropTop(img, -3).height).toBe(0);
  });

  it("rejects everything outside the 8-bit RGBA non-interlaced shape (the caller's keep-square guard path)", () => {
    const img = syntheticImage(4, 4);
    expect(() => decodePng(buildPngWithFilters(img, [0], { colorType: 2 }))).toThrow(/unsupported/);
    expect(() => decodePng(buildPngWithFilters(img, [0], { bitDepth: 16 }))).toThrow(/unsupported/);
    expect(() => decodePng(buildPngWithFilters(img, [0], { interlace: 1 }))).toThrow(/interlaced/);
    expect(() => decodePng(Buffer.from("png-bytes"))).toThrow(/not a PNG/);
  });

  it("encodePng validates the pixel buffer length against the dimensions", () => {
    expect(() => encodePng({ width: 3, height: 3, pixels: Buffer.alloc(3 * 3 * 4 - 1) })).toThrow();
  });
});
