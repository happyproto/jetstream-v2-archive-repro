// Finding 6: large Bridgy Fed repos are marked backfill `complete` with
// "Match failure", and the archive holds a small fraction of their records.
//
// For fixtures/bridgy_partial_dids.txt (8 DIDs on https://atproto.brid.gy):
//   - status page account lookup (Backfill, Result, local records),
//   - com.atproto.repo.listRecords count of site.standard.document on brid.gy
//     (paged, limit 100),
//   - com.atproto.sync.getRepo on brid.gy without following the redirect, then
//     following it (status, Location host, body).
//   --archive-count [N]  COSTLY (needs the key): for the first N DIDs (default
//     all), plan dids:[did], kinds:["commit"], collections:[site.standard.document]
//     over the whole archive, download the planned blocks and count that DID's
//     document commit events.
//
// No key needed without --archive-count. Third-party load: ~300 listRecords pages
// per DID on brid.gy (sequential per DID, 6 DIDs at a time).
// --archive-count quota cost: ~0.3 MB per planned block.
import {
  downloadBlock, estimateBytes, listSegments, planBlocks, planSnapshot, requireKey, segmentsByName,
  type ByteEstimate, type Segment,
} from "./lib/archive.ts";
import { countInBlock, decompressBlock } from "./lib/block.ts";
import { main, type Check, type CommonOpts, type Finding } from "./lib/cli.ts";
import { fixture, NSID_DOCUMENT } from "./lib/config.ts";
import { errorText, fetchPublic, isRedirect, jsonOf, textOf } from "./lib/http.ts";
import { parseIntLoose, round } from "./lib/format.ts";
import { mapPool } from "./lib/pool.ts";
import { statusAccount, type AccountStatus } from "./lib/status.ts";

const PDS = "https://atproto.brid.gy";

/** undefined = flag absent; 0 = all DIDs; N = first N DIDs. */
export type BridgyOpts = CommonOpts & { archiveCount?: number };

type RecordCount = { count: number; pages: number; complete: boolean; error?: string };

type GetRepo = {
  no_follow: { status: number; location_host: string | null; body: string };
  followed?: { status: number; host: string; content_type: string; body: string };
};

type ArchiveCount =
  | { error: string }
  | ({ planned_blocks: number; bytes_downloaded: number; events: number; methods: string[]; failed_blocks: string[] } & ByteEstimate);

type Row = {
  did: string;
  status: AccountStatus;
  pds_listRecords: RecordCount;
  getRepo: GetRepo;
  archive?: ArchiveCount;
  local_records_over_pds?: number | null;
  archive_events_over_pds?: number | null;
};

export type BridgyResult = { pds: string; collection: string; segments_fetched_at?: string; rows: Row[] };

/** Count a DID's records of `collection` on brid.gy by paging listRecords. */
async function countRecords(did: string, collection = NSID_DOCUMENT, maxPages = 2000): Promise<RecordCount> {
  let count = 0;
  let cursor: string | undefined;
  for (let pages = 1; pages <= maxPages; pages++) {
    const q = new URLSearchParams({ repo: did, collection, limit: "100", ...(cursor ? { cursor } : {}) });
    const r = await fetchPublic(`${PDS}/xrpc/com.atproto.repo.listRecords?${q}`, { timeoutMs: 60_000 });
    if (r.status !== 200) return { count, pages, complete: false, error: `${r.status} ${textOf(r, 200)}` };
    const j = jsonOf<{ records?: unknown[]; cursor?: string }>(r);
    count += j.records?.length ?? 0;
    cursor = j.cursor;
    if (!cursor || !j.records?.length) return { count, pages, complete: true };
  }
  return { count, pages: maxPages, complete: false, error: `stopped at ${maxPages} pages` };
}

/** getRepo on brid.gy: record the redirect, then follow it and record what the target says. */
async function getRepo(did: string): Promise<GetRepo> {
  const url = `${PDS}/xrpc/com.atproto.sync.getRepo?${new URLSearchParams({ did })}`;
  const r = await fetchPublic(url, { timeoutMs: 60_000, maxBody: 4096 });
  const out: GetRepo = {
    no_follow: { status: r.status, location_host: null, body: r.status >= 300 ? textOf(r, 300) : `<${r.body.length}+ bytes>` },
  };
  const location = r.headers.location;
  if (isRedirect(r.status) && location) {
    const target = new URL(location, url);
    out.no_follow.location_host = target.host;
    const f = await fetchPublic(target.href, { timeoutMs: 120_000, maxBody: 4096 });
    const contentType = f.headers["content-type"] ?? "";
    out.followed = {
      status: f.status,
      host: target.host,
      content_type: contentType,
      body: contentType.includes("car") ? `<CAR, ${f.headers["content-length"] ?? "?"} bytes>` : textOf(f, 300),
    };
  }
  return out;
}

