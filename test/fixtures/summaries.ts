/**
 * Hand-crafted fixture `Summary` objects for render tests. render.ts is
 * a pure function of Summary, so these let us snapshot-test all three
 * endings + card/--md/--compact without going through the analyzer at all.
 * Every number here is internally consistent (buckets sum to totals, R/C
 * matches buckets, leak shares sum sanely) but is otherwise a plausible,
 * round, easy-to-eyeball scenario — NOT derived from a real corpus.
 */

import type { Summary } from "../../src/types.js";

const NOW = 1783610914; // arbitrary fixed epoch-seconds anchor for determinism

/** Ending A: api-5m, above threshold — the recommender ("enable 1h"). */
export const fixtureEndingAEnable: Summary = {
  summaryVersion: 1,
  scoreVersion: 1,
  window: { mode: "days", days: 90, firstTs: NOW - 30 * 86400, lastTs: NOW, spanDays: 30 },
  scope: { project: null, sessions: 42, turns: 3100 },
  branch: "api-5m",
  branchEvidence: ["ANTHROPIC_API_KEY present (API billing)", "observed write regime: 5m", "=> API-billed, receiving 5m"],
  regime: "5m",
  ttlRealityCheck: { windowDays: 7, regime: "5m", creation5m: 8_200_000, creation1h: 0, received: "5m" },
  buckets: {
    warm: 12_000_000,
    recoverable: 9_000_000,
    cold: 4_000_000,
    creationTotal: 25_000_000,
    readsAfterRecoverableGap: 6_000_000,
    turnCounts: { start: 42, warm: 2400, recoverable: 550, cold: 108 },
  },
  tokens: { creationTotal: 25_000_000, creation5m: 25_000_000, creation1h: 0, readTotal: 180_000_000 },
  recoverableRatio: 9_000_000 / 25_000_000, // 0.36 — above the 0.3947 threshold when weighted with reads below
  threshold: 0.39473684210526316,
  aboveThreshold: true,
  perModel: [
    {
      model: "claude-opus-4-8",
      basePrice: 5,
      priceFallback: false,
      priceUnknown: false,
      creation5m: 25_000_000,
      creation1h: 0,
      read: 180_000_000,
      actualCost: 25_000_000 * 1.25 * 5e-6 + 180_000_000 * 0.1 * 5e-6,
      turns: 3100,
    },
  ],
  unknownModels: [],
  leaks: [
    {
      cause: "ttl-expiry-rewarm",
      label: "TTL-expiry re-warms (5–60m gaps)",
      tokens: 9_000_000,
      dollars: 420.5,
      shareOfWriteSpend: 0.27,
      informational: false,
    },
    {
      cause: "cold-start",
      label: "Session cold starts (>60m or session start)",
      tokens: 4_000_000,
      dollars: 25.0,
      shareOfWriteSpend: 0.016,
      informational: true,
    },
    {
      cause: "model-switch",
      label: "Model-switch invalidations",
      tokens: 500_000,
      dollars: 3.125,
      shareOfWriteSpend: 0.002,
      informational: false,
    },
    {
      cause: "compaction-rewrite",
      label: "Compaction rewrites",
      tokens: 0,
      dollars: 0,
      shareOfWriteSpend: 0,
      informational: false,
    },
    {
      cause: "subagent-5m",
      label: "Subagent 5m overhead",
      tokens: 0,
      dollars: 0,
      shareOfWriteSpend: 0,
      informational: true,
    },
  ],
  counterfactual: {
    // Internally consistent: |delta| must be smaller than cost5m ($246.25),
    // or the implied cost1h goes negative (the original -380 draft had that
    // bug — caught when the share templates started expressing the delta as
    // a share of the bill: 380/246.25 would be a nonsense 154%).
    actualCost: 25_000_000 * 1.25 * 5e-6 + 180_000_000 * 0.1 * 5e-6,
    cost5m: 25_000_000 * 1.25 * 5e-6 + 180_000_000 * 0.1 * 5e-6,
    cost1h: 25_000_000 * 1.25 * 5e-6 + 180_000_000 * 0.1 * 5e-6 - 80.0, // 1h is cheaper
    delta1hMinus5m: -80.0,
    tailWriteTokens: 1_200_000,
    tailWriteCost: 12.0,
    delta30d: -80.0,
    spanDays: 30,
  },
  efficiencyScore: 71.2,
  biggestMiss: {
    ts: NOW - 5 * 86400,
    isoTime: new Date((NOW - 5 * 86400) * 1000).toISOString(),
    project: "-Users-dev-widgetco-api",
    sessionKey: "abc123.jsonl:abc123",
    tokens: 441_000,
    dollars: 7.62,
  },
  worstDay: {
    day: "2026-06-28",
    tokens: 3_100_000,
    dollars: 62.4,
  },
  wrapped: {
    streakDays: 11,
    peakHour: 14,
    peakHourTurns: 420,
    biggestSessionKey: "big1.jsonl:big1",
    biggestSessionProject: "-Users-dev-widgetco-api",
    biggestSessionCreation: 5_200_000,
    activeDays: 24,
  },
  currency: "USD",
};

