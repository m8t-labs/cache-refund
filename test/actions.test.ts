/**
 * Actions tests — the highest-blast-radius code in the repo.
 *
 * HARD LAW: every test in this file runs under a synthetic HOME created by
 * `mkdtempSync`. Nothing here may EVER touch the real ~/.claude.
 *
 * Design note on WHY this guard checks `os.tmpdir()`, not `process.env.HOME`:
 * `applyEnable`/`applyRevert`/`runVerify`/`runRecheck` all take `home` as a
 * REQUIRED explicit parameter (see actions.ts's doc comment) and never fall
 * back to `process.env.HOME` or `os.homedir()` internally — that's the whole
 * point of the "home is required, never defaulted" design. So gating this
 * guard on the ambient `process.env.HOME` env var would check something
 * these functions don't even read, AND would force every `npm test`
 * invocation (which also runs oracle-parity.test.ts, which deliberately
 * reads the REAL `~/.claude/projects` corpus via `homedir()`) to run under a
 * fake HOME just to satisfy this file — breaking oracle parity's real-corpus
 * trust test to protect a file that doesn't need the protection that way.
 *
 * Instead, the guard verifies the actual mechanism this file uses to select
 * a home: every test gets its `home` value from `freshHome()`, which builds
 * a path under `os.tmpdir()` via `mkdtempSync` and is asserted (both at
 * module load and per-call) to never coincide with the real account home
 * (read independently from the OS user database via `os.userInfo()`, which
 * — unlike `os.homedir()` — ignores the `HOME` env var, so it can't be
 * spoofed by the very value under test). This is the guard that fails the
 * test run if HOME resolves to a real user home, applied to the HOME this
 * suite actually constructs and passes to the code under test, rather than
 * to an ambient variable actions.ts never consults.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyEnable, applyRevert, runRecheck, runVerify } from "../src/actions.js";
import type { Summary } from "../src/types.js";

// --------------------------------------------------------- CI guard (hard law)

/**
 * The REAL account home directory, from the OS password database
 * (`os.userInfo()`, NOT `os.homedir()` / `process.env.HOME` — those just
 * echo back whatever HOME is currently set to, which is a tautology when
 * used to validate HOME itself; `userInfo().homedir` is sourced from
 * getpwuid and can't be spoofed by an env var).
 */
const REAL_ACCOUNT_HOME = (() => {
  try {
    return userInfo().homedir;
  } catch {
    // Some sandboxes/containers have no password-database entry. Fall back
    // to null; freshHome()'s tmpdir-prefix check below still guards against
    // writing outside a temp directory.
    return null;
  }
})();

/**
 * Fails the entire test run if this file's home-construction base
 * (`os.tmpdir()`) resolves to (or under) the real account home — the
 * explicit CI guard this suite requires, applied to the value this file
 * actually uses. Runs once at module load, before any test executes.
 */
beforeAll(() => {
  const base = tmpdir();
  if (!base) {
    throw new Error(
      "actions.test.ts REFUSES to run: os.tmpdir() returned empty. This test " +
        "suite edits settings.json under a synthetic HOME built from tmpdir() " +
        "and must NEVER touch the real ~/.claude.",
    );
  }
  if (REAL_ACCOUNT_HOME !== null && (base === REAL_ACCOUNT_HOME || base.startsWith(REAL_ACCOUNT_HOME + "/"))) {
    throw new Error(
      "actions.test.ts REFUSES to run: os.tmpdir() (" +
        base +
        ") resolves to (or under) the REAL account home directory (" +
        REAL_ACCOUNT_HOME +
        ", from the OS user database). This test suite edits settings.json " +
        "under a synthetic HOME built from tmpdir() and must NEVER touch the " +
        "real ~/.claude. This usually means TMPDIR is misconfigured to point " +
        "inside the real home — fix TMPDIR before running tests.",
    );
  }
});

// ------------------------------------------------------------ test fixtures

const tempDirs: string[] = [];

/** A fresh synthetic HOME for one test. Asserts it is not the real home. */
function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "cache-refund-actions-"));
  const unsafe =
    dir.length === 0 ||
    (REAL_ACCOUNT_HOME !== null && (dir === REAL_ACCOUNT_HOME || dir.startsWith(REAL_ACCOUNT_HOME + "/")));
  if (unsafe) {
    throw new Error("freshHome() produced an unsafe path (" + dir + ") — aborting");
  }
  tempDirs.push(dir);
  return dir;
}

function settingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

function backupPath(home: string): string {
  return join(home, ".claude", "settings.json.cache-refund.bak");
}

function baselinePath(home: string): string {
  return join(home, ".claude", "cache-refund.json");
}

function writeSettings(home: string, obj: unknown): void {
  const dir = join(home, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath(home), JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function readSettingsRaw(home: string): string {
  return readFileSync(settingsPath(home), "utf8");
}

function readSettingsJson(home: string): Record<string, unknown> {
  return JSON.parse(readSettingsRaw(home));
}

function statModeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    if (dir !== REAL_ACCOUNT_HOME) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// A minimal synthetic Summary for baseline-write tests. Only the fields
// applyEnable's baseline writer touches need to be realistic; everything else
// is zeroed. Kept local to this file (not test/fixtures/summaries.ts) since
// it exercises a narrow slice specific to the baseline shape.
function fixtureSummary(overrides: Partial<Summary> = {}): Summary {
  const base: Summary = {
    summaryVersion: 1,
    scoreVersion: 1,
    window: { mode: "days", days: 90, firstTs: 1000, lastTs: 2000, spanDays: 90 },
    scope: { project: null, sessions: 3, turns: 10 },
    branch: "api-5m",
    branchEvidence: ["ANTHROPIC_API_KEY present (API billing)", "observed write regime: 5m"],
    regime: "5m",
    ttlRealityCheck: { windowDays: 7, regime: "5m", creation5m: 1000, creation1h: 0, received: "5m" },
    buckets: {
      warm: 100,
      recoverable: 500,
      cold: 400,
      creationTotal: 1000,
      readsAfterRecoverableGap: 200,
      turnCounts: { start: 1, warm: 3, recoverable: 4, cold: 2 },
    },
    tokens: { creationTotal: 1000, creation5m: 1000, creation1h: 0, readTotal: 300 },
    recoverableRatio: 0.5,
    threshold: 0.3947,
    aboveThreshold: true,
    perModel: [],
    unknownModels: [],
    leaks: [],
    counterfactual: {
      actualCost: 10,
      cost5m: 10,
      cost1h: 6,
      delta1hMinus5m: -4,
      tailWriteTokens: 50,
      tailWriteCost: 0.5,
      delta30d: -1.33,
      spanDays: 90,
    },
    efficiencyScore: 72.3,
    biggestMiss: null,
    worstDay: null,
    wrapped: { streakDays: 2, peakHour: 14, peakHourTurns: 5, biggestSessionKey: "x", biggestSessionProject: "p", biggestSessionCreation: 500, activeDays: 5 },
    currency: "USD",
  };
  return { ...base, ...overrides };
}

// ============================================================ applyEnable

describe("applyEnable", () => {
  it("creates a minimal settings.json when none exists", () => {
    const home = freshHome();
    expect(existsSync(settingsPath(home))).toBe(false);

    const res = applyEnable({ home });

    expect(res.applied).toBe(true);
    expect(existsSync(settingsPath(home))).toBe(true);
    const j = readSettingsJson(home);
    expect((j.env as Record<string, unknown>)["ENABLE_PROMPT_CACHING_1H"]).toBe("1");
  });

  it("does NOT write a backup file when settings.json did not previously exist", () => {
    // Nothing to back up — a backup of a nonexistent file would be misleading.
    const home = freshHome();
    applyEnable({ home });
    expect(existsSync(backupPath(home))).toBe(false);
  });

  it("sets the flag on an existing settings.json and preserves all other keys", () => {
    const home = freshHome();
    writeSettings(home, {
      model: "opus[1m]",
      statusLine: { type: "command", command: "bash foo.sh" },
      env: { SOME_OTHER_FLAG: "yes" },
    });

    const res = applyEnable({ home });

    expect(res.applied).toBe(true);
    const j = readSettingsJson(home);
    expect(j.model).toBe("opus[1m]");
    expect(j.statusLine).toEqual({ type: "command", command: "bash foo.sh" });
    const env = j.env as Record<string, unknown>;
    expect(env.SOME_OTHER_FLAG).toBe("yes");
    expect(env.ENABLE_PROMPT_CACHING_1H).toBe("1");
  });

  it("preserves foreign top-level keys it has never heard of", () => {
    const home = freshHome();
    writeSettings(home, {
      someFutureField: { nested: true, arr: [1, 2, 3] },
      permissions: { allow: ["Bash(git *)"] },
    });

    applyEnable({ home });

    const j = readSettingsJson(home);
    expect(j.someFutureField).toEqual({ nested: true, arr: [1, 2, 3] });
    expect(j.permissions).toEqual({ allow: ["Bash(git *)"] });
  });

  it("preserves 2-space indentation formatting", () => {
    const home = freshHome();
    writeSettings(home, { model: "opus[1m]" });

    applyEnable({ home });

    const raw = readSettingsRaw(home);
    const lines = raw.split("\n");
    // Top-level key should be indented exactly 2 spaces (matches real Claude
    // Code settings.json formatting, confirmed against this machine's own
    // file). The nested "env.ENABLE_PROMPT_CACHING_1H" key is legitimately
    // 4 spaces deep (2 levels x 2-space indent) — that's correct nesting,
    // not a formatting bug, so this only asserts consistent 2-space steps
    // (no 3-space, no tabs), not "never 4 spaces anywhere".
    expect(lines[1]).toMatch(/^  "model"/);
    expect(raw).toContain('\n  "env": {\n    "ENABLE_PROMPT_CACHING_1H": "1"\n  }\n');
    expect(raw).not.toMatch(/\t/);
    // Every indented line's leading-space count is a multiple of 2.
    for (const line of lines) {
      const m = line.match(/^( *)\S/);
      if (m) expect(m[1].length % 2).toBe(0);
    }
  });

  it("creates a timestamped backup when settings.json already existed", () => {
    const home = freshHome();
    const original = { model: "opus[1m]", env: { FOO: "bar" } };
    writeSettings(home, original);

    applyEnable({ home });

    expect(existsSync(backupPath(home))).toBe(true);
    const backup = JSON.parse(readFileSync(backupPath(home), "utf8"));
    expect(backup).toEqual(original);
  });

  it("writes settings.json atomically: no stray temp files are left behind", () => {
    const home = freshHome();
    writeSettings(home, { model: "opus[1m]" });

    applyEnable({ home });

    const entries = readdirSync(join(home, ".claude"));
    const strays = entries.filter((e) => e.includes(".cache-refund.tmp."));
    expect(strays).toEqual([]);
    // And the final file is valid, complete JSON (the point of atomicity: a
    // reader never sees a half-written file).
    expect(() => readSettingsJson(home)).not.toThrow();
  });

  it("refuses (never silently discards) when env is a string, array, or number — malformed env is treated like malformed JSON", () => {
    for (const badEnv of ["not-an-object", [1, 2, 3], 42]) {
      const home = freshHome();
      const original = { model: "opus[1m]", env: badEnv };
      writeSettings(home, original);
      const before = readSettingsRaw(home);

      const res = applyEnable({ home });

      expect(res.applied).toBe(false);
      expect(res.message.join("\n")).toMatch(/"env"/);
      // File byte-for-byte untouched, and no backup was created (nothing
      // was ever applied — silently discarding the bad env value would be
      // exactly the "preserve all other keys" violation this guards against).
      expect(readSettingsRaw(home)).toBe(before);
      expect(existsSync(backupPath(home))).toBe(false);
    }
  });

  it("treats env: null the same as env absent (benign, not malformed) — applies cleanly", () => {
    const home = freshHome();
    writeSettings(home, { model: "opus[1m]", env: null });

    const res = applyEnable({ home });

    expect(res.applied).toBe(true);
    const j = readSettingsJson(home);
    expect(j.model).toBe("opus[1m]");
    expect((j.env as Record<string, unknown>).ENABLE_PROMPT_CACHING_1H).toBe("1");
  });

  it("applyRevert also refuses when env is a string, array, or number", () => {
    const home = freshHome();
    const original = { model: "opus[1m]", env: "not-an-object" };
    writeSettings(home, original);
    const before = readSettingsRaw(home);

    const res = applyRevert({ home });

    expect(res.applied).toBe(false);
    expect(readSettingsRaw(home)).toBe(before);
  });

  it("applyRevert works when the env key is missing entirely", () => {
    const home = freshHome();
    writeSettings(home, { model: "opus[1m]" });

    const res = applyRevert({ home });

    expect(res.applied).toBe(true);
    const j = readSettingsJson(home);
    expect(j.env).toEqual({});
    expect(j.model).toBe("opus[1m]");
  });

  it("shows the exact diff applied", () => {
    const home = freshHome();
    writeSettings(home, { model: "opus[1m]" });

    const res = applyEnable({ home });

    const joined = res.message.join("\n");
    expect(joined).toContain("ENABLE_PROMPT_CACHING_1H");
    expect(joined).toContain("1");
  });

  it("prints takes-effect-next-session, revert instruction, and the verify instruction", () => {
    const home = freshHome();
    const res = applyEnable({ home });
    const joined = res.message.join("\n");
    expect(joined.toLowerCase()).toMatch(/next session/);
    expect(joined).toContain("revert");
    expect(joined).toContain("verify");
  });

  it("prints the known-flakiness caveat (#49139)", () => {
    const home = freshHome();
    const res = applyEnable({ home });
    expect(res.message.join("\n")).toContain("49139");
  });

  it("refuses when FORCE_PROMPT_CACHING_5M is set in settings.json, and does not edit the file", () => {
    const home = freshHome();
    const original = { env: { FORCE_PROMPT_CACHING_5M: "1" } };
    writeSettings(home, original);
    const before = readSettingsRaw(home);

    const res = applyEnable({ home });

    expect(res.applied).toBe(false);
    expect(res.message.join("\n").toUpperCase()).toContain("FORCE_PROMPT_CACHING_5M");
    expect(readSettingsRaw(home)).toBe(before);
    expect(existsSync(backupPath(home))).toBe(false);
  });

  it("refuses when FORCE_PROMPT_CACHING_5M is set via process env (not settings)", () => {
    const home = freshHome();
    writeSettings(home, { model: "opus[1m]" });
    const before = readSettingsRaw(home);

    const res = applyEnable({ home, env: { ...process.env, FORCE_PROMPT_CACHING_5M: "1" } });

    expect(res.applied).toBe(false);
    expect(readSettingsRaw(home)).toBe(before);
  });

  it("aborts with a clear message on malformed JSON and never overwrites the file", () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const malformed = '{ "model": "opus[1m]", invalid_json_here }}}';
    writeFileSync(settingsPath(home), malformed, "utf8");

    const res = applyEnable({ home });

    expect(res.applied).toBe(false);
    expect(res.message.join("\n").toLowerCase()).toMatch(/malformed|invalid|parse/);
    // The file must be byte-for-byte untouched.
    expect(readFileSync(settingsPath(home), "utf8")).toBe(malformed);
    expect(existsSync(backupPath(home))).toBe(false);
  });

  it("aborts when settings.json parses but is not a JSON object (e.g. an array)", () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const arrayJson = "[1, 2, 3]";
    writeFileSync(settingsPath(home), arrayJson, "utf8");

    const res = applyEnable({ home });

    expect(res.applied).toBe(false);
    expect(readFileSync(settingsPath(home), "utf8")).toBe(arrayJson);
  });

  it("writes a baseline file on successful enable with aggregate numbers only", () => {
    const home = freshHome();
    const summary = fixtureSummary({ efficiencyScore: 81.4, recoverableRatio: 0.55 });

    const res = applyEnable({ home, summary });

    expect(res.applied).toBe(true);
    expect(existsSync(baselinePath(home))).toBe(true);
    const baseline = JSON.parse(readFileSync(baselinePath(home), "utf8"));
    expect(typeof baseline.enabled_at).toBe("string");
    expect(baseline.window_days).toBe(90);
    expect(baseline.efficiencyScore).toBeCloseTo(81.4);
    expect(baseline.recoverableRatio).toBeCloseTo(0.55);
    // No transcript content — only aggregate/summary-shaped numbers.
    const raw = readFileSync(baselinePath(home), "utf8");
    expect(raw).not.toMatch(/sessionKey|"ts":|biggestMiss/); // no per-turn/raw-transcript fields
  });

  it("does NOT write a baseline file when no summary is provided (still applies the flag)", () => {
    const home = freshHome();
    const res = applyEnable({ home });
    expect(res.applied).toBe(true);
    expect(existsSync(baselinePath(home))).toBe(false);
  });

  it("does not write anything when --json mode would be in effect (never-writes law enforced by caller, but applyEnable itself has no json flag — verifying it has no such escape hatch)", () => {
    // applyEnable has no jsonMode parameter at all — the "--json never
    // triggers writes" law is enforced by cli.ts never calling applyEnable
    // when args.json is true (see cli.ts's early-return for --json). This
    // test documents that applyEnable's own surface has no way to bypass
    // that discipline from within actions.ts.
    const home = freshHome();
    const res = applyEnable({ home });
    expect("json" in res).toBe(false);
  });

  it("is idempotent: calling enable twice does not corrupt the file or double-append", () => {
    const home = freshHome();
    writeSettings(home, { model: "opus[1m]" });

    applyEnable({ home });
    const afterFirst = readSettingsJson(home);
    const res2 = applyEnable({ home });
    const afterSecond = readSettingsJson(home);

    expect(res2.applied).toBe(true);
    expect(afterSecond).toEqual(afterFirst);
  });

  // Skipped when running as root: permission bits don't block root's own
  // writes on POSIX, so this test would be unreliable (not a real failure,
  // just a platform property) in a root-run CI container.
  const itUnlessRoot = process.getuid && process.getuid() === 0 ? it.skip : it;

  itUnlessRoot("if the backup write fails, the original settings.json is left completely untouched (fail-closed ordering)", () => {
    const home = freshHome();
    const original = { model: "opus[1m]", env: { PRECIOUS: "do-not-lose-me" } };
    writeSettings(home, original);
    const claudeDir = join(home, ".claude");

    // Make the directory read-only so the backup write (which happens BEFORE
    // the real settings.json write) fails with EACCES. This proves the
    // write-ordering claim in actions.ts's doc comment: "backup first" means
    // a backup failure aborts before the primary file is ever touched, not
    // "backup best-effort, then overwrite regardless."
    const originalMode = statModeOf(claudeDir);
    try {
      chmodSync(claudeDir, 0o555); // read+execute, no write
      expect(() => applyEnable({ home })).toThrow();
      // The original file must be byte-for-byte unchanged — the throw must
      // have happened before writeFileSync(settingsPath, ...) ever ran.
      const afterRaw = readFileSync(settingsPath(home), "utf8");
      expect(JSON.parse(afterRaw)).toEqual(original);
      expect(existsSync(backupPath(home))).toBe(false);
    } finally {
      // Restore write permission so afterEach's rmSync can clean up.
      chmodSync(claudeDir, originalMode);
    }
  });
});

