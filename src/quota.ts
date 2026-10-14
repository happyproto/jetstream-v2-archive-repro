// Finding 2: the per-key byte quota (1 GB burst, 2 MB/s refill) is charged when
// getBlock issues its 307 redirect, not when the bytes are downloaded.
//
//   (default)    one small planSnapshot; record the headwind-quota-* headers.
//   --drain      COSTLY (the whole ~1 GB bucket; needs a FULL bucket, so wait
//                at least 500 s after any other costly run). Issues getBlock
//                WITHOUT following the 307, 8 concurrent, until the first 429.
//   --follow N   COSTLY. Follows redirects for N seconds (8 workers, waiting
//                out 429s) and reports sustained MB/s.
//
// Quota cost: default a few KB. --drain: ~1 GB. --follow N: ~2 MB x N plus any burst left.
import {
  afterSeqForTail, archiveCall, blockBytes, blocksInSegment, getBlock, getBlockFollow, listSegments,
  quotaHeaders, requireKey, retryAfterSeconds, type Segment,
} from "./lib/archive.ts";
import { main, type Check, type CommonOpts, type Finding } from "./lib/cli.ts";
import { NSID_WHTWND } from "./lib/config.ts";
import { errorText, textOf } from "./lib/http.ts";
import { round } from "./lib/format.ts";
import { runWorkers, sleep } from "./lib/pool.ts";

const EXPECT: Record<string, string> = {
  "headwind-quota-refill-bytes": "2000000",
  "headwind-quota-refill-period-seconds": "1",
  "headwind-quota-burst-bytes": "1000000000",
};

export type QuotaOpts = CommonOpts & { drain?: boolean; follow?: number };

type Drain = {
  issued: number;
  redirects: number;
  est_bytes: number;
  est_GB: number;
  statuses: Record<string, number>;
  first429: null | {
    after_redirects: number;
    est_bytes_before: number;
    seconds_in: number;
    status: number;
    body: string;
    retry_after: string | null;
    headers: Record<string, string>;
  };
  last_redirect_quota_headers: Record<string, string> | null;
  other: string[];
  elapsed_s: number;
  concurrency: number;
  followed_redirects: false;
  cap: number;
};

type Follow = { requests: number; bytes: number; statuses: Record<string, number>; throttled_wait_s: number; seconds: number; MB_per_s: number; concurrency: number };

export type QuotaResult = {
  segments_fetched_at: string;
  headers_probe: { request: string; status: number; elapsed_s: number; quota_headers: Record<string, string>; all_headers: Record<string, string> };
  drain?: Drain;
  follow?: Follow;
};

/** [segment, blockIndex, est. bytes] for the 40 newest segments, skipping each one's last
 * (possibly short) estimated block so no index is out of range. */
function blockPool(segs: Segment[], newest = 40): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const s of [...segs].sort((a, b) => a.index - b.index).slice(-newest)) {
    const n = blocksInSegment(s);
    for (let i = 0; i < Math.max(1, n - 1); i++) out.push([s.name, i, blockBytes(s)]);
  }
  return out;
}

const bump = (counts: Record<string, number>, key: string) => (counts[key] = (counts[key] ?? 0) + 1);

/** Issue getBlock without following redirects until the first 429. Nothing is downloaded. */
async function drain(segs: Segment[], concurrency = 8, cap = 20_000): Promise<Drain> {
  const pool = blockPool(segs);
  const started = performance.now();
  let next = 0;
  let stop = false;
  let estBytes = 0;
  const st: Drain = {
    issued: 0, redirects: 0, est_bytes: 0, est_GB: 0, statuses: {}, first429: null, last_redirect_quota_headers: null,
    other: [], elapsed_s: 0, concurrency, followed_redirects: false, cap,
  };
  await runWorkers(concurrency, async () => {
    while (!stop) {
      if (st.issued >= cap) {
        stop = true;
        return;
      }
      st.issued++;
      const [seg, idx, est] = pool[next++ % pool.length] as [string, number, number];
      let r;
      try {
        r = await getBlock(seg, idx);
      } catch (err) {
        bump(st.statuses, "error");
        st.other.push(errorText(err, 120));
        continue;
      }
      bump(st.statuses, String(r.status));
      if (r.status === 307) {
        st.redirects++;
        estBytes += est;
        st.last_redirect_quota_headers = quotaHeaders(r.headers);
      } else if (r.status === 429) {
        st.first429 ??= {
          after_redirects: st.redirects,
          est_bytes_before: Math.round(estBytes),
          seconds_in: round((performance.now() - started) / 1000, 2),
          status: r.status,
          body: textOf(r, 300),
          retry_after: r.headers["retry-after"] ?? null,
          headers: r.headers,
        };
        stop = true;
      } else if (st.other.length < 10) {
        st.other.push(`${r.status} ${textOf(r, 120)}`);
      }
    }
  });
  st.elapsed_s = round((performance.now() - started) / 1000, 2);
  st.est_bytes = Math.round(estBytes);
  st.est_GB = round(estBytes / 1e9, 3);
  return st;
}

