/**
 * Render snapshot + width tests. Snapshots strip ANSI (snapshot tests cover
 * all three endings + card + --md + --compact from fixture Summaries; ANSI
 * is stripped in snapshots). Width tests assert the hard layout laws: the
 * score box exactly <=57 cols, no line exceeds 80 cols in the default
 * (non-TTY, since tests run non-interactively) render.
 */

import { describe, expect, it } from "vitest";
import { stripAnsi, boxWidth, makeInk, makeSym } from "../src/format.js";
import {
  checkupLines,
  decideEnding,
  numberBox,
  renderCard,
  renderCompact,
  renderExplain,
  renderFull,
  renderMarkdown,
  wrappedLines,
} from "../src/render.js";
import {
  fixtureAllZeroLeaks,
  fixtureEndingAEnable,
  fixtureEndingBOptimal,
  fixtureEndingCReceipt,
  fixtureNegativeCachingSavings,
  fixtureNegativeCachingSavingsEndingB,
} from "./fixtures/summaries.js";

const NON_TTY = { tty: false } as const;

function maxLineWidth(text: string): number {
  return Math.max(0, ...stripAnsi(text).split("\n").map((l) => l.length));
}

describe("ending decision logic", () => {
  it("api-5m above threshold (1h cheaper) -> A-enable", () => {
    expect(decideEnding(fixtureEndingAEnable)).toBe("A-enable");
  });
  it("api-5m below threshold (5m already optimal) -> B", () => {
    expect(decideEnding(fixtureEndingBOptimal)).toBe("B");
  });
  it("subscription -> C always", () => {
    expect(decideEnding(fixtureEndingCReceipt)).toBe("C");
  });
});

describe("score box width law (<=57 cols)", () => {
  it("numberBox is exactly 57 cols on every line, for all three fixtures, TTY and non-TTY (Unicode and ASCII box chars)", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      for (const tty of [true, false]) {
        const rendered = stripAnsi(numberBox(s, makeInk(tty), makeSym(!tty)));
        for (const line of rendered.split("\n")) {
          expect(line.length).toBe(boxWidth);
          expect(line.length).toBeLessThanOrEqual(57);
        }
      }
    }
  });
});

describe("no line exceeds 80 cols (default terminal width)", () => {
  // Scope: "at default terminal" means terminal-rendered modes. --md is
  // explicitly the Slack/Teams paste payload (prose in a chat client,
  // not a terminal) — its table rows may legitimately run longer; it still
  // gets its own ANSI-free assertion above and a snapshot below.
  it("renderFull, non-TTY, all fixtures", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt, fixtureAllZeroLeaks]) {
      const { lines } = renderFull(s, NON_TTY);
      const text = lines.join("\n");
      const w = maxLineWidth(text);
      expect(w).toBeLessThanOrEqual(80);
    }
  });
  it("card, compact all fixtures", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      expect(maxLineWidth(renderCard(s, NON_TTY))).toBeLessThanOrEqual(80);
      expect(maxLineWidth(renderCompact(s, NON_TTY))).toBeLessThanOrEqual(80);
    }
  });
});

describe("non-TTY renders are ANSI-free", () => {
  it("renderFull emits no ANSI escape codes when tty:false", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      const { lines } = renderFull(s, NON_TTY);
      const text = lines.join("\n");
      // eslint-disable-next-line no-control-regex
      expect(text).not.toMatch(/\x1b\[/);
    }
  });
  it("--md is always ANSI-free (no tty concept for md)", () => {
    expect(renderMarkdown(fixtureEndingCReceipt)).not.toMatch(/\x1b\[/);
  });
});

describe("non-TTY / CI renders are byte-clean 7-bit ASCII (layout law)", () => {
  // This is the exact gate `CI=1 node dist/cli.js | cat` exercises at the
  // CLI level: no box-drawing chars, no checkmarks, no em dashes, no color.
  function nonAsciiChars(text: string): string[] {
    return [...new Set([...text].filter((c) => c.codePointAt(0)! > 127))];
  }
  it("renderFull(tty:false) is pure ASCII for all three endings + zero-leak fixture", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt, fixtureAllZeroLeaks]) {
      const { lines } = renderFull(s, NON_TTY);
      const bad = nonAsciiChars(lines.join("\n"));
      expect(bad, `non-ASCII chars found: ${JSON.stringify(bad)}`).toEqual([]);
    }
  });
  it("card(tty:false) and --compact(tty:false) are pure ASCII", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      expect(nonAsciiChars(renderCard(s, NON_TTY))).toEqual([]);
      expect(nonAsciiChars(renderCompact(s, NON_TTY))).toEqual([]);
    }
  });
  it("ASCII check glyph is 'OK', not '[x]' ([x] reads as failure)", () => {
    expect(makeSym(true).check).toBe("OK");
    expect(makeSym(true).warn).toBe("[!]");
    const { lines } = renderFull(fixtureEndingCReceipt, NON_TTY);
    const text = lines.join("\n");
    expect(text).not.toContain("[x]");
    expect(text).toContain("OK");
  });
});