/** Ending B: api-5m, below threshold — "certified optimal" (5m already right). */
export const fixtureEndingBOptimal: Summary = {
  summaryVersion: 1,
  scoreVersion: 1,
  window: { mode: "days", days: 90, firstTs: NOW - 60 * 86400, lastTs: NOW, spanDays: 60 },
  scope: { project: null, sessions: 80, turns: 5200 },
  branch: "api-5m",
  branchEvidence: ["ANTHROPIC_API_KEY present (API billing)", "observed write regime: 5m", "=> API-billed, receiving 5m"],
  regime: "5m",
  ttlRealityCheck: { windowDays: 7, regime: "5m", creation5m: 3_100_000, creation1h: 0, received: "5m" },
  buckets: {
    warm: 30_000_000,
    recoverable: 2_000_000,
    cold: 8_000_000,
    creationTotal: 40_000_000,
    readsAfterRecoverableGap: 1_200_000,
    turnCounts: { start: 80, warm: 4500, recoverable: 90, cold: 530 },
  },
  tokens: { creationTotal: 40_000_000, creation5m: 40_000_000, creation1h: 0, readTotal: 320_000_000 },
  recoverableRatio: 2_000_000 / 40_000_000, // 0.05 — well below threshold
  threshold: 0.39473684210526316,
  aboveThreshold: false,
  perModel: [
    {
      model: "claude-sonnet-4-6",
      basePrice: 3,
      priceFallback: false,
      priceUnknown: false,
      creation5m: 40_000_000,
      creation1h: 0,
      read: 320_000_000,
      actualCost: 40_000_000 * 1.25 * 3e-6 + 320_000_000 * 0.1 * 3e-6,
      turns: 5200,
    },
  ],
  unknownModels: [],
  leaks: [
    {
      cause: "ttl-expiry-rewarm",
      label: "TTL-expiry re-warms (5–60m gaps)",
      tokens: 2_000_000,
      dollars: 18.2,
      shareOfWriteSpend: 0.09,
      informational: false,
    },
    {
      cause: "cold-start",
      label: "Session cold starts (>60m or session start)",
      tokens: 8_000_000,
      dollars: 30.0,
      shareOfWriteSpend: 0.15,
      informational: true,
    },
    {
      cause: "model-switch",
      label: "Model-switch invalidations",
      tokens: 0,
      dollars: 0,
      shareOfWriteSpend: 0,
      informational: false,
    },
    {
      cause: "compaction-rewrite",
      label: "Compaction rewrites",
      tokens: 0,
      dollars: 0,
      shareOfWriteSpend: 0,
      informational: false,
    },
    {
      cause: "subagent-5m",
      label: "Subagent 5m overhead",
      tokens: 0,
      dollars: 0,
      shareOfWriteSpend: 0,
      informational: true,
    },
  ],
  counterfactual: {
    actualCost: 40_000_000 * 1.25 * 3e-6 + 320_000_000 * 0.1 * 3e-6,
    cost5m: 40_000_000 * 1.25 * 3e-6 + 320_000_000 * 0.1 * 3e-6,
    cost1h: 40_000_000 * 1.25 * 3e-6 + 320_000_000 * 0.1 * 3e-6 + 96.0, // 1h would cost MORE
    delta1hMinus5m: 96.0,
    tailWriteTokens: 400_000,
    tailWriteCost: 8.0,
    delta30d: 48.0,
    spanDays: 60,
  },
  efficiencyScore: 96.3,
  biggestMiss: {
    ts: NOW - 20 * 86400,
    isoTime: new Date((NOW - 20 * 86400) * 1000).toISOString(),
    project: "-Users-dev-quietco-app",
    sessionKey: "def456.jsonl:def456",
    tokens: 88_000,
    dollars: 0.61,
  },
  worstDay: {
    day: "2026-06-15",
    tokens: 410_000,
    dollars: 4.1,
  },
  wrapped: {
    streakDays: 4,
    peakHour: 10,
    peakHourTurns: 260,
    biggestSessionKey: "big2.jsonl:big2",
    biggestSessionProject: "-Users-dev-quietco-app",
    biggestSessionCreation: 1_800_000,
    activeDays: 33,
  },
  currency: "USD",
};