/** Follow redirects for `seconds`, waiting out 429s, and measure sustained throughput. */
async function follow(segs: Segment[], seconds: number, concurrency = 8): Promise<Follow> {
  const pool = blockPool(segs);
  const started = performance.now();
  const stopAt = started + seconds * 1000;
  let next = 0;
  const st = { requests: 0, bytes: 0, statuses: {} as Record<string, number>, throttled_wait_s: 0 };
  await runWorkers(concurrency, async () => {
    while (performance.now() < stopAt) {
      const [seg, idx] = pool[next++ % pool.length] as [string, number, number];
      let status: number | string = "error";
      let retryAfter = 1;
      try {
        const b = await getBlockFollow(seg, idx);
        status = b.status;
        if (b.raw) st.bytes += b.raw.length;
        retryAfter = retryAfterSeconds(b.info.headers);
      } catch {
        // counted as "error"
      }
      st.requests++;
      bump(st.statuses, String(status));
      if (status === 429) {
        const wait = Math.max(1, Math.min(retryAfter, 30));
        st.throttled_wait_s += wait;
        await sleep(wait * 1000);
      }
    }
  });
  const elapsed = (performance.now() - started) / 1000;
  return { ...st, seconds: round(elapsed, 1), MB_per_s: round(st.bytes / elapsed / 1e6, 3), concurrency };
}

export async function run(opts: QuotaOpts): Promise<QuotaResult> {
  requireKey();
  const { segments, fetchedAt } = await listSegments(opts.refresh);
  // A tiny plan (last hour, one rare collection) just to read the quota headers.
  const { afterSeq } = afterSeqForTail(segments, 1);
  const r = await archiveCall("POST", "planSnapshot", { body: { kinds: ["commit"], collections: [NSID_WHTWND], afterSeq } });
  const result: QuotaResult = {
    segments_fetched_at: fetchedAt,
    headers_probe: {
      request: "planSnapshot kinds=[commit] collections=[com.whtwnd.blog.entry] (last ~1 h)",
      status: r.status,
      elapsed_s: round(r.elapsedS, 3),
      quota_headers: quotaHeaders(r.headers),
      all_headers: r.headers,
    },
  };
  if (opts.drain) {
    console.log("draining: getBlock without following redirects, 8 concurrent, until the first 429 ...");
    result.drain = await drain(segments);
  }
  if (opts.follow) {
    console.log(`following redirects for ${opts.follow} s ...`);
    result.follow = await follow(segments, opts.follow);
  }
  return result;
}

export function checks(r: QuotaResult): Check[] {
  const q = r.headers_probe.quota_headers;
  const out: Check[] = Object.entries(EXPECT).map(([k, v]) => ({ name: `${k} == ${v}`, pass: q[k] === v, detail: `got ${JSON.stringify(q[k] ?? null)}` }));
  const d = r.drain;
  const no429 = "drain: 429 without downloading any block";
  const body429 = 'drain: 429 body is {"error":"byte limit exceeded"}';
  if (!d) {
    out.push({ name: no429, pass: null, detail: "not run (needs --drain)" });
    out.push({ name: body429, pass: null, detail: "not run (needs --drain)" });
    return out;
  }
  const f = d.first429;
  out.push({
    name: no429,
    pass: f !== null,
    detail: f ? `${d.redirects} redirects (~${d.est_GB} GB est.) then 429` : `no 429 after ${d.issued} requests (${JSON.stringify(d.statuses)})`,
  });
  const compact = (f?.body ?? "").replace(/\s/g, "");
  out.push({
    name: body429,
    pass: compact === '{"error":"bytelimitexceeded"}',
    detail: `body=${JSON.stringify(f?.body ?? null)} retry-after=${JSON.stringify(f?.retry_after ?? null)}`,
  });
  return out;
}

export function headline(r: QuotaResult): Record<string, unknown> {
  const h: Record<string, unknown> = Object.fromEntries(Object.keys(EXPECT).map((k) => [k, r.headers_probe.quota_headers[k] ?? null]));
  if (r.drain) {
    h.drain_redirects_before_429 = r.drain.redirects;
    h.drain_est_bytes = r.drain.est_bytes;
    h.drain_429_body = r.drain.first429?.body ?? null;
  }
  if (r.follow) h.follow_MB_per_s = r.follow.MB_per_s;
  return h;
}

function print(r: QuotaResult): void {
  console.log("quota headers:", r.headers_probe.quota_headers);
  const d = r.drain;
  if (d) {
    console.log(
      `drain: ${d.redirects} redirects (~${d.est_GB} GB est.) in ${d.elapsed_s} s; first 429: ` +
        `${JSON.stringify(d.first429?.body ?? null)} retry-after=${JSON.stringify(d.first429?.retry_after ?? null)}`,
    );
  }
  if (r.follow) console.log("follow:", r.follow);
}

export const finding: Finding<QuotaOpts, QuotaResult> = {
  name: "quota",
  usage: "npm run quota -- [options]\n\nFinding 2: the quota is charged when getBlock redirects, not when bytes move.",
  options: {
    drain: { type: "boolean", help: "COSTLY: drain the bucket with unfollowed redirects (~1 GB)" },
    follow: { type: "number", help: "COSTLY: follow redirects for N seconds" },
  },
  run,
  checks,
  headline,
  print,
};

if (import.meta.main) await main(finding);
