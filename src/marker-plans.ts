// Finding 3: account/sync ("marker") plans filtered by many DIDs cost about the
// same as no DID filter (the per-block DID blooms saturate), and the same plan
// over the whole archive fails.
//
// Plans kinds:["account","sync"] over the last 12 h (afterSeq from listSegments
// witnessed times) with 10, 100, 1000 and 10000 DIDs from
// fixtures/publication_dids.txt and with no DID filter, then over the WHOLE
// archive with 10000 DIDs. Nothing is downloaded; bytes are estimates.
//
// Quota cost: plan responses only (tens of KB to a few MB).
import {
  afterSeqForTail, estimateBytes, listSegments, planSnapshot, requireKey, segmentsByName,
  type ByteEstimate, type PlanPage, type PlanResult, type Segment,
} from "./lib/archive.ts";
import { main, type Check, type CommonOpts, type Finding } from "./lib/cli.ts";
import { fixture } from "./lib/config.ts";
import { gb, round } from "./lib/format.ts";

const COUNTS = [10, 100, 1000, 10000];
const KINDS = ["account", "sync"];

export type MarkerOpts = CommonOpts & { hours: number; timeout: number };

type PlanRow = {
  plan: string;
  request: Record<string, unknown>;
  ok: boolean;
  error: string | null;
  first_page_status: number | null;
  first_page_latency_s: number | null;
  total_latency_s: number;
  pages: PlanPage[];
} & Partial<ByteEstimate>;

export type MarkerResult = {
  segments_fetched_at: string;
  tail_hours: number;
  tail_after_seq: number;
  tail_cutoff_witnessed: string;
  dids_available: number;
  plans: PlanRow[];
};

function summarize(plan: string, res: PlanResult, byName: Map<string, Segment>): PlanRow {
  const first = res.pages[0];
  return {
    plan,
    request: res.request,
    ok: res.ok,
    error: res.error,
    first_page_status: first?.status ?? null,
    first_page_latency_s: first?.elapsed_s ?? null,
    total_latency_s: round(res.pages.reduce((n, p) => n + (p.elapsed_s ?? 0), 0), 3),
    pages: res.pages,
    ...(res.ok ? estimateBytes(res.segments, byName) : {}),
  };
}

export async function run(opts: MarkerOpts): Promise<MarkerResult> {
  requireKey();
  const { segments, fetchedAt } = await listSegments(opts.refresh);
  const byName = segmentsByName(segments);
  const dids = fixture("publication_dids.txt");
  const { afterSeq, cutoff } = afterSeqForTail(segments, opts.hours);
  const plans: PlanRow[] = [];
  for (const n of COUNTS) {
    console.log(`tail ${opts.hours} h, ${n} DIDs ...`);
    plans.push(summarize(`tail_${n}_dids`, await planSnapshot({ kinds: KINDS, dids: dids.slice(0, n), afterSeq }), byName));
  }
  console.log(`tail ${opts.hours} h, no DIDs ...`);
  plans.push(summarize("tail_no_dids", await planSnapshot({ kinds: KINDS, afterSeq }), byName));
  console.log("whole archive, 10000 DIDs ...");
  const whole = await planSnapshot({ kinds: KINDS, dids: dids.slice(0, 10000) }, { timeoutMs: opts.timeout * 1000 });
  plans.push(summarize("whole_archive_10000_dids", whole, byName));
  return {
    segments_fetched_at: fetchedAt,
    tail_hours: opts.hours,
    tail_after_seq: afterSeq,
    tail_cutoff_witnessed: cutoff,
    dids_available: dids.length,
    plans,
  };
}

const row = (r: MarkerResult, name: string) => r.plans.find((p) => p.plan === name) as PlanRow;

export function checks(r: MarkerResult): Check[] {
  const t10k = row(r, "tail_10000_dids");
  const none = row(r, "tail_no_dids");
  const whole = row(r, "whole_archive_10000_dids");
  const bloom = "tail: 10k-DID plan within 10% of the no-DID plan (bloom saturation)";
  const out: Check[] = [];
  if (t10k.total_bytes_est && none.total_bytes_est) {
    const ratio = t10k.total_bytes_est / none.total_bytes_est;
    out.push({
      name: bloom,
      pass: Math.abs(1 - ratio) <= 0.1,
      detail: `10k=${gb(t10k.total_bytes_est)} GB, none=${gb(none.total_bytes_est)} GB, ratio=${ratio.toFixed(3)}`,
    });
  } else {
    out.push({ name: bloom, pass: false, detail: `plan failed: 10k=${t10k.error} none=${none.error}` });
  }
  out.push({
    name: "whole archive, 10k DIDs: 502 or >15 s",
    pass: whole.first_page_status === 502 || whole.total_latency_s > 15,
    detail: `status=${whole.first_page_status} latency=${whole.total_latency_s} s error=${JSON.stringify(whole.error)}`,
  });
  return out;
}

export function headline(r: MarkerResult): Record<string, unknown> {
  const h: Record<string, unknown> = {};
  for (const p of r.plans) {
    h[`${p.plan}_status`] = p.first_page_status;
    if (p.total_bytes_est !== undefined) {
      h[`${p.plan}_bytes`] = p.total_bytes_est;
      h[`${p.plan}_blocks`] = p.blocks;
      h[`${p.plan}_whole_segments`] = p.whole_segments;
    }
  }
  return h;
}

function print(r: MarkerResult): void {
  for (const p of r.plans) {
    const head = `  ${p.plan.padEnd(26)} ${p.first_page_status} ${p.total_latency_s.toFixed(1).padStart(7)} s`;
    if (p.ok) {
      console.log(
        `${head}  ${String(p.whole_segments).padStart(3)} segs ${String(p.block_entries).padStart(4)} entries ` +
          `${String(p.blocks).padStart(6)} blocks  ${gb(p.total_bytes_est ?? 0).padStart(6)} GB`,
      );
    } else {
      console.log(`${head}  ${p.error}`);
    }
  }
}

export const finding: Finding<MarkerOpts, MarkerResult> = {
  name: "marker_plans",
  usage: "npm run markers -- [options]\n\nFinding 3: DID-filtered account/sync plans cost the same as unfiltered ones and fail over the whole archive.",
  options: {
    hours: { type: "number", default: 12, help: "tail window in hours (default 12)" },
    timeout: { type: "number", default: 300, help: "whole-archive plan timeout in seconds (default 300)" },
  },
  run,
  checks,
  headline,
  print,
};

if (import.meta.main) await main(finding);
