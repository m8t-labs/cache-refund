#!/usr/bin/env node
/**
 * The full CLI surface.
 *
 *   npx cache-refund                 full checkup
 *   npx cache-refund card            score box + top Wrapped line
 *   npx cache-refund enable          confirmed 1h-TTL enable flow
 *   npx cache-refund revert          confirmed 5m-TTL revert flow
 *   npx cache-refund verify          post-enable TTL check
 *   npx cache-refund recheck         baseline comparison
 *
 *   --days N (90) · --project <path> · --price <model=$/MTok,...> · --yes ·
 *   --no-color · --all-time · --json · --md · --compact · --explain ·
 *   --version · --help ·
 *   --projects (v1.0.1: opt back into project names in human output;
 *               default is share-safe — no project names in screenshots)
 *   --no-share (v1.0.2: silence the share prompt; same as env
 *               CACHE_REFUND_NO_SHARE=1 — see maybeSharePrompt)
 *   --plan <usd> (v1.0.2: monthly subscription price; subscription branch
 *               only — renders "~Nx your monthly plan, absorbed for free"
 *               on the receipt/card/SVG. Non-positive/non-numeric -> usage
 *               error, exit 2. See render.ts's planMultiplierLine.)
 *
 * Also: --branch-override <api-5m|api-1h|subscription> — a HIDDEN dev-only
 * flag (not in this list on purpose: not for README, not for users). Forces
 * the billing branch on your REAL corpus numbers, for previewing the other
 * endings without needing three different machines. See CONTRIBUTING.md's
 * "Previewing the other endings" and verdict.ts's BuildSummaryInput.branchOverride.
 *
 * Exit codes: 0 ok · 1 no transcripts found · 2 parse/usage/internal error.
 * `--json` never prompts.
 *
 * TTY-ness is decided ONCE, here, up front, and threaded through every
 * render call as `opts.tty` — render.ts and format.ts never call
 * process.stdout.isTTY themselves.
 */

import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { run } from "./pipeline.js";
import { parsePriceOverride } from "./pricing.js";
import { applyEnable, applyRevert, runRecheck, runVerify } from "./actions.js";
import {
  bskyIntentUrl,
  copyImageToClipboard,
  copyToClipboard,
  noShareEnvSet,
  openExternal,
  revealFile,
  runShareAccept,
  SHARE_PROMPT_LINE,
  xIntentUrl,
} from "./share.js";
import { writeCardImage } from "./cardimage.js";
import {
  checkupLines,
  decideEnding,
  gapBars,
  makeScanProgress,
  pickLoadingPun,
  renderAmbiguousNotice,
  renderCard,
  renderCompact,
  renderEnding,
  renderExplain,
  renderFull,
  renderMarkdown,
  shareRail,
  shareTemplate,
  trustLine,
  wrappedLines,
} from "./render.js";
import { makeInk, makeSym } from "./format.js";
import type { Branch, Summary } from "./types.js";

// ------------------------------------------------------------------ argv

type Subcommand = "checkup" | "card" | "enable" | "revert" | "verify" | "recheck" | "share";

