/**
 * Per-model base input pricing + prompt-cache multipliers.
 *
 * Base input $/MTok values verified against Anthropic's live pricing docs:
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *   Fetched 2026-07-09. The cache multipliers below are stated on that same
 *   page ("Prompt caching" section) and are pinned; do not change without
 *   re-verifying against the pricing page:
 *     5-minute cache write = 1.25x base input
 *     1-hour   cache write = 2.00x base input
 *     cache read (hit)     = 0.10x base input
 *
 * Verified base input prices ($/MTok), 2026-07-09:
 *   Claude Fable 5 / Mythos 5 ................ $10
 *   Claude Opus 4.8 / 4.7 / 4.6 / 4.5 ........ $5
 *   Claude Opus 4.1 / 4 (legacy) ............. $15
 *   Claude Sonnet 5 (intro, thru 2026-08-31) . $2   (standard $3 from Sep 1)
 *   Claude Sonnet 4.6 / 4.5 / 4 .............. $3
 *   Claude Haiku 4.5 ......................... $1
 *   Claude Haiku 3.5 (legacy) ................ $0.80
 *
 * We price by the CURRENT list rate a user would pay today. For $-equivalent
 * subscriber framing we still use these API list rates.
 */

export const MULT_5M_WRITE = 1.25;
export const MULT_1H_WRITE = 2.0;
export const MULT_READ = 0.1;

/**
 * Break-even recoverable ratio for the pure-5m case:
 * 1h is cheaper exactly when R/C > (2 - 1.25) / (2 - 0.1) = 0.75 / 1.9.
 */
export const THRESHOLD = (MULT_1H_WRITE - MULT_5M_WRITE) / (MULT_1H_WRITE - MULT_READ);

/** Exact model-id -> base input $/MTok. Keys are lowercased canonical ids. */
const EXACT_PRICES: Record<string, number> = {
  // Fable / Mythos family
  "claude-fable-5": 10,
  "claude-mythos-5": 10,
  "claude-mythos-preview": 10,
  // Opus current
  "claude-opus-4-8": 5,
  "claude-opus-4-7": 5,
  "claude-opus-4-6": 5,
  "claude-opus-4-5": 5,
  // Opus legacy (higher tokenizer-era pricing)
  "claude-opus-4-1": 15,
  "claude-opus-4": 15,
  "claude-opus-4-0": 15,
  // Sonnet
  "claude-sonnet-5": 2, // introductory through 2026-08-31
  "claude-sonnet-4-6": 3,
  "claude-sonnet-4-5": 3,
  "claude-sonnet-4": 3,
  // Haiku
  "claude-haiku-4-5": 1,
  "claude-haiku-3-5": 0.8,
};

/** Family-generation fallback prices (matched after id normalization). */
interface FamilyRule {
  family: "opus" | "sonnet" | "haiku" | "fable" | "mythos";
  /** null = any generation; otherwise the specific major.minor to match. */
  gen: string | null;
  price: number;
}

/**
 * Ordered fallback rules. First match wins. More specific (with a generation)
 * entries come before the family-wide default.
 */
const FAMILY_RULES: FamilyRule[] = [
  // Opus: 4.1 and older were $15; 4.5+ are $5. Default unknown Opus to $5
  // (current generation) — most conservative for a modern corpus.
  { family: "opus", gen: "4-1", price: 15 },
  { family: "opus", gen: "4-0", price: 15 },
  { family: "opus", gen: null, price: 5 },
  // Sonnet: default $3 (4.x standard); Sonnet 5 handled by exact map.
  { family: "sonnet", gen: null, price: 3 },
  // Haiku: default $1 (4.5).
  { family: "haiku", gen: null, price: 1 },
  // Fable / Mythos: $10.
  { family: "fable", gen: null, price: 10 },
  { family: "mythos", gen: null, price: 10 },
];

export interface PriceResult {
  /** base input $/MTok */
  base: number;
  /** true if resolved via family fallback rather than exact id */
  fallback: boolean;
  /** true if the id is genuinely unknown (no exact, no family match) */
  unknown: boolean;
}

