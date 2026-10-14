# Jetstream v2 archive: reproductions

Scripts that reproduce what we found while backfilling three collections from Bluesky's hosted Jetstream v2 archive (`jetstream1.us-east.bsky.network`), as of 2026-10-14. They accompany the write-up "Jetstream v2 archive backfill findings". Each finding has one TypeScript script under `src/`. Each script writes JSON to `results/<UTC date>/<name>.json` and has a `--check` mode that exits non-zero and names the assertion that no longer holds.

Numbers below were measured on 2026-10-14. "Recorded" means the result JSON is in `results/2026-10-14/`. The rest come from the ad-hoc scripts these were adapted from, run the same day.

> **Recorded outputs are incomplete.** `results/2026-10-14/` holds JSON for findings 5 and 6 (`coverage_migrated.json`, `coverage_bridgy.json`), which need no key. It does not yet hold JSON for the scripts that need an archive key (findings 1–4, and `--archive-count` in 6). Until it does, the archive numbers below come from the ad-hoc scripts. Run `npm run all -- --costly --out results/2026-10-14` with a key to fill it in, then remove this note.

## Findings

### 1. The archive starts on 2026-10-02 and is almost all one bulk import (`npm run overview`, `src/archive-overview.ts`)

`listSegments` returns 7,439 sealed segments: 25.8B events and 1.98 TB. The first segment was witnessed at 2026-10-02 20:53:35 UTC. Segments witnessed on 2026-10-03 to 2026-10-06 hold 25.48B events and 1.945 TB, which is 98.4% of the bytes. Since then the archive has grown by about 3.5 GB and 35M events a day. On 2026-10-14 the status page reported `v0.4.2 (commit f582c11)`, 25,818,750,521 events, a witnessed range starting 2026-10-02 20:53:35, and a 1d 12h cursor lookback. By 14:15 UTC the same day it reported `v0.4.4 (commit d4db8c0)`. Anything that was not imported in that window has to come from the live stream after 2026-10-02.

### 2. The per-key quota is charged when getBlock redirects, not when bytes move (`npm run quota`, `src/quota.ts`)

Every archive response carries `headwind-quota-burst-bytes: 1000000000`, `headwind-quota-refill-bytes: 2000000` and `headwind-quota-refill-period-seconds: 1`. That is a 1 GB burst refilling at 2 MB/s, for a key created on 2026-10-13. `getBlock` answers `307` with a signed CDN URL. Issuing `getBlock` requests without ever following the redirect still drains the bucket. After roughly a burst's worth of blocks (estimated from `listSegments` sizes), the next request gets `429 {"error":"byte limit exceeded"}` with a `Retry-After`. Nothing was downloaded. The bytes are charged when the redirect is issued.

