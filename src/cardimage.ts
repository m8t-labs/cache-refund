/**
 * Generated share image (v1.0.4): a zero-dep, 720x720 SQUARE SVG card writer
 * that replicates the real terminal `card` output — dark terminal window,
 * traffic lights, the branded score/receipt box, exactly as printed — with
 * the numbers substituted from the live Summary. Written on share-prompt
 * accept so the post has an attachment without a manual screenshot; cli.ts
 * then best-effort copies the resulting PNG straight onto the image
 * clipboard (see share.ts's copyImageToClipboard) so the post is paste-ready.
 *
 * Square canvas is deliberate, not cosmetic: qlmanage's `-t` thumbnail mode
 * renders a square thumbnail regardless of the source's aspect ratio, so a
 * non-square source came out letterboxed/padded after conversion. At
 * 720x720 the thumbnail IS the artwork — no crop/sips step needed before or
 * after `qlmanage -t -s 1440` (kept as-is below).
 *
 * THE 1:1 GUARANTEE: nothing in the box, the wrapped insight line, the
 * limit-stretch line, or the share rail is hand-typed here. Every one of
 * those strings is pulled straight out of the same render.ts functions the
 * real terminal calls (numberBox, wrappedLines, limitStretchLine,
 * shareHint) — this file only strips ANSI, un-pads the box's border and
 * centering, and lays the result out as SVG text. The terminal and the
 * image can't drift apart, because the image never carries its own copy of
 * any number-bearing string to drift from. See boxContentRows/factLine below.
 *
 * Share-safe rules (same as the terminal + share templates): NEVER project
 * names — the wrapped line is derived with showProjects hardcoded false, the
 * same default `card` itself uses. Every substituted string is XML-escaped.
 *
 * PNG: X attachments need a raster, so on darwin we best-effort convert via
 * `qlmanage -t -s 1440` (ships with macOS) and rename its `<name>.svg.png`
 * output; any failure silently falls back to SVG-only. `dir`/`execFileSyncFn`
 * are injectable so tests never touch a real ~/Downloads or spawn anything.
 */

import { execFileSync } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decideEnding, limitStretchLine, numberBox, shareHint, wrappedLines } from "./render.js";
import { makeInk, makeSym, stripAnsi } from "./format.js";
import type { Summary } from "./types.js";

export const CARD_BASENAME = "cache-refund-card";

/** Minimal XML escaping for every substituted string. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ------------------------------------------------------------------ geometry
//
// One 720x720 canvas, a terminal window centered vertically inside it. The
// window's height is never a guess: it's PAD_TOP + every row this specific
// Summary produces (the box's row count varies 6-8 depending on whether the
// absorbed/plan-multiplier rows are present, the limit-stretch line is
// subscription-only, the second footer line is subscriber-only) + PAD_BOTTOM
// — computed fresh per card in buildCardSvg, then centered. That's what
// keeps "box rect sized to wrap its rows" and "whole content block
// vertically centered" true for every ending, not just the fixtures at hand.

const CANVAS = 720;
const WIN_X = 16;
const WIN_W = 688;
const WIN_RIGHT = WIN_X + WIN_W;
const WIN_CENTER_X = WIN_X + WIN_W / 2; // 360, also the canvas center
const RADIUS = 16;
const TITLEBAR_H = 42;

const PAD_X = 24; // inner left/right text inset from the window edges
const TEXT_LEFT = WIN_X + PAD_X;
const TEXT_RIGHT = WIN_RIGHT - PAD_X;
const TEXT_WIDTH = TEXT_RIGHT - TEXT_LEFT;

const ROW_H = 26;
const FONT = 15;
const FONT_DIM = 13; // the limit-stretch line + share rail: secondary, still on the row grid
const FOOTER_FONT = 12;
const FOOTER_ROW_H = 19;
const PAD_TOP = 20;
const PAD_BOTTOM = 20;
const GAP_AFTER_PROMPT = 14;
const GAP_AFTER_BOX = 20;
const GAP_BEFORE_SHARE = 14;
const GAP_BEFORE_FOOTER = 20;

const BOX_W = 560;
const BOX_X = WIN_X + (WIN_W - BOX_W) / 2;
const BOX_PAD_Y = 14;
const BOX_NOTCH_W = 150;
const BOX_NOTCH_H = 18;

/**
 * Conservative average glyph width (px) at this file's row font sizes — the
 * same 8.6px/char estimate the width-sanity test uses, so the two can never
 * silently disagree. Purely a defensive cap: the box's own <=57-col law
 * (format.ts) already keeps its rows short, and the free-text rows below it
 * are bounded by the terminal's own 80-col wrap — neither comes close to
 * these caps for any real corpus, they only guard the pathological case.
 */
