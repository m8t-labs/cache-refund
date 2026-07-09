/**
 * End-to-end pipeline: discover -> stream-parse -> analyze -> Summary.
 * Streaming, bounded memory: files are parsed one at a time; only TurnEvents
 * (small) accumulate.
 */

import { homedir } from "node:os";
import { discover } from "./discover.js";
import { parseFile, type ParseOptions } from "./parse.js";
import { analyze } from "./analyze.js";
import { buildSummary } from "./verdict.js";
import { readEnvHints } from "./verdict.js";
import type { PriceCtx } from "./costmodel.js";
import type { Summary, TurnEvent } from "./types.js";

export interface RunOptions {
  project?: string;
  days?: number | null;
  allTime?: boolean;
  jsonMode?: boolean;
  overrides?: Record<string, number>;
  home?: string;
}

export interface RunResult {
  summary: Summary | null;
  fileCount: number;
  /** exit code: 0 ok · 1 no transcripts · 2 handled elsewhere */
  code: 0 | 1 | 2;
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const home = opts.home ?? homedir();
  const { files, projectOf } = discover(opts.project, home);
  if (files.length === 0) {
    return { summary: null, fileCount: 0, code: 1 };
  }

  const allTime = opts.allTime === true;
  const days = allTime ? null : opts.days ?? null;
  const cutoff = days != null ? Date.now() / 1000 - days * 86400 : null;

  const seenIds = new Set<string>();
  const events: TurnEvent[] = [];
  for (const file of files) {
    const parseOpts: ParseOptions = {
      cutoff,
      seenIds,
      project: projectOf(file),
    };
    await parseFile(file, parseOpts, events);
  }

  const agg = analyze(events);
  const hints = readEnvHints(home);
  const ctx: PriceCtx = { overrides: opts.overrides };
  const summary = buildSummary({
    events,
    agg,
    windowMode: allTime ? "all-time" : "days",
    windowDays: days,
    project: opts.project ?? null,
    hints,
    jsonMode: opts.jsonMode === true,
    ctx,
  });

  return { summary, fileCount: files.length, code: 0 };
}