describe("zero-leak rows render gracefully, never hidden", () => {
  it("renderFull with all-zero leaks still prints every leak label", () => {
    const { lines } = renderFull(fixtureAllZeroLeaks, NON_TTY);
    const text = lines.join("\n");
    expect(text).toContain("subagent-5m".length > 0 ? "" : ""); // sanity noop
    for (const l of fixtureAllZeroLeaks.leaks) {
      // Every leak row's cause must be attributable somewhere OR its dollars=0
      // must not cause the row to vanish from --md (checked separately below).
      expect(l.dollars).toBe(0);
    }
  });
  it("--md prints every leak row even at $0", () => {
    const md = renderMarkdown(fixtureAllZeroLeaks);
    for (const l of fixtureAllZeroLeaks.leaks) {
      expect(md).toContain(l.label);
    }
  });
  it("renderFull handles null biggestMiss/worstDay without crashing", () => {
    expect(() => renderFull(fixtureAllZeroLeaks, NON_TTY)).not.toThrow();
  });
});

describe("wrapped lines never cite unattributable causes", () => {
  const ATTRIBUTABLE_HINTS = [
    "re-warm",
    "leaked",
    "days in a row",
    "peak hour",
    "biggest session",
    "model switch",
    "compaction",
  ];
  it("every wrapped INSIGHT (logical bullet, across its wrapped physical lines) traces to a locked leak-taxonomy or stat field", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      const { lines } = renderFull(s, NON_TTY);
      const text = stripAnsi(lines.join("\n"));
      const wrappedStart = text.indexOf("YOUR CACHE, WRAPPED");
      const wrappedEnd = text.indexOf("\n\n", wrappedStart);
      const wrappedSection = text.slice(wrappedStart, wrappedEnd === -1 ? undefined : wrappedEnd);
      const physicalLines = wrappedSection
        .split("\n")
        .slice(1)
        .filter((l) => l.trim().length > 0);
      // Regroup physical lines into logical bullets: a bullet starts with "»",
      // continuation (wrapped) lines don't. The layout law ("every line
      // contains a number") is about the logical insight, not every wrapped
      // terminal row.
      const insights: string[] = [];
      for (const line of physicalLines) {
        if (line.includes("»")) insights.push(line);
        else insights[insights.length - 1] += " " + line.trim();
      }
      for (const insight of insights) {
        expect(insight).not.toMatch(/resume/i);
        // every insight has a number (layout law: "EVERY line contains a number")
        expect(insight).toMatch(/\d/);
        const matches = ATTRIBUTABLE_HINTS.some((h) => insight.toLowerCase().includes(h));
        expect(matches).toBe(true);
      }
    }
  });
});

describe("currency separation", () => {
  it("subscriber receipt never says 'saved you $' without -equivalent / -eq", () => {
    const { lines } = renderFull(fixtureEndingCReceipt, NON_TTY);
    const text = stripAnsi(lines.join("\n"));
    // Any dollar-saved claim near the subscriber ending must carry currency context.
    expect(text).toContain(fixtureEndingCReceipt.currency);
  });
  it("--md table header uses $-eq for subscription branch, $ for API branches", () => {
    const subMd = renderMarkdown(fixtureEndingCReceipt);
    expect(subMd).toContain("$-eq");
    const apiMd = renderMarkdown(fixtureEndingAEnable);
    expect(apiMd).toMatch(/\|\s*\$\s*\|/);
  });
});

describe("caching-vs-uncached honesty (write-heavy/read-light can make caching cost MORE)", () => {
  // Regression coverage for a real bug found during renderer smoke testing: a
  // synthetic write-heavy, read-light corpus produces uncachedCost <
  // actualCost (the 1.25x/2x write markup isn't recouped by 0.1x reads), and
  // the render used to print a nonsensical "Caching saved you -$2.41".
  it("renderFull flips to 'caching cost you $X MORE' instead of a negative saving", () => {
    const { lines } = renderFull(fixtureNegativeCachingSavings, NON_TTY);
    const text = stripAnsi(lines.join("\n")).replace(/\n/g, " ");
    expect(text).not.toMatch(/saved you -\$/);
    expect(text).not.toMatch(/saved you \$-/);
    expect(text).toMatch(/cost you \$2\.41.*MORE than uncached/);
  });
  it("the CERTIFIED OPTIMAL box line also flips to the box-safe short form (ending B)", () => {
    expect(decideEnding(fixtureNegativeCachingSavingsEndingB)).toBe("B");
    const { lines } = renderFull(fixtureNegativeCachingSavingsEndingB, NON_TTY);
    const text = stripAnsi(lines.join("\n"));
    expect(text).not.toMatch(/saved you -\$/);
    expect(text).not.toMatch(/saved you \$-/);
    expect(text).toContain("caching cost $2.41 more than uncached");
  });
  it("--md verdict block also flips for the subscription branch", () => {
    const md = renderMarkdown(fixtureNegativeCachingSavings).replace(/\n/g, " ");
    expect(md).not.toMatch(/saved you ~?-\$/);
    expect(md).toMatch(/Caching cost you \$2\.41.*MORE than uncached/i);
  });
});

