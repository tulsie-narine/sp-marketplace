/**
 * Client Clean Up API helpers.
 * All calls proxied through the scalepad-proxy edge function.
 */

import { supabase } from "@/integrations/supabase/client";

const DELAY_MS = 120;

function clientFilter(clientId: string) {
  // LMX v1 accepts the exact client identifier here. The documented eq:
  // prefix currently returns "ClientId does not exist" for these collections.
  return encodeURIComponent(clientId);
}

// ---- Types ----

export interface CleanupClient {
  id: string;
  coreId?: string;
  name: string;
  lifecycle: string;
  num_hardware_assets: number;
}

export type SectionType =
  | "initiatives"
  | "goals"
  | "meetings"
  | "actionItems"
  | "notes"
  | "assessments"
  | "contracts"
  | "deliverables";

export type SectionStatus =
  | "pending"
  | "running"
  | "success"
  | "partial"
  | "failed"
  | "skipped";

export interface SectionProgress {
  type: SectionType;
  label: string;
  status: SectionStatus;
  deleted: number;
  total: number;
}

export interface ClientProgress {
  clientId: string;
  clientName: string;
  sections: SectionProgress[];
}

export interface CleanupError {
  clientName: string;
  section: string;
  recordId: string;
  errorCode: string;
  errorDetail: string;
}

// ---- Internal helpers ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function proxyCall(
  apiKey: string,
  endpoint: string,
  method = "GET",
  body?: Record<string, unknown>
) {
  const { data: json, error: fnError } = await supabase.functions.invoke(
    "scalepad-proxy",
    {
      body: { endpoint, method, body },
      headers: { "x-scalepad-api-key": apiKey },
    }
  );

  if (fnError) throw new Error(fnError.message || "Edge function error");

  if (json?.upstream_status && json.upstream_status >= 400) {
    const detail =
      json.errors?.[0]?.detail || json.error || `API returned ${json.upstream_status}`;
    throw new Error(`${json.upstream_status}: ${detail}`);
  }

  if (json?.error) throw new Error(json.error);
  return json;
}

// ---- Fetch all clients ----

export async function fetchAllClients(apiKey: string): Promise<CleanupClient[]> {
  const all: CleanupClient[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({ page_size: "200", sort: "name" });
    if (cursor) params.set("cursor", cursor);

    const json = await proxyCall(apiKey, `/core/v1/clients?${params.toString()}`);
    const items = json.data || [];
    for (const c of items) {
      all.push({
        id: c.id,
        name: c.name || "Unnamed",
        lifecycle: c.lifecycle || "—",
        num_hardware_assets: c.num_hardware_assets ?? 0,
      });
    }
    cursor = json.next_cursor || null;
    await sleep(DELAY_MS);
  } while (cursor);

  // Core client IDs are not guaranteed to be valid Lifecycle Manager client
  // IDs. Resolve by name against the LMX client collection before using IDs in
  // Lifecycle Manager filters and delete routes.
  try {
    const lifecycleClients: Array<Record<string, any>> = [];
    let lifecycleCursor: string | null = null;
    do {
      const params = new URLSearchParams({ page_size: "200", sort: "name" });
      if (lifecycleCursor) params.set("cursor", lifecycleCursor);
      const json = await proxyCall(apiKey, `/lifecycle-manager/v1/clients?${params.toString()}`);
      lifecycleClients.push(...(json.data || []));
      lifecycleCursor = json.next_cursor || null;
    } while (lifecycleCursor);

    const lifecycleByName = new Map(
      lifecycleClients
        .map((client) => {
          const nestedClient = client.client && typeof client.client === "object" ? client.client : null;
          const name = String(client.name || nestedClient?.display_name || nestedClient?.name || "").trim().toLowerCase();
          const id = nestedClient?.client_id || client.id || nestedClient?.id;
          return name && id ? [name, String(id)] as const : null;
        })
        .filter((entry): entry is readonly [string, string] => Boolean(entry))
    );

    return all.map((client) => ({
      ...client,
      coreId: client.id,
      id: lifecycleByName.get(client.name.trim().toLowerCase()) || client.id,
    }));
  } catch {
    // Preserve the Core list if the account cannot enumerate LMX clients;
    // downstream calls will surface the exact permission or ID error.
    return all;
  }
}

// ---- Section config ----

interface SectionConfig {
  type: SectionType;
  label: string;
  listEndpoint: (clientId: string) => string;
  deleteEndpoint: (recordId: string) => string;
  paginated: boolean;
}