/**
 * Normalize a raw model id to a canonical `claude-<family>-<gen>` form by
 * stripping vendor prefixes (Bedrock `us.anthropic.`, Vertex, region tags) and
 * trailing date/version suffixes.
 *
 *   "us.anthropic.claude-opus-4-1-20250805-v1:0" -> "claude-opus-4-1"
 *   "anthropic.claude-3-5-haiku-20241022-v1:0"   -> "claude-3-5-haiku" (legacy order)
 *   "claude-opus-4-8"                            -> "claude-opus-4-8"
 */
export function normalizeModelId(raw: string): string {
  let id = raw.toLowerCase().trim();
  // Strip leading region/vendor prefixes up to and including "anthropic.".
  const anthIdx = id.indexOf("anthropic.");
  if (anthIdx >= 0) id = id.slice(anthIdx + "anthropic.".length);
  // Strip any remaining leading vendor dotted-prefix before "claude".
  const claudeIdx = id.indexOf("claude");
  if (claudeIdx > 0) id = id.slice(claudeIdx);
  // Drop a Bedrock version tag like ":0".
  id = id.replace(/:\d+$/, "");
  // Drop a trailing yyyymmdd(-vN) date/version stamp.
  id = id.replace(/-(\d{8})(-v\d+)?$/, "");
  id = id.replace(/-v\d+$/, "");
  return id;
}

/**
 * Detect family + generation from a normalized id.
 * Handles both new order ("claude-opus-4-1") and legacy order
 * ("claude-3-5-haiku") by locating the family keyword and the surrounding
 * numeric groups.
 */
function familyGen(id: string): { family: FamilyRule["family"] | null; gen: string | null } {
  const families: FamilyRule["family"][] = ["opus", "sonnet", "haiku", "fable", "mythos"];
  const family = families.find((f) => id.includes(f)) ?? null;
  if (!family) return { family: null, gen: null };
  // Collect numeric groups in order; join first two as "maj-min".
  const nums = id.match(/\d+/g) ?? [];
  let gen: string | null = null;
  if (nums.length >= 2) gen = `${nums[0]}-${nums[1]}`;
  else if (nums.length === 1) gen = nums[0];
  return { family, gen };
}

/** Resolve a base input $/MTok for a raw model id (with overrides applied). */
export function priceForModel(rawModel: string, overrides?: Record<string, number>): PriceResult {
  const norm = normalizeModelId(rawModel);
  if (overrides) {
    // Overrides may be keyed by:
    //   - a full/normalized id ("claude-opus-4-8"), matched exactly, or
    //   - a family/substring keyword ("opus"), matched if contained in the id.
    // Prefer the most specific (longest) matching key. Case-insensitive.
    let bestKey: string | null = null;
    for (const k of Object.keys(overrides)) {
      const lk = k.toLowerCase().trim();
      const nk = normalizeModelId(k);
      const matches =
        nk === norm || lk === rawModel.toLowerCase() || norm.includes(lk);
      if (matches && (bestKey === null || lk.length > bestKey.length)) bestKey = lk;
    }
    if (bestKey !== null) {
      // Recover the original-cased value for the matched key.
      for (const [k, v] of Object.entries(overrides)) {
        if (k.toLowerCase().trim() === bestKey) {
          return { base: v, fallback: false, unknown: false };
        }
      }
    }
  }
  const exact = EXACT_PRICES[norm];
  if (exact !== undefined) return { base: exact, fallback: false, unknown: false };

  const { family, gen } = familyGen(norm);
  if (family) {
    // Prefer a generation-specific rule, else the family default.
    const specific = FAMILY_RULES.find((r) => r.family === family && r.gen !== null && r.gen === gen);
    if (specific) return { base: specific.price, fallback: true, unknown: false };
    const dflt = FAMILY_RULES.find((r) => r.family === family && r.gen === null);
    if (dflt) return { base: dflt.price, fallback: true, unknown: false };
  }

  // Truly unknown. Use a neutral default so cost math still runs; caller flags
  // it as unknown only when the model carried non-zero billable tokens.
  return { base: 5, fallback: true, unknown: true };
}

/** Parse a `--price "opus=5,sonnet=3"` override string into a map. */
export function parsePriceOverride(spec: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of spec.split(",")) {
    const [k, v] = part.split("=");
    if (!k || v === undefined) continue;
    const num = Number(v.trim());
    if (Number.isFinite(num)) out[k.trim()] = num;
  }
  return out;
}
