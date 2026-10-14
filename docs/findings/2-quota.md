# 2. Quota is charged when a block is requested

Each API key gets a byte quota. Ours allows a 1 GB burst, then refills at 2 MB per second. The quota is charged when you ask `getBlock` for a block, before any data is sent. You pay even if you never download the block.

Run it with `npm run quota` ([`src/quota.ts`](../../src/quota.ts)). Our result is in [`results/2026-10-14/quota.json`](../../results/2026-10-14/quota.json).

## The numbers

Every archive response includes the quota in its headers:

```
headwind-quota-burst-bytes: 1000000000
headwind-quota-refill-bytes: 2000000
headwind-quota-refill-period-seconds: 1
```

We created this key on 2026-10-13.

`getBlock` doesn't return the block itself. It answers with a `307` redirect to a CDN URL, and you download the block from there. We started with a full quota and sent `getBlock` requests, 8 at a time, without ever following a redirect. After 3,235 redirects in 20 seconds, the archive answered `429 {"error":"byte limit exceeded"}` with `Retry-After: 1`. We had downloaded nothing, but the quota was gone.

We don't know exactly how much each redirect costs. Our estimate for those 3,235 blocks is about 1.37 GB, which is more than the 1 GB burst plus 20 seconds of refill. Either a redirect costs less than the full block, or our size estimate is too high ([how we estimate](../reference.md#download-sizes)). The blocks we downloaded for [finding 4](4-rare-collection-over-send.md) were bigger than our estimate, not smaller, which points to the first.

We then followed redirects for 60 seconds and averaged 1.97 MB/s, which is the refill rate.

## Compared with the default

Bluesky's documented default ([`jetstream-policy.ts`](https://github.com/bluesky-social/bps-website/blob/main/server/src/apikeys/jetstream-policy.ts), raised in [bps-website#32](https://github.com/bluesky-social/bps-website/pull/32)) is 100 TiB per 30 days with a 64 GiB burst. That's about 42 MB/s. Our key gets about 1/20 of that rate and 1/64 of that burst.

At 2 MB/s, reading the whole 1.98 TB archive once would take about 11.5 days.

## Running it

```sh
npm run quota -- --check                         # reads the headers only
npm run quota -- --drain --follow 60 --check     # uses the whole quota
```

Reading the headers costs almost nothing. `--drain` uses the full 1 GB without downloading anything. `--follow N` downloads for N seconds, at about 2 MB a second.

Start `--drain` with a full quota. An empty quota takes 500 seconds to refill, so wait at least that long after any other heavy use.

The checks pass if the headers show a 2,000,000-byte refill every second and a 1,000,000,000-byte burst. With `--drain`, they also need a 429 to arrive before any redirect is followed, with the body `{"error":"byte limit exceeded"}`. A change to the key's quota would fail the header checks. Charging on download instead of on redirect would fail the drain checks.
