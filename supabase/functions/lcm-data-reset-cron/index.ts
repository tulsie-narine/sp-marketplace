// LCM Data Reset — Nightly Cron Runner
// ------------------------------------
// Executes saved same-tenant "gold client" clones automatically.
// Triggered by pg_cron at ~2:00 AM Eastern. Iterates every config with
// schedule_enabled=true and runs reset+clone for the supported object
// types (initiatives, goals, action items, notes, contracts, meetings,
// deliverables). Assessments are intentionally skipped here — their
// template-mapped evaluation flow lives in the client orchestration
// and is not yet ported server-side.
//
// CORS is wide-open because this endpoint is invoked by pg_cron / pg_net
// from inside the database, not by browsers.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SCALEPAD_BASE = "https://api.scalepad.com";
const DEFAULT_DELAY_MS = 250;
const MAX_PAGES = 200;
const PAGE_SIZE = 50;

type SelectedObjects = {
  initiatives?: boolean;
  goals?: boolean;
  meetings?: boolean;
  notes?: boolean;
  actionItems?: boolean;
  contracts?: boolean;
  assessments?: boolean;
  deliverables?: boolean;
};

interface ConfigRow {
  id: string;
  user_id: string | null;
  owner_hash: string | null;
  name: string;
  destination_api_key: string;
  source_client_id: string;
  source_client_name: string;
  destination_client_ids: string[];
  destination_client_names: string[];
  selected_objects: SelectedObjects;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function spCall(
  apiKey: string,
  endpoint: string,
  method: string = "GET",
  body?: unknown,
): Promise<{ status: number; data: unknown; text: string }> {
  const headers: Record<string, string> = {
    "X-API-Key": apiKey,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${SCALEPAD_BASE}${endpoint}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { status: res.status, data, text };
}

async function spCallRetry(
  apiKey: string,
  endpoint: string,
  method: string = "GET",
  body?: unknown,
  attempts = 3,
): Promise<{ status: number; data: unknown; text: string }> {
  let last: { status: number; data: unknown; text: string } | null = null;
  for (let i = 0; i < attempts; i++) {
    const r = await spCall(apiKey, endpoint, method, body);
    last = r;
    if (r.status < 500 && r.status !== 429) return r;
    await sleep(500 * (i + 1));
  }
  return last!;
}

async function fetchAllPages(
  apiKey: string,
  basePath: string,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = basePath.includes("?") ? "&" : "?";
    const url = `${basePath}${sep}page_size=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await spCallRetry(apiKey, url, "GET");
    if (r.status >= 400) break;
    const data = r.data as Record<string, unknown> | null;
    const items = (data?.items || data?.data || []) as Record<string, unknown>[];
    if (Array.isArray(items)) all.push(...items);
    cursor = (data?.next_cursor as string) || (data?.cursor as string) || null;
    if (!cursor || items.length === 0) break;
    await sleep(50);
  }
  return all;
}

// --------- Cleanup (delete for one client) ---------

const CLEANUP_ENDPOINTS: Record<keyof SelectedObjects, { list: (clientId: string) => string; del: (id: string) => string } | null> = {
  initiatives: {
    list: (c) => `/lifecycle-manager/v1/initiatives?client_id=${c}`,
    del: (id) => `/lifecycle-manager/v1/initiatives/${id}`,
  },
  goals: {
    list: (c) => `/lifecycle-manager/v1/goals?client_id=${c}`,
    del: (id) => `/lifecycle-manager/v1/goals/${id}`,
  },
  meetings: {
    list: (c) => `/lifecycle-manager/v1/meetings?client_id=${c}`,
    del: (id) => `/lifecycle-manager/v1/meetings/${id}`,
  },
  notes: {
    list: (c) => `/lifecycle-manager/v1/notes?client_id=${c}`,
    del: (id) => `/lifecycle-manager/v1/notes/${id}`,
  },
  actionItems: {
    list: (c) => `/lifecycle-manager/v1/action-items?client_id=${c}`,
    del: (id) => `/lifecycle-manager/v1/action-items/${id}`,
  },
  contracts: {
    list: (c) => `/lifecycle-manager/v1/contracts?client_id=${c}`,
    del: (id) => `/lifecycle-manager/v1/contracts/${id}`,
  },
  deliverables: {
    list: (c) => `/lifecycle-manager/v1/deliverables?client_id=${c}`,
    del: (id) => `/lifecycle-manager/v1/deliverables/${id}`,
  },
  assessments: {
    list: (c) => `/lifecycle-manager/v1/assessments?client_id=${c}`,
    del: (id) => `/lifecycle-manager/v1/assessments/${id}`,
  },
};

async function deleteClientSection(
  apiKey: string,
  clientId: string,
  type: keyof SelectedObjects,
): Promise<{ deleted: number; failed: number }> {
  const ep = CLEANUP_ENDPOINTS[type];
  if (!ep) return { deleted: 0, failed: 0 };
  const items = await fetchAllPages(apiKey, ep.list(clientId));
  let deleted = 0;
  let failed = 0;
  for (const item of items) {
    const id = (item.id as string) || (item.uuid as string);
    if (!id) continue;
    const r = await spCallRetry(apiKey, ep.del(id), "DELETE");
    if (r.status >= 200 && r.status < 300) deleted++;
    else failed++;
    await sleep(DEFAULT_DELAY_MS);
  }
  return { deleted, failed };
}

// --------- Recreation (copy from source -> dest, minimal but faithful) ---------

const asText = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const extractIdArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item)) return asText(item.id);
      return "";
    })
    .filter(Boolean);
};

const extractActionItemOwnerEmail = (record: Record<string, unknown>) =>
  asText((record.assigned_user as Record<string, unknown> | undefined)?.email) ||
  asText((record.owner as Record<string, unknown> | undefined)?.email) ||
  asText(record.assigned_user_email) ||
  asText((record.assignee as Record<string, unknown> | undefined)?.email) ||
  asText(record.assignee_email) ||
  "";

const extractActionItemOwnerEmails = (record: Record<string, unknown>) => {
  const emails = new Set<string>();
  const push = (value: unknown) => {
    const email = asText(value).trim().toLowerCase();
    if (email) emails.add(email);
  };

  push((record.assigned_user as Record<string, unknown> | undefined)?.email);
  push((record.owner as Record<string, unknown> | undefined)?.email);
  push(record.assigned_user_email);
  push((record.assignee as Record<string, unknown> | undefined)?.email);
  push(record.assignee_email);

  for (const collection of [
    record.assigned_user_ids,
    record.assigned_users,
    record.assignees,
  ]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (typeof item === "string" && item.includes("@")) {
        push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      push(item.email);
      push((item.contact_info as Record<string, unknown> | undefined)?.email);
      push((item.user as Record<string, unknown> | undefined)?.email);
      push((item.member as Record<string, unknown> | undefined)?.email);
    }
  }

  return [...emails];
};

const extractActionItemOwnerId = (record: Record<string, unknown>) =>
  asText((record.assigned_user as Record<string, unknown> | undefined)?.id) ||
  asText((record.owner as Record<string, unknown> | undefined)?.id) ||
  asText(record.assigned_user_id) ||
  asText((record.assignee as Record<string, unknown> | undefined)?.id) ||
  asText(record.assignee_id) ||
  extractIdArray(record.assigned_user_ids)[0] ||
  extractIdArray(record.assigned_users)[0] ||
  extractIdArray(record.assignees)[0] ||
  "";

const extractActionItemOwnerIds = (record: Record<string, unknown>) => {
  const ids = new Set<string>();
  const push = (value: unknown) => {
    const id = asText(value);
    if (id) ids.add(id);
  };

  push((record.assigned_user as Record<string, unknown> | undefined)?.id);
  push((record.owner as Record<string, unknown> | undefined)?.id);
  push(record.assigned_user_id);
  push((record.assignee as Record<string, unknown> | undefined)?.id);
  push(record.assignee_id);
  extractIdArray(record.assigned_user_ids).forEach((id) => ids.add(id));
  extractIdArray(record.assigned_users).forEach((id) => ids.add(id));
  extractIdArray(record.assignees).forEach((id) => ids.add(id));
  return [...ids];
};

async function fetchMembers(apiKey: string): Promise<Array<{ id: string; email: string }>> {
  const members = await fetchAllPages(apiKey, "/core/v1/members");
  return members
    .map((member) => {
      const id = asText(member.id);
      const email = asText((member.contact_info as Record<string, unknown> | undefined)?.email).trim().toLowerCase();
      return id && email ? { id, email } : null;
    })
    .filter((member): member is { id: string; email: string } => Boolean(member));
}

const findMemberEmailById = (
  members: Array<{ id: string; email: string }>,
  id: string | null | undefined,
) => {
  const normalizedId = asText(id);
  if (!normalizedId) return "";
  return members.find((member) => member.id === normalizedId)?.email || "";
};

async function fetchSourceRecords(
  apiKey: string,
  clientId: string,
  type: keyof SelectedObjects,
): Promise<Record<string, unknown>[]> {
  const ep = CLEANUP_ENDPOINTS[type];
  if (!ep) return [];
  const list = await fetchAllPages(apiKey, ep.list(clientId));

  if (type !== "actionItems" && type !== "assessments") {
    return list;
  }

  const detailBase = ep.list(clientId).split("?")[0];
  const detailed: Record<string, unknown>[] = [];
  for (const item of list) {
    const id = asText(item.id) || asText(item.uuid);
    if (!id) {
      detailed.push(item);
      continue;
    }

    const detailResponse = await spCallRetry(
      apiKey,
      `${detailBase}/${encodeURIComponent(id)}`,
      "GET",
    );
    const detailData = isRecord(detailResponse.data) ? detailResponse.data : {};
    const detailRecord =
      (type === "actionItems" &&
        isRecord(detailData.action_item) &&
        detailData.action_item) ||
      (type === "assessments" &&
        isRecord(detailData.assessment) &&
        detailData.assessment) ||
      detailData;

    detailed.push({ ...item, ...detailRecord });
    await sleep(50);
  }

  return detailed;
}

async function recreate(
  apiKey: string,
  destClientId: string,
  type: keyof SelectedObjects,
  record: Record<string, unknown>,
  sourceMembers: Array<{ id: string; email: string }> = [],
): Promise<boolean> {
  const clientKey = { id: destClientId };

  if (type === "initiatives") {
    const body: Record<string, unknown> = {
      client_key: clientKey,
      name: asText(record.name) || "Migrated Initiative",
      description: asText(record.description) || "",
    };
    const r = await spCallRetry(apiKey, "/lifecycle-manager/v1/initiatives", "POST", body);
    return r.status >= 200 && r.status < 300;
  }
  if (type === "goals") {
    const body: Record<string, unknown> = {
      client_key: clientKey,
      title: asText(record.title) || asText(record.name) || "Migrated Goal",
      description: asText(record.description) || "",
    };
    const r = await spCallRetry(apiKey, "/lifecycle-manager/v1/goals", "POST", body);
    return r.status >= 200 && r.status < 300;
  }
  if (type === "notes") {
    const body: Record<string, unknown> = {
      client_key: clientKey,
      content: asText(record.content) || asText(record.body) || "Migrated note",
    };
    const r = await spCallRetry(apiKey, "/lifecycle-manager/v1/notes", "POST", body);
    return r.status >= 200 && r.status < 300;
  }
  if (type === "actionItems") {
    const assignedUserIds = extractActionItemOwnerIds(record);
    const assignedEmails = [
      ...new Set(
        [
          ...extractActionItemOwnerEmails(record),
          ...assignedUserIds
            .map((id) => findMemberEmailById(sourceMembers, id))
            .filter(Boolean),
        ],
      ),
    ];
    if (assignedUserIds.length === 0 && assignedEmails.length === 0) return false;
    const body: Record<string, unknown> = {
      client_key: clientKey,
      title:
        asText(record.title) ||
        asText(record.name) ||
        asText(record.description) ||
        "Migrated action item",
      description_json: asText(record.description_json) || null,
      assigned_user_ids:
        assignedEmails.length > 0
          ? assignedEmails.map((email) => ({ email }))
          : assignedUserIds.map((id) => ({ id })),
      due_at: record.due_at || null,
    };
    const r = await spCallRetry(apiKey, "/lifecycle-manager/v1/action-items", "POST", body);
    const createdData = isRecord(r.data) ? r.data : {};
    const createdId = asText(createdData.id);
    if (!(r.status >= 200 && r.status < 300) || !createdId) return false;

    const shouldComplete =
      record.is_completed === true ||
      Boolean(record.completed_at) ||
      asText(record.completion_status).length > 0;
    if (shouldComplete) {
      await sleep(DEFAULT_DELAY_MS);
      await spCallRetry(
        apiKey,
        `/lifecycle-manager/v1/action-items/${createdId}/completion-status`,
        "PUT",
        { is_completed: true },
      );
    }

    return true;
  }
  if (type === "meetings") {
    const body: Record<string, unknown> = {
      client_key: clientKey,
      title: asText(record.title) || "Migrated meeting",
      scheduled_at: record.scheduled_at || record.start_at || null,
    };
    const r = await spCallRetry(apiKey, "/lifecycle-manager/v1/meetings", "POST", body);
    return r.status >= 200 && r.status < 300;
  }
  if (type === "contracts") {
    const body: Record<string, unknown> = {
      client_key: clientKey,
      name: asText(record.name) || "Migrated contract",
    };
    const r = await spCallRetry(apiKey, "/lifecycle-manager/v1/contracts", "POST", body);
    return r.status >= 200 && r.status < 300;
  }
  if (type === "deliverables") {
    const body: Record<string, unknown> = {
      client_key: clientKey,
      name: asText(record.name) || "Migrated deliverable",
    };
    const r = await spCallRetry(apiKey, "/lifecycle-manager/v1/deliverables", "POST", body);
    return r.status >= 200 && r.status < 300;
  }
  if (type === "assessments") {
    const templateId = asText(record.assessment_template_id);
    const evaluatorId =
      asText(record.evaluate_user_id) ||
      asText((record.evaluate_user as Record<string, unknown> | undefined)?.id) ||
      asText((record.evaluator as Record<string, unknown> | undefined)?.id);
    if (!templateId || !evaluatorId) return false;

    const body: Record<string, unknown> = {
      client_key: clientKey,
      title: asText(record.title) || "Migrated Assessment",
      assessment_template_id: templateId,
      evaluate_user_id: evaluatorId,
      evaluate_at: record.evaluate_at || record.record_updated_at || new Date().toISOString(),
    };
    const created = await spCallRetry(
      apiKey,
      "/lifecycle-manager/v1/assessments",
      "POST",
      body,
    );
    const createdData = isRecord(created.data) ? created.data : {};
    const createdId =
      asText((createdData.assessment as Record<string, unknown> | undefined)?.id) ||
      asText(createdData.id);
    if (!(created.status >= 200 && created.status < 300) || !createdId) {
      return false;
    }

    const shouldComplete =
      asText(record.status) === "Completed" || Boolean(record.completion_status);
    if (shouldComplete) {
      await sleep(DEFAULT_DELAY_MS);
      await spCallRetry(
        apiKey,
        `/lifecycle-manager/v1/assessments/${createdId}/completion-status`,
        "PUT",
        { is_completed: true },
      );
    }

    return true;
  }
  return false;
}

// --------- Per-config runner ---------

async function runConfig(supabaseAdmin: ReturnType<typeof createClient>, cfg: ConfigRow) {
  const apiKey = cfg.destination_api_key;
  const totals = { deleted: 0, created: 0, failures: 0 };
  const perClient: Array<Record<string, unknown>> = [];
  const sourceMembers = cfg.selected_objects.actionItems ? await fetchMembers(apiKey) : [];

  // Pre-fetch source records once per object type
  const sourceData: Partial<Record<keyof SelectedObjects, Record<string, unknown>[]>> = {};
  const types = Object.entries(cfg.selected_objects)
    .filter(([, v]) => v)
    .map(([k]) => k as keyof SelectedObjects);

  for (const type of types) {
    sourceData[type] = await fetchSourceRecords(apiKey, cfg.source_client_id, type);
  }

  for (let i = 0; i < cfg.destination_client_ids.length; i++) {
    const destId = cfg.destination_client_ids[i];
    const destName = cfg.destination_client_names[i] || destId;
    const clientLog: Record<string, unknown> = { destId, destName, sections: [] as unknown[] };

    for (const type of types) {
      // 1. delete
      const delRes = await deleteClientSection(apiKey, destId, type);
      totals.deleted += delRes.deleted;
      totals.failures += delRes.failed;

      // 2. recreate
      let created = 0;
      let failed = 0;
      const records = sourceData[type] || [];
      for (const rec of records) {
        const ok = await recreate(apiKey, destId, type, rec, sourceMembers);
        if (ok) created++;
        else failed++;
        await sleep(DEFAULT_DELAY_MS);
      }
      totals.created += created;
      totals.failures += failed;
      (clientLog.sections as unknown[]).push({ type, deleted: delRes.deleted, created, failed });
    }
    perClient.push(clientLog);
  }

  const status = totals.failures === 0 ? "success" : totals.created > 0 ? "partial" : "failed";

  await supabaseAdmin.from("lcm_data_reset_runs").insert({
    config_id: cfg.id,
    user_id: cfg.user_id,
    owner_hash: cfg.owner_hash,
    trigger_type: "scheduled",
    status,
    finished_at: new Date().toISOString(),
    total_deleted: totals.deleted,
    total_created: totals.created,
    total_failures: totals.failures,
    details: { perClient } as never,
  });

  await supabaseAdmin
    .from("lcm_data_reset_configs")
    .update({
      last_run_at: new Date().toISOString(),
      last_run_status: status,
      last_run_summary: { ...totals, perClient } as never,
    })
    .eq("id", cfg.id);

  return { status, totals };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { data: configs, error } = await supabaseAdmin
      .from("lcm_data_reset_configs")
      .select("*")
      .eq("schedule_enabled", true);

    if (error) throw error;

    const results: Array<Record<string, unknown>> = [];
    for (const cfg of (configs || []) as unknown as ConfigRow[]) {
      try {
        // Key-owned configs always use the currently saved key; skip if it was forgotten.
        if (cfg.owner_hash) {
          const { data: saved } = await supabaseAdmin
            .from("saved_api_keys").select("api_key").eq("key_hash", cfg.owner_hash).maybeSingle();
          if (!saved?.api_key) throw new Error("No saved API key for this configuration.");
          cfg.destination_api_key = (saved as { api_key: string }).api_key;
        }
        const r = await runConfig(supabaseAdmin, cfg);
        results.push({ config_id: cfg.id, name: cfg.name, ...r });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ config_id: cfg.id, name: cfg.name, status: "error", error: msg });
        await supabaseAdmin.from("lcm_data_reset_runs").insert({
          config_id: cfg.id,
          user_id: cfg.user_id,
          owner_hash: cfg.owner_hash,
    owner_hash: cfg.owner_hash,
          trigger_type: "scheduled",
          status: "error",
          finished_at: new Date().toISOString(),
          error_message: msg,
        });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, processed: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