/** Ending C: subscription — the receipt. Matches the real corpus shape. */
export const fixtureEndingCReceipt: Summary = {
  summaryVersion: 1,
  scoreVersion: 1,
  window: { mode: "days", days: 90, firstTs: NOW - 84 * 86400, lastTs: NOW, spanDays: 84 },
  scope: { project: null, sessions: 590, turns: 43774 },
  branch: "subscription",
  branchEvidence: ["observed write regime: 1h", "=> subscription (1h auto-active, no API provider hint, no 1h flag)"],
  regime: "1h",
  ttlRealityCheck: { windowDays: 7, regime: "1h", creation5m: 0, creation1h: 84_484_176, received: "1h" },
  buckets: {
    warm: 298_898_667,
    recoverable: 102_960_510,
    cold: 351_673_734,
    creationTotal: 753_532_911,
    readsAfterRecoverableGap: 706_678_910,
    turnCounts: { start: 590, warm: 40114, recoverable: 2121, cold: 949 },
  },
  tokens: { creationTotal: 753_532_911, creation5m: 4_070_381, creation1h: 749_462_530, readTotal: 14_241_056_613 },
  recoverableRatio: 0.13663704464263274,
  threshold: 0.39473684210526316,
  aboveThreshold: false,
  perModel: [
    {
      model: "claude-opus-4-8",
      basePrice: 5,
      priceFallback: false,
      priceUnknown: false,
      creation5m: 24326,
      creation1h: 552334177,
      read: 9549991838,
      actualCost: 10298.489726499916,
      turns: 28312,
    },
  ],
  unknownModels: [],
  leaks: [
    {
      cause: "ttl-expiry-rewarm",
      label: "TTL-expiry re-warms (5–60m gaps)",
      tokens: 102770623,
      dollars: 618.6003484999992,
      shareOfWriteSpend: 0.07325821207378146,
      informational: false,
    },
    {
      cause: "cold-start",
      label: "Session cold starts (>60m or session start)",
      tokens: 351673734,
      dollars: 2447.8952112499974,
      shareOfWriteSpend: 0.289893833643947,
      informational: true,
    },
    {
      cause: "model-switch",
      label: "Model-switch invalidations",
      tokens: 70273091,
      dollars: 513.86058875,
      shareOfWriteSpend: 0.06085432715692329,
      informational: false,
    },
    {
      cause: "compaction-rewrite",
      label: "Compaction rewrites",
      tokens: 189887,
      dollars: 1.931675,
      shareOfWriteSpend: 0.00022876006641567875,
      informational: false,
    },
    {
      cause: "subagent-5m",
      label: "Subagent 5m overhead",
      tokens: 0,
      dollars: 0,
      shareOfWriteSpend: 0,
      informational: true,
    },
  ],
  counterfactual: {
    actualCost: 16645.73241585009,
    cost5m: 18121.66781520016,
    cost1h: 15620.722612599773,
    delta1hMinus5m: -2500.9452026003855,
    tailWriteTokens: 3638862.5,
    tailWriteCost: 39.238210000000095,
    delta30d: -892.7977288710981,
    spanDays: 84.03735096064983,
  },
  efficiencyScore: 98.5,
  biggestMiss: {
    ts: 1783283154.094,
    isoTime: "2026-07-05T20:25:54.094Z",
    project: "-Users-dev-projects-orders-api",
    sessionKey: "9ee541aa-a41c-4ee1-9b88-99e4cbd2ba8e.jsonl:9ee541aa-a41c-4ee1-9b88-99e4cbd2ba8e",
    tokens: 612360,
    dollars: 7.02718,
  },
  worstDay: {
    day: "2026-06-10",
    tokens: 7641323,
    dollars: 49.210621499999995,
  },
  wrapped: {
    streakDays: 61,
    peakHour: 0,
    peakHourTurns: 4774,
    biggestSessionKey: "4e08e64f-59ec-4213-822c-f670fd2f7589.jsonl:4e08e64f-59ec-4213-822c-f670fd2f7589",
    biggestSessionProject: "-Users-dev-projects-web-dashboard",
    biggestSessionCreation: 21204722,
    activeDays: 68,
  },
  currency: "USD-equivalent (API list rates)",
};

