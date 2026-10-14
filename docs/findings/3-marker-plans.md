# 3. Filtering by 10,000 DIDs does nothing

You can ask the archive to plan a download of `account` and `sync` events for a list of accounts (DIDs). With 10,000 DIDs, the plan is as big as one with no filter at all. Run over the whole archive, the same plan fails with a 502.

Run it with `npm run markers` ([`src/marker-plans.ts`](../../src/marker-plans.ts)). Our result is in [`results/2026-10-14/marker_plans.json`](../../results/2026-10-14/marker_plans.json).

## The numbers

We called `planSnapshot` with `kinds:["account","sync"]` for the last 12 hours. Each plan used the first N DIDs from [`fixtures/publication_dids.txt`](../../fixtures/publication_dids.txt).

| DIDs | What the plan returned | Estimated download |
|---|---|---|
| none | 748 blocks + 7 whole segments | 1.84 GB |
| 10,000 | 740 blocks + 7 whole segments | 1.83 GB |
| 1,000 | 2,782 blocks + 1 whole segment | 1.30 GB |
| 100 | 638 blocks | 0.28 GB |
| 10 | 48 blocks | 0.02 GB |

At 10,000 DIDs the plan is within 1% of the unfiltered one. Each block has a small filter (a bloom filter) for checking whether an account appears in it. With 10,000 accounts, almost every block matches, so the filter removes nothing.

We ran the 10,000-DID plan over the whole archive instead of 12 hours. It answered `502 {"error":"upstream unavailable"}` after about 30 seconds, every time we tried.

The 12-hour window moves forward as the archive grows, so these numbers shift a little between runs.

## This one was partly our fault

HappyView used to run this plan over the whole archive after replaying each collection. It didn't need to. The archive regularly deletes records that a later `account` or `sync` event cancels out, so only the most recent hours need checking. Those plans caused about 95% of a 16.4 GB run. HappyView now only checks the last 12 hours, so it no longer hits the 502.

## Running it

```sh
npm run markers -- --check
```

It only fetches plans and downloads no blocks, so it uses between a few KB and a few MB of quota.

The checks pass if the 10,000-DID plan is within 10% of the unfiltered plan, and the whole-archive plan returns a 502 or takes more than 15 seconds. They would fail if filtering started removing blocks at 10,000 DIDs, or if the whole-archive plan answered quickly.
