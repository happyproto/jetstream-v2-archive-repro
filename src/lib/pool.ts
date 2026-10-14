// Bounded concurrency without dependencies.
import { POLITE_CONCURRENCY } from "./config.ts";

/** Map `items` through `fn` with at most `limit` calls in flight. Keeps input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit = POLITE_CONCURRENCY,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Run `n` copies of `worker` concurrently and wait for all of them. */
export async function runWorkers(n: number, worker: () => Promise<void>): Promise<void> {
  await Promise.all(Array.from({ length: n }, worker));
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Deterministic PRNG (mulberry32) so samples are repeatable for a given seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded random sample of `n` items without replacement (all items if n >= length). */
export function seededSample<T>(items: readonly T[], n: number, seed: number): T[] {
  if (n >= items.length) return [...items];
  const copy = [...items];
  const rand = rng(seed);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy.slice(0, n);
}
