# Re-run, 2026-11-18

The full `npm run check` suite, re-run a month after the original, with a new API key. Jetstream reported v0.4.6 (commit a0d1212), up from v0.4.4. Compare with `npm run all -- --no-run --compare results/2026-10-14 --out results/2026-11-18`.

Every finding still reproduces:

| # | Finding | 2026-10-14 | 2026-11-18 |
|---|---|---|---|
| 1 | One bulk import | starts 2026-10-02; Oct 3–6 = 98.3% of 1.98 TB | starts 2026-10-02; Oct 3–6 = 92.4% of 2.10 TB (≈3.4 GB/day since) |
| 2 | Quota | 1 GB burst, 2 MB/s refill | unchanged (a new key, the same quota) |
| 3 | DID filtering | the 10k-DID plan = the no-DID plan; whole archive 502 | the 10k-DID plan = the no-DID plan (2.31 GB each); whole archive 502 after 30 s |
| 4 | Small collections | whtwnd 81 KB/event, publication 242 KB/event | whtwnd 165 KB/event, publication 253 KB/event |
| 5 | Migrated accounts | 52/60 absent repos pending | 52/60 pending |
| 6 | Bridgy Fed repos | complete, under 10% of records | complete, about 1–7% of records |

The drain and block-sample checks (`--costly`) weren't run.

## A large collection: `app.bsky.actor.profile`

`profile_plan.json` is a single `planSnapshot` for `app.bsky.actor.profile` (commits only), run with an ad hoc script, not one of the repo's commands.

- Status page: 41,437,105 events in 5,681,273 blocks across 8,046 of 8,047 segments.
- Plan: 6,220 whole segments plus 1,007,880 blocks, an estimated **1.93 TB**, which is 92% of the archive.
- At our key's 2 MB/s that is about **11.2 days** of quota. At the documented default (about 42 MB/s) it would be about 12.8 hours.

A common collection that every account writes touches nearly every block, so for it the cost is the whole archive.