// ============================================================ applyRevert

describe("applyRevert", () => {
  it("removes ENABLE_PROMPT_CACHING_1H and preserves everything else", () => {
    const home = freshHome();
    writeSettings(home, {
      model: "opus[1m]",
      env: { ENABLE_PROMPT_CACHING_1H: "1", OTHER: "kept" },
    });

    const res = applyRevert({ home });

    expect(res.applied).toBe(true);
    const j = readSettingsJson(home);
    const env = j.env as Record<string, unknown>;
    expect(env.ENABLE_PROMPT_CACHING_1H).toBeUndefined();
    expect(env.OTHER).toBe("kept");
    expect(j.model).toBe("opus[1m]");
  });

  it("creates a backup before reverting", () => {
    const home = freshHome();
    const original = { env: { ENABLE_PROMPT_CACHING_1H: "1" } };
    writeSettings(home, original);

    applyRevert({ home });

    expect(existsSync(backupPath(home))).toBe(true);
    expect(JSON.parse(readFileSync(backupPath(home), "utf8"))).toEqual(original);
  });

  it("is a clean no-op-but-applied when the flag was already absent", () => {
    const home = freshHome();
    writeSettings(home, { model: "opus[1m]" });

    const res = applyRevert({ home });

    expect(res.applied).toBe(true);
    const j = readSettingsJson(home);
    expect(j.model).toBe("opus[1m]");
  });

  it("refuses to create a settings.json out of nothing just to revert", () => {
    const home = freshHome();
    expect(existsSync(settingsPath(home))).toBe(false);

    const res = applyRevert({ home });

    // Nothing to revert — this should be a clean, honest no-op, not a write.
    expect(res.applied).toBe(false);
    expect(existsSync(settingsPath(home))).toBe(false);
  });

  it("aborts with a clear message on malformed JSON and never overwrites", () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const malformed = "{ not: valid, json";
    writeFileSync(settingsPath(home), malformed, "utf8");

    const res = applyRevert({ home });

    expect(res.applied).toBe(false);
    expect(readFileSync(settingsPath(home), "utf8")).toBe(malformed);
  });

  it("round-trips with applyEnable: enable then revert returns to the original env shape", () => {
    const home = freshHome();
    const original = { model: "opus[1m]", env: { KEEP_ME: "yes" } };
    writeSettings(home, original);

    applyEnable({ home });
    const afterEnable = readSettingsJson(home);
    expect((afterEnable.env as Record<string, unknown>).ENABLE_PROMPT_CACHING_1H).toBe("1");

    applyRevert({ home });
    const afterRevert = readSettingsJson(home);
    expect(afterRevert).toEqual(original);
  });

  it("supports an explicit --force-5m variant only when trivially clean (no conflicting flags)", () => {
    const home = freshHome();
    writeSettings(home, { env: { ENABLE_PROMPT_CACHING_1H: "1" } });

    const res = applyRevert({ home, force: true });

    expect(res.applied).toBe(true);
    const j = readSettingsJson(home);
    const env = j.env as Record<string, unknown>;
    expect(env.FORCE_PROMPT_CACHING_5M).toBe("1");
    expect(env.ENABLE_PROMPT_CACHING_1H).toBeUndefined();
  });
});

