/**
 * Generated share-image tests (v1.0.4: 720x720 square card, a faithful
 * replica of the terminal `card` output). The SVG writer's file IO runs
 * against an injected temp dir — never a real ~/Downloads — and the darwin
 * PNG leg uses an injected qlmanage stub, so nothing here spawns a real
 * process.
 *
 * The centerpiece below is the 1:1 identity suite: it independently
 * re-derives every number-bearing string the same way cardimage.ts does
 * (stripAnsi + un-pad numberBox's box rows; wrappedLines' top line;
 * limitStretchLine; shareHint) and asserts the SVG contains each one
 * verbatim. That's what makes the terminal and the image unable to drift
 * apart — a wording change in render.ts either shows up in both places or
 * fails this suite.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCardSvg, CARD_BASENAME, defaultCardDir, escapeXml, writeCardImage } from "../src/cardimage.js";
import {
  absorbedDollars,
  fmtAbsorbed,
  limitStretchLine,
  numberBox,
  planMultiplierLine,
  shareHint,
  wrappedLines,
} from "../src/render.js";
import { makeInk, makeSym, stripAnsi } from "../src/format.js";
import {
  fixtureAllZeroLeaks,
  fixtureEndingAEnable,
  fixtureEndingBOptimal,
  fixtureEndingCReceipt,
  fixtureNegativeCachingSavings,
} from "./fixtures/summaries.js";
import type { Summary } from "../src/types.js";

const PROJECT_LEAKS = ["orders-api", "web-dashboard", "widgetco", "quietco", "-Users-"];
const ENDINGS = [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt];

/** Independent re-derivation of the box's content rows — see numberBox's own
 * doc comment for the row shape. Deliberately NOT imported from
 * cardimage.ts (which keeps this private): the point of this suite is to
 * catch drift between the terminal renderer and the image, so it must
 * compute its expectation from render.ts directly, not from the
 * implementation under test. */
function terminalBoxRows(s: Summary, planPrice?: number): string[] {
  const rendered = stripAnsi(numberBox(s, makeInk(true), makeSym(false), planPrice));
  return rendered
    .split("\n")
    .slice(1, -1)
    .map((line) => line.slice(1, -1).trim());
}

/** Independent re-derivation of the top wrapped insight line (sans bullet). */
function terminalFactLine(s: Summary): string {
  const lines = wrappedLines(s, makeInk(false), makeSym(false), false);
  return (lines[1] ?? "").replace(/^\s*»\s*/, "").trim();
}

/** Strip tags and decode entities from an SVG fragment, for comparing
 * against plain expected text regardless of how many tspans it's split
 * across (the fact line's embedded $ figure gets its own orange tspan —
 * see splitDollarFigure in cardimage.ts — so its text content is no longer
 * one contiguous substring of the raw SVG markup). */
