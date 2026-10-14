// Decode archive blocks. Layout (little-endian, columnar; jetstream docs "Block body"):
//
//   u32 event_count
//   seq[] u64, witnessed_at[] i64, indexed_at[] i64, kind[] u8,
//   collection_len[] u8, did_len[] u16, rkey_len[] u8, rev_len[] u8, payload_len[] u32
//   collections, dids, rkeys, revs, payloads (each concatenated)
//
// No trailing bytes are allowed. Payloads are skipped, not decoded.
import { zstdDecompressSync } from "node:zlib";

export type BlockRow = { seq: number; kind: number; collection: string; did: string };

/** Event kinds that carry a record commit (create, update, delete, and kind 7). */
export const COMMIT_KINDS = new Set([1, 2, 3, 7]);

/** Blocks are zstd frames; Node's built-in zlib decompresses them. */
export const decompressBlock = (raw: Uint8Array): Buffer => zstdDecompressSync(raw);

export function decodeBlock(body: Uint8Array): BlockRow[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const n = view.getUint32(0, true);
  let off = 4;

  // Read one fixed-width column of n values (DataView throws on a short buffer).
  const column = (width: 1 | 2 | 4 | 8): number[] => {
    const values: number[] = [];
    for (let i = 0; i < n; i++, off += width) {
      if (width === 1) values.push(view.getUint8(off));
      else if (width === 2) values.push(view.getUint16(off, true));
      else if (width === 4) values.push(view.getUint32(off, true));
      else values.push(Number(view.getBigUint64(off, true)));
    }
    return values;
  };

  const seqs = column(8);
  column(8); // witnessed_at
  column(8); // indexed_at
  const kinds = column(1);
  const collectionLens = column(1);
  const didLens = column(2);
  const rkeyLens = column(1);
  const revLens = column(1);
  const payloadLens = column(4);

  const decoder = new TextDecoder();
  const strings = (lengths: number[]): string[] =>
    lengths.map((len) => {
      if (off + len > body.length) throw new RangeError("block truncated");
      const s = decoder.decode(body.subarray(off, off + len));
      off += len;
      return s;
    });
  const collections = strings(collectionLens);
  const dids = strings(didLens);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  off += sum(rkeyLens) + sum(revLens) + sum(payloadLens);
  if (off !== body.length) throw new Error(`block length mismatch: parsed ${off} of ${body.length} bytes`);

  return seqs.map((seq, i) => ({
    seq,
    kind: kinds[i] as number,
    collection: collections[i] as string,
    did: dids[i] as string,
  }));
}

export type BlockCount = {
  matches: number;
  /** "decoded" = exact; "approx_byte_count" = occurrences of the NSID string (approximate). */
  method: "decoded" | "approx_byte_count";
  events: number | null;
};

/** Count commit events of `collection` (and optionally `did`) in a decompressed block. */
export function countInBlock(body: Uint8Array, collection: string, did?: string): BlockCount {
  try {
    const rows = decodeBlock(body);
    const matches = rows.filter(
      (r) => COMMIT_KINDS.has(r.kind) && r.collection === collection && (did === undefined || r.did === did),
    ).length;
    return { matches, method: "decoded", events: rows.length };
  } catch {
    return { matches: countOccurrences(Buffer.from(body), Buffer.from(collection)), method: "approx_byte_count", events: null };
  }
}

function countOccurrences(haystack: Buffer, needle: Buffer): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}