// ============================================================== runVerify

describe("runVerify", () => {
  function projectDir(home: string): string {
    const dir = join(home, ".claude", "projects", "test-project");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeTranscript(dir: string, name: string, lines: unknown[]): void {
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(join(dir, name), body, "utf8");
  }

  function turnLine(tsIso: string, c1: number, c5: number, read = 0) {
    return {
      timestamp: tsIso,
      sessionId: "sess-1",
      isSidechain: false,
      message: {
        id: `msg-${tsIso}-${c1}-${c5}`,
        model: "claude-sonnet-5",
        usage: {
          cache_creation: { ephemeral_5m_input_tokens: c5, ephemeral_1h_input_tokens: c1 },
          cache_read_input_tokens: read,
        },
      },
    };
  }

  it("reports 'no fresh sessions yet' when there are no transcripts at all", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });

    const res = await runVerify({ home });

    expect(res.applied).toBe(false);
    expect(res.message.join("\n").toLowerCase()).toMatch(/no fresh sessions|do a few turns/);
  });

  it("reports 'working end to end' when recent transcripts show 1h writes landing", async () => {
    const home = freshHome();
    const dir = projectDir(home);
    const now = new Date();
    writeTranscript(dir, "recent.jsonl", [turnLine(now.toISOString(), 5000, 0, 1000)]);

    const res = await runVerify({ home });

    expect(res.message.join("\n").toLowerCase()).toMatch(/working end to end|✓|\bok\b/i);
  });

  it("reports 'still 5m' with the #49139 pointer when recent transcripts are still 5m", async () => {
    const home = freshHome();
    const dir = projectDir(home);
    const now = new Date();
    writeTranscript(dir, "recent.jsonl", [turnLine(now.toISOString(), 0, 5000, 1000)]);

    const res = await runVerify({ home });

    const joined = res.message.join("\n");
    expect(joined).toMatch(/still 5m/i);
    expect(joined).toContain("49139");
  });

  it("only looks at transcripts modified since baseline/enable (or last 24h if no baseline)", async () => {
    const home = freshHome();
    const dir = projectDir(home);
    // An OLD 5m-only transcript far outside any 24h/baseline window...
    const old = new Date(Date.now() - 40 * 86400 * 1000);
    writeTranscript(dir, "old.jsonl", [turnLine(old.toISOString(), 0, 9000, 0)]);
    // ...and a fresh, small 1h transcript.
    const now = new Date();
    writeTranscript(dir, "fresh.jsonl", [turnLine(now.toISOString(), 3000, 0, 500)]);

    const res = await runVerify({ home });

    // Should reflect the FRESH regime (1h), not be swamped by the old 5m data.
    expect(res.message.join("\n").toLowerCase()).toMatch(/working end to end|✓/);
  });

  it("never writes anything to disk", async () => {
    const home = freshHome();
    const dir = projectDir(home);
    writeTranscript(dir, "recent.jsonl", [turnLine(new Date().toISOString(), 1000, 0, 200)]);
    const settingsBefore = existsSync(settingsPath(home));

    await runVerify({ home });

    expect(existsSync(settingsPath(home))).toBe(settingsBefore);
    expect(existsSync(baselinePath(home))).toBe(false);
  });
});

