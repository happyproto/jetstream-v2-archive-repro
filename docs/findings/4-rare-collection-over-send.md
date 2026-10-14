# 4. Small collections are expensive to replay

The archive stores events in blocks of 4,096, in the order they happened. To replay one collection, you download every block that holds at least one of its events. For a small collection, that usually means a whole block for one or two events.

Bluesky already describes this as expected behaviour in [jetstream#192](https://github.com/bluesky-social/jetstream/issues/192). We include it to show what it costs at our quota, not to report a bug.

Run it with `npm run amplification` ([`src/amplification.ts`](../../src/amplification.ts)). Our result is in [`results/2026-10-14/amplification.json`](../../results/2026-10-14/amplification.json).

## The numbers

Across the whole archive, a compressed block averages about 311 KB. The blocks these collections need are bigger. In 50 sample blocks per collection, they averaged 349 KB for whtwnd and 387 KB for publication.

| Collection | Events | Blocks | Estimated download | Per event (estimated) | Per event (measured) |
|---|---|---|---|---|---|
| `com.whtwnd.blog.entry` | 6,882 | 1,555 | 0.56 GB | 81 KB | 143 KB |
| `site.standard.publication` | 17,596 | 13,081 | 4.25 GB | 242 KB | 293 KB |
| `site.standard.document` | 3.90M | 71,800 | 22 GB | 5.7 KB | not measured |

The event counts come from the archive's status page. The estimated columns divide the plan's estimated size by that count. The measured column comes from 50 blocks we downloaded and decoded, dividing the bytes by the matching events we found. The middle block in that sample held a single matching event.

The `site.standard.document` row is from an earlier test the same day. The script only includes that collection if you pass `--with-document`.

At 2 MB/s ([finding 2](2-quota.md)), replaying `site.standard.publication` alone uses 35–45 minutes of quota to get about 18,000 records.

## Running it

```sh
npm run amplification -- --check                 # plans only
npm run amplification -- --sample 50 --check     # also downloads 50 blocks per collection
```

Plans alone use a few MB of quota. `--sample N` downloads about 0.3 MB for each of N blocks, per collection. `--with-document` adds a large plan.

The check passes if each collection costs more than 10 KB of download per event.
