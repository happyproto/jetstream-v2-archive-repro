# 6. Bridgy Fed repos are mostly empty

Large repos hosted on Bridgy Fed (`atproto.brid.gy`) are marked complete in the archive. Yet the archive's own check of each one fails, and it holds less than 10% of their records.

Run it with `npm run coverage:bridgy` ([`src/coverage-bridgy.ts`](../../src/coverage-bridgy.ts)). Our result is in [`results/2026-10-14/coverage_bridgy.json`](../../results/2026-10-14/coverage_bridgy.json).

## The numbers

We tested the 8 brid.gy repos with the biggest gap between their PDS and the archive. They're listed in [`fixtures/bridgy_partial_dids.txt`](../../fixtures/bridgy_partial_dids.txt).

On the archive's status page, all 8 show `Backfill: complete`. The page also checks each repo live against its PDS. For all 8 that check reports `Result: Match failure`, meaning the archive's copy of the repo doesn't match brid.gy's.

That failure is unusual. Repos the archive holds normally show `Result: Match`. We checked 5 of them by hand on 2026-10-14, along with `did:plc:wc3uljbzjvw6xqq3b2yoirgf`. The scripts can't repeat that check reliably, because the status page limits how often it runs. In our [finding 5](5-migrated-accounts.md) run it refused all 20 comparison accounts.

Our run at 16:32 UTC on 2026-10-14:

| DID | Records the archive reports | Document events in the archive | Documents on brid.gy | Share |
|---|---|---|---|---|
| did:plc:nng24p5wvmvzrtn7w2hoyfdq | 412 | 206 | 30,063 | 0.7% |
| did:plc:u7ffgmu5yvsqbhws4xuw4sr3 | 1,284 | 642 | 30,363 | 2.1% |
| did:plc:hdmzvl3efru5o76jr6uoz65a | 1,176 | not counted | 29,889 | 3.9% |
| did:plc:wc3uljbzjvw6xqq3b2yoirgf | 324 | not counted | 29,186 | 1.1% |
| did:plc:avpncyh6y7jvfug6jhvclq3v | 2,286 | not counted | 30,004 | 7.6% |
| did:plc:27ynjnbos35i76bn7am3hgdq | 2,090 | not counted | 29,819 | 7.0% |
| did:plc:vzwxydbnqygisw42xlddrqfz | 2,600 | not counted | 29,741 | 8.7% |
| did:plc:pgcgxp22ajr7fkrrqogsxp2y | 2,096 | not counted | 28,484 | 7.4% |

"Records the archive reports" is the status page's count for the whole repo, across all collections. "Document events in the archive" is what we found by downloading and decoding the archive's blocks for that repo. That costs a few hundred blocks of quota per repo, so we only did it for the first two. "Share" uses the archive count where we have one, and the reported count otherwise.

For 7 of the 8 repos, the archive's copy is also older than brid.gy's. For `did:plc:vzwxydbnqygisw42xlddrqfz` both are at the same revision, but the contents still differ.

## A possible cause

When we asked brid.gy for each full repo (`com.atproto.sync.getRepo`), it redirected to `bridgy-hubble.microcosm.blue`. That server answered `400 {"error":"RepoNotFound","message":"repo not synchronized yet"}` for all 8. If the archive's import went the same way, it couldn't have fetched these repos.

Our HappyView replay from the archive ended up with 162 to 1,141 documents per repo. Each repo has about 29,000 on brid.gy.

## Running it

```sh
npm run coverage:bridgy -- --check
npm run coverage:bridgy -- --archive-count 2 --check     # also counts events in the archive for 2 repos
```

Without `--archive-count` it uses no quota. It reads the status page and about 300 pages of `listRecords` per repo from brid.gy. `--archive-count N` costs about 0.3 MB per block it downloads.

The checks pass if each repo is complete with a `Match failure`, and the archive has less than 10% of its documents. They would fail once these repos are re-imported, or are no longer marked complete.

This script is slow, because the status page limits how often it checks repos. It looks repos up one at a time, and when it is refused it retries every 30 seconds, up to 10 times.
