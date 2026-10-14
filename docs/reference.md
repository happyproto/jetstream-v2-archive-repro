# Reference

The details the [README](../README.md) skips. The findings themselves are in [`findings/`](findings/).

## Requirements

You need Node.js 24 or newer; we used 26.9. Node runs the `.ts` files directly, so there's no build step. Nothing else is needed at runtime. `npm install` only adds `typescript` and `@types/node`, for `npm run typecheck`.

Archive blocks are compressed with zstd. Node's built-in `zlib.zstdDecompressSync` handles them, so you don't need the `zstd` command.

Findings 1–4 need an archive API key, and so does the `--archive-count` option. Without a key the archive answers `401 {"error":"invalid bearer credential"}`. Findings 5 and 6 only use public endpoints.

## Configuration

Settings go in `.env`, which is loaded automatically and ignored by git. Copy [`.env.example`](../.env.example) to start.

| Variable | What it does |
|---|---|
| `JETSTREAM_API_KEY` | Your archive API key. |
| `JETSTREAM_HOST` | The archive host, as a bare host name or an `http(s)://` URL. Defaults to `jetstream1.us-east.bsky.network`. |
| `JETSTREAM_STATUS_HOST` | The status page host. Defaults to `jetstream.us-east.bsky.network`. |

Without a key, the scripts that need the archive stop right away and point you to `.env.example`. `npm run overview` still reads the status page, and `npm run all` runs everything that doesn't need a key.

The key is only ever sent to the archive host. The CDN that blocks redirect to never sees it, and it isn't printed or saved. Saved results leave out the `authorization`, `set-cookie` and `cookie` headers. CDN `token=` values are replaced with `REDACTED`, and anything that looks like a key is removed before a result is written.

## Commands

```sh
npm run all                    # run every script, skipping the expensive tests
npm run check                  # the same, then print a pass/fail table (exits 1 on any FAIL)
npm run all -- --costly        # also run the expensive tests
npm run all -- --costly --check
npm run all -- --compare results/2026-10-14              # compare key numbers with our run
npm run all -- --no-run --check --out results/2026-10-14 # re-check saved results without new requests
npm test                       # unit tests for the block decoder and redaction
npm run typecheck
```

Each finding has its own command: `npm run overview`, `quota`, `markers`, `amplification`, `coverage:migrated` and `coverage:bridgy`. Put extra options after `--`, as in `npm run quota -- --drain --check`.

Every script accepts `--check`, `--out DIR`, `--refresh` and `--help`. Results go to `results/<UTC date>/<name>.json` unless you pass `--out`. The segment list is cached in `.cache/segments.json`; `--refresh` fetches it again.

## Quota use

Our key allows a 1 GB burst and refills at 2 MB/s.

| Script | Normal run | Expensive options |
|---|---|---|
| `overview` | About 2 MB for the segment list, or none once it's cached. | None. |
| `quota` | One small plan, a few KB. | `--drain` uses the whole 1 GB without downloading anything. `--follow N` uses about 2 MB a second for N seconds. |
| `markers` | Plans only, a few KB to a few MB. | None. |
| `amplification` | Plans only, a few MB. | `--sample N` downloads about 0.3 MB per block, N blocks per collection. `--with-document` adds a large plan. |
| `coverage:migrated` | None. It uses the status page and plc.directory. | `--all` checks all 912 accounts instead of 60. |
| `coverage:bridgy` | None. It uses the status page and brid.gy. | `--archive-count N` uses about 0.3 MB per block downloaded. |

In `npm run all`, `--costly` adds `quota --drain --follow 60`, `amplification --sample 50` and `coverage:bridgy --archive-count 2`. Our run with it used about 1.5 GB.

`quota --drain` only gives a useful count if the quota is full when it starts. An empty quota takes 500 seconds to refill, so `npm run all -- --costly` waits 520 seconds before draining. If you run scripts by hand, wait at least 500 seconds after any other heavy use. The download steps after the drain run at the 2 MB/s refill rate and pause whenever they get a 429.

## Checks

`npm run check` tests each claim against fresh data:

| Script | Passes when |
|---|---|
| archive_overview | The archive starts on 2026-10-02, and more than 90% of its data was recorded on Oct 3–6. |
| quota | The headers show a 2,000,000-byte refill per second and a 1,000,000,000-byte burst. With `--drain`, a 429 with the body `{"error":"byte limit exceeded"}` arrives before any redirect is followed. |
| marker_plans | Over the last 12 hours, the 10,000-DID plan is within 10% of the unfiltered plan. Over the whole archive, the 10,000-DID plan returns a 502 or takes more than 15 seconds. |
| amplification | Each collection costs more than 10 KB of download per matching event. |
| coverage_migrated | Most missing accounts are pending, most of those left their listed PDS before 2026-10-02, and most comparison accounts are complete. |
| coverage_bridgy | Each repo is complete with a `Match failure`, and the archive holds less than 10% of its documents. |