/**
 * Zero-leak edge case: an honest empty corpus / all-zero leak rows (a real
 * possibility — no sidechain usage, compaction excluded). Used to test that
 * zero rows render gracefully instead of being hidden.
 */
export const fixtureAllZeroLeaks: Summary = {
  ...fixtureEndingBOptimal,
  biggestMiss: null,
  worstDay: null,
  leaks: fixtureEndingBOptimal.leaks.map((l) => ({ ...l, tokens: 0, dollars: 0, shareOfWriteSpend: 0 })),
  wrapped: { streakDays: 1, peakHour: 9, peakHourTurns: 0, biggestSessionKey: "", biggestSessionProject: "", biggestSessionCreation: 0, activeDays: 1 },
};

/**
 * Pathological write-heavy / read-light subscription corpus: uncachedCost <
 * actualCost, i.e. caching genuinely cost MORE than not caching would have
 * for this specific access pattern (large sequential 5m writes, almost no
 * reads to recoup the 1.25x/2x write markup). Numbers are the exact ones
 * from a real smoke-test run (4-turn synthetic session, single Opus 4.8
 * model, actualCost=$22.4125, perModel totals creation5m=3,550,000 read=450,000
 * -> uncachedCost = 3,550,000*5e-6 + 0 + 450,000*5e-6 = $20.00, so
 * uncachedCost - actualCost = -$2.4125). Exercises the honesty fix in
 * cachingSavedLine()/endingCertified()'s box line: "caching cost you $X MORE
 * than uncached" instead of a nonsensical negative "saved you -$X".
 */
export const fixtureNegativeCachingSavings: Summary = {
  ...fixtureEndingCReceipt,
  branch: "subscription",
  perModel: [
    {
      model: "claude-opus-4-8",
      basePrice: 5,
      priceFallback: false,
      priceUnknown: false,
      creation5m: 3_550_000,
      creation1h: 0,
      read: 450_000,
      actualCost: 22.4125,
      turns: 4,
    },
  ],
  counterfactual: {
    ...fixtureEndingCReceipt.counterfactual,
    actualCost: 22.4125,
  },
};

/**
 * Same pathological write-heavy/read-light shape as
 * fixtureNegativeCachingSavings, but on the api-5m branch with 5m already
 * optimal (decideEnding -> "B") so it exercises endingCertified()'s
 * box-safe "caching cost $X more than uncached" line specifically (the
 * receipt fixture above only exercises endingReceipt()'s line).
 */
export const fixtureNegativeCachingSavingsEndingB: Summary = {
  ...fixtureEndingBOptimal,
  perModel: [
    {
      model: "claude-opus-4-8",
      basePrice: 5,
      priceFallback: false,
      priceUnknown: false,
      creation5m: 3_550_000,
      creation1h: 0,
      read: 450_000,
      actualCost: 22.4125,
      turns: 4,
    },
  ],
  counterfactual: {
    ...fixtureEndingBOptimal.counterfactual,
    actualCost: 22.4125,
  },
};
