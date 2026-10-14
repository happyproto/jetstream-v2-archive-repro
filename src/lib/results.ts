// Redaction and result files. Everything recorded goes through scrubText.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { RESULTS_DIR, ROOT } from "./config.ts";

const DROP_HEADERS = new Set(["authorization", "set-cookie", "cookie", "proxy-authorization"]);

/** Replace any `token=...` query value (signed CDN URLs) with REDACTED. */
export function redactUrl(url: string | null | undefined): string {
  return (url ?? "").replace(/(token=)[^&#\s"]*/gi, "$1REDACTED");
}

/** Response headers as a plain object, without credentials, with Location redacted. */
export function redactHeaders(headers: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (let [name, value] of headers) {
    name = name.toLowerCase();
    if (DROP_HEADERS.has(name)) continue;
    if (name === "location") value = redactUrl(value);
    out[name] = name in out ? `${out[name]}, ${value}` : value;
  }
  return out;
}

/** Defensive scrub of any text we are about to record: CDN tokens and anything key-shaped. */
export function scrubText(s: string): string {
  return redactUrl(s).replace(/g[k]_[A-Za-z0-9_-]+/g, "REDACTED_KEY");
}

export function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** results/<UTC date>, or `out` if given. Created if missing. */
export function resultsDir(out?: string): string {
  const dir = out ? path.resolve(out) : path.join(RESULTS_DIR, utcNowIso().slice(0, 10));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write <dir>/<script>.json (scrubbed). Returns the path. */
export function writeResult(script: string, data: object, out?: string): string {
  const record = { script, generated_at: utcNowIso(), ...data };
  const file = path.join(resultsDir(out), `${script}.json`);
  writeFileSync(file, scrubText(JSON.stringify(record, null, 1)) + "\n");
  console.log(`wrote ${file.startsWith(ROOT) ? path.relative(ROOT, file) : file}`);
  return file;
}

export function loadResult<T>(dir: string, script: string): T | null {
  const file = path.join(dir, `${script}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
}