/** Plan this DID's document commits over the whole archive and count them in the downloaded blocks. */
export async function archiveCount(did: string, byName: Map<string, Segment>): Promise<ArchiveCount> {
  const res = await planSnapshot({ dids: [did], kinds: ["commit"], collections: [NSID_DOCUMENT] });
  if (!res.ok) return { error: res.error ?? "plan failed" };
  const blocks = planBlocks(res.segments, byName);
  const got = await mapPool(
    blocks,
    async ([segment, index]) => {
      try {
        const b = await downloadBlock(segment, index);
        if (!b.raw) return { events: null, note: `${segment}/${index}: ${b.status}`, bytes: 0 };
        const c = countInBlock(decompressBlock(b.raw), NSID_DOCUMENT, did);
        return { events: c.matches, note: c.method, bytes: b.raw.length };
      } catch (err) {
        return { events: null, note: `${segment}/${index}: ${errorText(err, 100)}`, bytes: 0 };
      }
    },
    4,
  );
  const ok = got.filter((g) => g.events !== null);
  return {
    planned_blocks: blocks.length,
    ...estimateBytes(res.segments, byName),
    bytes_downloaded: got.reduce((n, g) => n + g.bytes, 0),
    events: ok.reduce((n, g) => n + (g.events ?? 0), 0),
    methods: [...new Set(ok.map((g) => g.note))].sort(),
    failed_blocks: got.filter((g) => g.events === null).map((g) => g.note).slice(0, 20),
  };
}

export async function run(opts: BridgyOpts): Promise<BridgyResult> {
  if (opts.archiveCount !== undefined) requireKey(); // fail before any third-party traffic
  const dids = fixture("bridgy_partial_dids.txt");
  // Status lookups one at a time: each makes the status page verify the whole repo
  // against brid.gy, and the page rate-limits that (we wait and retry, up to 10 x 30 s).
  const statuses: AccountStatus[] = [];
  for (const did of dids) {
    console.log(`  status page: ${did} ...`);
    statuses.push(await statusAccount(did, 10));
  }
  // brid.gy itself: sequential per DID, 6 DIDs at a time.
  const rows: Row[] = await mapPool(dids, async (did, i) => {
    console.log(`  brid.gy: ${did} ...`);
    const pdsCount = await countRecords(did);
    const repo = await getRepo(did);
    return { did, status: statuses[i] as AccountStatus, pds_listRecords: pdsCount, getRepo: repo };
  });
  const out: BridgyResult = { pds: PDS, collection: NSID_DOCUMENT, rows };
  if (opts.archiveCount !== undefined) {
    const { segments, fetchedAt } = await listSegments(opts.refresh);
    const byName = segmentsByName(segments);
    out.segments_fetched_at = fetchedAt;
    for (const row of rows.slice(0, opts.archiveCount || rows.length)) {
      console.log(`  archive count for ${row.did} ...`);
      row.archive = await archiveCount(row.did, byName);
    }
  }
  for (const row of rows) {
    const pdsCount = row.pds_listRecords.count;
    const local = parseIntLoose(row.status["local records"]);
    row.local_records_over_pds = local !== null && pdsCount ? round(local / pdsCount, 4) : null;
    if (row.archive && "events" in row.archive) row.archive_events_over_pds = pdsCount ? round(row.archive.events / pdsCount, 4) : null;
  }
  return out;
}

export function checks(r: BridgyResult): Check[] {
  const out: Check[] = [];
  for (const row of r.rows) {
    const st = row.status;
    out.push({
      name: `${row.did}: complete + Match failure`,
      pass: st.Backfill === "complete" && st.Result === "Match failure",
      detail:
        `Backfill=${JSON.stringify(st.Backfill ?? null)} Result=${JSON.stringify(st.Result ?? null)} ` +
        `local rev/authoritative rev=${st["local rev"] ?? null}/${st["authoritative rev"] ?? null}` +
        (st.verification_error ? ` (verification: ${st.verification_error})` : "") +
        (st.error ? ` (status page: ${st.error})` : ""),
    });
    const useArchive = row.archive_events_over_pds !== undefined;
    const ratio = useArchive ? row.archive_events_over_pds : row.local_records_over_pds;
    const what = useArchive ? "archive events" : "status-page local records";
    const value = row.archive && "events" in row.archive ? row.archive.events : st["local records"];
    out.push({
      name: `${row.did}: ${what} < 10% of PDS records`,
      pass: ratio !== null && ratio !== undefined && ratio < 0.1,
      detail:
        `${what}=${value ?? null} pds=${row.pds_listRecords.count} ratio=${ratio ?? null}` +
        (row.pds_listRecords.complete ? "" : ` (PDS count incomplete: ${row.pds_listRecords.error})`),
    });
  }
  return out;
}

export function headline(r: BridgyResult): Record<string, unknown> {
  const h: Record<string, unknown> = {};
  for (const row of r.rows) {
    h[`${row.did}_pds_records`] = row.pds_listRecords.count;
    h[`${row.did}_local_records`] = parseIntLoose(row.status["local records"]);
    if (row.archive) h[`${row.did}_archive_events`] = "events" in row.archive ? row.archive.events : null;
  }
  return h;
}

function print(r: BridgyResult): void {
  for (const row of r.rows) {
    const g = row.getRepo;
    console.log(
      `  ${row.did} backfill=${row.status.Backfill} result=${row.status.Result} local=${row.status["local records"]} ` +
        `pds=${row.pds_listRecords.count} getRepo=${g.no_follow.status}->${g.no_follow.location_host} ` +
        `${g.followed?.status ?? ""} ${(g.followed?.body ?? "").slice(0, 80)}` +
        (row.archive ? ` archive=${"events" in row.archive ? row.archive.events : row.archive.error}` : ""),
    );
  }
}

export const finding: Finding<BridgyOpts, BridgyResult> = {
  name: "coverage_bridgy",
  usage: "npm run coverage:bridgy -- [options]\n\nFinding 6: large Bridgy Fed repos are `complete` but hold a small fraction of their records.",
  options: {
    "archive-count": { type: "optional-number", help: "COSTLY: count archive events for the first N DIDs (no N = all)" },
  },
  run,
  checks,
  headline,
  print,
};

if (import.meta.main) await main(finding);
