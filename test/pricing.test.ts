/**
 * Pricing table + family-fallback + id-normalization tests.
 * Base prices asserted here are the ones verified against Anthropic's pricing
 * docs on 2026-07-09 (see src/pricing.ts header).
 */

import { describe, expect, it } from "vitest";
import {
  MULT_1H_WRITE,
  MULT_5M_WRITE,
  MULT_READ,
  THRESHOLD,
  normalizeModelId,
  parsePriceOverride,
  priceForModel,
} from "../src/pricing.js";

describe("multipliers + threshold", () => {
  it("match the pinned cache multipliers", () => {
    expect(MULT_5M_WRITE).toBe(1.25);
    expect(MULT_1H_WRITE).toBe(2.0);
    expect(MULT_READ).toBe(0.1);
  });
  it("break-even ratio is 0.75/1.9 ~= 0.3947", () => {
    expect(THRESHOLD).toBeCloseTo(0.75 / 1.9, 10);
    expect(THRESHOLD).toBeCloseTo(0.3947, 4);
  });
});

describe("exact per-model base prices (verified 2026-07-09)", () => {
  const cases: Array<[string, number]> = [
    ["claude-opus-4-8", 5],
    ["claude-opus-4-7", 5],
    ["claude-opus-4-6", 5],
    ["claude-opus-4-5", 5],
    ["claude-opus-4-1", 15],
    ["claude-opus-4", 15],
    ["claude-sonnet-5", 2],
    ["claude-sonnet-4-6", 3],
    ["claude-sonnet-4-5", 3],
    ["claude-haiku-4-5", 1],
    ["claude-haiku-3-5", 0.8],
    ["claude-fable-5", 10],
    ["claude-mythos-5", 10],
  ];
  for (const [id, price] of cases) {
    it(`${id} = $${price}/MTok`, () => {
      const r = priceForModel(id);
      expect(r.base).toBe(price);
      expect(r.fallback).toBe(false);
      expect(r.unknown).toBe(false);
    });
  }
});

describe("id normalization strips vendor + date suffixes", () => {
  it("Bedrock us.anthropic prefix + date + version tag", () => {
    expect(normalizeModelId("us.anthropic.claude-opus-4-1-20250805-v1:0")).toBe("claude-opus-4-1");
  });
  it("plain anthropic. prefix", () => {
    expect(normalizeModelId("anthropic.claude-sonnet-4-6-20260101-v1:0")).toBe("claude-sonnet-4-6");
  });
  it("trailing yyyymmdd date", () => {
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });
});

describe("family fallback for unknown-but-recognizable ids", () => {
  it("a Bedrock-dated Opus id resolves to Opus family price via exact-after-normalize", () => {
    const r = priceForModel("us.anthropic.claude-opus-4-8-20260101-v1:0");
    expect(r.base).toBe(5);
    expect(r.unknown).toBe(false);
  });
  it("a future unknown Opus generation falls back to $5 (current Opus)", () => {
    const r = priceForModel("claude-opus-9-9");
    expect(r.base).toBe(5);
    expect(r.fallback).toBe(true);
    expect(r.unknown).toBe(false);
  });
  it("a future unknown Sonnet falls back to $3", () => {
    const r = priceForModel("claude-sonnet-9-0");
    expect(r.base).toBe(3);
    expect(r.fallback).toBe(true);
  });
  it("legacy Opus 4.1 generation via family rule when not in exact map", () => {
    // normalizes to claude-opus-4-1 which IS exact; test the rule path with a
    // hypothetical opus-4-0 dated id
    const r = priceForModel("anthropic.claude-opus-4-0-20250601-v1:0");
    expect(r.base).toBe(15);
  });
});

describe("truly unknown ids", () => {
  it("flag unknown + neutral $5 default", () => {
    const r = priceForModel("gpt-4o");
    expect(r.unknown).toBe(true);
    expect(r.base).toBe(5);
  });
  it("<synthetic> is unknown-by-family but only flagged when it carries tokens (caller's job)", () => {
    const r = priceForModel("<synthetic>");
    expect(r.unknown).toBe(true);
  });
});

describe("--price overrides", () => {
  it("parses opus=5,sonnet=3", () => {
    expect(parsePriceOverride("opus=5,sonnet=3")).toEqual({ opus: 5, sonnet: 3 });
  });
  it("override wins over the table (by family keyword)", () => {
    const r = priceForModel("claude-opus-4-8", { opus: 99 });
    expect(r.base).toBe(99);
    expect(r.unknown).toBe(false);
  });
  it("override by exact id", () => {
    const r = priceForModel("claude-opus-4-8", { "claude-opus-4-8": 7 });
    expect(r.base).toBe(7);
  });
});