interface Args {
  subcommand: Subcommand;
  days: number | null;
  allTime: boolean;
  project?: string;
  overrides?: Record<string, number>;
  yes: boolean;
  noColor: boolean;
  json: boolean;
  md: boolean;
  compact: boolean;
  explain: boolean;
  /**
   * --projects (v1.0.1): opt back into printing project names in human
   * output for local diagnosis. Default OFF — share-safe output never leaks
   * project names into screenshots. Distinct from --project <path> (scope
   * filter). --json always keeps its project fields regardless.
   */
  projects: boolean;
  /**
   * --no-share (v1.0.2): silence maybeSharePrompt entirely (no prompt line,
   * no "share anytime" hint) — same effect as env CACHE_REFUND_NO_SHARE
   * (see share.ts's noShareEnvSet). The share prompt itself has no other
   * frequency guard: it appears on every interactive checkup end, so this
   * flag is the standing opt-out.
   */
  noShare: boolean;
  /**
   * --plan <usd> (v1.0.2): monthly subscription price, USD. Display-only —
   * never affects any computed figure, only whether the "~Nx your monthly
   * plan, absorbed for free" line renders (subscription branch only; see
   * render.ts's planMultiplierLine). Validated at parse time: non-positive
   * or non-numeric is a usage error (UsageError below), not a silent ignore
   * — unlike most flags here, a wrong --plan value would silently mislabel
   * a real dollar comparison, so it fails loud instead.
   */
  plan?: number;
  /**
   * --branch-override <api-5m|api-1h|subscription> (v1.0.2): HIDDEN dev-only
   * flag, not documented in README (see this file's top comment and
   * CONTRIBUTING.md's "Previewing the other endings"). Forces buildSummary's
   * existing branchOverride seam — see verdict.ts — from the CLI instead of
   * from the interactive ambiguous-branch question, so a maintainer can
   * preview any of the three endings against their OWN real corpus for
   * screenshots/QA. Validated at parse time like --plan.
   */
  branchOverride?: Branch;
}

const SUBCOMMANDS = new Set<Subcommand>(["card", "enable", "revert", "verify", "recheck", "share"]);
const BRANCH_OVERRIDE_VALUES: ReadonlySet<Branch> = new Set(["api-5m", "api-1h", "subscription"]);

/**
 * A clean, stack-trace-free CLI usage error: caught in main(), printed as
 * `cache-refund: <message>` on stderr, exit 2 — never the generic top-level
 * catch-all (which prints err.stack, appropriate for a genuine bug, not a
 * typo'd flag value).
 */
class UsageError extends Error {}

function describeArg(raw: string | undefined): string {
  return raw === undefined ? "nothing" : JSON.stringify(raw);
}