const CHAR_W_EST = 8.6;
const ROW_MAX_CHARS = Math.floor(TEXT_WIDTH / CHAR_W_EST);
const BOX_ROW_MAX_CHARS = Math.floor((BOX_W - 40) / CHAR_W_EST);

/** Truncate to `maxChars`, appending a single ellipsis when cut. */
function truncateRow(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

// -------------------------------------------------------- terminal-exact derivation

/**
 * The box's content rows, verbatim from the terminal — see the file doc
 * comment's 1:1 guarantee. numberBox() draws the exact <=57-col branded box
 * `card` prints; rendering it with color on (then stripped right back off,
 * purely to reuse its centering math) and Unicode symbols, splitting on
 * newlines, and trimming each row's border glyph + padding recovers exactly
 * what the terminal shows — never hand-typed, so this and the terminal
 * cannot drift apart. Blank spacer rows survive as "" (rendered as vertical
 * gaps below, not text nodes — see buildCardSvg's box-row loop).
 */
function boxContentRows(s: Summary, planPrice?: number): string[] {
  const rendered = stripAnsi(numberBox(s, makeInk(true), makeSym(false), planPrice));
  const lines = rendered.split("\n");
  // First/last lines are the box's own top/bottom border (the top one
  // carries the woven brand label, e.g. "╭─── cache-refund ───…───╮"); the
  // SVG draws its border and label graphically (see the notch rect in
  // buildCardSvg) instead of reusing those box-drawing characters.
  return lines.slice(1, -1).map((line) => line.slice(1, -1).trim());
}

/**
 * The figure row's color. Not recoverable from boxContentRows (the ANSI
 * codes that carried it were stripped there, deliberately, to reuse the
 * box's plain-text centering math), so it's recomputed here from the same
 * Summary fields numberBox itself branches on: green for good news (a saved
 * receipt, or a certified-optimal score), orange for the actionable gap (an
 * unclaimed refund, or the rare costlier receipt).
 */
function figureColor(s: Summary): "green" | "orange" {
  const kind = decideEnding(s);
  if (kind === "C") return s.counterfactual.delta1hMinus5m < 0 ? "green" : "orange";
  return kind === "B" ? "green" : "orange";
}

/**
 * The top wrapped insight line, terminal-exact — including its "-eq" suffix
 * when the terminal shows one (v1.0.4: this image IS the terminal now, and
 * the footer still carries the API-value qualifier). Only the leading "» "
 * bullet is stripped; the SVG draws its own "›" glyph in front instead of
 * reusing the terminal's "»" (assets/card.svg's established convention).
 * Project-free by construction: showProjects is hardcoded false, the same
 * default `card` itself renders with.
 */
function factLine(s: Summary): string {
  const lines = wrappedLines(s, makeInk(false), makeSym(false), false);
  return (lines[1] ?? "").replace(/^\s*»\s*/, "").trim();
}

/**
 * Split a fact line around its (at most one) embedded dollar figure, e.g.
 * "...cache ($453.97-eq)." -> pre="...cache ", figure="($453.97-eq)",
 * post=".". Mirrors assets/card.svg's own hand-built convention (orange
 * glyph, orange $ figure, everything else plain) — not every candidate line
 * carries a dollar figure (the streak/peak-hour/biggest-session lines
 * don't), so `figure` is null for those and the whole line renders plain.
 * Greedily includes an immediately-adjacent enclosing "(" / ")" so a
 * parenthesized figure highlights as one unit, same as the hand-built asset.
 */
function splitDollarFigure(text: string): { pre: string; figure: string | null; post: string } {
  const m = text.match(/\(?\$[\d,]+(?:\.\d+)?(?:-eq)?\)?/);
  if (!m || m.index === undefined) return { pre: text, figure: null, post: "" };
  return { pre: text.slice(0, m.index), figure: m[0], post: text.slice(m.index + m[0].length) };
}

// ------------------------------------------------------------------- build

/**
 * Build the 720x720 SVG card: a dark terminal window replicating `card`'s
 * real output — the branded score/receipt box, the top wrapped insight
 * line, the optional limit-stretch line, and the share rail, at a
 * consistent line height — plus a short local-only footer. See the file doc
 * comment for the 1:1 guarantee that keeps every substituted string
 * identical to what the terminal prints for the same Summary.
 *
 * `planPrice` (`--plan <usd>`, display-only, CLI-supplied) reaches the box's
 * "~Nx your monthly plan" row for free: it's threaded straight into
 * numberBox, the same function the terminal box uses, so there is no
 * separate plan-line code path here to keep in sync.
 */
export function buildCardSvg(s: Summary, planPrice?: number): string {
  const subscriber = s.currency !== "USD";

  // ---- terminal-exact derivation (the 1:1 guarantee) ----
  const bodyRows = boxContentRows(s, planPrice);
  const figColor = figureColor(s);
  const fact = truncateRow(factLine(s), ROW_MAX_CHARS - 2); // reserve 2 cols for "› "
  const stretchRaw = limitStretchLine(s);
  const stretch = stretchRaw !== null ? truncateRow(stretchRaw, ROW_MAX_CHARS) : null;
  const rail = shareHint(makeSym(false));

  const boxH = bodyRows.length * ROW_H + BOX_PAD_Y * 2;

  // ---- vertical stack, relative to the content area (just below the title bar) ----
  let cursor = PAD_TOP;
  const promptYRel = cursor;
  cursor += ROW_H + GAP_AFTER_PROMPT;
  const boxTopRel = cursor;
  cursor += boxH + GAP_AFTER_BOX;
  const factYRel = cursor;
  cursor += ROW_H;
  let stretchYRel: number | null = null;
  if (stretch !== null) {
    stretchYRel = cursor;
    cursor += ROW_H;
  }
  cursor += GAP_BEFORE_SHARE;
  const shareYRel = cursor;
  cursor += ROW_H + GAP_BEFORE_FOOTER;
  const footer1YRel = cursor;
  cursor += FOOTER_ROW_H;
  let footer2YRel: number | null = null;
  if (subscriber) {
    footer2YRel = cursor;
    cursor += FOOTER_ROW_H;
  }
  cursor += PAD_BOTTOM;

  const winH = TITLEBAR_H + cursor;
  const winY = Math.max(16, Math.round((CANVAS - winH) / 2));
  const contentTop = winY + TITLEBAR_H;

  const boxY = contentTop + boxTopRel;
  const boxCx = BOX_X + BOX_W / 2;
  const notchX = BOX_X + (BOX_W - BOX_NOTCH_W) / 2;

  // ---- box interior rows: 1st non-blank = title, 2nd = figure (bold+color), rest = dim ----
  let nonBlank = 0;
  const boxRowsSvg = bodyRows
    .map((row, i) => {
      if (row === "") return ""; // blank spacer row: height already reserved, no text node
      nonBlank++;
      const rowY = boxY + BOX_PAD_Y + i * ROW_H + ROW_H / 2 + 5;
      const text = escapeXml(truncateRow(row, BOX_ROW_MAX_CHARS));
      const cls = nonBlank === 1 ? "txt" : nonBlank === 2 ? figColor : "dim";
      const weight = nonBlank === 2 ? ' font-weight="700"' : "";
      return `<text x="${boxCx}" y="${rowY}" text-anchor="middle" class="t ${cls}" font-size="${FONT}"${weight}>${text}</text>`;
    })
    .filter((l) => l.length > 0)
    .join("\n  ");

  const promptSvg = `<text x="${TEXT_LEFT}" y="${contentTop + promptYRel + ROW_H / 2 + 5}" class="t dim" font-size="${FONT}">${escapeXml("$ ")}<tspan class="t txt">${escapeXml("npx cache-refund card")}</tspan></text>`;

  const { pre: factPre, figure: factFigure, post: factPost } = splitDollarFigure(fact);
  const factFigureSvg =
    factFigure !== null
      ? `<tspan class="orange" font-size="${FONT}">${escapeXml(factFigure)}</tspan><tspan class="txt" font-size="${FONT}">${escapeXml(factPost)}</tspan>`
      : "";
  const factSvg = `<text x="${TEXT_LEFT}" y="${contentTop + factYRel + ROW_H / 2 + 5}" class="t"><tspan class="orange" font-size="${FONT}">${escapeXml("›")}</tspan><tspan class="txt" font-size="${FONT}">${escapeXml(` ${factPre}`)}</tspan>${factFigureSvg}</text>`;

  const stretchSvg =
    stretchYRel !== null
      ? `<text x="${TEXT_LEFT}" y="${contentTop + stretchYRel + ROW_H / 2 + 5}" class="t dim" font-size="${FONT_DIM}">${escapeXml(stretch!)}</text>`
      : "";

  const shareSvg = `<text x="${TEXT_LEFT}" y="${contentTop + shareYRel + ROW_H / 2 + 5}" class="t dim" font-size="${FONT_DIM}">${escapeXml(rail)}</text>`;

  const footer1Svg = `<text x="${TEXT_LEFT}" y="${contentTop + footer1YRel + FOOTER_ROW_H / 2 + 4}" class="t dim" font-size="${FOOTER_FONT}">${escapeXml(
    "100% local · token counts + timestamps · nothing leaves this machine",
  )}</text>`;

  const footer2Svg =
    footer2YRel !== null
      ? `<text x="${TEXT_LEFT}" y="${contentTop + footer2YRel + FOOTER_ROW_H / 2 + 4}" class="t dim" font-size="${FOOTER_FONT}">${escapeXml(
          "$ figures are API-value (list rates) — subscription usage is metered in it, not billed",
        )}</text>`
      : "";

  const titleY = winY + 26;
  const dotCy = winY + 21;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs><style>
    .t { font-family: "SF Mono", Menlo, Monaco, "DejaVu Sans Mono", monospace; white-space: pre; }
    .dim { fill: #8b8fa3; } .txt { fill: #e6e6ef; }
    .green { fill: #3fd68f; } .orange { fill: #e8a15d; } .brand { fill: #d75fd7; font-weight: 700; }
  </style></defs>
  <rect width="${CANVAS}" height="${CANVAS}" fill="#0f1016"/>
  <rect x="${WIN_X}" y="${winY}" width="${WIN_W}" height="${winH}" rx="${RADIUS}" fill="#15161c" stroke="#2a2c37"/>
  <path d="M${WIN_X} ${winY + RADIUS} a${RADIUS} ${RADIUS} 0 0 1 ${RADIUS} -${RADIUS} h${WIN_W - 2 * RADIUS} a${RADIUS} ${RADIUS} 0 0 1 ${RADIUS} ${RADIUS} v${TITLEBAR_H - RADIUS} h-${WIN_W} z" fill="#1d1f28"/>
  <circle cx="${WIN_X + 28}" cy="${dotCy}" r="6.5" fill="#ff5f57"/><circle cx="${WIN_X + 50}" cy="${dotCy}" r="6.5" fill="#febc2e"/><circle cx="${WIN_X + 72}" cy="${dotCy}" r="6.5" fill="#28c840"/>
  <text x="${WIN_CENTER_X}" y="${titleY}" text-anchor="middle" class="t dim" font-size="13">${escapeXml("npx cache-refund")}</text>
  ${promptSvg}
  <rect x="${BOX_X}" y="${boxY}" width="${BOX_W}" height="${boxH}" rx="10" fill="none" stroke="#d75fd7" stroke-width="1.6"/>
  <rect x="${notchX}" y="${boxY - 9}" width="${BOX_NOTCH_W}" height="${BOX_NOTCH_H}" fill="#15161c"/>
  <text x="${boxCx}" y="${boxY + 5}" text-anchor="middle" class="t brand" font-size="14">${escapeXml("cache-refund")}</text>
  ${boxRowsSvg}
  ${factSvg}${stretchSvg}
  ${shareSvg}
  ${footer1Svg}${footer2Svg}
</svg>
`;
}

export interface CardImageResult {
  svgPath: string;
  /** null when PNG conversion was unavailable/failed (non-darwin, or qlmanage hiccup). */
  pngPath: string | null;
}

export interface CardImageOpts {
  /** Output dir override (tests). Default: ~/Downloads if it exists, else cwd. */
  dir?: string;
  platform?: NodeJS.Platform;
  /** Injectable qlmanage runner (tests). */
  execFileSyncFn?: (cmd: string, args: string[]) => void;
  /** `--plan <usd>`, threaded to buildCardSvg — see its doc comment. */
  planPrice?: number;
}

/** Default output dir: ~/Downloads when present, else the current directory. */
export function defaultCardDir(home: string = homedir(), cwd: string = process.cwd()): string {
  const downloads = join(home, "Downloads");
  return existsSync(downloads) ? downloads : cwd;
}

/**
 * Write the SVG (and, on darwin, best-effort PNG) card for this Summary.
 * Never throws for the PNG leg — SVG-only is the graceful floor. The square
 * 720x720 canvas means qlmanage's `-t` thumbnail needs no post-processing:
 * its square output IS the full card, at any `-s` size — no sips/crop step.
 */
export function writeCardImage(s: Summary, opts: CardImageOpts = {}): CardImageResult {
  const dir = opts.dir ?? defaultCardDir();
  const platform = opts.platform ?? process.platform;
  const exec = opts.execFileSyncFn ?? ((cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: "ignore" }));

  const svgPath = join(dir, `${CARD_BASENAME}.svg`);
  writeFileSync(svgPath, buildCardSvg(s, opts.planPrice), "utf8");

  let pngPath: string | null = null;
  if (platform === "darwin") {
    try {
      // qlmanage renders `<basename>.svg.png` into the -o dir.
      exec("qlmanage", ["-t", "-s", "1440", "-o", dir, svgPath]);
      const qlOut = join(dir, `${CARD_BASENAME}.svg.png`);
      if (existsSync(qlOut)) {
        const target = join(dir, `${CARD_BASENAME}.png`);
        renameSync(qlOut, target);
        pngPath = target;
      }
    } catch {
      pngPath = null; // silent SVG-only fallback
    }
  }
  return { svgPath, pngPath };
}
