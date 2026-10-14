// Run every reproduction, write results/<UTC date>/, and optionally check or compare.
//
//   npm run all                          cheap modes of all six scripts
//   npm run all -- --costly              also quota --drain --follow 60, amplification
//                                        --sample 50, coverage-bridgy --archive-count 2
//                                        (several GB of quota; waits 520 s for a full
//                                        bucket before the drain)
//   npm run check                        run, then a pass/fail table; exit 1 on any FAIL
//   npm run all -- --compare results/2026-10-14
//                                        diff headline numbers against a recorded run
//   npm run all -- --no-run --check --out results/2026-10-14
//                                        re-check recorded JSON without new requests
//
// Without JETSTREAM_API_KEY, the scripts that need the archive are skipped and the
// rest (status page, PLC, brid.gy) still run.
import path from "node:path";
import { hasKey, MissingKeyError } from "./lib/archive.ts";
import { checkTag, COMMON_OPTIONS, parseArgs, runFinding, type Check, type CommonOpts, type Finding } from "./lib/cli.ts";
import { ROOT } from "./lib/config.ts";
import { errorText } from "./lib/http.ts";
import { sleep } from "./lib/pool.ts";
import { loadResult, resultsDir } from "./lib/results.ts";
import * as overview from "./archive-overview.ts";
import * as quota from "./quota.ts";
import * as markers from "./marker-plans.ts";
import * as amplification from "./amplification.ts";
import * as migrated from "./coverage-migrated.ts";
import * as bridgy from "./coverage-bridgy.ts";

// Each script has its own option and result types.
type AnyFinding = Finding<any, any>;

/** In run order, with whether the cheap mode needs the archive key and the extra args --costly adds. */
const SCRIPTS: { finding: AnyFinding; needsKey: boolean; costlyArgs: string[] }[] = [
  { finding: overview.finding, needsKey: false, costlyArgs: [] }, // status page part runs without a key
  { finding: quota.finding, needsKey: true, costlyArgs: ["--drain", "--follow", "60"] },
  { finding: markers.finding, needsKey: true, costlyArgs: [] },
  { finding: amplification.finding, needsKey: true, costlyArgs: ["--sample", "50"] },
  { finding: migrated.finding, needsKey: false, costlyArgs: [] },
  { finding: bridgy.finding, needsKey: false, costlyArgs: ["--archive-count", "2"] },
];

const REFILL_WAIT_S = 520; // 1 GB burst / 2 MB/s = 500 s, plus a margin

type RunAllOpts = { costly?: boolean; check?: boolean; compare?: string; noRun?: boolean; refresh?: boolean; out?: string };

const USAGE = "npm run all -- [options]\n\nRuns every finding script; see the header of src/run-all.ts.";
const OPTIONS = {
  costly: { type: "boolean", help: "also run the costly modes (several GB of quota)" },
  check: { type: "boolean", help: "print a pass/fail table; exit 1 on any FAIL" },
  compare: { type: "string", help: "diff headline numbers against a recorded results directory" },
  "no-run": { type: "boolean", help: "use existing results in --out instead of running" },
  refresh: COMMON_OPTIONS.refresh,
  out: COMMON_OPTIONS.out,
} as const;

type Outcome = { checks: Check[] } | { skipped: string } | { error: string };