The default policy in bps-website (`server/src/apikeys/jetstream-policy.ts`, raised in bluesky-social/bps-website#32) is 100 TiB per 30 days with a 64 GiB burst, about 42 MB/s. Our key got 1 GB and 2 MB/s, roughly 1/20 of that rate and 1/64 of that burst.

### 3. DID-filtered account/sync plans cost the same as unfiltered ones, and fail over the whole archive (`npm run markers`, `src/marker-plans.ts`)

`planSnapshot` with `kinds:["account","sync"]` over the last 12 hours:

| DIDs | Planned | Est. download |
|---|---|---|
| none | 748 blocks + 6 whole segments | 1.73 GB |
| 10,000 | 740 blocks + 6 whole segments | 1.72 GB |
| 1,000 | 2,260 blocks + 2 whole segments | 1.32 GB |
| 100 | 564 blocks | 0.24 GB |
| 10 | 50 blocks | 0.02 GB |

At 10,000 DIDs the plan is within 1% of the unfiltered one: the per-block DID blooms are saturated, so the filter prunes nothing. The same plan over the whole archive (no `afterSeq`) with 10,000 DIDs returns `502 {"error":"upstream unavailable"}`, and did so every time we tried.

### 4. Rare collections download whole blocks for a few events each (`npm run amplification`, `src/amplification.ts`)

A commit plan for one collection returns every block whose collection index contains that NSID. Blocks average about 311 KB compressed (4,096 events).

| Collection | Events (status page) | Blocks | Est. download | Bytes per event |
|---|---|---|---|---|
| `com.whtwnd.blog.entry` | 6,811 | 1,486 | ~0.46 GB | ~68 KB |
| `site.standard.publication` | 17,600 | 13,081 | ~4.1 GB | ~231 KB |
| `site.standard.document` | 3.90M | 71,800 | ~22 GB | ~5.7 KB |

On 2026-10-14 at 12:47 UTC the status page's collections tab showed `com.whtwnd.blog.entry` at 6,879 events in 1,554 blocks across 952 segments, `site.standard.publication` at 17,606 events in 13,087 blocks across 4,825 segments, and `site.standard.document` at 3,901,510 events in 72,091 blocks across 4,127 segments. At the 2 MB/s refill rate, the publication replay alone takes about 34 minutes of quota for about 18k records. bluesky-social/jetstream#192 describes this over-send as inherent to block-granular replay. We include it for the cost numbers, not as a bug.

### 5. Repos that changed PDS before the archive began are missing from it (`npm run coverage:migrated`, `src/coverage-migrated.ts`)

912 DIDs have `site.standard.publication` records on their PDS but no event in the archive. The script draws a seeded sample of 60, plus 20 DIDs that are present in the archive as a control, and looks each one up on the status page and in the PLC audit log.

Recorded run (`results/2026-10-14/coverage_migrated.json`, 14:15 UTC, seed 1):

- 52 of the 60 are backfill `pending`, all with `Last attempted: never`, at the PDS the status page shows.
- 50 of those 52 had left that PDS before the archive began, between 2025-07-25 and 2026-09-30. They moved mostly to eurosky.social (29), blacksky.app (9), selfhosted.social (3), npmx.social (2) and northsky.social (2). For the other 2, the PDS the status page shows is still their current one.
- The other 8 of the 60 are `complete`, at their current PDS.
- All 20 control DIDs are `complete`.

The original investigation drew a different sample of 60 with Python's sampler and found the same pattern: 45 of 60 `pending`, and 42 of those 45 had moved between 2025-09-11 and 2026-10-01. The backfill appears to be stuck on the old host, so these repos only get events they create after 2026-10-02.

### 6. Large Bridgy Fed repos are `complete` but hold a small fraction of their records (`npm run coverage:bridgy`, `src/coverage-bridgy.ts`)

The 8 DIDs in `fixtures/bridgy_partial_dids.txt` all live on `atproto.brid.gy`. The status page shows each as `Backfill: complete`. Its live repo verification shows `Result: Match failure` ("local reconstructed MST root does not match authoritative repo root"), and the local root differs from brid.gy's. Repos that are present in the archive show `Result: Match`, with the same local and authoritative rev and root. So `Match failure` does mark these repos out. We verified this on 2026-10-14 against 5 control repos and `did:plc:wc3uljbzjvw6xqq3b2yoirgf`.

Recorded run (`results/2026-10-14/coverage_bridgy.json`, 14:14 UTC):

| DID | Local records (status page) | `site.standard.document` on brid.gy | Ratio |
|---|---|---|---|
| did:plc:nng24p5wvmvzrtn7w2hoyfdq | 412 | 30,053 | 1.4% |
| did:plc:u7ffgmu5yvsqbhws4xuw4sr3 | 1,284 | 30,353 | 4.2% |
| did:plc:hdmzvl3efru5o76jr6uoz65a | 1,176 | 29,879 | 3.9% |
| did:plc:wc3uljbzjvw6xqq3b2yoirgf | 324 | 29,176 | 1.1% |
| did:plc:avpncyh6y7jvfug6jhvclq3v | 2,286 | 29,983 | 7.6% |
| did:plc:27ynjnbos35i76bn7am3hgdq | 2,090 | 29,809 | 7.0% |
| did:plc:vzwxydbnqygisw42xlddrqfz | 2,580 | 29,731 | 8.7% |
| did:plc:pgcgxp22ajr7fkrrqogsxp2y | 2,096 | 28,474 | 7.4% |

All 8 are `complete` with `Match failure`. For 7 of them the local rev is also behind brid.gy's. For `did:plc:vzwxydbnqygisw42xlddrqfz` the revs are equal but the roots still differ. `com.atproto.sync.getRepo` on brid.gy answers 302 to `bridgy-hubble.microcosm.blue` for all 8, and that host answers `400 {"error":"RepoNotFound","message":"repo not synchronized yet"}`, so a full-repo backfill through it is not possible. Our HappyView archive replay ended with 162–1,141 documents per repo, against about 29,000 on the PDS. (`local records` counts the whole repo, not one collection. The archive-side count, `--archive-count`, needs a key and is not recorded yet.)

## End-to-end runs

`results/happyview-runs.md` compares crawling with archive replay for the same three collections. Those runs were done with HappyView, not with these scripts.

## Requirements

- Node.js 24 or newer. Node runs the `.ts` files directly (type stripping), so there is no build step. We used Node 26.9. There are no runtime dependencies. `npm install` only fetches `typescript` and `@types/node` for `npm run typecheck`.
- Blocks are zstd-compressed. They are decompressed with Node's built-in `zlib.zstdDecompressSync`, so no `zstd` CLI is needed.
- An archive API key for findings 1–4 and `--archive-count`. The archive answers `401 {"error":"invalid bearer credential"}` without one. Findings 5 and 6 (without `--archive-count`) only use public endpoints.

Setup:

```sh
cp .env.example .env     # then put your key in JETSTREAM_API_KEY
npm install
```

`.env` is loaded automatically and is git-ignored. `JETSTREAM_HOST` overrides the archive host (a bare host or an `http(s)://` base URL). `JETSTREAM_STATUS_HOST` overrides the status page host.

Without a key, the scripts that need the archive stop at once with a one-line message pointing at `.env.example`. `npm run overview` still reads the status page. `npm run all` skips the archive scripts and runs the rest.

The key is sent only to the archive host, never to the CDN that a redirect points at. It is never printed or written to disk. Recorded headers drop `authorization`, `set-cookie` and `cookie`. CDN `token=` values are replaced with `REDACTED`, and anything shaped like a key is replaced before a result file is written.

## How to run

```sh
npm run all                    # cheap modes of all six scripts
npm run check                  # same, then a pass/fail table; exit 1 on any FAIL
npm run all -- --costly        # also the costly modes below
npm run all -- --costly --check
npm run all -- --compare results/2026-10-14              # diff headline numbers against a recorded run
npm run all -- --no-run --check --out results/2026-10-14 # re-check recorded JSON without new requests
npm test                       # unit tests: block decoder, redaction
npm run typecheck
```

Each script also runs on its own: `npm run overview`, `quota`, `markers`, `amplification`, `coverage:migrated` and `coverage:bridgy`. Extra arguments go after `--`, for example `npm run quota -- --drain --check`. Every script takes `--check`, `--out DIR`, `--refresh` and `--help`. `listSegments` is cached in `.cache/segments.json`; pass `--refresh` to refetch it.

Quota cost per script, at 1 GB burst and 2 MB/s:

| Script | Cheap mode | Costly mode |
|---|---|---|
| `overview` | ~2 MB (listSegments, 8 pages); 0 with a warm cache | — |
| `quota` | one small plan (KBs) | `--drain`: the full bucket, ~1 GB, without downloading anything. `--follow N`: ~2 MB × N |
| `markers` | plan responses only (KBs to a few MB) | — |
| `amplification` | plan responses only (a few MB) | `--sample N`: ~0.3 MB × N per collection. `--with-document` adds a large plan |
| `coverage:migrated` | 0 (status page + plc.directory, 6 at a time) | `--all`: 912 lookups instead of 60 |
| `coverage:bridgy` | 0 (status page + ~300 listRecords pages per DID on brid.gy) | `--archive-count [N]`: ~0.3 MB per planned block |

`--costly` in `npm run all` means `quota --drain --follow 60`, `amplification --sample 50` and `coverage:bridgy --archive-count 2`. That is several GB of quota.

**Wait for refill.** `quota --drain` needs a full bucket to give a meaningful count, and a drained bucket takes 500 s to refill. `npm run all -- --costly` sleeps 520 s before the drain. When running scripts by hand, wait at least 500 s after any other costly run. After the drain, `--follow`, `--sample` and `--archive-count` run at the 2 MB/s refill rate and wait out 429s using `Retry-After`.

## Checking a fix

`npm run check` runs every assertion against fresh data:

| Script | Assertion |
|---|---|
| archive_overview | archive starts 2026-10-02; >90% of bytes witnessed 2026-10-03..06 |
| quota | refill 2000000 bytes per 1 s, burst 1000000000; with `--drain`: a 429 arrives without following any redirect, and its body is `{"error":"byte limit exceeded"}` |
| marker_plans | 12 h tail plan with 10k DIDs is within 10% of the no-DID plan's bytes; whole-archive 10k-DID plan returns 502 or takes >15 s |
| amplification | more than 10 KB is downloaded per matching event for each collection |
| coverage_migrated | most absent repos are `pending`; most of those left the host Jetstream shows before 2026-10-02; most control repos are `complete` |
| coverage_bridgy | each DID is `complete` + `Match failure`; its archive count (with `--archive-count`) or status-page local records is <10% of the PDS count |

A FAIL means the behaviour changed. That is what a fix looks like for 2, 3, 5 and 6. Finding 1 changes only if the archive is re-imported. A SKIP means the check was not evaluated: a costly mode was not run, or there was no key.

## Methodology

- **Estimated bytes.** Plans list whole segments (`mode:"segment"`) or block ranges (`mode:"blocks"`). A whole segment counts as its `sizeBytes` from `listSegments`. A block counts as `sizeBytes / ceil(eventCount / 4096)` of its segment: the segment's average block, since Jetstream cuts a block every 4,096 events. Actual blocks vary, and sampled downloads (`amplification --sample`) measure them directly. Plan entries for segments sealed after the `listSegments` cache was fetched are counted in `entries_not_in_segment_cache` and excluded from the byte totals. Use `--refresh` to avoid that.
- **Tail windows.** "Last 12 h" is measured back from the newest sealed segment's `maxWitnessedAt`. `afterSeq` is the `maxSeq` of the newest segment that ended before the cutoff, so the window does not depend on how stale the cache is.
- **Plans** are paged the way the Go client pages them: `afterSeq = plannedThroughSeq`, with `beforeSeq` pinned to the first page's `sealedTipSeq`. Latency is wall-clock per page, including network time.
- **Drain.** `quota --drain` cycles `getBlock` over block indexes of the 40 newest segments, 8 at a time. It never follows the 307 and stops at the first 429. Its byte figure is the estimated size of the blocks those redirects point to, not bytes transferred, because nothing is transferred.
- **Event counts in blocks** come from decoding the block body (`src/lib/block.ts`), which uses the documented columnar layout (`event_count`, then `seq`/`witnessed_at`/`indexed_at`/`kind`/length columns, then concatenated collections and DIDs). We count commit kinds (1, 2, 3, 7) whose collection (and, in `coverage:bridgy`, DID) matches. If a block does not decode, the script falls back to counting occurrences of the NSID string in the decompressed bytes. That method is labelled `approx_byte_count` in the output and is approximate.
- **Collection event counts** come from the status page's collections tab (columns: NSID, Events, Segments, Blocks). The tab ignores `collection=` and lists every NSID (~5 MB), so the scripts pick out their rows.
- **Status page** account fields are read as label/value pairs from the HTML. Each account lookup makes the page verify the repo live against its PDS. The page rate-limits that, answering `repo action rate limit exceeded` in place of the verification. `coverage:migrated` records how many lookups lost their verification (`verification_unavailable`); its checks do not use it. `coverage:bridgy` looks DIDs up one at a time and retries rate-limited lookups every 30 s, up to 10 times. `local records` counts the whole repo, not one collection.
- **Migrations** come from the PLC audit log (`https://plc.directory/<did>/log/audit`), skipping nullified operations. "Moved away" is the `createdAt` of the first operation after the last one that pointed at the host the status page shows.
- **Samples** are seeded (`--seed`, default 1) with a small deterministic PRNG (`seededSample` in `src/lib/pool.ts`), so a rerun picks the same DIDs and blocks. They are not the same DIDs that the original Python scripts picked.
- Third parties (status page, plc.directory, brid.gy) get at most 6 concurrent requests.

## Not a Bluesky issue

- **Whole-archive marker sweeps were our mistake.** HappyView followed each collection replay with `account`/`sync` plans over the whole archive. Compaction already removes what those markers supersede, so markers only matter in the uncompacted tail. Those sweeps were about 95% of the 16.4 GB whtwnd run, and the 429s that halted it came from them. We now bound them to the last 12 h. The 502 in finding 3 is still worth knowing about, but a correct client does not hit it.
- **Over-sending rare collections is how block-granular replay works** (bluesky-social/jetstream#192). Finding 4 only puts numbers on it at the hosted quota.

## Layout

```
src/lib/archive.ts   archive XRPC: authed calls, listSegments (+cache), planSnapshot, getBlock, byte estimates
src/lib/status.ts    status page scraping (summary, account lookup, collections table)
src/lib/plc.ts       PLC audit log and PDS history
src/lib/block.ts     block decoder and per-collection counts
src/lib/results.ts   redaction and results/<date>/<name>.json
src/lib/cli.ts       argument parsing and the shared script runner
src/lib/pool.ts      bounded concurrency and seeded sampling
src/lib/http.ts      fetch wrapper (redirects never followed automatically)
src/*.ts             one script per finding, plus run-all.ts
test/                node --test unit tests
```

Each finding script exports `run(opts)`, `checks(result)` and `headline(result)`, and runs itself when invoked directly. `run-all.ts` imports them.

## Fixtures

All public data, taken from our HappyView runs on 2026-10-13/14:

- `fixtures/publication_dids.txt`: the ≈12.4k distinct DIDs with a `site.standard.publication` record in our replay database. `markers` uses the first N.
- `fixtures/publication_absent_from_archive.txt`: 912 DIDs whose publication records exist on their PDS (found by crawling) but have no event in the archive.
- `fixtures/publication_present_in_archive_sample.txt`: a same-size list of DIDs whose publication records are in the archive, used as a control.
- `fixtures/bridgy_partial_dids.txt`: the 8 brid.gy repos with the largest gap between PDS and archive for `site.standard.document`.

`results/2026-10-14/original_*.json` are the raw status-page lookups and PDS hosts from the original investigation.

## Links

- bluesky-social/jetstream#192 (block-granular over-send): https://github.com/bluesky-social/jetstream/issues/192
- bluesky-social/bps-website#32 (default key policy): https://github.com/bluesky-social/bps-website/pull/32, `server/src/apikeys/jetstream-policy.ts`
- Jetstream replay docs: https://bsky.network/docs/jetstream-replay
- Archive status page: https://jetstream.us-east.bsky.network/status
- HappyView replay implementation: https://github.com/gamesgamesgamesgamesgames/happyview, branch `feat/jetstream-replay`, PR #144
