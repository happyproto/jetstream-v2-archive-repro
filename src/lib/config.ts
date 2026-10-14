// Shared constants and paths. Importing this module loads `.env` once.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CACHE_DIR = path.join(ROOT, ".cache");
export const RESULTS_DIR = path.join(ROOT, "results");
export const FIXTURES_DIR = path.join(ROOT, "fixtures");

const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

/** Archive host. May be a bare host or a full http(s):// base URL. */
export const HOST = process.env.JETSTREAM_HOST || "jetstream1.us-east.bsky.network";
/** Public status page host (no key needed). */
export const STATUS_HOST = process.env.JETSTREAM_STATUS_HOST || "jetstream.us-east.bsky.network";
export const PLC_HOST = "plc.directory";
export const USER_AGENT = "jetstream-v2-archive-repro (+https://github.com/bluesky-social/jetstream/issues/192)";

/** Max concurrent requests to third parties (PLC, status page, PDSes). */
export const POLITE_CONCURRENCY = 6;
/** Jetstream cuts a block every 4096 events by default. */
export const EVENTS_PER_BLOCK = 4096;

export const NSID_WHTWND = "com.whtwnd.blog.entry";
export const NSID_PUBLICATION = "site.standard.publication";
export const NSID_DOCUMENT = "site.standard.document";

/** Lines of fixtures/<name>, skipping blanks and # comments. */
export function fixture(name: string): string[] {
  const file = path.join(FIXTURES_DIR, name);
  if (!existsSync(file)) throw new Error(`missing fixture ${file}`);
  return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}
