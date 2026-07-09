/**
 * Micro-fixture unit tests. Each fixture is small enough that every bucket,
 * counterfactual, leak $, and score is hand-derived; the derivation is written
 * out in comments so a reviewer can check the arithmetic without running code.
 *
 * All fixtures use Claude Opus 4.8 (base $5/MTok) unless noted, so:
 *   P = 5e-6 $/token ; w5 = 1.25P = 6.25e-6 ; w1 = 2P = 1e-5 ; rd = 0.1P = 5e-7
 * Token counts are round millions to keep the math legible.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonlString } from "../src/parse.js";
import { analyze, recoverableRatio } from "../src/analyze.js";
import {
  counterfactual,
  efficiencyScore,
  leakRows,
  perModelTotals,
} from "../src/costmodel.js";
import type { LeakRow, TurnEvent } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFileSync(join(HERE, "fixtures", name), "utf8");
const parse = (name: string): TurnEvent[] =>
  parseJsonlString(fx(name), name, { seenIds: new Set<string>() });

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const leak = (rows: LeakRow[], cause: LeakRow["cause"]) => rows.find((r) => r.cause === cause)!;

describe("basic-5m fixture: buckets, counterfactual, leaks", () => {
  const events = parse("basic-5m.jsonl");
  const agg = analyze(events);

  it("classifies gaps into oracle buckets", () => {
    // m1 start(cold)=1e6, m2 warm=4e5, m3 recoverable=6e5, m4 cold=3e5
    expect(agg.buckets.warm).toBe(400_000);
    expect(agg.buckets.recoverable).toBe(600_000);
    expect(agg.buckets.cold).toBe(1_300_000);
    expect(agg.buckets.creationTotal).toBe(2_300_000);
    expect(agg.buckets.readsAfterRecoverableGap).toBe(500_000); // only m3's read
    expect(agg.buckets.turnCounts).toEqual({ start: 1, warm: 1, recoverable: 1, cold: 1 });
    expect(agg.regime).toBe("5m");
  });

  it("computes R/C", () => {
    near(recoverableRatio(agg.buckets), 600_000 / 2_300_000);
  });

  it("reconstructs actual + symmetric counterfactual (5m regime)", () => {
    const cf = counterfactual(agg.annotated, 1);
    // actual = 2.3e6*6.25e-6 + reads(1.4e6)*5e-7 = 14.375 + 0.70 = 15.075
    near(cf.actualCost, 15.075);
    // cost5m = 14.375 + m2read 9e5*5e-7(0.45) + m3read 5e5*6.25e-6(3.125) = 17.95
    near(cf.cost5m, 17.95);
    // cost1h: m1 10.0 ; m2 4.0+0.45 ; m3 (6e5*5e-7=0.30 + tail4e5*1e-5=4.00)+read0.25 ; m4 3.0
    //       = 10.0 + 4.45 + 4.55 + 3.0 = 22.0
    near(cf.cost1h, 22.0);
    near(cf.delta1hMinus5m, 22.0 - 17.95); // +4.05, 1h costs more (R/C 0.26 < 0.395)
    expect(cf.delta1hMinus5m).toBeGreaterThan(0);
    // tail = warm-median of session = {4e5} = 4e5 ; cost = 4e5*1e-5 = 4.0
    expect(cf.tailWriteTokens).toBe(400_000);
    near(cf.tailWriteCost, 4.0);
  });

  it("attributes leaks (tail can exceed saving -> ttl netLeak clamps to 0)", () => {
    const rows = leakRows(agg.annotated, /*totalWriteSpend*/ 14.375);
    // ttl netLeak = 6e5*6.25e-6 - (6e5*5e-7 + 4e5*1e-5) = 3.75 - 4.30 = -0.55 -> 0
    expect(leak(rows, "ttl-expiry-rewarm").tokens).toBe(600_000);
    near(leak(rows, "ttl-expiry-rewarm").dollars, 0);
    // cold = m1+m4 creation 1.3e6 at w5 = 8.125
    expect(leak(rows, "cold-start").tokens).toBe(1_300_000);
    near(leak(rows, "cold-start").dollars, 8.125);
    expect(leak(rows, "cold-start").informational).toBe(true);
    expect(leak(rows, "model-switch").tokens).toBe(0);
    expect(leak(rows, "compaction-rewrite").tokens).toBe(0);
    expect(leak(rows, "subagent-5m").tokens).toBe(0);
  });
});

