#!/usr/bin/env python3
"""Reference implementation used by the parity tests. The TypeScript
implementation must match its bucket totals and R/C exactly on the same
inputs; counterfactual deltas may differ only by the documented tail-write
correction. Do not modify this file; tests compare against its exact output.

Reads Claude Code session transcripts (~/.claude/projects/<encoded-cwd>/*.jsonl),
reconstructs per-session cache behavior, and decides whether a 1-hour cache TTL
would save money.

Pricing model: 5m write = 1.25x base input, 1h write = 2.0x, read = 0.1x.
R = creation tokens following a 5-60min gap; C = all creation tokens.
1h cheaper exactly when R/C > 0.75/1.9 ~= 39.5%.
"""
import argparse, glob, json, os, re, sys
from collections import defaultdict
from datetime import datetime

M_5M_WRITE = 1.25
M_1H_WRITE = 2.0
M_READ = 0.1
THRESHOLD = (M_1H_WRITE - M_5M_WRITE) / (M_1H_WRITE - M_READ)  # 0.75 / 1.9

PROJECTS_ROOT = os.path.expanduser("~/.claude/projects")


def encode_cwd(path: str) -> str:
    return re.sub(r"[/.]", "-", os.path.realpath(os.path.expanduser(path)))


def parse_ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def collect_files(scope, project_dir):
    if project_dir:
        p = os.path.expanduser(project_dir)
        if os.path.isdir(p) and glob.glob(os.path.join(p, "*.jsonl")):
            roots = [p]
        else:
            cand = os.path.join(PROJECTS_ROOT, encode_cwd(p))
            roots = [cand] if os.path.isdir(cand) else [os.path.join(PROJECTS_ROOT, p)]
    elif scope == "current":
        roots = [os.path.join(PROJECTS_ROOT, encode_cwd(os.getcwd()))]
    else:
        roots = [d for d in glob.glob(os.path.join(PROJECTS_ROOT, "*")) if os.path.isdir(d)]
    files = []
    for r in roots:
        files.extend(glob.glob(os.path.join(r, "*.jsonl")))
    return files, roots


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scope", choices=["all", "current"], default="all")
    ap.add_argument("--project-dir")
    ap.add_argument("--input-price", type=float, default=5.0)
    ap.add_argument("--days", type=int)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    files, roots = collect_files(args.scope, args.project_dir)
    if not files:
        print(f"No transcripts found under: {roots}", file=sys.stderr)
        sys.exit(1)

    cutoff = None
    if args.days:
        cutoff = datetime.now().timestamp() - args.days * 86400

    sessions = defaultdict(list)
    seen_ids = set()
    for f in files:
        sid = os.path.basename(f)
        try:
            fh = open(f, errors="ignore")
        except OSError:
            continue
        with fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                msg = o.get("message") or {}
                usage = msg.get("usage")
                if not usage:
                    continue
                mid = msg.get("id")
                if mid:
                    if mid in seen_ids:
                        continue
                    seen_ids.add(mid)
                ts = parse_ts(o.get("timestamp", ""))
                if ts is None or (cutoff and ts < cutoff):
                    continue
                cc = usage.get("cache_creation") or {}
                c5 = cc.get("ephemeral_5m_input_tokens")
                c1 = cc.get("ephemeral_1h_input_tokens", 0) or 0
                if c5 is None:
                    c5 = usage.get("cache_creation_input_tokens", 0) or 0
                read = usage.get("cache_read_input_tokens", 0) or 0
                sessions[sid + ":" + (str(o.get("sessionId")) or "")].append((ts, c5, c1, read))

    C = R = warm = cold = 0
    R_read = 0
    total_read = total_1h = total_5m = 0
    turns = 0
    gap_turns = defaultdict(int)

    for rows in sessions.values():
        rows.sort(key=lambda r: r[0])
        prev = None
        for ts, c5, c1, read in rows:
            turns += 1
            creation = c5 + c1
            C += creation
            total_5m += c5
            total_1h += c1
            total_read += read
            gap = None if prev is None else ts - prev
            prev = ts
            if gap is None:
                cold += creation; gap_turns["start"] += 1
            elif gap <= 300:
                warm += creation; gap_turns["<=5m"] += 1
            elif gap <= 3600:
                R += creation; R_read += read
                gap_turns["5-60m"] += 1
            else:
                cold += creation; gap_turns[">60m"] += 1

    ratio = (R / C) if C else 0.0
    regime = "1h" if (total_1h > total_5m and total_1h > 0) else "5m"
    P = args.input_price / 1_000_000

    cost_5m = C * M_5M_WRITE * P
    cost_1h = ((C - R) * M_1H_WRITE + R * M_READ) * P
    delta = cost_1h - cost_5m

    summary = {
        "scope": args.scope, "sessions": len(sessions), "turns": turns,
        "current_ttl_regime": regime,
        "tokens": {"creation_total": C, "creation_5m": total_5m, "creation_1h": total_1h,
                   "read_total": total_read},
        "creation_by_gap": {"warm_<=5m": warm, "recoverable_5-60m": R, "cold_>60m_or_start": cold},
        "reads_after_5-60m_gap": R_read,
        "turn_counts_by_gap": dict(gap_turns),
        "recoverable_ratio_R_over_C": round(ratio, 4),
        "threshold": round(THRESHOLD, 4),
        "verdict": "parallelizer" if ratio > THRESHOLD else "not-a-parallelizer",
        "write_cost_5m": round(cost_5m, 2),
        "write_cost_1h": round(cost_1h, 2),
        "delta_1h_minus_5m": round(delta, 2),
        "input_price_per_mtok": args.input_price,
    }
    print("CACHE_TTL_SUMMARY_JSON " + json.dumps(summary))


if __name__ == "__main__":
    main()
