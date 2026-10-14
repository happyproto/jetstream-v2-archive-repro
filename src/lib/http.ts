// Plain `fetch` wrapper. Redirects are never followed automatically, so the
// scripts can see (and record) 3xx responses such as getBlock's 307.
import { USER_AGENT } from "./config.ts";
import { redactHeaders, redactUrl, scrubText } from "./results.ts";
import { sleep } from "./pool.ts";

export type Resp = {
  status: number;
  /** Lower-case names; authorization/set-cookie removed; Location token redacted. */
  headers: Record<string, string>;
  body: Uint8Array;
  elapsedS: number;
  /** Request URL with any token= value redacted. */
  url: string;
};

export type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  /** JSON-encoded when not a string. */
  body?: unknown;
  timeoutMs?: number;
  /** Read at most this many body bytes, then drop the connection. */
  maxBody?: number;
};

export async function request(url: string, opts: RequestOptions = {}): Promise<Resp> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT, ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    headers["content-type"] ??= "application/json";
  }
  const started = performance.now();
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
  });
  const bytes = await readBody(res, opts.maxBody);
  return {
    status: res.status,
    headers: redactHeaders(res.headers),
    body: bytes,
    elapsedS: (performance.now() - started) / 1000,
    url: redactUrl(url),
  };
}

async function readBody(res: Response, maxBody?: number): Promise<Uint8Array> {
  if (!maxBody || !res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBody) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, maxBody);
}

/** Unauthenticated GET (third parties). Retries transport errors only, not HTTP errors. */
export async function fetchPublic(url: string, opts: RequestOptions = {}, retries = 3): Promise<Resp> {
  let last: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await request(url, { timeoutMs: 120_000, ...opts });
    } catch (err) {
      last = err;
      await sleep(1000 + i * 2000);
    }
  }
  throw last;
}

/** Response body as text, scrubbed, truncated to `limit` bytes. */
export function textOf(r: Resp, limit = 2000): string {
  return scrubText(Buffer.from(r.body.subarray(0, limit)).toString("utf8"));
}

export function jsonOf<T>(r: Resp): T {
  return JSON.parse(Buffer.from(r.body).toString("utf8")) as T;
}

export const isRedirect = (status: number) => [301, 302, 303, 307, 308].includes(status);

export function errorText(err: unknown, limit = 200): string {
  const e = err as { name?: string; message?: string; cause?: { message?: string } };
  const msg = `${e?.name ?? "Error"}: ${e?.message ?? String(err)}${e?.cause?.message ? ` (${e.cause.message})` : ""}`;
  return msg.slice(0, limit);
}
