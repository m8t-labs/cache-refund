#!/usr/bin/env node
/**
 * Minimal the analyzer CLI: the debug entry that runs the full pipeline and prints the
 * Summary as JSON. the renderer replaces this with the multi-section renderer + subcommands.
 *
 * Supported now (a deliberate subset of the surface):
 *   --json         print the Summary as JSON (the only output mode in the analyzer)
 *   --days N       window (default 90)
 *   --all-time     ignore the window (whole corpus)
 *   --project P    restrict to one project (cwd path or encoded dir name)
 *   --price SPEC   per-model base-price override, e.g. "opus=5,sonnet=3"
 *
 * Exit codes: 0 ok · 1 no transcripts found · 2 parse/internal error.
 */

import { run } from "./pipeline.js";
import { parsePriceOverride } from "./pricing.js";

interface Args {
  json: boolean;
  days: number | null;
  allTime: boolean;
  project?: string;
  overrides?: Record<string, number>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, days: 90, allTime: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        args.json = true;
        break;
      case "--all-time":
        args.allTime = true;
        break;
      case "--days": {
        const v = Number(argv[++i]);
        args.days = Number.isFinite(v) ? v : args.days;
        break;
      }
      case "--project":
        args.project = argv[++i];
        break;
      case "--price":
        args.overrides = parsePriceOverride(argv[++i] ?? "");
        break;
      default:
        // ignore unknown flags in the analyzer (the renderer owns the full parser)
        break;
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const result = await run({
    project: args.project,
    days: args.days,
    allTime: args.allTime,
    jsonMode: args.json,
    overrides: args.overrides,
  });

  if (result.code === 1) {
    process.stderr.write("No transcripts found under ~/.claude/projects\n");
    return 1;
  }
  if (!result.summary) {
    process.stderr.write("Internal error: no summary produced\n");
    return 2;
  }

  // the analyzer only speaks JSON. the renderer adds pretty/compact/md.
  process.stdout.write(JSON.stringify(result.summary, null, 2) + "\n");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`cache-cash: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(2);
  });
