# HappyView end-to-end runs (2026-10-13/14)

**These numbers were produced by HappyView, not by the scripts in this repo.** HappyView: https://github.com/gamesgamesgamesgamesgames/happyview, branch `feat/jetstream-replay` (PR #144). "Crawl" is HappyView's existing backfill: it lists repos via the relay's `listReposByCollection` and reads each PDS with `listRecords`. "Archive" is the new replay from the hosted Jetstream v2 archive, using a key with a 1 GB burst and 2 MB/s refill.

| Collection | Source | Bytes | Wall | Records | Outcome |
|---|---|---|---|---|---|
| com.whtwnd.blog.entry | Crawl | 15 MB | 21 s | 5,376 | Complete |
| com.whtwnd.blog.entry | Archive | 16.4 GB | 2 h 10 m | 6,512 | Halted in the marker sweep (429s) |
| site.standard.publication | Crawl | 38 MB | 4 m | 17,881 | Complete |
| site.standard.publication | Archive | 4.57 GB | 38 m | 16,490 | Halted: planSnapshot 502 upstream unavailable |
| site.standard.document | Crawl | 6.84 GB | 1 h 53 m | 5,196,689 | Complete |
| site.standard.document | Archive | 24.1 GB | 4 h 2 m | 3,752,815 | Halted at seq 25,941,756,527 (2026-10-12) |

Records present in both sources had matching CIDs: 3,175,026 of 3,176,339 for document, and 5,170 of 5,170 for whtwnd.

Missed by the crawl:

- 407 whtwnd repos that the relay's `listReposByCollection` did not list.
- 1,001 document repos whose PDS returns 400 to `listRecords`. Replay recovered 575,806 records from them.

Missed by the archive:

- 912 publication repos (1,438 records) with no event at all. See `npm run coverage:migrated`.
- 502 document repos (227,094 records) with no event at all.
- 664 document repos short by more than 100 records each, 1.74M records in total. The largest gaps are the brid.gy repos in `npm run coverage:bridgy`.

The whtwnd archive run's 429s came from HappyView's whole-archive account/sync marker sweeps, about 95% of its 16.4 GB. That was our mistake (see README, "Not a Bluesky issue"). The publication run's halt looks like the same whole-archive 502 that `npm run markers` reproduces.