describe("flat-fallback fixture: cache_creation absent -> flat field to c5", () => {
  const events = parse("flat-fallback.jsonl");
  it("routes flat cache_creation_input_tokens to c5 (5m)", () => {
    // f1 500k, f2 200k both via flat field
    expect(events).toHaveLength(2);
    expect(events[0].c5).toBe(500_000);
    expect(events[0].c1).toBe(0);
    expect(events[1].c5).toBe(200_000);
    const agg = analyze(events);
    expect(agg.totals.creation5m).toBe(700_000);
    expect(agg.totals.creation1h).toBe(0);
    // f1 start=cold 500k ; f2 gap 600s recoverable 200k
    expect(agg.buckets.cold).toBe(500_000);
    expect(agg.buckets.recoverable).toBe(200_000);
    expect(agg.buckets.readsAfterRecoverableGap).toBe(700_000);
  });
});

describe("dedup fixture: repeated message.id dropped (first wins)", () => {
  it("keeps 2 of 3 lines", () => {
    const events = parse("dedup.jsonl");
    expect(events).toHaveLength(2);
    const agg = analyze(events);
    expect(agg.turns).toBe(2);
    // dup@00:00 start cold 100k ; d2@00:02 warm 50k
    expect(agg.buckets.cold).toBe(100_000);
    expect(agg.buckets.warm).toBe(50_000);
    expect(agg.buckets.creationTotal).toBe(150_000);
  });
});

describe("model-switch fixture: per-model pricing + switch attribution", () => {
  const events = parse("model-switch.jsonl");
  const agg = analyze(events);
  it("flags only the turn whose model changed", () => {
    // ms1 opus start ; ms2 sonnet warm (switch) ; ms3 sonnet warm (no switch)
    const sw = agg.annotated.filter((a) => a.modelSwitch);
    expect(sw).toHaveLength(1);
    expect(sw[0].ev.model).toBe("claude-sonnet-4-6");
  });
  it("prices the switch leak at the SONNET rate ($3), not Opus", () => {
    const rows = leakRows(agg.annotated, 1);
    // ms2 creation 200k * 1.25 * 3e-6 = 0.75
    expect(leak(rows, "model-switch").tokens).toBe(200_000);
    near(leak(rows, "model-switch").dollars, 0.75);
  });
  it("rolls up per-model totals at distinct prices", () => {
    const { rows } = perModelTotals(agg.annotated);
    const opus = rows.find((r) => r.model === "claude-opus-4-8")!;
    const sonnet = rows.find((r) => r.model === "claude-sonnet-4-6")!;
    expect(opus.basePrice).toBe(5);
    expect(sonnet.basePrice).toBe(3);
    near(opus.actualCost, 300_000 * 1.25 * 5e-6); // 1.875
    near(sonnet.actualCost, (200_000 + 100_000) * 1.25 * 3e-6); // 1.125
  });
});

describe("sidechain fixture: isSidechain -> subagent 5m overhead row", () => {
  it("attributes sidechain creation to the subagent leak", () => {
    const events = parse("sidechain.jsonl");
    expect(events[1].isSidechain).toBe(true);
    const agg = analyze(events);
    const rows = leakRows(agg.annotated, 1);
    // sc2 creation 250k * 1.25 * 5e-6 = 1.5625
    expect(leak(rows, "subagent-5m").tokens).toBe(250_000);
    near(leak(rows, "subagent-5m").dollars, 1.5625);
    expect(leak(rows, "subagent-5m").informational).toBe(true);
  });
});

describe("compact fixture: compact-marked recoverable turn excluded from ttl bucket", () => {
  const events = parse("compact.jsonl");
  const agg = analyze(events);
  it("still classifies the raw gap buckets like the oracle", () => {
    // cp1 start cold 800k ; cp2 warm 100k ; cp3 recoverable 500k (compact line has no usage)
    expect(agg.buckets.cold).toBe(800_000);
    expect(agg.buckets.warm).toBe(100_000);
    expect(agg.buckets.recoverable).toBe(500_000);
    expect(agg.turns).toBe(3); // the system compact line is not a turn
  });
  it("marks cp3 with compactBoundaryBefore", () => {
    const cp3 = agg.annotated.find((a) => a.ev.ts === Date.parse("2026-06-01T00:20:00.000Z") / 1000)!;
    expect(cp3.ev.compactBoundaryBefore).toBe(true);
  });
  it("routes cp3 to compaction-rewrite, NOT ttl-expiry-rewarm", () => {
    const rows = leakRows(agg.annotated, 1);
    expect(leak(rows, "ttl-expiry-rewarm").tokens).toBe(0);
    expect(leak(rows, "compaction-rewrite").tokens).toBe(500_000);
    near(leak(rows, "compaction-rewrite").dollars, 500_000 * 1.25 * 5e-6); // 3.125
  });
});

