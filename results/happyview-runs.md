# HappyView runs, 2026-10-13 and 14

The numbers on this page came from [HappyView](https://github.com/gamesgamesgamesgamesgames/happyview), not from the scripts in this repo. We used the `feat/jetstream-replay` branch (PR #144).

We loaded each collection two ways:

- The crawl is HappyView's existing backfill. It asks the relay's `listReposByCollection` which repos have the collection, then reads each repo from its PDS with `listRecords`.
- The archive run is the new replay from the hosted Jetstream v2 archive. Our key allows a 1 GB burst and refills at 2 MB/s.

| Collection | Source | Downloaded | Time | Records | Result |
|---|---|---|---|---|---|
| com.whtwnd.blog.entry | Crawl | 15 MB | 21 s | 5,376 | Finished |
| com.whtwnd.blog.entry | Archive | 16.4 GB | 2 h 10 m | 6,512 | Stopped by 429s during the marker sweep |
| site.standard.publication | Crawl | 38 MB | 4 m | 17,881 | Finished |
| site.standard.publication | Archive | 4.57 GB | 38 m | 16,490 | Stopped by a 502 "upstream unavailable" from planSnapshot |
| site.standard.document | Crawl | 6.84 GB | 1 h 53 m | 5,196,689 | Finished |
| site.standard.document | Archive | 24.1 GB | 4 h 2 m | 3,752,815 | Stopped at seq 25,941,756,527 (2026-10-12) |

Where both sources had the same record, the CIDs almost always matched: 3,175,026 of 3,176,339 for document, and 5,170 of 5,170 for whtwnd.

The crawl missed:

- 407 whtwnd repos that `listReposByCollection` didn't list.
- 1,001 document repos whose PDS answers `listRecords` with a 400. The archive run got 575,806 records from them.

The archive missed:

- 912 publication repos, with 1,438 records, that have no events in the archive. See [finding 5](../docs/findings/5-migrated-accounts.md).
- 502 document repos, with 227,094 records, that have no events in the archive.
- 1.74 million records across 664 document repos, each short by more than 100. The biggest gaps are the brid.gy repos in [finding 6](../docs/findings/6-bridgy-repos.md).

About 95% of the whtwnd archive run's 16.4 GB went on HappyView's whole-archive `account` and `sync` marker sweeps, and those caused its 429s. That was our mistake, explained in [finding 3](../docs/findings/3-marker-plans.md). The publication run stopped on what looks like the same whole-archive 502 that `npm run markers` reproduces.
