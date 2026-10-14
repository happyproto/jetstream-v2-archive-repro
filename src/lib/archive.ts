// The hosted archive's XRPC endpoints (network.bsky.jetstream.*).
// The key is read from JETSTREAM_API_KEY, sent only to the archive host
// (never to the CDN a redirect points at), and never printed or recorded.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CACHE_DIR, EVENTS_PER_BLOCK, HOST } from "./config.ts";
import { errorText, isRedirect, jsonOf, request, textOf, type Resp } from "./http.ts";
import { redactHeaders, utcNowIso } from "./results.ts";
import { round, usToIso } from "./format.ts";
import { sleep } from "./pool.ts";

// ---- Response shapes ------------------------------------------------------

/** One sealed segment from listSegments. Times are microseconds since the epoch. */
export type Segment = {
  name: string;
  index: number;
  checksum?: string;
  minSeq: number;
  maxSeq: number;
  minWitnessedAt: number;
  maxWitnessedAt: number;
  eventCount: number;
  sizeBytes: number;
};

/** One entry of a planSnapshot response: a whole segment, or block ranges in it. */
export type PlanEntry = {
  name: string;
  index: number;
  checksum?: string;
  minSeq: number;
  maxSeq: number;
  mode: "segment" | "blocks";
  blocks?: { first: number; last: number }[];
};

export type PlanResponse = {
  plannedThroughSeq: number;
  sealedTipSeq: number;
  segments: PlanEntry[];
  stats?: unknown;
};

export type PlanRequest = {
  kinds?: string[];
  collections?: string[];
  dids?: string[];
  afterSeq?: number;
  beforeSeq?: number;
};

// ---- Key and transport ----------------------------------------------------

export class MissingKeyError extends Error {
  constructor() {
    super("JETSTREAM_API_KEY is not set: cp .env.example .env and add your archive key (the archive answers 401 without one).");
  }
}

export const hasKey = () => Boolean(process.env.JETSTREAM_API_KEY);

/** Throws MissingKeyError before any request is made if the key is missing. */
export function requireKey(): string {
  const key = process.env.JETSTREAM_API_KEY;
  if (!key) throw new MissingKeyError();
  return key;
}

function archiveUrl(nsid: string, params?: Record<string, string | number>): string {
  const base = HOST.includes("://") ? HOST.replace(/\/+$/, "") : `https://${HOST}`;
  const q = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : "";
  return `${base}/xrpc/network.bsky.jetstream.${nsid}${q}`;
}

/** Authenticated archive call. Redirects are not followed. */
export function archiveCall(
  method: "GET" | "POST",
  nsid: string,
  opts: { params?: Record<string, string | number>; body?: unknown; timeoutMs?: number } = {},
): Promise<Resp> {
  return request(archiveUrl(nsid, opts.params), {
    method,
    body: opts.body,
    timeoutMs: opts.timeoutMs,
    headers: { authorization: `Bearer ${requireKey()}` },
  });
}

/** Only the quota headers (and Retry-After) of a response. */
export function quotaHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith("headwind-") || k === "retry-after"));
}

export function retryAfterSeconds(headers: Record<string, string> | undefined, fallback = 1): number {
  const n = Number(headers?.["retry-after"]);
  return Number.isFinite(n) && headers?.["retry-after"] !== undefined ? n : fallback;
}

// ---- listSegments ---------------------------------------------------------

const SEGMENTS_CACHE = path.join(CACHE_DIR, "segments.json");

/** All sealed segments (paged, limit 1000), cached in .cache/segments.json. */
export async function listSegments(refresh = false): Promise<{ segments: Segment[]; fetchedAt: string }> {
  if (!refresh && existsSync(SEGMENTS_CACHE)) {
    const cached = JSON.parse(readFileSync(SEGMENTS_CACHE, "utf8")) as { fetched_at: string; segments: Segment[] };
    console.log(`listSegments: using cache from ${cached.fetched_at} (${cached.segments.length} segments; --refresh to refetch)`);
    return { segments: cached.segments, fetchedAt: cached.fetched_at };
  }
  requireKey();
  const segments: Segment[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const params: Record<string, string | number> = { limit: 1000 };
    if (cursor) params.cursor = cursor;
    const r = await archiveCall("GET", "listSegments", { params });
    if (r.status !== 200) throw new Error(`listSegments ${r.status}: ${textOf(r, 300)}`);
    const page = jsonOf<{ segments?: Segment[]; cursor?: string }>(r);
    segments.push(...(page.segments ?? []));
    pages++;
    cursor = page.cursor;
    if (!cursor || !page.segments?.length) break;
  }
  segments.sort((a, b) => a.index - b.index);
  const fetchedAt = utcNowIso();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(SEGMENTS_CACHE, JSON.stringify({ fetched_at: fetchedAt, segments }));
  console.log(`listSegments: ${segments.length} segments in ${pages} pages`);
  return { segments, fetchedAt };
}