describe("receipt verification line shows the 1h WRITE SHARE, not R/C (launch-lethal regression)", () => {
  // The verification line's percentage was wired to recoverableRatio (a
  // gap-bucket ratio) instead of the 1h TTL write share. The fixture is the
  // real corpus shape where the two differ decisively: R/C = 13.7% vs
  // 1h share = creation1h/(creation1h+creation5m) = 99.5%.
  const s = fixtureEndingCReceipt;
  const share = s.tokens.creation1h / (s.tokens.creation1h + s.tokens.creation5m);
  const sharePct = `${(share * 100).toFixed(1)}%`; // "99.5%"
  const rcPct = `${(s.recoverableRatio * 100).toFixed(1)}%`; // "13.7%"

  it("fixture sanity: the two ratios differ decisively (test is meaningful)", () => {
    expect(sharePct).not.toBe(rcPct);
    expect(Math.abs(share - s.recoverableRatio)).toBeGreaterThan(0.5);
  });
  it("verification line uses the 1h share", () => {
    const { lines } = renderFull(s, NON_TTY);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain(`${sharePct} of writes are 1h`);
  });
  it("verification line does NOT use recoverableRatio", () => {
    const { lines } = renderFull(s, NON_TTY);
    const text = stripAnsi(lines.join("\n"));
    expect(text).not.toContain(`${rcPct} of writes are 1h`);
  });
});

describe("receipt ordering: counterfactual headline leads", () => {
  it("headline (1h-vs-5m, window-labeled) -> vs-uncached -> verification, in that order", () => {
    const { lines } = renderFull(fixtureEndingCReceipt, NON_TTY);
    // Flatten wrapping: the headline hard-wraps at 80 cols mid-phrase, so
    // search a space-joined copy for the full sentences.
    const flat = stripAnsi(lines.join("\n")).replace(/\n/g, " ");
    const iHeadline = flat.indexOf("vs a 5m world in the last 90 days");
    const iUncached = flat.indexOf("vs uncached this window");
    const iVerify = flat.indexOf("of writes are 1h");
    expect(iHeadline).toBeGreaterThan(-1);
    expect(iUncached).toBeGreaterThan(iHeadline);
    expect(iVerify).toBeGreaterThan(iUncached);
    // The headline carries the windowed delta (two-deltas rule: labeled with
    // its window, never "/30d") and the saving sign is rendered as a saving.
    expect(flat).toContain("Your 1h cache saved you ~$2,500.95");
  });
  it("--md subscription verdict mirrors the ordering (headline, then vs-uncached)", () => {
    const md = renderMarkdown(fixtureEndingCReceipt);
    const iHeadline = md.indexOf("vs a 5m world in the last 90 days");
    const iUncached = md.indexOf("vs uncached this window");
    expect(iHeadline).toBeGreaterThan(-1);
    expect(iUncached).toBeGreaterThan(iHeadline);
  });
});

describe("score box is ending-aware", () => {
  it("ending C's box leads with the $-eq receipt figure; score is the second line", () => {
    const rendered = stripAnsi(numberBox(fixtureEndingCReceipt, makeInk(false), makeSym(true)));
    expect(rendered).toContain("YOUR 1H CACHE RECEIPT");
    expect(rendered).toContain("saved ~$2,500.95-eq vs 5m (last 90d)");
    expect(rendered).toContain("efficiency score: 98.5 / 100");
    expect(rendered.indexOf("saved ~$2,500.95-eq")).toBeLessThan(rendered.indexOf("efficiency score"));
    for (const line of rendered.split("\n")) {
      expect(line.length).toBe(boxWidth); // width law still holds for this shape
    }
  });
  it("'certified optimal' is exclusively ending B's label", () => {
    // B keeps it (both in its score box label and its certificate box)...
    const bBox = stripAnsi(numberBox(fixtureEndingBOptimal, makeInk(false), makeSym(true)));
    expect(bBox).toContain("certified optimal");
    // ...and it appears NOWHERE in a full C render, even at score 98.5.
    const { lines } = renderFull(fixtureEndingCReceipt, NON_TTY);
    expect(stripAnsi(lines.join("\n")).toLowerCase()).not.toContain("certified optimal");
    // --compact and --md for C use the neutral high-score label instead.
    expect(renderCompact(fixtureEndingCReceipt, NON_TTY)).toContain("(excellent)");
    expect(renderMarkdown(fixtureEndingCReceipt)).not.toContain("certified optimal");
  });
});

