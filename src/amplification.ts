// Finding 4: replaying a rare collection downloads whole ~300 KB blocks for a
// handful of matching events, so bytes per matching event are 10^4-10^5 x the
// record size.
//
// For each collection: a whole-archive commit plan (kinds:["commit"],
// collections:[nsid]), planned blocks and estimated bytes, the collection's
// event count from the status page's collections tab, and bytes per event.
//
//   --sample N       COSTLY: download N planned blocks per collection (following
//                    the 307), zstd-decompress, and count the collection's commit
//                    events per block (decoded; NSID byte count fallback, labelled).
//   --with-document  also measure site.standard.document (large plan).
//
// Quota cost: plan responses only (~MBs). --sample N: about N x 0.3 MB per collection.
import {
  downloadBlock, estimateBytes, listSegments, planBlocks, planSnapshot, requireKey, segmentsByName, type ByteEstimate,
} from "./lib/archive.ts";
import { countInBlock, decompressBlock } from "./lib/block.ts";
import { main, type Check, type CommonOpts, type Finding } from "./lib/cli.ts";
import { NSID_DOCUMENT, NSID_PUBLICATION, NSID_WHTWND } from "./lib/config.ts";
import { errorText } from "./lib/http.ts";
import { gb, round } from "./lib/format.ts";
import { mapPool, seededSample } from "./lib/pool.ts";
import { statusCollections, type CollectionRow } from "./lib/status.ts";

export type AmplificationOpts = CommonOpts & { sample: number; seed: number; withDocument?: boolean };

type SampledBlock = {
  segment: string;
  block: number;
  status: number | string;
  compressed_bytes?: number;
  decompressed_bytes?: number;
  events_in_block?: number | null;
  matching_events?: number;
  method?: string;
};

type Sample = {
  requested: number;
  downloaded: number;
  seed: number;
  methods: string[];
  bytes_downloaded?: number;
  mean_block_bytes?: number;
  mean_matching_events_per_block?: number;
  median_matching_events_per_block?: number;
  blocks_with_zero_matches?: number;
  bytes_per_matching_event_sampled?: number;
  blocks: SampledBlock[];
};

type CollectionResult = {
  plan_ok: boolean;
  plan_error: string | null;
  plan_latency_s: number;
  plan_pages: number;
  status_page: CollectionRow | null;
  planned_blocks_total?: number;
  bytes_per_event?: number;
  events_per_planned_block?: number;
  sample?: Sample;
} & Partial<ByteEstimate>;