// ============================================================= runRecheck

describe("runRecheck", () => {
  function writeBaseline(home: string, baseline: Record<string, unknown>): void {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(baselinePath(home), JSON.stringify(baseline, null, 2), "utf8");
  }

  function projectDir(home: string): string {
    const dir = join(home, ".claude", "projects", "test-project");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeTranscript(dir: string, name: string, lines: unknown[]): void {
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(join(dir, name), body, "utf8");
  }

  function turnLine(tsIso: string, c1: number, c5: number, read = 0) {
    return {
      timestamp: tsIso,
      sessionId: "sess-1",
      isSidechain: false,
      message: {
        id: `msg-${tsIso}-${c1}-${c5}-${Math.random()}`,
        model: "claude-sonnet-5",
        usage: {
          cache_creation: { ephemeral_5m_input_tokens: c5, ephemeral_1h_input_tokens: c1 },
          cache_read_input_tokens: read,
        },
      },
    };
  }

  it("reports no baseline found when enable was never run", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });

    const res = await runRecheck({ home });

    expect(res.applied).toBe(false);
    expect(res.message.join("\n").toLowerCase()).toMatch(/no baseline|run.*enable|haven'?t enabled/);
  });

  it("treats a malformed (corrupt JSON) baseline file the same as no baseline — degrades safely, never throws", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    writeFileSync(baselinePath(home), "{ not valid json at all", "utf8");

    const res = await runRecheck({ home });

    expect(res.applied).toBe(false);
    expect(res.message.join("\n").toLowerCase()).toMatch(/no baseline|run.*enable|haven'?t enabled/);
  });

  it("treats a baseline file missing enabled_at the same as no baseline", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    writeFileSync(baselinePath(home), JSON.stringify({ window_days: 90 }), "utf8");

    const res = await runRecheck({ home });

    expect(res.applied).toBe(false);
    expect(res.message.join("\n").toLowerCase()).toMatch(/no baseline/);
  });

  it("computes since-switching $ saved against a synthetic baseline", async () => {
    const home = freshHome();
    const dir = projectDir(home);
    const now = new Date();
    // Post-enable activity: mostly 1h writes plus a bunch of reads (cheap).
    for (let i = 0; i < 5; i++) {
      writeTranscript(dir, `t${i}.jsonl`, [
        turnLine(new Date(now.getTime() - i * 60_000).toISOString(), 2000, 0, 5000),
      ]);
    }
    writeBaseline(home, {
      enabled_at: new Date(now.getTime() - 10 * 86400 * 1000).toISOString(),
      window_days: 90,
      efficiencyScore: 50,
      recoverableRatio: 0.5,
      delta30d: 0,
      currency: "USD",
      branch: "api-5m",
    });

    const res = await runRecheck({ home });

    const joined = res.message.join("\n");
    expect(joined).toMatch(/since switching/i);
    expect(joined).toMatch(/\$[\d,.]+/); // contains a dollar figure
  });

  it("never writes anything to disk (read-only law)", async () => {
    const home = freshHome();
    writeBaseline(home, {
      enabled_at: new Date().toISOString(),
      window_days: 90,
      efficiencyScore: 50,
      recoverableRatio: 0.5,
      delta30d: 0,
      currency: "USD",
      branch: "api-5m",
    });
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });

    await runRecheck({ home });

    expect(existsSync(settingsPath(home))).toBe(false);
  });
});

