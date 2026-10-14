# 5. Accounts that moved PDS are missing

Some accounts moved to a new PDS before the archive's import. Their records never made it into the archive. The archive still lists them as "pending" on the PDS they left, and it has never tried to import them.

Run it with `npm run coverage:migrated` ([`src/coverage-migrated.ts`](../../src/coverage-migrated.ts)). Our result is in [`results/2026-10-14/coverage_migrated.json`](../../results/2026-10-14/coverage_migrated.json).

## The numbers

We found 912 accounts that have `site.standard.publication` records on their PDS but no events in the archive. They're listed in [`fixtures/publication_absent_from_archive.txt`](../../fixtures/publication_absent_from_archive.txt).

The script picks 60 of them at random, using a fixed seed so every run picks the same 60. For comparison it also checks 20 accounts that are in the archive. For each account it reads the archive's status page and the account's PLC history, which shows every PDS the account has used.

Our run at 16:25 UTC on 2026-10-14 found:

- 52 of the 60 are "pending" and show `Last attempted: never`.
- 50 of those 52 had already left the PDS the archive lists, between 2025-07-25 and 2026-09-30. Most went to eurosky.social (29) or blacksky.app (9). A few went to selfhosted.social (3), npmx.social (2) or northsky.social (2). The other 2 still use the PDS the archive lists.
- The other 8 of the 60 are marked complete, at their current PDS.
- All 20 comparison accounts are complete.

An earlier run at 14:15 UTC gave the same counts.

Our first investigation picked a different 60 and found the same pattern. 45 of them were pending, and 42 of those had moved between 2025-09-11 and 2026-10-01. That data is in [`original_status_lookups_absent_sample.json`](../../results/2026-10-14/original_status_lookups_absent_sample.json) and [`original_plc_hosts.json`](../../results/2026-10-14/original_plc_hosts.json).

The archive seems to be stuck trying the old PDS. These accounts only get records they create after 2026-10-02.

## Running it

```sh
npm run coverage:migrated -- --check
npm run coverage:migrated -- --all --check     # checks all 912 instead of 60
```

It uses no quota. It reads the status page and plc.directory, at most 6 requests at a time.

The checks pass if most missing accounts are pending, most of those moved before 2026-10-02, and most comparison accounts are complete. Once Bluesky imports these accounts, the first two checks will fail.

Each status-page lookup also makes the archive check the account against its PDS, and the page limits how often it will do that. When it refuses, the lookup has no check result. The output counts these in `verification_unavailable`. The checks don't depend on them.