export const segmentsByName = (segments: Segment[]) => new Map(segments.map((s) => [s.name, s]));

/** Estimated block count: Jetstream cuts a block every 4096 events. */
export const blocksInSegment = (seg: Segment) => Math.max(1, Math.ceil(seg.eventCount / EVENTS_PER_BLOCK));

/** Estimated compressed size of one block of this segment (the segment's average block). */
export const blockBytes = (seg: Segment) => seg.sizeBytes / blocksInSegment(seg);

/**
 * afterSeq so a plan covers roughly the last `hours` of the sealed archive.
 * "Now" is the newest segment's maxWitnessedAt, so a stale cache does not shift the window.
 */
export function afterSeqForTail(segments: Segment[], hours: number): { afterSeq: number; cutoff: string } {
  const newest = Math.max(...segments.map((s) => s.maxWitnessedAt));
  const cutoff = newest - Math.round(hours * 3600 * 1e6);
  const older = segments.filter((s) => s.maxWitnessedAt <= cutoff);
  const afterSeq = older.length ? Math.max(...older.map((s) => s.maxSeq)) : 0;
  return { afterSeq, cutoff: usToIso(cutoff) };
}

// ---- planSnapshot ---------------------------------------------------------

export type PlanPage = {
  status: number | null;
  elapsed_s?: number;
  plannedThroughSeq?: number;
  sealedTipSeq?: number;
  segments?: number;
  stats?: unknown;
  body?: string;
  headers?: Record<string, string>;
  error?: string;
};

export type PlanResult = {
  request: Record<string, unknown>;
  pages: PlanPage[];
  segments: PlanEntry[];
  ok: boolean;
  error: string | null;
};

/**
 * POST planSnapshot, paging the way the Go client does: afterSeq = plannedThroughSeq,
 * with beforeSeq pinned to the first page's sealedTipSeq.
 */
export async function planSnapshot(body: PlanRequest, opts: { timeoutMs?: number; maxPages?: number } = {}): Promise<PlanResult> {
  const recorded: Record<string, unknown> = { ...body };
  if (body.dids) recorded.dids = `<${body.dids.length} DIDs>`;
  const out: PlanResult = { request: recorded, pages: [], segments: [], ok: false, error: null };
  let req: PlanRequest = { ...body };
  let tip: number | null = null;
  const maxPages = opts.maxPages ?? 50;
  for (let n = 0; n < maxPages; n++) {
    let r: Resp;
    try {
      r = await archiveCall("POST", "planSnapshot", { body: req, timeoutMs: opts.timeoutMs ?? 300_000 });
    } catch (err) {
      out.error = errorText(err);
      out.pages.push({ status: null, error: out.error });
      return out;
    }
    const page: PlanPage = { status: r.status, elapsed_s: round(r.elapsedS, 3) };
    if (r.status !== 200) {
      out.pages.push({ ...page, body: textOf(r, 500), headers: r.headers });
      out.error = `${r.status} ${textOf(r, 200)}`;
      return out;
    }
    const j = jsonOf<PlanResponse>(r);
    out.pages.push({
      ...page,
      plannedThroughSeq: j.plannedThroughSeq,
      sealedTipSeq: j.sealedTipSeq,
      segments: j.segments?.length ?? 0,
      stats: j.stats,
    });
    out.segments.push(...(j.segments ?? []));
    tip ??= j.sealedTipSeq ?? 0;
    const through = j.plannedThroughSeq ?? 0;
    if (through >= tip) {
      out.ok = true;
      return out;
    }
    if (req.afterSeq !== undefined && through <= req.afterSeq) {
      out.error = "plannedThroughSeq did not advance";
      return out;
    }
    req = { ...body, afterSeq: through, beforeSeq: tip };
  }
  out.error = `stopped after ${maxPages} pages`;
  return out;
}

