// Finding 5: repos that moved PDS before the archive started (2026-10-02) are
// still `pending` in Jetstream's backfill at their OLD host, so their records
// are missing from the archive.
//
// fixtures/publication_absent_from_archive.txt holds 912 DIDs whose
// site.standard.publication records exist on their PDS but have no event in the
// archive. For a seeded sample (default 60; --all for every DID) we read the
// public status page's account view and the PLC audit log, and do the same for
// a control sample of fixtures/publication_present_in_archive_sample.txt.
//
// No archive key needed. Quota cost: 0. Third-party load: 2 GETs per DID, 6 at a time.
import { main, type Check, type CommonOpts, type Finding } from "./lib/cli.ts";
import { fixture } from "./lib/config.ts";
import { countBy } from "./lib/format.ts";
import { movedAwayFrom, pdsHistory, plcAudit, type PdsHistory } from "./lib/plc.ts";
import { mapPool, seededSample } from "./lib/pool.ts";
import { statusAccount, type AccountStatus } from "./lib/status.ts";

const ARCHIVE_START = "2026-10-02";

export type MigratedOpts = CommonOpts & { sample: number; control: number; seed: number; all?: boolean };

type Lookup = {
  did: string;
  status: AccountStatus;
  plc_error: string | null;
  plc_pds_history: PdsHistory;
  current_pds: string | null;
  /** The PDS the status page says Jetstream is backfilling from. */
  jetstream_pds: string | null;
  jetstream_host_is_current: boolean;
  moved_away_at: string | null;
  moved_to: string | null;
};

type Summary = {
  n: number;
  backfill: Record<string, number>;
  result: Record<string, number>;
  pending: number;
  pending_moved_before_archive_start: number;
  pending_jetstream_host_is_current: number;
  moved_between: [string, string] | null;
  moved_to: Record<string, number>;
  jetstream_pds_hosts: Record<string, number>;
  /** Lookups where the status page skipped its live repo verification (rate limit). */
  verification_unavailable: number;
};

type Group = { fixture: string; population: number; summary: Summary; rows: Lookup[] };

export type MigratedResult = { seed: number; sampler: string; archive_start: string; absent: Group; control: Group };

/** Status page + PLC for one DID: where Jetstream looks, where the repo is now, and when it left. */
async function lookup(did: string): Promise<Lookup> {
  const status = await statusAccount(did);
  const { audit, error } = await plcAudit(did);
  const history = pdsHistory(audit);
  const jetstreamPds = typeof status["PDS endpoint"] === "string" ? status["PDS endpoint"] : null;
  const moved = jetstreamPds ? movedAwayFrom(history, jetstreamPds) : null;
  const current = history.at(-1)?.[1] ?? null;
  return {
    did,
    status,
    plc_error: error,
    plc_pds_history: history,
    current_pds: current,
    jetstream_pds: jetstreamPds,
    jetstream_host_is_current: history.length > 0 && current === jetstreamPds,
    moved_away_at: moved?.[0] ?? null,
    moved_to: moved?.[1] ?? null,
  };
}

function summarize(rows: Lookup[]): Summary {
  const pending = rows.filter((r) => r.status.Backfill === "pending");
  const migrated = pending.filter((r) => r.moved_away_at && r.moved_away_at.slice(0, 10) < ARCHIVE_START);
  const dates = migrated.map((r) => (r.moved_away_at as string).slice(0, 10)).sort();
  return {
    n: rows.length,
    backfill: countBy(rows, (r) => (r.status.Backfill ?? r.status.error ?? "unknown") as string),
    result: countBy(rows, (r) => r.status.Result as string | undefined),
    pending: pending.length,
    pending_moved_before_archive_start: migrated.length,
    pending_jetstream_host_is_current: pending.filter((r) => r.jetstream_host_is_current).length,
    moved_between: dates.length ? [dates[0] as string, dates.at(-1) as string] : null,
    moved_to: countBy(migrated, (r) => r.moved_to),
    jetstream_pds_hosts: Object.fromEntries(Object.entries(countBy(pending, (r) => r.jetstream_pds)).slice(0, 10)),
    verification_unavailable: rows.filter((r) => r.status.verification_error).length,
  };
}

export async function run(opts: MigratedOpts): Promise<MigratedResult> {
  const absent = fixture("publication_absent_from_archive.txt");
  const present = fixture("publication_present_in_archive_sample.txt");
  const a = opts.all ? absent : seededSample(absent, opts.sample, opts.seed);
  const c = seededSample(present, opts.control, opts.seed);
  console.log(`looking up ${a.length} absent + ${c.length} control DIDs (status page + PLC, 6 at a time) ...`);
  const absentRows = await mapPool(a, lookup);
  const controlRows = await mapPool(c, lookup);
  return {
    seed: opts.seed,
    sampler: "mulberry32 + partial Fisher-Yates (src/lib/pool.ts seededSample)",
    archive_start: ARCHIVE_START,
    absent: { fixture: "publication_absent_from_archive.txt", population: absent.length, summary: summarize(absentRows), rows: absentRows },
    control: { fixture: "publication_present_in_archive_sample.txt", population: present.length, summary: summarize(controlRows), rows: controlRows },
  };
}

export function checks(r: MigratedResult): Check[] {
  const a = r.absent.summary;
  const c = r.control.summary;
  const controlComplete = c.backfill.complete ?? 0;
  return [
    { name: "most absent repos are pending", pass: a.pending > a.n / 2, detail: `${a.pending}/${a.n} pending (${JSON.stringify(a.backfill)})` },
    {
      name: "most pending absent repos left Jetstream's host before 2026-10-02",
      pass: a.pending_moved_before_archive_start > a.pending / 2,
      detail: `${a.pending_moved_before_archive_start}/${a.pending} moved, ${JSON.stringify(a.moved_between)}, to ${JSON.stringify(a.moved_to)}`,
    },
    {
      name: "control: most present repos are complete",
      pass: controlComplete > c.n / 2,
      detail: `${controlComplete}/${c.n} complete (${JSON.stringify(c.backfill)})`,
    },
  ];
}

export function headline(r: MigratedResult): Record<string, unknown> {
  const a = r.absent.summary;
  const c = r.control.summary;
  return {
    absent_n: a.n,
    absent_pending: a.pending,
    absent_pending_moved_before_start: a.pending_moved_before_archive_start,
    control_n: c.n,
    control_complete: c.backfill.complete ?? 0,
  };
}

function print(r: MigratedResult): void {
  for (const key of ["absent", "control"] as const) console.log(key, JSON.stringify(r[key].summary));
}

export const finding: Finding<MigratedOpts, MigratedResult> = {
  name: "coverage_migrated",
  usage: "npm run coverage:migrated -- [options]\n\nFinding 5: repos that changed PDS before the archive began are missing from it.",
  options: {
    sample: { type: "number", default: 60, help: "absent DIDs to sample (default 60)" },
    control: { type: "number", default: 20, help: "present DIDs to sample as a control (default 20)" },
    seed: { type: "number", default: 1, help: "sample seed (default 1)" },
    all: { type: "boolean", help: "look up every absent DID (912)" },
  },
  run,
  checks,
  headline,
  print,
};

if (import.meta.main) await main(finding);