const SECTIONS: SectionConfig[] = [
  // Delete dependent records before their parent records so relationship
  // constraints do not prevent the cleanup from completing.
  {
    type: "actionItems",
    label: "Action Items",
    listEndpoint: (cid) =>
      `/lifecycle-manager/v1/action-items?filter[client.id]=${clientFilter(cid)}&page_size=100`,
    deleteEndpoint: (id) => `/lifecycle-manager/v1/action-items/${id}`,
    paginated: true,
  },
  {
    type: "notes",
    label: "Notes",
    listEndpoint: (cid) =>
      `/lifecycle-manager/v1/notes?filter[client.id]=${clientFilter(cid)}&page_size=100`,
    deleteEndpoint: (id) => `/lifecycle-manager/v1/notes/${id}`,
    paginated: true,
  },
  {
    type: "assessments",
    label: "Assessments",
    listEndpoint: (cid) =>
      `/lifecycle-manager/v1/assessments?filter[client.id]=${clientFilter(cid)}&page_size=100`,
    deleteEndpoint: (id) => `/lifecycle-manager/v1/assessments/${id}`,
    paginated: true,
  },
  {
    type: "deliverables",
    label: "Deliverables",
    listEndpoint: (cid) =>
      `/lifecycle-manager/v1/deliverables?filter[client.id]=${clientFilter(cid)}&page_size=100`,
    deleteEndpoint: (id) => `/lifecycle-manager/v1/deliverables/${id}`,
    paginated: true,
  },
  {
    type: "meetings",
    label: "Meetings",
    listEndpoint: (cid) =>
      `/lifecycle-manager/v1/meetings?filter[client.id]=${clientFilter(cid)}&page_size=100`,
    deleteEndpoint: (id) => `/lifecycle-manager/v1/meetings/${id}`,
    paginated: true,
  },
  {
    type: "contracts",
    label: "Contracts",
    listEndpoint: (cid) =>
      `/lifecycle-manager/v1/contracts?filter[client.id]=${clientFilter(cid)}&page_size=100`,
    deleteEndpoint: (id) => `/lifecycle-manager/v1/contracts/${id}`,
    paginated: true,
  },
  {
    type: "goals",
    label: "Goals",
    listEndpoint: (cid) =>
      `/lifecycle-manager/v1/goals?filter[client.id]=${clientFilter(cid)}&page_size=100`,
    deleteEndpoint: (id) => `/lifecycle-manager/v1/goals/${id}`,
    paginated: true,
  },
  {
    type: "initiatives",
    label: "Initiatives",
    listEndpoint: (cid) =>
      `/lifecycle-manager/v1/initiatives?filter[client.id]=${clientFilter(cid)}&page_size=100`,
    deleteEndpoint: (id) => `/lifecycle-manager/v1/initiatives/${id}`,
    paginated: true,
  },
];

export function getSectionConfigs() {
  return SECTIONS;
}

// ---- Fetch record IDs for a section ----

async function fetchRecordIds(
  apiKey: string,
  config: SectionConfig,
  clientId: string
): Promise<string[]> {
  const ids: string[] = [];

  const getRecordId = (item: any): string | null => {
    const id =
      item?.id ||
      item?.note_id ||
      item?.action_item_id ||
      item?.engagement_action_id ||
      item?.uuid;
    return id ? String(id) : null;
  };

  const matchesClient = (item: any) => {
    const candidates = [
      item?.client?.id,
      item?.client?.client_id,
      item?.client_id,
      item?.clientId,
    ]
      .filter(Boolean)
      .map((value) => String(value));
    return candidates.includes(String(clientId));
  };

  const fetchUnfilteredIds = async () => {
    const fallbackIds: string[] = [];
    let fallbackCursor: string | null = null;
    do {
      const baseEndpoint = config.listEndpoint(clientId).split("?")[0];
      const params = new URLSearchParams({ page_size: "100" });
      if (fallbackCursor) params.set("cursor", fallbackCursor);
      const fallbackJson = await proxyCall(
        apiKey,
        `${baseEndpoint}?${params.toString()}`
      );
      for (const item of fallbackJson.data || []) {
        const recordId = getRecordId(item);
        if (recordId && matchesClient(item)) fallbackIds.push(recordId);
      }
      fallbackCursor = fallbackJson.next_cursor || null;
      if (fallbackCursor) await sleep(DELAY_MS);
    } while (fallbackCursor);
    return fallbackIds;
  };

  if (!config.paginated) {
    const json = await proxyCall(apiKey, config.listEndpoint(clientId));
    for (const item of json.data || []) {
      const recordId = getRecordId(item);
      if (recordId && matchesClient(item)) ids.push(recordId);
    }
    return ids;
  }

  try {
    let cursor: string | null = null;
    do {
      let url = config.listEndpoint(clientId);
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      const json = await proxyCall(apiKey, url);
      for (const item of json.data || []) {
        const recordId = getRecordId(item);
        // Keep this client-side guard even when the API accepted the filter.
        // A malformed or ignored filter must never broaden deletion scope.
        if (recordId && matchesClient(item)) ids.push(recordId);
      }
      cursor = json.next_cursor || null;
      if (cursor) await sleep(DELAY_MS);
    } while (cursor);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/422|ClientId does not exist/i.test(detail)) throw error;
    // Some LMX tenants reject the documented client filter even when the
    // client exists. Scan the paginated collection and match its embedded
    // client.id instead of failing before deletion can begin.
    return fetchUnfilteredIds();
  }

  return ids;
}