export type AmplificationResult = {
  segments_fetched_at: string;
  status_collections: { url?: string; columns?: string[] | null; error?: string };
  collections: Record<string, CollectionResult>;
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Download a seeded sample of planned blocks and count matching events in each. */
async function sampleBlocks(blocks: [string, number][], n: number, nsid: string, seed: number): Promise<Sample> {
  const pick = seededSample(blocks, n, seed);
  const results = await mapPool(
    pick,
    async ([segment, block]): Promise<SampledBlock> => {
      try {
        const b = await downloadBlock(segment, block);
        if (!b.raw) return { segment, block, status: b.status };
        const body = decompressBlock(b.raw);
        const c = countInBlock(body, nsid);
        return {
          segment, block, status: b.status, compressed_bytes: b.raw.length, decompressed_bytes: body.length,
          events_in_block: c.events, matching_events: c.matches, method: c.method,
        };
      } catch (err) {
        return { segment, block, status: `error: ${errorText(err, 120)}` };
      }
    },
    4,
  );
  const ok = results.filter((x) => x.matching_events !== undefined) as Required<SampledBlock>[];
  const sample: Sample = { requested: pick.length, downloaded: ok.length, seed, methods: [...new Set(ok.map((x) => x.method))].sort(), blocks: results };
  if (ok.length) {
    const bytes = ok.reduce((n, x) => n + x.compressed_bytes, 0);
    const matches = ok.map((x) => x.matching_events);
    Object.assign(sample, {
      bytes_downloaded: bytes,
      mean_block_bytes: Math.round(bytes / ok.length),
      mean_matching_events_per_block: round(mean(matches), 3),
      median_matching_events_per_block: median(matches),
      blocks_with_zero_matches: matches.filter((m) => m === 0).length,
      bytes_per_matching_event_sampled: Math.round(bytes / Math.max(1, matches.reduce((a, b) => a + b, 0))),
    });
  }
  return sample;
}

export async function run(opts: AmplificationOpts): Promise<AmplificationResult> {
  requireKey();
  const { segments, fetchedAt } = await listSegments(opts.refresh);
  const byName = segmentsByName(segments);
  const nsids = [NSID_WHTWND, NSID_PUBLICATION, ...(opts.withDocument ? [NSID_DOCUMENT] : [])];

  let rows: Record<string, CollectionRow | null> = {};
  let statusMeta: AmplificationResult["status_collections"];
  try {
    const s = await statusCollections(nsids);
    rows = s.rows;
    statusMeta = { url: s.url, columns: s.columns };
  } catch (err) {
    statusMeta = { error: errorText(err) };
  }

  const collections: Record<string, CollectionResult> = {};
  for (const nsid of nsids) {
    console.log(`planning ${nsid} ...`);
    const res = await planSnapshot({ kinds: ["commit"], collections: [nsid] });
    const row: CollectionResult = {
      plan_ok: res.ok,
      plan_error: res.error,
      plan_latency_s: round(res.pages.reduce((n, p) => n + (p.elapsed_s ?? 0), 0), 3),
      plan_pages: res.pages.length,
      status_page: rows[nsid] ?? null,
    };
    if (res.ok) {
      const est = estimateBytes(res.segments, byName);
      Object.assign(row, est);
      row.planned_blocks_total = est.blocks + est.whole_segment_blocks_est;
      const events = row.status_page?.events;
      if (events) {
        // The headline number: estimated download divided by matching events.
        row.bytes_per_event = Math.round(est.total_bytes_est / events);
        row.events_per_planned_block = round(events / Math.max(1, row.planned_blocks_total), 3);
      }
      if (opts.sample) {
        console.log(`  sampling ${opts.sample} blocks ...`);
        row.sample = await sampleBlocks(planBlocks(res.segments, byName), opts.sample, nsid, opts.seed);
      }
    }
    collections[nsid] = row;
  }
  return { segments_fetched_at: fetchedAt, status_collections: statusMeta, collections };
}

export function checks(r: AmplificationResult): Check[] {
  return Object.entries(r.collections).map(([nsid, c]) => {
    const bpe = c.bytes_per_event;
    return {
      name: `${nsid}: >10 KB downloaded per matching event`,
      pass: bpe !== undefined && bpe > 10_000,
      detail:
        `${c.planned_blocks_total} blocks, ${gb(c.total_bytes_est ?? 0)} GB est. for ${c.status_page?.events ?? null} events = ${bpe ?? null} B/event` +
        (c.plan_ok ? "" : ` (plan error ${c.plan_error})`),
    };
  });
}

export function headline(r: AmplificationResult): Record<string, unknown> {
  const h: Record<string, unknown> = {};
  for (const [nsid, c] of Object.entries(r.collections)) {
    h[`${nsid}_planned_blocks_total`] = c.planned_blocks_total ?? null;
    h[`${nsid}_total_bytes_est`] = c.total_bytes_est ?? null;
    h[`${nsid}_bytes_per_event`] = c.bytes_per_event ?? null;
    h[`${nsid}_status_events`] = c.status_page?.events ?? null;
    if (c.sample) h[`${nsid}_sample_mean_matching_per_block`] = c.sample.mean_matching_events_per_block ?? null;
  }
  return h;
}

function print(r: AmplificationResult): void {
  for (const [nsid, c] of Object.entries(r.collections)) {
    console.log(
      `  ${nsid.padEnd(28)} events=${c.status_page?.events ?? null} blocks=${c.planned_blocks_total ?? null} ` +
        `est=${gb(c.total_bytes_est ?? 0)} GB  B/event=${c.bytes_per_event ?? null}`,
    );
    const s = c.sample;
    if (s) {
      console.log(
        `    sample: ${s.downloaded}/${s.requested} blocks, mean ${s.mean_block_bytes ?? null} B/block, ` +
          `${s.mean_matching_events_per_block ?? null} matching events/block (${s.methods.join(",")})`,
      );
    }
  }
}

export const finding: Finding<AmplificationOpts, AmplificationResult> = {
  name: "amplification",
  usage: "npm run amplification -- [options]\n\nFinding 4: rare collections download whole blocks for a few events each.",
  options: {
    sample: { type: "number", default: 0, help: "COSTLY: download N planned blocks per collection" },
    seed: { type: "number", default: 1, help: "sample seed (default 1)" },
    "with-document": { type: "boolean", help: "include site.standard.document" },
  },
  run,
  checks,
  headline,
  print,
};

if (import.meta.main) await main(finding);
