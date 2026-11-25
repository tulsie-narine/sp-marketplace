// The ControlMap side of the ScalePad public API: just what the importer needs.
// The transport decides how requests are sent; the marketplace uses scalepad-proxy
// (see src/lib/controlmap-importer-api.ts).
// Requests are serialized at ~9.5 per second to stay under the 50 requests /
// 5 seconds limit, with retry on 429 and 5xx.

import { createHttpClient, HttpError, type Transport } from "./http";

export type CmFramework = { id: number; name: string; total: number };
export type CmClient = { id: string; name: string; frameworks: CmFramework[] };

export type ControlMapClient = ReturnType<typeof createControlMapClient>;

export function createControlMapClient({ transport, sleep }: { transport: Transport; sleep?: (ms: number) => Promise<void> }) {
  const http = createHttpClient({ transport, minIntervalMs: 105, ...(sleep ? { sleep } : {}) });

  return {
    /** Every client with the frameworks it has enabled. */
    async listClients(): Promise<CmClient[]> {
      const out: CmClient[] = [];
      let cursor = "";
      for (let page = 0; page < 100; page++) {
        const body = await http.get(`/clients/health?fields=frameworks&page_size=200&sort=client.name${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        for (const row of body?.data ?? []) {
          out.push({
            id: row.client.id,
            name: row.client.name,
            frameworks: (row.frameworks ?? []).map((f) => ({ id: Number(f.framework_id), name: f.framework_name, total: f.compliance_breakdown?.total ?? 0 })),
          });
        }
        cursor = body?.next_cursor ?? body?.meta?.next_cursor ?? body?.pagination?.next_cursor ?? "";
        if (!cursor) break;
      }
      return out;
    },

    /** Every objective (practices and their sub-objectives) for one client framework, as raw API objects. */
    async listObjectives(clientId: string, frameworkId: number, onProgress?: (loaded: number, total: number) => void) {
      const out: unknown[] = [];
      let cursor = "";
      for (let page = 0; page < 200; page++) {
        const body = await http.post(`/clients/${encodeURIComponent(clientId)}/frameworks/${frameworkId}/objectives/search`, {
          page_size: 200,
          ...(cursor ? { cursor } : {}),
        });
        const objectives = body?.objectives ?? body?.data?.objectives ?? {};
        out.push(...(objectives.data ?? []));
        onProgress?.(out.length, objectives.total_count ?? out.length);
        cursor = objectives.next_cursor ?? "";
        if (!cursor) break;
      }
      return out;
    },

    /** PATCH only the fields given; status is applied last by the API. */
    updateObjective(clientId: string, frameworkId: number, objectiveId: number, body: Record<string, string>) {
      return http.patch(`/clients/${encodeURIComponent(clientId)}/frameworks/${frameworkId}/objectives/${objectiveId}`, body);
    },
  };
}

/** A short, partner-readable reason from an API failure. */
export function describeError(e: unknown): string {
  if (e instanceof HttpError) {
    const b = e.body as { errors?: Array<{ detail?: string; title?: string }>; message?: string; title?: string } | string | null;
    const detail =
      typeof b === "string"
        ? b.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)
        : b?.errors?.[0]?.detail ?? b?.errors?.[0]?.title ?? b?.message ?? b?.title ?? (b && Object.keys(b).length ? JSON.stringify(b).slice(0, 200) : "");
    if (e.status === 401) return "Your ScalePad API key wasn't accepted. Sign out and sign in again with a current key.";
    if (e.status === 429) return "ScalePad is rate limiting requests. Wait a minute and retry the failed rows.";
    if (e.status === 403) return `Your API key isn't allowed to do that (403)${detail ? `: ${detail}` : ""}. It needs read and write access to ControlMap.`;
    return `${e.status}${detail ? `: ${detail}` : ""}`;
  }
  return e instanceof Error ? e.message : String(e);
}