function plainText(svgFragment: string): string {
  return svgFragment
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

describe("buildCardSvg (v1.0.4: terminal-replica card)", () => {
  it("is well-formed XML: single svg root, balanced text/tspan tags, no raw ampersands", () => {
    for (const s of ENDINGS) {
      const svg = buildCardSvg(s);
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect((svg.match(/<text/g) ?? []).length).toBe((svg.match(/<\/text>/g) ?? []).length);
      expect((svg.match(/<tspan/g) ?? []).length).toBe((svg.match(/<\/tspan>/g) ?? []).length);
      // every & must be an entity
      expect(svg).not.toMatch(/&(?!(amp|lt|gt|quot|apos|#\d+);)/);
    }
  });

  it("is a deliberate 720x720 square canvas (qlmanage's thumbnail IS the artwork, no crop step)", () => {
    for (const s of ENDINGS) {
      const svg = buildCardSvg(s);
      expect(svg).toContain('width="720" height="720" viewBox="0 0 720 720"');
    }
  });

  describe("the 1:1 identity guarantee: every derived row matches the real renderer verbatim", () => {
    it.each([
      ["A-enable", fixtureEndingAEnable],
      ["B", fixtureEndingBOptimal],
      ["C", fixtureEndingCReceipt],
    ] as const)("every non-blank numberBox row appears in the SVG, trimmed and unchanged (%s)", (_name, s) => {
      const svg = buildCardSvg(s);
      const rows = terminalBoxRows(s).filter((r) => r.length > 0);
      expect(rows.length).toBeGreaterThanOrEqual(4); // title, figure, sub-line, scale line at minimum
      for (const row of rows) {
        expect(svg).toContain(escapeXml(row));
      }
    });

    it.each([
      ["A-enable", fixtureEndingAEnable],
      ["B", fixtureEndingBOptimal],
      ["C", fixtureEndingCReceipt],
    ] as const)("the box rows also carry the --plan multiplier row when planPrice applies (%s)", (_name, s) => {
      const svg = buildCardSvg(s, 2000);
      const rows = terminalBoxRows(s, 2000).filter((r) => r.length > 0);
      for (const row of rows) {
        expect(svg).toContain(escapeXml(row));
      }
    });

    it("the top wrapped insight line matches wrappedLines' real output verbatim, for every ending", () => {
      for (const s of ENDINGS) {
        const svg = buildCardSvg(s);
        // The line is split across tspans (the embedded $ figure gets its
        // own orange span — see splitDollarFigure), so recover the fact
        // row's full text content rather than looking for one contiguous
        // substring: it's the <text> block that opens with the "›" glyph.
        const factBlock = svg.match(/<text[^>]*><tspan class="orange"[^>]*>›<\/tspan>[\s\S]*?<\/text>/);
        expect(factBlock).not.toBeNull();
        expect(plainText(factBlock![0]).replace("›", "").trim()).toBe(terminalFactLine(s));
      }
    });

    it("the fact line's embedded $ figure (when present) renders in its own orange tspan, matching assets/card.svg's convention", () => {
      // fixtureEndingCReceipt's top candidate is the model-switch leak,
      // whose text carries a parenthesized $-eq figure — exercise the
      // figure-highlighting path end to end (not just its plain-text sum).
      const svg = buildCardSvg(fixtureEndingCReceipt);
      const expected = terminalFactLine(fixtureEndingCReceipt);
      const m = expected.match(/\(?\$[\d,]+(?:\.\d+)?(?:-eq)?\)?/);
      expect(m).not.toBeNull();
      expect(svg).toContain(`<tspan class="orange" font-size="15">${escapeXml(m![0])}</tspan>`);
    });

    it("the limit-stretch line matches limitStretchLine's real output verbatim when present (subscription only)", () => {
      const svg = buildCardSvg(fixtureEndingCReceipt);
      const expected = limitStretchLine(fixtureEndingCReceipt);
      expect(expected).not.toBeNull();
      expect(svg).toContain(escapeXml(expected!));
      // off-branch: no stretch line, no drift-risk string either
      expect(limitStretchLine(fixtureEndingAEnable)).toBeNull();
      expect(limitStretchLine(fixtureEndingBOptimal)).toBeNull();
    });

    it("the share rail matches shareHint's real output verbatim, for every ending", () => {
      const expected = shareHint(makeSym(false));
      for (const s of ENDINGS) {
        expect(buildCardSvg(s)).toContain(escapeXml(expected));
      }
    });
  });

  describe("width sanity: nothing overflows the 720 canvas", () => {
    /**
     * Estimates each <text> element's rendered horizontal extent from its
     * (possibly tspan-nested) content length, using the same 8.6px/char
     * baseline the layout constants are sized against (cardimage.ts's
     * CHAR_W_EST, at the 15px row font) — scaled by each element's own
     * font-size, since the footer/share-rail rows deliberately render
     * smaller than the primary 15px rows.
     */
    function textExtents(svg: string): { text: string; left: number; right: number }[] {
      const CHAR_W_AT_15 = 8.6;
      const out: { text: string; left: number; right: number }[] = [];
      for (const m of svg.matchAll(/<text\s+([^>]*)>([\s\S]*?)<\/text>/g)) {
        const attrs = m[1];
        const decoded = m[2]
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'");
        const x = Number(attrs.match(/x="([\d.]+)"/)?.[1] ?? 0);
        // an outer <text> with no font-size of its own sizes purely via its
        // tspans (the wrapped-insight line) — all of which render at 15px here.
        const fontSize = Number(attrs.match(/font-size="([\d.]+)"/)?.[1] ?? 15);
        const width = decoded.length * CHAR_W_AT_15 * (fontSize / 15);
        const anchored = /text-anchor="middle"/.test(attrs);
        out.push({
          text: decoded,
          left: anchored ? x - width / 2 : x,
          right: anchored ? x + width / 2 : x + width,
        });
      }
      return out;
    }

    it("every text row stays within [0, 720] for the widest fixtures", () => {
      for (const [s, plan] of [
        [fixtureEndingAEnable, undefined],
        [fixtureEndingBOptimal, undefined],
        [fixtureEndingCReceipt, undefined],
        [fixtureEndingCReceipt, 2000], // the tallest/widest box: absorbed + plan-multiplier rows both present
      ] as const) {
        const svg = buildCardSvg(s, plan);
        for (const { text, left, right } of textExtents(svg)) {
          expect(left, `"${text}" left edge`).toBeGreaterThanOrEqual(-0.5);
          expect(right, `"${text}" right edge`).toBeLessThanOrEqual(720.5);
        }
      }
    });
  });

  it("ending C: receipt box leads with 'YOUR 1H CACHE RECEIPT', figure row green when 1h saved (cents included — this IS the terminal now)", () => {
    const svg = buildCardSvg(fixtureEndingCReceipt);
    expect(svg).toContain("YOUR 1H CACHE RECEIPT");
    expect(svg).toContain('class="t green" font-size="15" font-weight="700">saved ~$2,500.95 in API-value (last 90d)<');
  });

  it("ending C, unusual costlier case: figure row flips to orange, never claims a saving", () => {
    const costlier: Summary = {
      ...fixtureEndingCReceipt,
      counterfactual: { ...fixtureEndingCReceipt.counterfactual, delta1hMinus5m: 40 },
    };
    const svg = buildCardSvg(costlier);
    const row = terminalBoxRows(costlier).filter((r) => r.length > 0)[1];
    expect(row).toContain("costlier than 5m");
    expect(svg).toContain(`class="t orange" font-size="15" font-weight="700">${escapeXml(row)}<`);
  });

  it("ending A (unclaimed refund): box title is the real terminal's 'CACHE EFFICIENCY SCORE', figure row orange", () => {
    const svg = buildCardSvg(fixtureEndingAEnable);
    expect(svg).toContain("CACHE EFFICIENCY SCORE");
    expect(svg).toContain('class="t orange" font-size="15" font-weight="700">71.2 / 100<');
  });

  it("ending B (certified optimal): same box title as A, figure row green, 'certified optimal' sub-line", () => {
    const svg = buildCardSvg(fixtureEndingBOptimal);
    expect(svg).toContain("CACHE EFFICIENCY SCORE");
    expect(svg).toContain('class="t green" font-size="15" font-weight="700">96.3 / 100<');
    expect(svg).toContain('class="t dim" font-size="15">certified optimal<');
  });

  it("share-safe: no project names; API-branch cards carry no '-eq' jargon, subscriber cards do (terminal-exact wording)", () => {
    for (const s of ENDINGS) {
      const svg = buildCardSvg(s);
      for (const leak of PROJECT_LEAKS) expect(svg).not.toContain(leak);
      expect(svg).toContain("npx cache-refund");
    }
    expect(buildCardSvg(fixtureEndingAEnable)).not.toContain("-eq");
    expect(buildCardSvg(fixtureEndingBOptimal)).not.toContain("-eq");
    // the receipt fixture's own wrapped line legitimately carries "-eq" in
    // the real terminal (subscriber currency) — v1.0.4 keeps it verbatim.
    expect(buildCardSvg(fixtureEndingCReceipt)).toContain("-eq");
  });

  it("v1.0.4: the old designed hero is gone — no giant number, no gap bars, no CTA pill, no standalone hashtag line", () => {
    for (const s of ENDINGS) {
      const svg = buildCardSvg(s);
      expect(svg).not.toContain('font-size="68"'); // the old giant hero number
      expect(svg).not.toContain("CACHE WRITES BY RE-WARM GAP"); // the old gap-bars section label
      expect(svg).not.toContain('height="12" rx="6"'); // the old gap-bar rects
      expect(svg).not.toContain('fill-opacity="0.10"'); // the old magenta CTA pill
      expect(svg).not.toMatch(/text-anchor="middle"[^>]*>#cacherefund</); // the old standalone centered hashtag line
      expect(svg).not.toContain("UNCLAIMED CACHE REFUND"); // the old hand-typed hero overline
      expect(svg).not.toContain("CERTIFIED OPTIMAL"); // ditto (real title is "CACHE EFFICIENCY SCORE"; real sub-line is lowercase)
    }
  });

  it("escapeXml escapes all five specials", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });

  describe("absorbed-value row (inside the box, via numberBox's own scaleRows — no separate code path here)", () => {
    it("renders the same figure the terminal box uses, for a positive fixture, on every ending", () => {
      for (const s of ENDINGS) {
        const svg = buildCardSvg(s);
        const absorbed = absorbedDollars(s);
        expect(absorbed).not.toBeNull();
        expect(svg).toContain(escapeXml(fmtAbsorbed(absorbed!)));
      }
    });
    it("omits the row entirely when there's nothing positive to absorb", () => {
      const svg = buildCardSvg(fixtureNegativeCachingSavings);
      expect(svg).not.toContain("absorbed $");
    });
  });

  describe("--plan multiplier row (inside the box; subscription-branch-only, same gate as the terminal)", () => {
    it("renders for the subscription fixture when a planPrice is passed", () => {
      const svg = buildCardSvg(fixtureEndingCReceipt, 2000);
      expect(svg).toContain(escapeXml(planMultiplierLine(fixtureEndingCReceipt, 2000)!));
    });
    it("omits the row when no planPrice is passed", () => {
      expect(buildCardSvg(fixtureEndingCReceipt)).not.toContain("your monthly plan");
    });
    it("omits the row on API-branch endings even when a planPrice is passed (branch-gated)", () => {
      expect(buildCardSvg(fixtureEndingAEnable, 200)).not.toContain("your monthly plan");
    });
  });

  describe("subscriber footer qualifier", () => {
    it("carries both dim footer lines for the subscriber fixture", () => {
      const svg = buildCardSvg(fixtureEndingCReceipt);
      expect(svg).toContain("100% local");
      expect(svg).toContain("token counts + timestamps");
      expect(svg).toContain("nothing leaves this machine");
      expect(svg).toContain("$ figures are API-value (list rates)");
      expect(svg).toContain("subscription usage is metered in it, not billed");
    });
    it("API-branch cards carry only the local-only footer line, no subscriber qualifier", () => {
      const svg = buildCardSvg(fixtureEndingAEnable);
      expect(svg).toContain("100% local");
      expect(svg).not.toContain("$ figures are API-value");
    });
  });

  it("handles the empty-insight edge case (no candidates) without throwing or overflowing", () => {
    expect(() => buildCardSvg(fixtureAllZeroLeaks)).not.toThrow();
    const svg = buildCardSvg(fixtureAllZeroLeaks);
    expect(svg).toContain("Not enough data yet");
  });
});

describe("writeCardImage (injected dir + qlmanage stub — no real system access)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cache-refund-card-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the SVG into the injected dir; non-darwin skips PNG entirely", () => {
    let execCalled = false;
    const res = writeCardImage(fixtureEndingCReceipt, {
      dir,
      platform: "linux",
      execFileSyncFn: () => {
        execCalled = true;
      },
    });
    expect(res.svgPath).toBe(join(dir, `${CARD_BASENAME}.svg`));
    expect(existsSync(res.svgPath)).toBe(true);
    expect(res.pngPath).toBeNull();
    expect(execCalled).toBe(false);
    expect(readFileSync(res.svgPath, "utf8")).toContain("YOUR 1H CACHE RECEIPT");
  });

  it("darwin: renames qlmanage's <name>.svg.png output to <name>.png", () => {
    const res = writeCardImage(fixtureEndingCReceipt, {
      dir,
      platform: "darwin",
      execFileSyncFn: (cmd, args) => {
        expect(cmd).toBe("qlmanage");
        expect(args).toContain("-t");
        expect(args).toContain("1440");
        // simulate qlmanage's output naming
        writeFileSync(join(dir, `${CARD_BASENAME}.svg.png`), "png-bytes");
      },
    });
    expect(res.pngPath).toBe(join(dir, `${CARD_BASENAME}.png`));
    expect(existsSync(res.pngPath!)).toBe(true);
    expect(existsSync(join(dir, `${CARD_BASENAME}.svg.png`))).toBe(false); // renamed away
  });

  it("darwin: silent SVG-only fallback when qlmanage fails", () => {
    const res = writeCardImage(fixtureEndingCReceipt, {
      dir,
      platform: "darwin",
      execFileSyncFn: () => {
        throw new Error("qlmanage exploded");
      },
    });
    expect(existsSync(res.svgPath)).toBe(true);
    expect(res.pngPath).toBeNull();
  });

  it("defaultCardDir: ~/Downloads when present, else cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "cache-refund-home-"));
    try {
      expect(defaultCardDir(home, "/some/cwd")).toBe("/some/cwd"); // no Downloads yet
      const dl = join(home, "Downloads");
      mkdirSync(dl, { recursive: true });
      expect(defaultCardDir(home, "/some/cwd")).toBe(dl);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
