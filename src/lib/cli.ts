// Tiny argument parsing and the shared "run a finding script" wrapper.
import { MissingKeyError } from "./archive.ts";
import { writeResult } from "./results.ts";

export type OptionSpec = {
  type: "boolean" | "number" | "string" | "optional-number";
  help: string;
  default?: number | string | boolean;
};
export type Options = Record<string, OptionSpec>;

/** Options every finding script takes. */
export const COMMON_OPTIONS: Options = {
  check: { type: "boolean", help: "evaluate this finding's checks; exit 1 if any fails" },
  refresh: { type: "boolean", help: "refetch listSegments instead of using .cache/" },
  out: { type: "string", help: "results directory (default results/<UTC date>)" },
};

export type CommonOpts = { check?: boolean; refresh?: boolean; out?: string };

const camel = (flag: string) => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Parse `--flag`, `--flag value` and `--flag=value`. An "optional-number" flag takes a
 * number if one follows, otherwise 0. Keys are camelCased (`--archive-count` -> archiveCount).
 */
export function parseArgs<T>(argv: string[], spec: Options, usage: string): T {
  const out: Record<string, unknown> = {};
  for (const [flag, s] of Object.entries(spec)) if (s.default !== undefined) out[camel(flag)] = s.default;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      console.log(usage.trim() + "\n\nOptions:\n" + Object.entries(spec).map(([f, s]) => `  --${f.padEnd(16)} ${s.help}`).join("\n"));
      process.exit(0);
    }
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(arg);
    const s = m && spec[m[1] as string];
    if (!m || !s) fail(`unknown argument ${arg} (try --help)`);
    const flag = m[1] as string;
    let value: string | undefined = m[2];
    if (s.type === "boolean") {
      out[camel(flag)] = true;
      continue;
    }
    if (value === undefined && s.type === "optional-number") {
      const nextArg = argv[i + 1];
      if (nextArg !== undefined && /^\d+$/.test(nextArg)) value = argv[++i];
      out[camel(flag)] = value === undefined ? 0 : Number(value);
      continue;
    }
    value ??= argv[++i];
    if (value === undefined) fail(`--${flag} needs a value`);
    if (s.type !== "string" && !Number.isFinite(Number(value))) fail(`--${flag} needs a number, got ${value}`);
    out[camel(flag)] = s.type === "string" ? value : Number(value);
  }
  return out as T;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** One assertion about a finding. pass = null means "not evaluated" (e.g. a costly mode was not run). */
export type Check = { name: string; pass: boolean | null; detail: string };

export const checkTag = (c: Check) => (c.pass === true ? "PASS" : c.pass === null ? "SKIP" : "FAIL");

/** What every finding script exports. */
export type Finding<O extends CommonOpts, R extends object> = {
  name: string; // result file name: results/<date>/<name>.json
  usage: string;
  options: Options;
  run: (opts: O) => Promise<R>;
  checks: (result: R) => Check[];
  headline: (result: R) => Record<string, unknown>;
  print: (result: R) => void;
};

/** Run a finding, record its result (with checks) and, with --check, exit 1 on any FAIL. */
export async function runFinding<O extends CommonOpts, R extends object>(f: Finding<O, R>, opts: O): Promise<{ result: R; checks: Check[] }> {
  const result = await f.run(opts);
  f.print(result);
  const checks = f.checks(result);
  writeResult(f.name, { ...result, checks }, opts.out);
  return { result, checks };
}

/** Entry point used when a finding script is run directly. */
export async function main<O extends CommonOpts, R extends object>(f: Finding<O, R>): Promise<void> {
  const opts = parseArgs<O>(process.argv.slice(2), { ...COMMON_OPTIONS, ...f.options }, f.usage);
  try {
    const { checks } = await runFinding(f, opts);
    if (opts.check) {
      for (const c of checks) console.log(`[${checkTag(c)}] ${f.name}: ${c.name} -- ${c.detail}`);
      process.exitCode = checks.some((c) => c.pass === false) ? 1 : 0;
    }
  } catch (err) {
    if (err instanceof MissingKeyError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