const HELP_TEXT = `cache-refund - a cache doctor for Claude Code

Usage
  npx cache-refund                 full checkup
  npx cache-refund card            score box + top Wrapped line
  npx cache-refund enable          confirmed 1h-TTL enable flow
  npx cache-refund revert          confirmed 5m-TTL revert flow
  npx cache-refund verify          post-enable TTL check
  npx cache-refund recheck         baseline comparison

Flags
  --days <n>                 analysis window in days (default 90)
  --all-time                 the whole corpus, ignoring --days
  --project <path>           one project directory only
  --price <model=$/MTok,...> per-model price overrides
  --plan <usd>               your monthly subscription price, in USD
  --yes, -y                  skip the confirmation prompt
  --json                     machine-readable summary; never prompts
  --md                       markdown report
  --compact                  the short version
  --explain                  the formulas, with your numbers filled in
  --projects                 show project names (hidden by default)
  --no-share                 silence the share prompt
  --no-color                 strip ANSI color
  --version                  print the version and exit
  --help                     this

Exit codes: 0 ok, 1 no transcripts found, 2 parse/internal error
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    subcommand: "checkup",
    days: 90,
    allTime: false,
    yes: false,
    noColor: false,
    json: false,
    md: false,
    compact: false,
    explain: false,
    projects: false,
    noShare: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (i === 0 && !a.startsWith("-") && SUBCOMMANDS.has(a as Subcommand)) {
      args.subcommand = a as Subcommand;
      continue;
    }
    switch (a) {
      case "--json":
        args.json = true;
        break;
      case "--md":
        args.md = true;
        break;
      case "--compact":
        args.compact = true;
        break;
      case "--explain":
        args.explain = true;
        break;
      case "--all-time":
        args.allTime = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--no-color":
        args.noColor = true;
        break;
      case "--no-share":
        args.noShare = true;
        break;
      case "--days": {
        const v = Number(argv[++i]);
        args.days = Number.isFinite(v) ? v : args.days;
        break;
      }
      case "--projects":
        // NOTE: distinct from --project <path> below (exact-match switch, no
        // prefix ambiguity): --projects re-enables project names in human
        // output; --project scopes the analysis to one project dir.
        args.projects = true;
        break;
      case "--project":
        args.project = argv[++i];
        break;
      case "--price":
        args.overrides = parsePriceOverride(argv[++i] ?? "");
        break;
      case "--plan": {
        const raw = argv[++i];
        const v = Number(raw);
        if (raw === undefined || !Number.isFinite(v) || v <= 0) {
          throw new UsageError(`--plan requires a positive USD amount, e.g. --plan 200 (got ${describeArg(raw)})`);
        }
        args.plan = v;
        break;
      }
      case "--branch-override": {
        const raw = argv[++i];
        if (raw === undefined || !BRANCH_OVERRIDE_VALUES.has(raw as Branch)) {
          throw new UsageError(
            `--branch-override must be one of api-5m, api-1h, subscription (got ${describeArg(raw)})`,
          );
        }
        args.branchOverride = raw as Branch;
        break;
      }
      default:
        // Unknown flags are ignored rather than fatal — a screenshot tool
        // shouldn't crash on a typo'd flag; --json output is still valid.
        break;
    }
  }
  return args;
}

// -------------------------------------------------------------------- tty

/**
 * TTY-ness, decided once. Non-TTY (piped, redirected), CI=1, --no-color,
 * or --json all force the plain/non-interactive path. `--json` additionally
 * never prompts.
 */
function isInteractiveTty(args: Args): boolean {
  if (args.json) return false;
  if (process.env.CI) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

function useColor(args: Args, tty: boolean): boolean {
  if (args.noColor) return false;
  if (process.env.CI) return false;
  return tty;
}

// ------------------------------------------------------------- prompt/ask

/** A single [y/N]-style prompt on stdin. Never used on transcript files — stdin only. */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** One free-form prompt line on stdin (share CTA). */
function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ------------------------------------------------------------- share CTA

/**
 * The share CTA (v1.0.1; default-on, no frequency guard, as of v1.0.2).
 * TTY-interactive only — never non-TTY/CI/--json/--md/card/--compact
 * (callers gate on the checkup TTY path + the two forced re-ask moments).
 *
 * No once-per-machine gate anymore: this fires on EVERY interactive checkup
 * end, plus right after a successful enable, after a recheck showing
 * positive savings, and on the `share` subcommand — all callers just call
 * this directly now. The only way to silence it is the standing opt-out:
 * `--no-share` (the `noShare` param) or env `CACHE_REFUND_NO_SHARE`
 * (share.ts's noShareEnvSet) — checked FIRST, before the interactive check,
 * so a suppressed run prints nothing at all, not even the dim hint line.
 * Any non-[x/b/c] answer (including a bare Enter) = skip, no nag — but the
 * door stays visible via the dim "share anytime" line.
 *
 * Trust line holds: zero network requests from this process — [x]/[b] open
 * the user's own browser with prefilled text they read before posting; [c]
 * uses the local clipboard tool.
 */
type ShareContext = "checkup" | "post-enable" | "recheck";

async function maybeSharePrompt(summary: Summary, noShare: boolean, planPrice?: number, context: ShareContext = "checkup"): Promise<void> {
  if (noShare || noShareEnvSet()) return;
  const interactive = process.stdout.isTTY && !process.env.CI;
  if (!interactive) return;

  const answer = await promptLine(`\n${SHARE_PROMPT_LINE}`);

  if (answer === "x" || answer === "b") {
    const text = shareTemplate(summary, context);
    const url = answer === "x" ? xIntentUrl(text) : bskyIntentUrl(text);
    // Generated share image (v1.0.2, replaces the screenshot ask): write the
    // SVG card (+ best-effort PNG on darwin — X attachments need a raster),
    // best-effort put the IMAGE ITSELF on the clipboard so the post is
    // paste-ready (Cmd+V), and print the tip — ALL BEFORE opening the
    // browser (see share.ts's runShareAccept: opening the browser first used
    // to steal terminal focus before the clipboard tip ever printed).
    await runShareAccept(url, {
      writeCardImage: () => writeCardImage(summary, { planPrice }),
      copyImageToClipboard,
      revealFile,
      openExternal,
      write: (s) => process.stdout.write(s),
      pauseBeforeOpen: () => new Promise((r) => setTimeout(r, 1100)),
    });
    return;
  }
  if (answer === "c") {
    const md = renderMarkdown(summary);
    const copied = await copyToClipboard(md);
    if (copied) {
      process.stdout.write("copied — paste it into Slack/Teams.\n");
    } else {
      process.stdout.write(md + "\n\n(no clipboard tool found — copy the block above)\n");
    }
    return;
  }
  // Skipped (Enter, or anything else): stay quiet, but leave the door visible.
  process.stdout.write(makeInk(true).dim("share anytime: npx cache-refund share\n"));
}

/** The one interactive branch-ambiguity question: "subscription or API/Bedrock/Vertex?". */
function promptBranch(): Promise<Branch> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      "cache-refund: couldn't tell how you pay from transcripts or settings.\n" +
        "How do you pay for Claude Code — (s)ubscription or (a)PI/Bedrock/Vertex? [s/a] ",
      (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        resolve(a.startsWith("a") ? "api-5m" : "subscription");
      },
    );
  });
}

// ------------------------------------------------------------------ main

async function main(): Promise<number> {
  const rawArgv = process.argv.slice(2);

  // --version / --help short-circuit everything else, at any argv position
  // (e.g. `cache-refund card --help`) — they must answer with no transcripts,
  // no HOME, and no TTY required, since that's what a fresh `npx cache-refund
  // --version` on a random machine looks like. Ahead of parseArgs too, so a
  // bad companion flag can't turn `--help` into a usage error. --version wins
  // when both are present.
  if (rawArgv.includes("--version")) {
    const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
    process.stdout.write(pkg.version + "\n");
    return 0;
  }
  if (rawArgv.includes("--help")) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  let args: Args;
  try {
    args = parseArgs(rawArgv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`cache-refund: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  const tty = isInteractiveTty(args);
  const color = useColor(args, tty);
  const ink = makeInk(color);
  // ascii-ness tracks TTY-ness only (non-TTY/CI -> ASCII), never --no-color
  // on its own — --no-color strips color but keeps Unicode box chars on a
  // real TTY, per RenderOptions.noColor's "independent of TTY" doc.
  const sym = makeSym(!tty);

  // enable/revert are first-class subcommands and must work in a HOME with
  // zero transcripts — the settings edit needs no Summary. Route them BEFORE
  // the analysis pipeline. --json is exempt: `cache-refund enable --json` is a
  // Summary dump and never writes, so it keeps the pipeline path below.
  // verify/recheck DO need transcripts (they analyze them) and keep their
  // pipeline dependency unchanged.
  if (!args.json && (args.subcommand === "enable" || args.subcommand === "revert")) {
    return await runStandaloneAction(args);
  }

  // Live in-place scan counter (TTY checkup only), fed by pipeline.ts's
  // additive onFileParsed hook (v1.0.1 — replaces the old one-shot
  // "scanning 0/1" line that stayed stuck above the CHECKUP section).
  // The counter rewrites ONLY its own line via "\r" frames and is finalized
  // (erased) the moment run() resolves — the CHECKUP section carries the
  // final counts, and nothing above the progress line is ever touched
  // (no-screen-clear law).
  let progress: ReturnType<typeof makeScanProgress> | null = null;
  if (tty && args.subcommand === "checkup") {
    process.stdout.write(trustLine(ink, sym) + "\n");
    progress = makeScanProgress(pickLoadingPun(), ink, sym);
    const first = progress.frame(0, 0);
    if (first !== null) process.stdout.write(first);
  }

  // Always resolve with jsonMode:true internally first so we get the HONEST
  // branch (including a true "ambiguous" verdict) regardless of the user's
  // requested output mode — see verdict.ts's jsonMode-gated detectBranch.
  const baseResult = await run({
    project: args.project,
    days: args.allTime ? null : args.days,
    allTime: args.allTime,
    jsonMode: true,
    overrides: args.overrides,
    // Hidden dev flag (see Args.branchOverride): forces the branch on the
    // REAL corpus below, before the ambiguous-branch check even runs — the
    // interactive question never fires when this is set (branch is never
    // "ambiguous" once overridden).
    branchOverride: args.branchOverride,
    branchOverrideSource: args.branchOverride ? "flag" : undefined,
    onFileParsed: progress
      ? (done, total) => {
          const p = progress!.frame(done, total);
          if (p !== null) process.stdout.write(p);
        }
      : undefined,
  });
  // Finalize the progress line BEFORE anything else prints (errors, the
  // ambiguous-branch question, the checkup itself).
  if (progress) process.stdout.write(progress.finish());

  if (baseResult.code === 1) {
    process.stderr.write("No transcripts found under ~/.claude/projects\n");
    return 1;
  }
  if (!baseResult.summary) {
    process.stderr.write("Internal error: no summary produced\n");
    return 2;
  }

  let summary = baseResult.summary;

  if (summary.branch === "ambiguous") {
    if (args.json) {
      // --json never prompts — report ambiguous as-is.
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      return 0;
    }
    if (tty) {
      const answer = await promptBranch();
      const resolved = await run({
        project: args.project,
        days: args.allTime ? null : args.days,
        allTime: args.allTime,
        jsonMode: false,
        overrides: args.overrides,
        branchOverride: answer,
      });
      if (!resolved.summary) {
        process.stderr.write("Internal error: no summary produced\n");
        return 2;
      }
      summary = resolved.summary;
    } else {
      // Non-TTY, non-json (e.g. piped to `cat`): can't ask, don't guess wrong
      // silently — print the honest ambiguous notice and stop.
      process.stdout.write(renderAmbiguousNotice() + "\n");
      return 0;
    }
  }

  return await dispatch(args, summary, { tty, color });
}

async function dispatch(
  args: Args,
  summary: Summary,
  renderOpts: { tty: boolean; color: boolean },
): Promise<number> {
  const opts = { tty: renderOpts.tty, noColor: !renderOpts.color, showProjects: args.projects, planPrice: args.plan };

  // --json always wins (stable machine-readable schema).
  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }

  switch (args.subcommand) {
    case "card":
      process.stdout.write(renderCard(summary, opts) + "\n");
      return 0;

    case "share":
      // Sharing on demand: same card + prompt as the checkup's closing frame
      // (there's no frequency guard to bypass anymore — see maybeSharePrompt
      // — running `share` just asks, same as any other checkup end).
      process.stdout.write(renderCard(summary, opts) + "\n");
      await maybeSharePrompt(summary, args.noShare, args.plan);
      return 0;

    // "enable" / "revert" never reach this switch: non-json runs are
    // early-routed to runStandaloneAction() in main() BEFORE the pipeline
    // (they must work without transcripts), and --json runs return via the
    // JSON dump above. Keeping a single standalone write path (with its
    // consent gate) avoids a second, unguarded route to applyEnable.

    case "verify": {
      const res = await runVerify({ home: homedir() });
      process.stdout.write(res.message.join("\n") + "\n");
      return 0;
    }

    case "recheck": {
      const res = await runRecheck({ home: homedir() });
      process.stdout.write(res.message.join("\n") + "\n");
      if ((res.savedSinceEnable ?? 0) > 0) {
        // High-emotion re-ask moment #2: a receipt showing positive savings.
        await maybeSharePrompt(summary, args.noShare, args.plan, "recheck");
      }
      return 0;
    }

    case "checkup":
    default:
      return await renderCheckup(args, summary, opts);
  }
}

/** The default multi-section checkup: --md / --compact / --explain / full (TTY staggered or plain). */
async function renderCheckup(
  args: Args,
  summary: Summary,
  opts: { tty: boolean; noColor: boolean; planPrice?: number },
): Promise<number> {
  if (args.md) {
    process.stdout.write(renderMarkdown(summary) + "\n");
    return 0;
  }
  if (args.compact) {
    process.stdout.write(renderCompact(summary, opts) + "\n");
    return 0;
  }
  if (args.explain) {
    process.stdout.write(renderExplain(summary) + "\n");
    return 0;
  }

  if (!opts.tty) {
    // Plain ASCII, no stagger, no in-place updates, single shot.
    const full = renderFull(summary, opts);
    process.stdout.write(full.lines.join("\n") + "\n");
    return await maybeConsentFromEnding(args, summary, full.needsConsent, full.consentVerb);
  }

  // TTY path: staggered reveal of the trust line and CHECKUP header, then
  // the rest prints normally. Never clears the screen at any point.
  //
  // v1.0.2: no score-box print here anymore. The closing card below (after
  // the ending) is the ONLY box in the whole interactive run — one
  // screenshot-worthy frame at the end, not two. Ending C's receipt total
  // needs nothing extra "at the bottom" for this: the closing card reuses
  // renderCard(), which itself wraps numberBox(), so the receipt's headline
  // figure already lands there. Non-TTY/CI output is untouched (renderFull,
  // used by the !opts.tty branch above, still prints its box up top — see
  // render.ts's craft-laws comment: that snapshot must not change).
  //
  // Tail order (v1.0.2): ending -> closing card -> gap bars + verdict line
  // -> share prompt. Gap bars moved from right after CHECKUP to right after
  // the closing card, so the terminal's last frame mirrors the generated
  // share image's own composition (cardimage.ts's buildCardSvg: hero block,
  // then the gap-bars breakdown) — screenshot and card now read the same way.
  const ink = makeInk(!opts.noColor);
  // Reached only when opts.tty is true (see the !opts.tty branch above), so
  // this is always the Unicode table — ascii-ness tracks TTY-ness.
  const sym = makeSym(false);
  await staggerPrint(checkupLines(summary, ink, sym));
  process.stdout.write("\n" + wrappedLines(summary, ink, sym, args.projects).join("\n") + "\n\n");

  const kind = decideEnding(summary);
  const ending = renderEnding(summary, kind, ink, sym, opts.planPrice);
  process.stdout.write(ending.lines.join("\n") + "\n\n");
  process.stdout.write(shareRail(ink, sym, { closingCardFollows: true }).join("\n") + "\n");

  const code = await maybeConsentFromEnding(args, summary, ending.needsConsent, ending.consentVerb);

  // Closing card (v1.0.2, TTY full checkup only): the run ends by dealing
  // your card — the exact `card` block re-printed as the final frame, so the
  // tail of the terminal IS the screenshot. After the rail (and any consent
  // flow, which would otherwise push it up), before the gap bars.
  // Non-TTY/CI output is unchanged (this is the TTY branch only).
  process.stdout.write("\n" + renderCard(summary, opts) + "\n");

  // Gap bars + verdict line (moved here, v1.0.2 — see the tail-order comment
  // above), after the closing card, before the share prompt.
  process.stdout.write("\n" + gapBars(summary, ink, false, sym).join("\n") + "\n");

  // Share CTA, after the gap bars (TTY path only — the non-TTY branch
  // above never prompts). Fires every time (see maybeSharePrompt) unless
  // suppressed by --no-share / CACHE_REFUND_NO_SHARE.
  await maybeSharePrompt(summary, args.noShare, args.plan);
  return code;
}

/** ~150ms stagger between CHECKUP's ✓✓⚠ lines, TTY only. */
async function staggerPrint(lines: string[]): Promise<void> {
  for (const line of lines) {
    process.stdout.write(line + "\n");
    await sleep(150);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Standalone `cache-refund enable` / `cache-refund revert` (first-class
 * subcommands). Runs BEFORE the analysis pipeline — the settings edit needs
 * no Summary, so a HOME with zero transcripts can still enable/revert;
 * enable/revert must work without any transcripts present, unlike the
 * "No transcripts found" gate that guards the rest of main().
 *
 * Consent discipline mirrors maybeConsentFromEnding exactly: interactive
 * [y/N] by default, --yes skips it, and a non-interactive run without --yes
 * writes NOTHING — the one write is always confirmed.
 *
 * For `enable`, the pipeline still runs best-effort AFTER consent so the
 * recheck baseline gets written when transcripts exist ("enable writes a
 * small local baseline file"). Analysis failure or an empty corpus skips the
 * baseline silently — it is convenience data for recheck receipts, never a
 * precondition for the settings edit.
 */
async function runStandaloneAction(args: Args): Promise<number> {
  const verb: "enable" | "revert" = args.subcommand === "enable" ? "enable" : "revert";
  const interactive = process.stdout.isTTY && !process.env.CI;
  const verbLabel = verb === "enable" ? "Claim your cache refund (sets 1h TTL)" : "Revert to 5m now";

  let confirmed = args.yes;
  if (!confirmed && interactive) {
    confirmed = await promptYesNo(`${verbLabel}? [y/N] `);
  }
  if (!confirmed) {
    process.stdout.write(
      interactive
        ? "Nothing changed.\n"
        : `(non-interactive: pass --yes to apply: \`cache-refund ${verb} --yes\`)\n`,
    );
    return 0;
  }

  if (verb === "revert") {
    const res = applyRevert({ home: homedir() });
    process.stdout.write(res.message.join("\n") + "\n");
    return 0;
  }

  let summary: Summary | undefined;
  try {
    const r = await run({
      project: args.project,
      days: args.allTime ? null : args.days,
      allTime: args.allTime,
      jsonMode: true,
      overrides: args.overrides,
      branchOverride: args.branchOverride,
      branchOverrideSource: args.branchOverride ? "flag" : undefined,
    });
    summary = r.summary ?? undefined;
  } catch {
    // Analysis failure never blocks the enable itself (baseline is optional).
  }
  const res = applyEnable({ home: homedir(), summary });
  process.stdout.write(res.message.join("\n") + "\n");
  if (res.applied && summary) {
    // High-emotion re-ask moment #1 (standalone `enable` route). Skipped
    // when no Summary exists (empty corpus) — no numbers to fill a template.
    await maybeSharePrompt(summary, args.noShare, args.plan, "post-enable");
  }
  return 0;
}