async function fetchLinkedActionItemIds(
  apiKey: string,
  clientId: string
): Promise<string[]> {
  const actionItemIds = new Set<string>();

  for (const resource of ["initiatives", "meetings"] as const) {
    const parentConfig: SectionConfig = {
      type: resource,
      label: resource,
      listEndpoint: (cid) =>
        `/lifecycle-manager/v1/${resource}?filter[client.id]=${clientFilter(cid)}&page_size=100`,
      deleteEndpoint: (id) => `/lifecycle-manager/v1/${resource}/${id}`,
      paginated: true,
    };
    const parentIds = await fetchRecordIds(apiKey, parentConfig, clientId);

    for (const parentId of parentIds) {
      const response = await proxyCall(
        apiKey,
        `/lifecycle-manager/v1/${resource}/${parentId}/action-items`
      );
      const linkedIds = Array.isArray(response?.action_item_ids)
        ? response.action_item_ids
        : [];
      linkedIds.forEach((id: unknown) => {
        if (typeof id === "string" && id.trim()) actionItemIds.add(id);
      });
    }
  }

  return [...actionItemIds];
}

// ---- Delete a single record ----

async function deleteRecord(
  apiKey: string,
  config: SectionConfig,
  recordId: string
): Promise<{ success: boolean; errorCode?: string; errorDetail?: string }> {
  try {
    const json = await proxyCall(
      apiKey,
      config.deleteEndpoint(recordId),
      "DELETE"
    );
    // 204 comes back as upstream_status=204
    if (json?.upstream_status === 429) {
      const retryAfter = json.retry_after || 5;
      await sleep(retryAfter * 1000);
      // retry once
      const retry = await proxyCall(
        apiKey,
        config.deleteEndpoint(recordId),
        "DELETE"
      );
      if (retry?.upstream_status && retry.upstream_status >= 400) {
        return {
          success: false,
          errorCode: String(retry.upstream_status),
          errorDetail: retry.errors?.[0]?.detail || retry.error || "Delete failed on retry",
        };
      }
    }
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const code = msg.match(/^(\d+):/)?.[1] || "500";
    return { success: false, errorCode: code, errorDetail: msg };
  }
}

// ---- Run cleanup for one client ----

export type ProgressCallback = (progress: ClientProgress) => void;
export type ErrorCallback = (error: CleanupError) => void;

export async function runClientCleanup(
  apiKey: string,
  client: CleanupClient,
  selectedSections: Record<SectionType, boolean>,
  onProgress: ProgressCallback,
  onError: ErrorCallback
): Promise<ClientProgress> {
  const progress: ClientProgress = {
    clientId: client.id,
    clientName: client.name,
    sections: SECTIONS.map((s) => ({
      type: s.type,
      label: s.label,
      status: selectedSections[s.type] ? "pending" : "skipped",
      deleted: 0,
      total: 0,
    })),
  };

  onProgress({ ...progress, sections: [...progress.sections] });

  for (let i = 0; i < SECTIONS.length; i++) {
    const config = SECTIONS[i];
    const sp = progress.sections[i];

    if (!selectedSections[config.type]) continue;

    sp.status = "running";
    onProgress({ ...progress, sections: progress.sections.map((s) => ({ ...s })) });

    // Fetch IDs
    let ids: string[];
    try {
      ids = await fetchRecordIds(apiKey, config, client.id);
    } catch (err) {
      sp.status = "failed";
      sp.total = 0;
      const msg = err instanceof Error ? err.message : "Fetch failed";
      onError({
        clientName: client.name,
        section: config.label,
        recordId: "—",
        errorCode: "FETCH",
        errorDetail: `Fetch failed for ${config.label} — ${msg}`,
      });
      onProgress({ ...progress, sections: progress.sections.map((s) => ({ ...s })) });
      continue;
    }

    if (config.type === "actionItems" && ids.length === 0) {
      try {
        ids = await fetchLinkedActionItemIds(apiKey, client.id);
      } catch {
        // Preserve the primary list result; a relationship fallback is best effort.
      }
    }

    sp.total = ids.length;
    if (ids.length === 0) {
      sp.status = "success";
      onProgress({ ...progress, sections: progress.sections.map((s) => ({ ...s })) });
      continue;
    }

    // Delete each
    let failures = 0;
    for (const recordId of ids) {
      await sleep(DELAY_MS);
      const result = await deleteRecord(apiKey, config, recordId);
      if (result.success) {
        sp.deleted++;
      } else {
        failures++;
        onError({
          clientName: client.name,
          section: config.label,
          recordId,
          errorCode: result.errorCode || "ERR",
          errorDetail: result.errorDetail || "Delete failed",
        });
      }
      onProgress({ ...progress, sections: progress.sections.map((s) => ({ ...s })) });
    }

    sp.status = failures === 0 ? "success" : sp.deleted > 0 ? "partial" : "failed";
    onProgress({ ...progress, sections: progress.sections.map((s) => ({ ...s })) });
  }

  return progress;
}
