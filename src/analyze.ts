/**
 * Pure analysis: TurnEvent[] -> gap-bucketed aggregates, per-model rollups,
 * regime, leak attribution inputs, wrapped stats, biggest-miss / worst-day.
 *
 * The gap-bucket totals + turn counts + R/C produced here MUST match the
 * oracle exactly on identical inputs (that is the parity contract). The leak
 * attribution refinements (compaction exclusion, model-switch, sidechain) are
 * layered on top WITHOUT disturbing the raw buckets.
 */

import type { GapBuckets, GapClass, TurnEvent } from "./types.js";

const WARM_S = 300; // 5 minutes
const RECOV_S = 3600; // 60 minutes

/** Classify a turn by the gap to the previous turn in the same session. */
export function classifyGap(prevTs: number | null, ts: number): GapClass {
  if (prevTs === null) return "start";
  const gap = ts - prevTs;
  if (gap <= WARM_S) return "warm";
  if (gap <= RECOV_S) return "recoverable";
  return "cold";
}

/** A single turn annotated with its computed gap class and creation total. */
export interface AnnotatedTurn {
  ev: TurnEvent;
  gap: GapClass;
  creation: number;
  /** true if this turn's model differs from the previous turn's, same session. */
  modelSwitch: boolean;
}

export interface Aggregate {
  buckets: GapBuckets;
  sessions: number;
  turns: number;
  totals: { creation5m: number; creation1h: number; read: number };
  regime: "5m" | "1h" | "none";
  /** All turns annotated with gap class, in per-session time order. */
  annotated: AnnotatedTurn[];
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * Group events by sessionKey, sort each session by ts, and accumulate the
 * oracle-identical buckets plus annotations for downstream attribution.
 *
 * Tie-break note: the oracle uses Python's list.sort keyed on ts only (stable,
 * preserving file order for equal timestamps). We replicate that: a stable sort
 * on ts, preserving insertion order for ties. Because bucket sums are additive
 * over a session regardless of intra-session order, and gap classification only
 * depends on consecutive ts deltas, equal-ts ties (gap 0 => "warm") are handled
 * identically to the oracle.
 */
export function analyze(events: TurnEvent[]): Aggregate {
  const bySession = new Map<string, TurnEvent[]>();
  for (const ev of events) {
    let arr = bySession.get(ev.sessionKey);
    if (!arr) {
      arr = [];
      bySession.set(ev.sessionKey, arr);
    }
    arr.push(ev);
  }

  let warm = 0;
  let recoverable = 0;
  let cold = 0;
  let readsAfterRecoverableGap = 0;
  let creation5m = 0;
  let creation1h = 0;
  let readTotal = 0;
  let turns = 0;
  const turnCounts = { start: 0, warm: 0, recoverable: 0, cold: 0 };
  const annotated: AnnotatedTurn[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const rows of bySession.values()) {
    // Stable sort by ts (ties keep insertion/file order, like Python's sort).
    const indexed = rows.map((r, i) => ({ r, i }));
    indexed.sort((a, b) => (a.r.ts - b.r.ts) || (a.i - b.i));

    let prevTs: number | null = null;
    let prevModel: string | null = null;
    for (const { r: ev } of indexed) {
      turns++;
      const creation = ev.c5 + ev.c1;
      creation5m += ev.c5;
      creation1h += ev.c1;
      readTotal += ev.read;
      if (firstTs === null || ev.ts < firstTs) firstTs = ev.ts;
      if (lastTs === null || ev.ts > lastTs) lastTs = ev.ts;

      const gap = classifyGap(prevTs, ev.ts);
      const modelSwitch = prevModel !== null && ev.model !== prevModel;
      switch (gap) {
        case "start":
          cold += creation;
          turnCounts.start++;
          break;
        case "warm":
          warm += creation;
          turnCounts.warm++;
          break;
        case "recoverable":
          recoverable += creation;
          readsAfterRecoverableGap += ev.read;
          turnCounts.recoverable++;
          break;
        case "cold":
          cold += creation;
          turnCounts.cold++;
          break;
      }
      annotated.push({ ev, gap, creation, modelSwitch });
      prevTs = ev.ts;
      prevModel = ev.model;
    }
  }

  const creationTotal = warm + recoverable + cold;
  const regime: "5m" | "1h" | "none" =
    creation1h > creation5m && creation1h > 0
      ? "1h"
      : creation5m > 0 || creation1h > 0
        ? "5m"
        : "none";

  const buckets: GapBuckets = {
    warm,
    recoverable,
    cold,
    creationTotal,
    readsAfterRecoverableGap,
    turnCounts,
  };

  return {
    buckets,
    sessions: bySession.size,
    turns,
    totals: { creation5m, creation1h, read: readTotal },
    regime,
    annotated,
    firstTs,
    lastTs,
  };
}

/** Recoverable ratio R/C (0 when no creation). */
export function recoverableRatio(buckets: GapBuckets): number {
  return buckets.creationTotal > 0 ? buckets.recoverable / buckets.creationTotal : 0;
}