/** Expand a plan into [segment, blockIndex] pairs. Whole segments expand to every estimated block. */
export function planBlocks(entries: PlanEntry[], byName: Map<string, Segment>): [string, number][] {
  const out: [string, number][] = [];
  for (const e of entries) {
    if (e.mode === "blocks") {
      for (const b of e.blocks ?? []) for (let i = b.first; i <= b.last; i++) out.push([e.name, i]);
    } else {
      const seg = byName.get(e.name);
      const n = seg ? blocksInSegment(seg) : 0;
      for (let i = 0; i < n; i++) out.push([e.name, i]);
    }
  }
  return out;
}

export type ByteEstimate = {
  plan_entries: number;
  whole_segments: number;
  whole_segment_bytes: number;
  whole_segment_blocks_est: number;
  block_entries: number;
  blocks: number;
  block_bytes_est: number;
  total_bytes_est: number;
  entries_not_in_segment_cache: number;
};

/**
 * Estimated download for a plan. A whole segment counts its listSegments sizeBytes;
 * a block counts sizeBytes / ceil(eventCount / 4096) of its segment. Entries for
 * segments missing from the cache (sealed after it was fetched) are counted, not sized.
 */
export function estimateBytes(entries: PlanEntry[], byName: Map<string, Segment>): ByteEstimate {
  let whole = 0, wholeBytes = 0, wholeBlocks = 0, blockEntries = 0, blocks = 0, blkBytes = 0, unknown = 0;
  for (const e of entries) {
    const seg = byName.get(e.name);
    if (!seg) {
      unknown++;
      continue;
    }
    if (e.mode === "blocks") {
      const n = (e.blocks ?? []).reduce((sum, b) => sum + b.last - b.first + 1, 0);
      blockEntries++;
      blocks += n;
      blkBytes += n * blockBytes(seg);
    } else {
      whole++;
      wholeBytes += seg.sizeBytes;
      wholeBlocks += blocksInSegment(seg);
    }
  }
  return {
    plan_entries: entries.length,
    whole_segments: whole,
    whole_segment_bytes: wholeBytes,
    whole_segment_blocks_est: wholeBlocks,
    block_entries: blockEntries,
    blocks,
    block_bytes_est: Math.round(blkBytes),
    total_bytes_est: Math.round(wholeBytes + blkBytes),
    entries_not_in_segment_cache: unknown,
  };
}

// ---- getBlock -------------------------------------------------------------

/** getBlock WITHOUT following the 307. The recorded Location has its token redacted. */
export function getBlock(segment: string, blockIndex: number, timeoutMs = 180_000): Promise<Resp> {
  return archiveCall("GET", "getBlock", { params: { segment, blockIndex }, timeoutMs });
}

export type FollowedBlock = {
  status: number;
  /** Compressed block bytes, or null if no block was downloaded. */
  raw: Uint8Array | null;
  info: { headers: Record<string, string>; location_host?: string; cdn_status?: number; body?: string; cdn_body?: string };
};

/**
 * getBlock, then follow the redirect ourselves WITHOUT the key. The signed CDN URL
 * is used once and only its host is recorded.
 */
export async function getBlockFollow(segment: string, blockIndex: number, timeoutMs = 180_000): Promise<FollowedBlock> {
  const url = archiveUrl("getBlock", { segment, blockIndex });
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${requireKey()}` },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = new Uint8Array(await res.arrayBuffer());
  const rawLocation = res.headers.get("location");
  const info: FollowedBlock["info"] = { headers: redactHeaders(res.headers) };
  if (res.status === 200) return { status: 200, raw: body, info };
  if (!isRedirect(res.status) || !rawLocation) {
    info.body = textOf({ body } as Resp, 300);
    return { status: res.status, raw: null, info };
  }
  const target = new URL(rawLocation, url);
  info.location_host = target.host;
  const cdn = await request(target.href, { timeoutMs });
  info.cdn_status = cdn.status;
  if (cdn.status !== 200) {
    info.cdn_body = textOf(cdn, 300);
    return { status: cdn.status, raw: null, info };
  }
  return { status: res.status, raw: cdn.body, info };
}

/** getBlockFollow, waiting out 429s (Retry-After, 1..30 s) up to `attempts` times. */
export async function downloadBlock(segment: string, blockIndex: number, attempts = 120): Promise<FollowedBlock | { status: string; raw: null }> {
  for (let i = 0; i < attempts; i++) {
    const b = await getBlockFollow(segment, blockIndex);
    if (b.status !== 429) return b;
    await sleep(Math.max(1, Math.min(retryAfterSeconds(b.info.headers), 30)) * 1000);
  }
  return { status: `gave up after ${attempts} throttled attempts`, raw: null };
}
