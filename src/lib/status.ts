// Scrape the public Jetstream status page (no key needed). The page is HTML
// with label/value pairs; we strip tags and read "label line -> next line".
import { STATUS_HOST } from "./config.ts";
import { errorText, fetchPublic } from "./http.ts";
import { parseIntLoose } from "./format.ts";
import { sleep } from "./pool.ts";

export function statusUrl(params?: Record<string, string>): string {
  const q = params ? `?${new URLSearchParams(params)}` : "";
  return `https://${STATUS_HOST}/status${q}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML -> non-empty trimmed text lines (style/script removed, every tag a line break). */
export function htmlLines(html: string): string[] {
  const text = unescapeHtml(html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, "\n"));
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** First occurrence of each label -> the line after it (dt/dd style). */
export function labelValues(lines: string[], labels: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  lines.forEach((line, i) => {
    if (labels.has(line) && !(line in out) && i + 1 < lines.length) out[line] = lines[i + 1] as string;
  });
  return out;
}

const SUMMARY_FIELDS = new Set([
  "State", "Entered", "Events", "Collections", "Seq range", "Witnessed range", "Configured lookback",
  "Sealed segments tracked", "Oldest retained seq", "Durable sequence frontier", "Discovered", "Downloaded",
  "Pending", "Errored", "Unavailable", "Duration",
]);

export type StatusSummary = { url: string; status: number; jetstream_version: string | null; fields: Record<string, string> };

/** The status page's front page: Jetstream version and the summary fields. */
export async function statusSummary(): Promise<StatusSummary> {
  const r = await fetchPublic(statusUrl(), { timeoutMs: 60_000 });
  const lines = htmlLines(Buffer.from(r.body).toString("utf8"));
  return {
    url: statusUrl(),
    status: r.status,
    jetstream_version: lines.find((l) => /^v\d+\.\d+\.\d+/.test(l)) ?? null,
    fields: labelValues(lines, SUMMARY_FIELDS),
  };
}

const ACCOUNT_FIELDS = new Set([
  "PDS endpoint", "Active", "Backfill", "Retries", "Last attempted", "Backfill rev", "Latest rev", "declared handle",
  // The "Repo verification" section: the page compares Jetstream's local copy with the PDS live.
  "Result", "Message", "authoritative rev", "authoritative root", "local rev", "local root", "local records",
]);

/** The status page verifies the repo live on each lookup; it rate-limits that per client. */
const VERIFICATION_RATE_LIMIT = /rate limit/i;

/** Label -> value for one account (e.g. "Backfill": "pending"); `error` on transport failure. */
export type AccountStatus = Record<string, string | number | undefined> & { http_status?: number; error?: string; verification_error?: string };

/**
 * `/status?tab=accounts&account=<did>`: PDS endpoint, Backfill, and the repo verification
 * (Result, local/authoritative rev and root, local records). When the page answers
 * "repo action rate limit exceeded" instead of a verification, `verification_error` says so;
 * with `retries` > 0 we wait 30 s and ask again, up to that many times.
 */
export async function statusAccount(did: string, retries = 0): Promise<AccountStatus> {
  for (let attempt = 0; ; attempt++) {
    const out = await statusAccountOnce(did);
    const limited = typeof out.verification_error === "string" && VERIFICATION_RATE_LIMIT.test(out.verification_error);
    if (!limited || attempt >= retries) return attempt ? { ...out, verification_attempts: attempt + 1 } : out;
    await sleep(30_000);
  }
}

async function statusAccountOnce(did: string): Promise<AccountStatus> {
  let html: string;
  let status: number;
  try {
    const r = await fetchPublic(statusUrl({ tab: "accounts", account: did }), { timeoutMs: 60_000 });
    html = Buffer.from(r.body).toString("utf8");
    status = r.status;
  } catch (err) {
    return { error: errorText(err, 120) };
  }
  const lines = htmlLines(html);
  const out: AccountStatus = labelValues(lines, ACCOUNT_FIELDS);
  if (Object.keys(out).length === 0) out.text = lines.slice(8, 20).join(" | ");
  // Normally "Repo verification" is followed by "Result"; otherwise the next line is an error.
  const v = lines.indexOf("Repo verification");
  if (v >= 0 && lines[v + 1] !== "Result") out.verification_error = lines[v + 1] ?? "(empty)";
  out.http_status = status;
  return out;
}

export type CollectionRow = { events: number | null; segments: number | null; blocks: number | null };

/**
 * Rows of the collections tab: NSID | Events | Segments | Blocks. The tab lists
 * every collection (~5 MB) whatever `collection=` says, so we pick our rows out.
 */
export async function statusCollections(nsids: string[]): Promise<{ url: string; columns: string[] | null; rows: Record<string, CollectionRow | null> }> {
  const url = statusUrl({ tab: "collections", collection: nsids[0] ?? "" });
  const r = await fetchPublic(url, { timeoutMs: 120_000 });
  const html = Buffer.from(r.body).toString("utf8");
  const tbody = html.indexOf("<tbody");
  const header = htmlLines(tbody >= 0 ? html.slice(0, tbody) : html.slice(0, 20000));
  const nsidCol = header.indexOf("NSID");
  const columns = nsidCol >= 0 ? header.slice(nsidCol, nsidCol + 4) : null;
  const rows: Record<string, CollectionRow | null> = {};
  for (const nsid of nsids) {
    const escaped = nsid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`<code>${escaped}</code>\\s*</td>((?:\\s*<td[^>]*>[^<]*</td>){3})`).exec(html);
    if (!m) {
      rows[nsid] = null;
      continue;
    }
    const cells = [...(m[1] as string).matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((c) => c[1]);
    rows[nsid] = { events: parseIntLoose(cells[0]), segments: parseIntLoose(cells[1]), blocks: parseIntLoose(cells[2]) };
  }
  return { url, columns, rows };
}
