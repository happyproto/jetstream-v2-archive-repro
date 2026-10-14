// Small formatting helpers shared by the scripts.

export const round = (n: number, digits = 0) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Microseconds since the epoch -> "YYYY-MM-DDTHH:MM:SSZ". */
export const usToIso = (us: number) => new Date(us / 1000).toISOString().replace(/\.\d+Z$/, "Z");

/** Microseconds since the epoch -> UTC day "YYYY-MM-DD". */
export const usToDay = (us: number) => usToIso(us).slice(0, 10);

/** "1,234" -> 1234; anything unparseable -> null. */
export function parseIntLoose(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/,/g, "").trim();
  return /^-?\d+$/.test(t) ? Number(t) : null;
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const gb = (bytes: number) => (bytes / 1e9).toFixed(2);

/** Count occurrences of each key, most common first (like Python's Counter.most_common). */
export function countBy<T>(items: T[], key: (item: T) => string | null | undefined): Record<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = String(key(item) ?? "null");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
}