async function runAll(opts: RunAllOpts, out: string): Promise<Map<string, Outcome>> {
  const outcomes = new Map<string, Outcome>();
  const key = hasKey();
  if (!key) console.log("JETSTREAM_API_KEY is not set (see .env.example): running only the scripts that need no key.");
  for (const [i, { finding, needsKey, costlyArgs }] of SCRIPTS.entries()) {
    if (needsKey && !key) {
      outcomes.set(finding.name, { skipped: "needs JETSTREAM_API_KEY" });
      continue;
    }
    const args = ["--out", out, ...(opts.costly && key ? costlyArgs : []), ...(opts.refresh && i === 0 ? ["--refresh"] : [])];
    if (finding.name === "quota" && opts.costly) {
      console.log(`waiting ${REFILL_WAIT_S} s for the quota bucket to refill before --drain ...`);
      await sleep(REFILL_WAIT_S * 1000);
    }
    console.log(`\n$ ${finding.name} ${args.join(" ")}`);
    const fopts = parseArgs<CommonOpts>(args, { ...COMMON_OPTIONS, ...finding.options }, finding.usage);
    try {
      const { checks } = await runFinding(finding, fopts);
      outcomes.set(finding.name, { checks });
    } catch (err) {
      const message = err instanceof MissingKeyError ? err.message : errorText(err, 300);
      console.error(`${finding.name} failed: ${message}`);
      outcomes.set(finding.name, { error: message });
    }
  }
  return outcomes;
}

/** Re-evaluate checks from the JSON already in `dir`. */
function loadOutcomes(dir: string): Map<string, Outcome> {
  const outcomes = new Map<string, Outcome>();
  for (const { finding } of SCRIPTS) {
    const r = loadResult<object>(dir, finding.name);
    outcomes.set(finding.name, r ? { checks: finding.checks(r) } : { error: "no result written" });
  }
  return outcomes;
}

function printCheckTable(outcomes: Map<string, Outcome>): number {
  const rows: [string, string, string, string][] = [];
  for (const [name, o] of outcomes) {
    if ("checks" in o) for (const c of o.checks) rows.push([name, c.name, checkTag(c), c.detail]);
    else if ("skipped" in o) rows.push([name, "-", "SKIP", o.skipped]);
    else rows.push([name, "-", "FAIL", o.error]);
  }
  const w = Math.max(...rows.map((r) => r[1].length), 5);
  console.log(`\n${"script".padEnd(18)} ${"check".padEnd(w)} result`);
  for (const [s, n, t, d] of rows) console.log(`${s.padEnd(18)} ${n.padEnd(w)} ${t}  ${d}`);
  const skipped = rows.filter((r) => r[2] === "SKIP").length;
  if (skipped) console.log(`\n${skipped} check(s) skipped (costly mode not run, or no key).`);
  return rows.filter((r) => r[2] === "FAIL").length;
}

function compare(newDir: string, oldDir: string): void {
  console.log(`\nheadline numbers: ${path.relative(ROOT, oldDir)} -> ${path.relative(ROOT, newDir)}`);
  for (const { finding } of SCRIPTS) {
    const a = loadResult<object>(oldDir, finding.name);
    const b = loadResult<object>(newDir, finding.name);
    if (!a || !b) {
      console.log(`  ${finding.name}: missing in ${a ? "new" : "recorded"} run`);
      continue;
    }
    const ha = finding.headline(a);
    const hb = finding.headline(b);
    for (const k of [...new Set([...Object.keys(ha), ...Object.keys(hb)])].sort()) {
      const va = ha[k];
      const vb = hb[k];
      const delta = typeof va === "number" && typeof vb === "number" && va ? `${(((vb - va) / Math.abs(va)) * 100).toFixed(1)}%` : "";
      const flag = JSON.stringify(va) === JSON.stringify(vb) ? "" : "  *";
      console.log(`  ${finding.name.padEnd(18)} ${k.padEnd(58)} ${String(va).padStart(22)} ${String(vb).padStart(22)} ${delta.padStart(8)}${flag}`);
    }
  }
}

const opts = parseArgs<RunAllOpts>(process.argv.slice(2), OPTIONS, USAGE);
const out = resultsDir(opts.out);
const outcomes = opts.noRun ? loadOutcomes(out) : await runAll(opts, out);
const failed = opts.check ? printCheckTable(outcomes) : 0;
const errored = [...outcomes.values()].filter((o) => "error" in o).length;
if (opts.compare) compare(out, path.resolve(ROOT, opts.compare));
process.exitCode = failed || errored ? 1 : 0;
