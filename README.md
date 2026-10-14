# Jetstream v2 archive: reproductions

We tried to backfill whole collections from Bluesky's hosted Jetstream v2 archive (`jetstream1.us-east.bsky.network`) and hit six problems. This repo has a small script for each one. Run them against the live archive to see whether a problem still happens. Our own results from 2026-10-14 are included for comparison.

## What we found

| # | Finding | Summary |
|---|---|---|
| 1 | [The archive is one bulk import](docs/findings/1-archive-start.md) | The archive starts on 2026-10-02. 98% of its data came from a single import on Oct 3–6, so anything that import missed is still missing. |
| 2 | [Quota is charged when a block is requested](docs/findings/2-quota.md) | Our key is limited to 2 MB/s, about 1/20 of the documented default. Requesting a block uses up quota even if you never download it. |
| 3 | [Filtering by 10,000 DIDs does nothing](docs/findings/3-marker-plans.md) | A plan for 10,000 accounts costs as much as a plan for every account. Over the whole archive, it fails with a 502. |
| 4 | [Small collections are expensive to replay](docs/findings/4-rare-collection-over-send.md) | Each block holds 4,096 events, and a small collection may have only one of them in a block. That works out to 80–300 KB downloaded per record. Bluesky already knows about this ([jetstream#192](https://github.com/bluesky-social/jetstream/issues/192)). |
| 5 | [Accounts that moved PDS are missing](docs/findings/5-migrated-accounts.md) | Accounts that switched to a new PDS before the import never got imported. The archive still lists them as pending on their old PDS. |
| 6 | [Bridgy Fed repos are mostly empty](docs/findings/6-bridgy-repos.md) | Large brid.gy repos are marked complete, but the archive holds less than 10% of their records. |

Findings 1, 5 and 6 are about records the archive doesn't have. Findings 2, 3 and 4 are about why replaying the archive is slow and expensive.

One of the problems was our fault. HappyView used to run finding 3's plans over the entire archive after every replay. That caused most of our downloads and all of our 502 errors. It now only looks at the last 12 hours.

## Running the scripts

You need Node.js 24 or newer. Findings 1–4 also need an archive API key. Findings 5 and 6 work without one.

```sh
cp .env.example .env     # then add your key to JETSTREAM_API_KEY
npm install
npm run check            # runs every script and prints a pass/fail table
```

`npm run check` uses a few MB of your quota. Some tests need much more, such as draining the quota or downloading sample blocks. To include them, run `npm run all -- --costly --check`. That takes about 20 minutes and uses about 1.5 GB of quota. Start it with a full quota, so wait at least 500 seconds after any other heavy use.

Each finding also has its own command, like `npm run quota`. The finding's doc explains how to run it and what it costs.

In the results, PASS means the problem still happens and FAIL means the archive now behaves differently. For findings 2, 3, 5 and 6, a FAIL is what a fix would look like. SKIP means the check needed a key or one of the costly tests.

To compare your run with ours, use `npm run all -- --compare results/2026-10-14`.

## More detail

- [`docs/findings/`](docs/findings/) has one page per finding, with the full numbers and how we measured them.
- [`docs/reference.md`](docs/reference.md) covers configuration, every command, the quota each script uses, what each check tests, how we measured things, and how the code is laid out.
- [`results/2026-10-14/`](results/2026-10-14/) is the raw output from our run.
- [`results/happyview-runs.md`](results/happyview-runs.md) compares full backfills done both ways (crawling each PDS, and replaying the archive) for three collections. We ran those with HappyView, not with these scripts.

## Links

- [bluesky-social/jetstream#192](https://github.com/bluesky-social/jetstream/issues/192) explains why small collections over-download.
- [bluesky-social/bps-website#32](https://github.com/bluesky-social/bps-website/pull/32) and [`jetstream-policy.ts`](https://github.com/bluesky-social/bps-website/blob/main/server/src/apikeys/jetstream-policy.ts) set the default key quota.
- [Jetstream replay docs](https://bsky.network/docs/jetstream-replay)
- [Archive status page](https://jetstream.us-east.bsky.network/status)
- [HappyView](https://github.com/gamesgamesgamesgamesgames/happyview) is the AppView we were building when we found these problems. The replay code is on the `feat/jetstream-replay` branch, PR #144.
