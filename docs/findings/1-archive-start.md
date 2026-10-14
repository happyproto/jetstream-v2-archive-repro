# 1. The archive is one bulk import

The archive starts on 2026-10-02. Almost all of it came from one import that ran from Oct 3 to Oct 6. Since then it has only added new events as they happen.

Run it with `npm run overview` ([`src/archive-overview.ts`](../../src/archive-overview.ts)). Our result is in [`results/2026-10-14/archive_overview.json`](../../results/2026-10-14/archive_overview.json).

## The numbers

`listSegments` lists 7,443 segments, holding 25.82 billion events and 1.978 TB. The first one was recorded at 2026-10-02 20:53:35 UTC.

The segments recorded between Oct 3 and Oct 6 hold 25.48 billion events and 1.945 TB, which is 98.3% of the archive. Since then the archive has grown by about 35 million events (3.5 GB) a day.

The status page changed during our run on 2026-10-14. In the morning it reported version `v0.4.2 (commit f582c11)`. By 14:15 UTC it reported `v0.4.4 (commit d4db8c0)`. At 16:14 UTC it showed 25,823,086,362 events, starting at 2026-10-02 20:53:35, and a cursor lookback of 1 day 12 hours.

This explains findings [5](5-migrated-accounts.md) and [6](6-bridgy-repos.md). If the import missed a repo's older records, nothing adds them later. Only new events reach the archive.

## Running it

```sh
npm run overview -- --check
```

It uses about 2 MB of quota to fetch the segment list, or none if the list is already cached. The status page part works without a key.

The check passes if the archive starts on 2026-10-02 and more than 90% of its data was recorded on Oct 3–6. That would only change if Bluesky re-imported the archive.