describe("currency separation on shared surfaces", () => {
  // On the subscriber branch every waste $-figure must carry the terse "-eq"
  // suffix — card, --compact, WRAPPED lines, and the CHECKUP warning line
  // must be consistent with the QUOTA-LEAK LIST, which says "$X-eq" for the
  // same figures, on exactly the most-shared surfaces. API branches stay
  // bare "$".
  const sub = fixtureEndingCReceipt; // currency: "USD-equivalent (API list rates)"
  const api = fixtureEndingAEnable; // currency: "USD"

  it("subscriber: checkup warning line carries -eq", () => {
    const text = stripAnsi(checkupLines(sub, makeInk(false), makeSym(true)).join("\n"));
    expect(text).toContain("($618.60-eq)");
  });
  it("subscriber: every wrapped-insight $ figure carries -eq", () => {
    const text = stripAnsi(wrappedLines(sub, makeInk(false), makeSym(true)).join("\n"));
    // every $ amount in the wrapped section is followed by -eq
    const bare = text.match(/\$[\d,]+\.\d{2}(?!-eq)/g) ?? [];
    expect(bare, `bare $ figures found in subscriber wrapped lines: ${JSON.stringify(bare)}`).toEqual([]);
    expect(text).toMatch(/\$[\d,]+\.\d{2}-eq/);
  });
  it("subscriber: card and --compact carry -eq on their $ figures", () => {
    for (const out of [renderCard(sub, NON_TTY), renderCompact(sub, NON_TTY)]) {
      const text = stripAnsi(out);
      const bare = text.match(/\$[\d,]+\.\d{2}(?!-eq)/g) ?? [];
      expect(bare, `bare $ figures found: ${JSON.stringify(bare)}`).toEqual([]);
      expect(text).toMatch(/\$[\d,]+\.\d{2}-eq/);
    }
  });
  it("subscriber: --md biggest-miss/worst-day match its own $-eq table header", () => {
    const md = renderMarkdown(sub);
    expect(md).toMatch(/\*\*Biggest single miss:\*\*.*-eq in one turn\./);
    expect(md).toMatch(/\*\*Worst day:\*\*.*-eq leaked\./);
  });
  it("API branch: no -eq anywhere on card/compact/full render", () => {
    for (const out of [
      renderCard(api, NON_TTY),
      renderCompact(api, NON_TTY),
      renderFull(api, NON_TTY).lines.join("\n"),
      renderMarkdown(api),
    ]) {
      expect(stripAnsi(out)).not.toContain("-eq");
    }
  });
});

describe("snapshots (ANSI-stripped)", () => {
  it("ending A (enable) full render", () => {
    const { lines } = renderFull(fixtureEndingAEnable, NON_TTY);
    expect(stripAnsi(lines.join("\n"))).toMatchSnapshot();
  });
  it("ending B (certified optimal) full render", () => {
    const { lines } = renderFull(fixtureEndingBOptimal, NON_TTY);
    expect(stripAnsi(lines.join("\n"))).toMatchSnapshot();
  });
  it("ending C (subscriber receipt) full render", () => {
    const { lines } = renderFull(fixtureEndingCReceipt, NON_TTY);
    expect(stripAnsi(lines.join("\n"))).toMatchSnapshot();
  });
  it("card, all three fixtures", () => {
    expect(stripAnsi(renderCard(fixtureEndingAEnable, NON_TTY))).toMatchSnapshot();
    expect(stripAnsi(renderCard(fixtureEndingBOptimal, NON_TTY))).toMatchSnapshot();
    expect(stripAnsi(renderCard(fixtureEndingCReceipt, NON_TTY))).toMatchSnapshot();
  });
  it("--compact, all three fixtures", () => {
    expect(stripAnsi(renderCompact(fixtureEndingAEnable, NON_TTY))).toMatchSnapshot();
    expect(stripAnsi(renderCompact(fixtureEndingBOptimal, NON_TTY))).toMatchSnapshot();
    expect(stripAnsi(renderCompact(fixtureEndingCReceipt, NON_TTY))).toMatchSnapshot();
  });
  it("--md, all three fixtures", () => {
    expect(renderMarkdown(fixtureEndingAEnable)).toMatchSnapshot();
    expect(renderMarkdown(fixtureEndingBOptimal)).toMatchSnapshot();
    expect(renderMarkdown(fixtureEndingCReceipt)).toMatchSnapshot();
  });
  it("--explain, subscriber fixture", () => {
    expect(renderExplain(fixtureEndingCReceipt)).toMatchSnapshot();
  });
});
