// PLC directory helpers: which PDS a DID pointed at, and when it moved.
import { PLC_HOST } from "./config.ts";
import { errorText, fetchPublic, jsonOf, textOf } from "./http.ts";

/** One entry of https://plc.directory/<did>/log/audit (only the fields we read). */
export type AuditEntry = {
  createdAt: string;
  nullified?: boolean;
  operation: {
    type?: string;
    service?: string; // legacy create op
    services?: { atproto_pds?: { endpoint?: string } };
  };
};

/** [createdAt, PDS host] pairs. */
export type PdsHistory = [string, string][];

export async function plcAudit(did: string): Promise<{ audit: AuditEntry[] | null; error: string | null }> {
  if (!did.startsWith("did:plc:")) return { audit: null, error: "not a did:plc" };
  try {
    const r = await fetchPublic(`https://${PLC_HOST}/${did}/log/audit`, { timeoutMs: 60_000 });
    if (r.status !== 200) return { audit: null, error: `${r.status} ${textOf(r, 120)}` };
    return { audit: jsonOf<AuditEntry[]>(r), error: null };
  } catch (err) {
    return { audit: null, error: errorText(err, 120) };
  }
}

function pdsHost(entry: AuditEntry): string | null {
  const endpoint = entry.operation?.services?.atproto_pds?.endpoint || entry.operation?.service;
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

/** PDS hosts over time, skipping nullified ops and collapsing repeats. */
export function pdsHistory(audit: AuditEntry[] | null): PdsHistory {
  const out: PdsHistory = [];
  for (const entry of audit ?? []) {
    if (entry.nullified) continue;
    let host = pdsHost(entry);
    if (host === null && entry.operation?.type === "plc_tombstone") host = "(tombstoned)";
    if (host && out.at(-1)?.[1] !== host) out.push([entry.createdAt, host]);
  }
  return out;
}

/**
 * When the DID last left `host`: the first entry after its last entry on `host`.
 * Null if it is still there or never was.
 */
export function movedAwayFrom(history: PdsHistory, host: string): [string, string] | null {
  const last = history.findLastIndex(([, h]) => h === host);
  if (last === -1 || last === history.length - 1) return null;
  return history[last + 1] ?? null;
}
