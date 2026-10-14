// The block decoder against a hand-built block (layout in src/lib/block.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";
import { countInBlock, decodeBlock, decompressBlock } from "../src/lib/block.ts";

type Ev = { seq: number; kind: number; collection: string; did: string; rkey: string; rev: string; payload: string };

/** Encode events with the documented columnar layout. */
function buildBlock(events: Ev[]): Buffer {
  const n = events.length;
  const head = Buffer.alloc(4 + n * (8 + 8 + 8 + 1 + 1 + 2 + 1 + 1 + 4));
  let off = head.writeUInt32LE(n, 0);
  for (const e of events) off = head.writeBigUInt64LE(BigInt(e.seq), off);
  for (const e of events) off = head.writeBigInt64LE(BigInt(e.seq) * 1000n, off); // witnessed_at
  for (const _ of events) off = head.writeBigInt64LE(0n, off); // indexed_at
  for (const e of events) off = head.writeUInt8(e.kind, off);
  for (const e of events) off = head.writeUInt8(Buffer.byteLength(e.collection), off);
  for (const e of events) off = head.writeUInt16LE(Buffer.byteLength(e.did), off);
  for (const e of events) off = head.writeUInt8(Buffer.byteLength(e.rkey), off);
  for (const e of events) off = head.writeUInt8(Buffer.byteLength(e.rev), off);
  for (const e of events) off = head.writeUInt32LE(Buffer.byteLength(e.payload), off);
  const tail = (["collection", "did", "rkey", "rev", "payload"] as const).flatMap((k) => events.map((e) => Buffer.from(e[k])));
  return Buffer.concat([head, ...tail]);
}

const A = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const DOC = "site.standard.document";
const EVENTS: Ev[] = [
  { seq: 25_941_756_527, kind: 1, collection: DOC, did: A, rkey: "3k1", rev: "r1", payload: "cbor-1" },
  { seq: 25_941_756_528, kind: 4, collection: "", did: A, rkey: "", rev: "", payload: "identity" },
  { seq: 25_941_756_529, kind: 2, collection: DOC, did: B, rkey: "3k2", rev: "r2", payload: "cbor-2" },
  { seq: 25_941_756_530, kind: 3, collection: DOC, did: A, rkey: "3k1", rev: "r3", payload: "" },
  { seq: 25_941_756_531, kind: 1, collection: "app.bsky.feed.post", did: A, rkey: "3k3", rev: "r4", payload: `mentions ${DOC}` },
];

test("decodes seq, kind, collection and did per event", () => {
  const rows = decodeBlock(buildBlock(EVENTS));
  assert.deepEqual(rows, EVENTS.map(({ seq, kind, collection, did }) => ({ seq, kind, collection, did })));
});

test("counts commit events of a collection, optionally for one DID", () => {
  const body = buildBlock(EVENTS);
  assert.deepEqual(countInBlock(body, DOC), { matches: 3, method: "decoded", events: 5 });
  assert.equal(countInBlock(body, DOC, A).matches, 2);
  assert.equal(countInBlock(body, DOC, B).matches, 1);
});

test("an empty (compacted) block is 4 zero bytes", () => {
  assert.deepEqual(decodeBlock(Buffer.alloc(4)), []);
});

test("trailing or missing bytes are rejected, and counting falls back to a labelled byte count", () => {
  const body = buildBlock(EVENTS);
  assert.throws(() => decodeBlock(Buffer.concat([body, Buffer.from([0])])), /length mismatch/);
  assert.throws(() => decodeBlock(body.subarray(0, body.length - 3)));
  // The fallback counts every occurrence of the NSID string, including the one in a payload.
  const approx = countInBlock(Buffer.concat([body, Buffer.from([0])]), DOC);
  assert.deepEqual(approx, { matches: 4, method: "approx_byte_count", events: null });
});

test("zstd round trip through node:zlib", () => {
  const body = buildBlock(EVENTS);
  assert.deepEqual(decodeBlock(decompressBlock(zstdCompressSync(body))), decodeBlock(body));
});