describe("regime-1h fixture: symmetric counterfactual flips sign (1h cheaper)", () => {
  const events = parse("regime-1h.jsonl");
  const agg = analyze(events);
  it("detects 1h regime; recoverable-gap read carries R_read but 0 creation", () => {
    expect(agg.regime).toBe("1h");
    expect(agg.totals.creation1h).toBe(1_500_000);
    expect(agg.totals.creation5m).toBe(0);
    // h3 recoverable but pure read: creation 0, read 1.2e6
    expect(agg.buckets.recoverable).toBe(0);
    expect(agg.buckets.readsAfterRecoverableGap).toBe(1_200_000);
  });
  it("credits the recoverable read so 1h beats 5m", () => {
    const cf = counterfactual(agg.annotated, 1);
    // actual = 1.5e6*1e-5 + reads(2e6)*5e-7 = 15.0 + 1.0 = 16.0
    near(cf.actualCost, 16.0);
    // cost5m = 1.5e6*6.25e-6(9.375) + h3read 1.2e6*6.25e-6(7.5) + h2read 8e5*5e-7(0.4) = 17.275
    near(cf.cost5m, 17.275);
    // cost1h = h1 10.0 + h2 5.0+0.4 + h3 (0 + 0.6) = 16.0
    near(cf.cost1h, 16.0);
    // delta = 16.0 - 17.275 = -1.275  => 1h cheaper (subscriber-correct sign)
    near(cf.delta1hMinus5m, -1.275);
    expect(cf.delta1hMinus5m).toBeLessThan(0);
  });
});

describe("efficiency score: sub-100 when a real recoverable leak survives the tail", () => {
  // Construct a case where recoverable creation >> warm-median so netLeak > 0.
  // Session E: warm turn 100k (median), then a big recoverable re-warm 2,000,000.
  const jsonl = [
    `{"timestamp":"2026-08-01T00:00:00.000Z","sessionId":"E","message":{"id":"e1","model":"claude-opus-4-8","usage":{"cache_creation":{"ephemeral_5m_input_tokens":100000,"ephemeral_1h_input_tokens":0},"cache_read_input_tokens":0}}}`,
    `{"timestamp":"2026-08-01T00:02:00.000Z","sessionId":"E","message":{"id":"e2","model":"claude-opus-4-8","usage":{"cache_creation":{"ephemeral_5m_input_tokens":100000,"ephemeral_1h_input_tokens":0},"cache_read_input_tokens":0}}}`,
    `{"timestamp":"2026-08-01T00:20:00.000Z","sessionId":"E","message":{"id":"e3","model":"claude-opus-4-8","usage":{"cache_creation":{"ephemeral_5m_input_tokens":2000000,"ephemeral_1h_input_tokens":0},"cache_read_input_tokens":1000000}}}`,
  ].join("\n");
  const events = parseJsonlString(jsonl, "eff", { seenIds: new Set() });
  const agg = analyze(events);

  it("produces a netLeak>0 ttl row and a score in (0,100)", () => {
    const rows = leakRows(agg.annotated, 1);
    // warm-median(E) = median{100k} (only e2 is warm; e1 is start) = 100k
    // e3 recoverable netLeak = 2e6*6.25e-6 - (2e6*5e-7 + 1e5*1e-5)
    //   = 12.5 - (1.0 + 1.0) = 10.5
    near(leak(rows, "ttl-expiry-rewarm").dollars, 10.5);
    const score = efficiencyScore(agg.annotated, rows);
    // captured = read 1e6 * 0.9 * 5e-6 = 4.5 ; avoidable = 10.5 (+0 switch)
    // score = 100 * 4.5 / (4.5 + 10.5) = 30.0
    expect(score).toBeCloseTo(30.0, 1);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });
});

describe("malformed lines tolerated", () => {
  it("skips non-JSON and usage-less lines without throwing", () => {
    const jsonl = [
      "not json at all",
      "{ broken",
      `{"timestamp":"2026-09-01T00:00:00.000Z","sessionId":"X","type":"user","message":{"role":"user","content":"hi"}}`,
      `{"timestamp":"2026-09-01T00:00:01.000Z","sessionId":"X","message":{"id":"g1","model":"claude-opus-4-8","usage":{"cache_creation":{"ephemeral_5m_input_tokens":123456,"ephemeral_1h_input_tokens":0},"cache_read_input_tokens":0}}}`,
      "",
    ].join("\n");
    const events = parseJsonlString(jsonl, "x", { seenIds: new Set() });
    expect(events).toHaveLength(1);
    expect(events[0].c5).toBe(123_456);
  });
});