async function maybeConsentFromEnding(
  args: Args,
  summary: Summary,
  needsConsent: boolean,
  consentVerb: "enable" | "revert" | undefined,
): Promise<number> {
  if (!needsConsent || !consentVerb) return 0;

  // --json never prompts and never reaches here (handled earlier). Non-TTY
  // (piped) also never prompts: print the manual instruction and exit 0 —
  // never prompt when not attached to a TTY.
  const interactive = process.stdout.isTTY && !process.env.CI;
  const verbLabel = consentVerb === "enable" ? "Claim your cache refund (sets 1h TTL)" : "Revert to 5m now";

  let confirmed = args.yes;
  if (!confirmed && interactive) {
    confirmed = await promptYesNo(`${verbLabel}? [y/N] `);
  }

  if (!confirmed) {
    if (!interactive && !args.yes) {
      process.stdout.write(
        `\n(non-interactive: pass --yes to apply, or run \`cache-refund ${consentVerb}\` from a terminal)\n`,
      );
    }
    return 0;
  }

  const res =
    consentVerb === "enable"
      ? applyEnable({ home: homedir(), summary })
      : applyRevert({ home: homedir() });
  process.stdout.write("\n" + res.message.join("\n") + "\n");
  if (res.applied && consentVerb === "enable") {
    // High-emotion re-ask moment #1: right after a successful enable.
    await maybeSharePrompt(summary, args.noShare, args.plan, "post-enable");
  }
  return 0;
}

// ------------------------------------------------------------- entrypoint
// Run only when executed directly (`node dist/cli.js`, the npm bin shim,
// `npx cache-refund`) — never on import, so tests can reach the interactive
// code paths without spawning the CLI as a side effect. The realpath step is
// load-bearing: the npm bin entry is a symlink to dist/cli.js, and node
// resolves the main module's import.meta.url through symlinks, so comparing
// against a realpath'd argv[1] keeps the shim matching. If realpath fails
// (argv[1] missing or unreadable), fall back to the raw path comparison.
const entryHref = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return null;
  try {
    return pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return pathToFileURL(argv1).href;
  }
})();

if (entryHref === import.meta.url) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`cache-refund: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(2);
    });
}