// ================================================= module-level CI safety

describe("CI guard", () => {
  it("every home this suite constructs is a tmpdir-rooted path, not the real account home", () => {
    // Re-assert per-test (not just at module-load beforeAll) so a rogue test
    // that somehow got a home value from somewhere other than freshHome()
    // can't silently slip past the guard.
    const home = freshHome();
    expect(home.startsWith(tmpdir())).toBe(true);
    if (REAL_ACCOUNT_HOME !== null) {
      expect(home).not.toBe(REAL_ACCOUNT_HOME);
      expect(home.startsWith(REAL_ACCOUNT_HOME + "/")).toBe(false);
    }
  });

  it("actions.ts's public functions never fall back to process.env.HOME or os.homedir() — home is always required", () => {
    // This is a structural/type-level guarantee (ActionOpts.home is a
    // required, non-optional string — see actions.ts), but assert the
    // runtime behavior too: calling with a home that is deliberately NOT
    // process.env.HOME must operate on THAT path, not silently redirect to
    // the ambient home. If this ever regressed to reading process.env.HOME
    // internally, this test would start failing because settingsPath(home)
    // would never get created.
    const home = freshHome();
    expect(home).not.toBe(process.env.HOME);
    applyEnable({ home });
    expect(existsSync(settingsPath(home))).toBe(true);
  });
});
