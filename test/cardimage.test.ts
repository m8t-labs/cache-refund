/**
 * Generated share-image tests (v1.0.2: 720x720 square card, ending-aware hero
 * block, gap bars). The SVG writer's file IO runs against an injected temp
 * dir — never a real ~/Downloads — and the darwin PNG leg uses an injected
 * qlmanage stub, so nothing here spawns a real process.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCardSvg, CARD_BASENAME, defaultCardDir, escapeXml, writeCardImage } from "../src/cardimage.js";
import { absorbedDollars, fmtAbsorbed } from "../src/render.js";
import {
  fixtureEndingAEnable,
  fixtureEndingBOptimal,
  fixtureEndingCReceipt,
  fixtureNegativeCachingSavings,
} from "./fixtures/summaries.js";

const PROJECT_LEAKS = ["orders-api", "web-dashboard", "widgetco", "quietco", "-Users-"];

describe("buildCardSvg (v1.0.2: 720x720 square card)", () => {
  it("is well-formed XML: single svg root, balanced text tags, no raw ampersands", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
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

  it("is a deliberate 720x720 square canvas (kills the qlmanage padding bug)", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      const svg = buildCardSvg(s);
      expect(svg).toContain('width="720" height="720" viewBox="0 0 720 720"');
      // no other width/height pair anywhere claims the old 720x440 shape
      expect(svg).not.toContain('height="440"');
    }
  });

  it("ending C: receipt hero leads with the API-value delta, green when 1h saved", () => {
    const svg = buildCardSvg(fixtureEndingCReceipt);
    expect(svg).toContain("YOUR 1H CACHE RECEIPT");
    // |delta1hMinus5m| = 2500.9452... -> rounds to 2501, comma-grouped, no cents
    expect(svg).toContain('class="t green" font-size="68" font-weight="700">$2,501<');
    expect(svg).toContain("saved in API-value");
    expect(svg).toContain("last 90 days");
    expect(svg).toContain("efficiency 98.5 / 100");
    expect(svg).toMatch(/[\d.]+B tokens/);
    expect(svg).toContain("590 sessions");
  });

  it("ending A: unclaimed-refund hero, orange, no cents", () => {
    const svg = buildCardSvg(fixtureEndingAEnable);
    expect(svg).toContain("UNCLAIMED CACHE REFUND");
    // |delta1hMinus5m| = 80.0 -> "$80"
    expect(svg).toContain('class="t orange" font-size="68" font-weight="700">$80<');
    expect(svg).toContain("left on the table");
    expect(svg).toContain("one config line recovers it");
  });

  it("ending B: certified-optimal hero is the bare score, green, unconditionally (mirrors the terminal certificate box)", () => {
    const svg = buildCardSvg(fixtureEndingBOptimal);
    expect(svg).toContain("CERTIFIED OPTIMAL");
    expect(svg).toContain('class="t green" font-size="68" font-weight="700">96.3<');
    expect(svg).toContain("the default cache setting is right for how you work");
  });

  it("dollar hero figures never carry cents (v1.0.2 rule: Math.round, comma-grouped)", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingCReceipt]) {
      const svg = buildCardSvg(s);
      const m = svg.match(/font-size="68" font-weight="700">([^<]+)</);
      expect(m).not.toBeNull();
      expect(m![1]).not.toContain(".");
      expect(m![1]).toMatch(/^\$[\d,]+$/);
    }
  });

  it("gap bars: widths derive from the buckets, non-negative, and <=300 (the track width)", () => {
    const svg = buildCardSvg(fixtureEndingCReceipt);
    const widths = [...svg.matchAll(/width="(\d+(?:\.\d+)?)" height="12" rx="6" fill="#(?:3fd68f|e0b856|949cb8)"/g)].map(
      (m) => Number(m[1]),
    );
    expect(widths.length).toBe(3); // warm, recoverable, cold
    for (const w of widths) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(300);
    }
    // the three re-warm-gap percentages are one-decimal and sum to ~100%
    const pcts = [...svg.matchAll(/class="t txt" font-size="13">([\d.]+)%<\/text>/g)].map((m) => Number(m[1]));
    expect(pcts.length).toBe(3);
    expect(pcts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
  });

  it("a zero bucket renders a zero-width bar, not the 6px floor (floor only applies when pct>0)", () => {
    const zeroCold = {
      ...fixtureEndingAEnable,
      buckets: { ...fixtureEndingAEnable.buckets, cold: 0, warm: fixtureEndingAEnable.buckets.warm + fixtureEndingAEnable.buckets.cold },
    };
    const svg = buildCardSvg(zeroCold);
    expect(svg).toContain('width="0" height="12" rx="6" fill="#949cb8"');
  });

  it("share-safe: no project names, no -eq (API-value allowed); brand text is npx cache-refund", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      const svg = buildCardSvg(s);
      for (const leak of PROJECT_LEAKS) expect(svg).not.toContain(leak);
      expect(svg).not.toContain("-eq");
      expect(svg).toContain(">npx cache-refund<");
    }
    // subscriber footer carries the API-value qualifier; API branches don't
    expect(buildCardSvg(fixtureEndingCReceipt)).toContain("$ figures are API-value (list rates)");
    expect(buildCardSvg(fixtureEndingAEnable)).not.toContain("$ figures are API-value");
  });

  it("carries the top wrapped fact line, truncated to <=64 chars, project-free", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      const svg = buildCardSvg(s);
      const m = svg.match(/<tspan class="txt"> ([^<]*)<\/tspan>/);
      expect(m).not.toBeNull();
      expect(m![1].length).toBeLessThanOrEqual(64);
      expect(m![1].length).toBeGreaterThan(0);
    }
  });

  it("escapeXml escapes all five specials", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });

  describe("absorbed-value line (v1.0.2): dim, under the stat row (y=316)", () => {
    it("renders the same figure the terminal box uses, for a positive fixture, on every ending", () => {
      for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
        const svg = buildCardSvg(s);
        const absorbed = absorbedDollars(s);
        expect(absorbed).not.toBeNull();
        expect(svg).toContain(
          `<text x="360" y="316" text-anchor="middle" class="t dim" font-size="14">${escapeXml(fmtAbsorbed(absorbed!))}</text>`,
        );
      }
    });
    it("omits the line entirely (no y=316 element) when there's nothing positive to absorb", () => {
      const svg = buildCardSvg(fixtureNegativeCachingSavings);
      expect(svg).not.toContain("absorbed $");
      expect(svg).not.toContain('y="316"');
    });
  });

  describe("--plan multiplier line (v1.0.2): dim, under the hero sub-line (y=266)", () => {
    it("renders for the subscription fixture when a planPrice is passed", () => {
      const svg = buildCardSvg(fixtureEndingCReceipt, 2000);
      expect(svg).toContain(
        `<text x="360" y="266" text-anchor="middle" class="t dim" font-size="14">${escapeXml("~6.0x your monthly plan, absorbed for free")}</text>`,
      );
    });
    it("omits the line when no planPrice is passed", () => {
      const svg = buildCardSvg(fixtureEndingCReceipt);
      expect(svg).not.toContain("your monthly plan");
      expect(svg).not.toContain('y="266"');
    });
    it("omits the line on API-branch endings even when a planPrice is passed (branch-gated)", () => {
      const svg = buildCardSvg(fixtureEndingAEnable, 200);
      expect(svg).not.toContain("your monthly plan");
      expect(svg).not.toContain('y="266"');
    });
  });

  describe("subscriber footer qualifier (v1.0.2 wording)", () => {
    it("carries the updated two-half qualifier for the subscriber fixture", () => {
      const svg = buildCardSvg(fixtureEndingCReceipt);
      expect(svg).toContain("$ figures are API-value (list rates)");
      expect(svg).toContain("subscription usage is metered in it, not billed");
      expect(svg).not.toContain("— not a bill</text>");
    });
    it("API-branch cards carry no subscriber footer at all", () => {
      const svg = buildCardSvg(fixtureEndingAEnable);
      expect(svg).not.toContain("$ figures are API-value");
    });
  });

  describe("gap-bars block position (v1.0.2: nudged down to make room for the absorbed line)", () => {
    it("the section label sits at its new y, not the old one", () => {
      const svg = buildCardSvg(fixtureEndingCReceipt);
      expect(svg).toContain('<text x="80" y="359" class="t dim" font-size="12" letter-spacing="2">CACHE WRITES BY RE-WARM GAP</text>');
      expect(svg).not.toContain('y="345"');
    });
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
