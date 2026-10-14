// Finding 1: the hosted archive starts on 2026-10-02, and almost all of it was
// written by a bulk import on 2026-10-03..06.
//
// Reads listSegments (needs JETSTREAM_API_KEY unless .cache/segments.json exists)
// and the public status page, then groups segments by the UTC day of their
// minWitnessedAt. Without a key and without a cache, only the status page runs.
//
// Quota cost: listSegments only, ~2 MB of JSON (8 pages). 0 with a warm cache.
import { listSegments, MissingKeyError, type Segment } from "./lib/archive.ts";
import { main, type Check, type CommonOpts, type Finding } from "./lib/cli.ts";
import { errorText } from "./lib/http.ts";
import { round, usToDay, usToIso, pct } from "./lib/format.ts";
import { statusSummary, type StatusSummary } from "./lib/status.ts";

const IMPORT_DAYS = ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"];

type Day = { segments: number; events: number; bytes: number; GB?: number; share_of_bytes?: number };

type ArchivePart = {
  segments_fetched_at: string;
  segments: number;
  first_segment: Pick<Segment, "name" | "index" | "minSeq" | "minWitnessedAt"> | null;
  archive_start: string;
  archive_end: string;
  total_events: number;
  total_bytes: number;
  total_TB: number;
  import_days: string[];
  import_events: number;
  import_bytes: number;
  import_share_of_bytes: number;
  import_share_of_events: number;
  per_day: Record<string, Day>;
};

export type OverviewResult = {
  /** null when there was no key and no segment cache. */
  archive: ArchivePart | null;
  archive_skipped?: string;
  status_page: StatusSummary | { error: string };
};

function summarize(segs: Segment[], fetchedAt: string): ArchivePart {
  const days: Record<string, Day> = {};
  for (const s of [...segs].sort((a, b) => a.minWitnessedAt - b.minWitnessedAt)) {
    const d = (days[usToDay(s.minWitnessedAt)] ??= { segments: 0, events: 0, bytes: 0 });
    d.segments++;
    d.events += s.eventCount;
    d.bytes += s.sizeBytes;
  }
  const totalBytes = segs.reduce((n, s) => n + s.sizeBytes, 0);
  const totalEvents = segs.reduce((n, s) => n + s.eventCount, 0);
  const importBytes = IMPORT_DAYS.reduce((n, d) => n + (days[d]?.bytes ?? 0), 0);
  const importEvents = IMPORT_DAYS.reduce((n, d) => n + (days[d]?.events ?? 0), 0);
  for (const d of Object.values(days)) {
    d.GB = round(d.bytes / 1e9, 2);
    d.share_of_bytes = round(d.bytes / totalBytes, 4);
  }
  const first = segs[0];
  return {
    segments_fetched_at: fetchedAt,
    segments: segs.length,
    first_segment: first ? { name: first.name, index: first.index, minSeq: first.minSeq, minWitnessedAt: first.minWitnessedAt } : null,
    archive_start: usToIso(Math.min(...segs.map((s) => s.minWitnessedAt))),
    archive_end: usToIso(Math.max(...segs.map((s) => s.maxWitnessedAt))),
    total_events: totalEvents,
    total_bytes: totalBytes,
    total_TB: round(totalBytes / 1e12, 3),
    import_days: IMPORT_DAYS,
    import_events: importEvents,
    import_bytes: importBytes,
    import_share_of_bytes: round(importBytes / totalBytes, 4),
    import_share_of_events: round(importEvents / totalEvents, 4),
    per_day: days,
  };
}

export async function run(opts: CommonOpts): Promise<OverviewResult> {
  let archive: ArchivePart | null = null;
  let archiveSkipped: string | undefined;
  try {
    const { segments, fetchedAt } = await listSegments(opts.refresh);
    archive = summarize(segments, fetchedAt);
  } catch (err) {
    // The status page needs no key, so it still runs without one.
    if (!(err instanceof MissingKeyError)) throw err;
    console.error(`${err.message} Skipping listSegments; reading the status page only.`);
    archiveSkipped = "JETSTREAM_API_KEY not set and no .cache/segments.json";
  }
  let status: OverviewResult["status_page"];
  try {
    status = await statusSummary();
  } catch (err) {
    status = { error: errorText(err) };
  }
  return { archive, ...(archiveSkipped ? { archive_skipped: archiveSkipped } : {}), status_page: status };
}

export function checks(r: OverviewResult): Check[] {
  const a = r.archive;
  if (!a) {
    return [
      { name: "archive starts 2026-10-02", pass: null, detail: "not run (needs JETSTREAM_API_KEY)" },
      { name: ">90% of bytes witnessed 2026-10-03..06", pass: null, detail: "not run (needs JETSTREAM_API_KEY)" },
    ];
  }
  return [
    { name: "archive starts 2026-10-02", pass: a.archive_start.startsWith("2026-10-02"), detail: `archive_start=${a.archive_start}` },
    {
      name: ">90% of bytes witnessed 2026-10-03..06",
      pass: a.import_share_of_bytes > 0.9,
      detail: `share=${pct(a.import_share_of_bytes)} (${(a.import_bytes / 1e12).toFixed(2)} TB, ${(a.import_events / 1e9).toFixed(2)}B events)`,
    },
  ];
}

export function headline(r: OverviewResult): Record<string, unknown> {
  const a = r.archive;
  return {
    archive_start: a?.archive_start.slice(0, 10) ?? null,
    total_events: a?.total_events ?? null,
    total_bytes: a?.total_bytes ?? null,
    import_events: a?.import_events ?? null,
    import_bytes: a?.import_bytes ?? null,
    import_share_of_bytes: a?.import_share_of_bytes ?? null,
    jetstream_version: "jetstream_version" in r.status_page ? r.status_page.jetstream_version : null,
  };
}

function print(r: OverviewResult): void {
  const a = r.archive;
  if (a) {
    console.log(
      `archive ${a.archive_start} .. ${a.archive_end}: ${a.total_events.toLocaleString("en-US")} events, ${a.total_TB} TB ` +
        `in ${a.segments.toLocaleString("en-US")} segments; Oct 3-6 = ${pct(a.import_share_of_bytes)} of bytes`,
    );
    for (const [day, d] of Object.entries(a.per_day)) {
      console.log(`  ${day}  ${String(d.segments).padStart(5)} segs  ${d.events.toLocaleString("en-US").padStart(15)} events  ${(d.GB ?? 0).toFixed(2).padStart(9)} GB`);
    }
  }
  const s = r.status_page;
  console.log("status page:", "error" in s ? s.error : `${s.jetstream_version} events=${s.fields.Events}`);
}

export const finding: Finding<CommonOpts, OverviewResult> = {
  name: "archive_overview",
  usage: "npm run overview -- [options]\n\nFinding 1: the archive starts on 2026-10-02 and is almost all a 2026-10-03..06 bulk import.",
  options: {},
  run,
  checks,
  headline,
  print,
};

if (import.meta.main) await main(finding);