PASS means the problem still happens. FAIL means the archive now behaves differently, and for findings 2, 3, 5 and 6 that's what a fix would look like. Finding 1 would only change if the archive were re-imported. SKIP means the check didn't run because it needed a key or an expensive option.

## How we measured

### Download sizes

A plan lists either whole segments or ranges of blocks. A whole segment counts as its `sizeBytes` from `listSegments`.

We don't know each block's size until we download it. So we estimate it as the segment's size divided by its number of blocks, `ceil(eventCount / 4096)`. Real blocks vary. In our run, the sample blocks were 12–24% bigger than this estimate, so our estimated totals are probably low.

If a plan includes a segment newer than the cached segment list, it's counted in `entries_not_in_segment_cache` and left out of the totals. `--refresh` avoids that.

### The 12-hour window

"Last 12 hours" counts back from the newest segment's `maxWitnessedAt`. The plan starts after the newest segment that ended before that point. That keeps the window the same even if the cached segment list is old.

### Plans

Plans are paged the same way Bluesky's Go client pages them. Each page starts at the previous page's `plannedThroughSeq`, and every page ends at the first page's `sealedTipSeq`. Timings are per page and include network time.

### The drain test

`quota --drain` requests blocks from the 40 newest segments, 8 at a time. It never follows a redirect, and it stops at the first 429. Its byte total is our estimate of the blocks it was redirected to, since nothing is downloaded.

### Counting events in a block

[`src/lib/block.ts`](../src/lib/block.ts) decodes blocks using the layout in Jetstream's docs. A block starts with an event count. Columns for each event's sequence number, timestamps, kind and lengths come next, and then all the collection names and DIDs.

We count commit events (kinds 1, 2, 3 and 7) whose collection matches. In `coverage:bridgy` the DID has to match too. If a block won't decode, the script instead counts how often the collection name appears in the raw bytes. The output labels that method `approx_byte_count`, because it's only an approximation.

### Collection counts

Event counts per collection come from the status page's collections tab. Its columns are NSID, Events, Segments and Blocks. The tab ignores its `collection=` parameter and returns every collection, about 5 MB, so the scripts find the rows they need.

### Status page lookups

Account details are read from the status page's HTML. Each lookup also makes the archive check the repo against its PDS. The page limits how often it will do that, and when it refuses it shows `repo action rate limit exceeded` in place of the result.

`coverage:migrated` counts those refusals in `verification_unavailable`, and its checks don't depend on them. `coverage:bridgy` looks repos up one at a time and retries a refusal every 30 seconds, up to 10 times. The page's "local records" count covers the whole repo, not one collection.

### Account moves

PDS history comes from each account's PLC audit log (`https://plc.directory/<did>/log/audit`), skipping cancelled (nullified) entries. The move date is the first entry after the last one that pointed at the PDS the status page lists.

### Samples

Random samples use a fixed seed (`--seed`, default 1) and a small random-number generator (`seededSample` in [`src/lib/pool.ts`](../src/lib/pool.ts)). A rerun picks the same accounts and blocks. These aren't the same ones our earlier Python scripts picked.

### Load on other services

The scripts send at most 6 requests at a time to the status page, plc.directory and brid.gy.

## Code layout

```
src/lib/archive.ts   archive API calls, the segment list and its cache, plans, blocks, size estimates
src/lib/status.ts    reading the status page (summary, accounts, collections)
src/lib/plc.ts       PLC audit logs and PDS history
src/lib/block.ts     decoding blocks and counting events
src/lib/results.ts   removing secrets and writing results/<date>/<name>.json
src/lib/cli.ts       option parsing and the shared script runner
src/lib/pool.ts      limiting concurrent requests, and seeded sampling
src/lib/http.ts      fetch wrapper that never follows redirects on its own
src/*.ts             one script per finding, plus run-all.ts
test/                unit tests (node --test)
docs/                this file and one page per finding
```

Each finding script exports `run(opts)`, `checks(result)` and `headline(result)`, and runs itself when called directly. `run-all.ts` imports all of them.

## Fixtures

All of these are public data, taken from our HappyView runs on 2026-10-13 and 2026-10-14.

| File | Contents |
|---|---|
| [`publication_dids.txt`](../fixtures/publication_dids.txt) | About 12,400 DIDs with a `site.standard.publication` record in our replay. `markers` uses the first N. |
| [`publication_absent_from_archive.txt`](../fixtures/publication_absent_from_archive.txt) | 912 DIDs whose publication records are on their PDS, but which have no events in the archive. |
| [`publication_present_in_archive_sample.txt`](../fixtures/publication_present_in_archive_sample.txt) | DIDs whose publication records are in the archive, used for comparison. |
| [`bridgy_partial_dids.txt`](../fixtures/bridgy_partial_dids.txt) | The 8 brid.gy repos with the biggest gap between their PDS and the archive for `site.standard.document`. |

`results/2026-10-14/original_*.json` holds the raw status-page lookups and PDS history from our first investigation.
