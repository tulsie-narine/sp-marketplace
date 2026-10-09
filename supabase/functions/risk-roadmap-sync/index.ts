import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-scalepad-api-key",
};
const SCALEPAD_BASE = "https://api.scalepad.com";
const APP_ID = "risk-roadmap";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Config = {
  clientId: string;
  clientName?: string;
  sourceType: "action_items" | "risks";
  destination?: "initiatives" | "action_items";
  onRemoved?: "decline" | "ignore";
  skipStatuses?: string[];
  horizonMonths?: 3 | 6 | 12;
  syncAll?: boolean;
  selectedSourceIds?: string[];
};

type TaskRow = { id: string; owner_hash: string; name: string; config: Config; schedule_enabled: boolean };
type SourceItem = Record<string, unknown> & { id: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const text = (value: unknown) => (value == null ? "" : String(value));
const normalized = (value: unknown) => text(value).trim().toLowerCase();

async function hash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function spCall(apiKey: string, endpoint: string, method = "GET", body?: unknown) {
  const response = await fetch(`${SCALEPAD_BASE}${endpoint}`, {
    method,
    headers: { "x-api-key": apiKey, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data: Record<string, unknown> = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { response_text: raw }; }
  if (!response.ok) throw new Error(`${method} ${endpoint} -> HTTP ${response.status}: ${raw.slice(0, 300)}`);
  return data;
}

async function fetchAll(apiKey: string, endpoint: string, method = "GET", body?: Record<string, unknown>) {
  const all: SourceItem[] = [];
  let cursor = "";
  for (let page = 0; page < 200; page++) {
    const pageBody = method === "POST" ? { ...(body || {}), page_size: 200, ...(cursor ? { cursor } : {}) } : undefined;
    const url = method === "GET"
      ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}page_size=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      : endpoint;
    const result = await spCall(apiKey, url, method, pageBody);
    const container = (result.action_items as Record<string, unknown> | undefined)
      || (result.risks as Record<string, unknown> | undefined)
      || result;
    const rows = (container.data || container.items || []) as SourceItem[];
    all.push(...rows.filter((row) => row && row.id != null));
    cursor = text(container.next_cursor || container.cursor);
    if (!cursor || rows.length === 0) break;
    await sleep(120);
  }
  return all;
}

function quarterFromDate(value: unknown) {
  const date = new Date(text(value));
  if (Number.isNaN(date.getTime())) return null;
  return { year: date.getUTCFullYear(), quarter: Math.floor(date.getUTCMonth() / 3) + 1 };
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function sourceSpec(item: SourceItem, config: Config) {
  const isRisk = config.sourceType === "risks";
  const code = text(item.code || `${isRisk ? "RSK" : "AI"}-${item.id}`);
  const title = text(item.weakness_name || item.name || item.title || "Untitled item").trim();
  const status = text(item.status || "Not Started");
  const priorityLabel = normalized(item.priority || item.current_risk_label);
  const statusMap: Record<string, string> = { "not started": "Proposed", "in progress": "InProgress", review: "InProgress", completed: "Completed" };
  const priorityMap: Record<string, string> = { critical: "High", high: "High", medium: "Medium", low: "Low" };
  const dateValue = item.planned_completion_date || item.planned_end_date || item.due_date || item.planned_start_date;
  const fiscalQuarter = quarterFromDate(dateValue) || (config.horizonMonths ? quarterFromDate(addMonths(new Date(), config.horizonMonths)) : null);
  const description = text(item.weakness_description || item.description);
  const corrective = text(item.corrective_action || item.business_impact);
  const summary = JSON.stringify({ type: "doc", content: [
    ...(description ? [{ type: "paragraph", content: [{ type: "text", text: `Description: ${description}` }] }] : []),
    ...(corrective ? [{ type: "paragraph", content: [{ type: "text", text: `Corrective action: ${corrective}` }] }] : []),
    { type: "paragraph", content: [{ type: "text", text: `Synced from ControlMap ${code}.` }] },
  ]});
  const budget = Number(item.cost) > 0 ? [{ label: `ControlMap ${code} remediation`, cost_subunits: Math.round(Number(item.cost) * 100), cost_type: "Fixed" }] : [];
  const owner = (item.owner || item.assignee || item.assigned_to) as Record<string, unknown> | undefined;
  const assignedUserIds = owner?.email ? [{ email: text(owner.email) }] : owner?.id ? [{ id: text(owner.id) }] : [];
  const dueAt = item.due_at || item.due_date || item.planned_completion_date || item.planned_end_date || null;
  const spec = {
    code,
    name: `${code} · ${title}`.slice(0, 200),
    summary,
    status: statusMap[normalized(status)] || "Proposed",
    priority: priorityMap[priorityLabel] || "None",
    fiscalQuarter,
    estimatedHours: Number(item.effort_in_hours || item.efforts_in_hours || item.efforts) > 0 ? Number(item.effort_in_hours || item.efforts_in_hours || item.efforts) : null,
    budget,
    dueAt,
    assignedUserIds,
    isCompleted: ["completed", "closed", "remediated"].includes(normalized(status)),
  };
  return { ...spec, fingerprint: JSON.stringify(spec) };
}

async function applyActionItemSpec(apiKey: string, actionItemId: string, spec: ReturnType<typeof sourceSpec>) {
  const body = { title: spec.name, description_json: spec.summary, due_at: spec.dueAt };
  await spCall(apiKey, `/lifecycle-manager/v1/action-items/${actionItemId}`, "PATCH", body);
  await spCall(apiKey, `/lifecycle-manager/v1/action-items/${actionItemId}/completion-status`, "PUT", { is_completed: spec.isCompleted });
}

async function applySpec(apiKey: string, initiativeId: string, spec: ReturnType<typeof sourceSpec>, existingBudget: Record<string, unknown>[] = [], created = false) {
  const failures: string[] = [];
  const steps: Array<[string, () => Promise<unknown>]> = [];
  if (!created) steps.push(["details", () => spCall(apiKey, `/lifecycle-manager/v1/initiatives/${initiativeId}`, "PATCH", { name: spec.name, executive_summary_json: spec.summary })]);
  steps.push(["status", () => spCall(apiKey, `/lifecycle-manager/v1/initiatives/${initiativeId}/status`, "PUT", { status: spec.status })]);
  steps.push(["priority", () => spCall(apiKey, `/lifecycle-manager/v1/initiatives/${initiativeId}/priority`, "PUT", { priority: spec.priority })]);
  if (spec.fiscalQuarter) {
    const startMonth = (spec.fiscalQuarter.quarter - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const end = new Date(Date.UTC(spec.fiscalQuarter.year, endMonth, 0));
    steps.push(["schedule", () => spCall(apiKey, `/lifecycle-manager/v1/initiatives/${initiativeId}/schedule`, "PUT", {
      target_start_date: `${spec.fiscalQuarter.year}-${String(startMonth).padStart(2, "0")}-01T00:00:00Z`,
      target_end_date: `${spec.fiscalQuarter.year}-${String(endMonth).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}T00:00:00Z`,
      target_precision: "Quarter",
    })]);
  }
  const owned = spec.budget[0]?.label;
  const budget = [...existingBudget.filter((line) => line.label !== owned), ...spec.budget];
  if (spec.budget.length || existingBudget.some((line) => line.label === owned)) {
    steps.push(["budget", () => spCall(apiKey, `/lifecycle-manager/v1/initiatives/${initiativeId}/budget`, "PUT", { budget_line_items: budget })]);
  }
  for (const [name, operation] of steps) {
    try { await operation(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (failures.length) throw new Error(failures.join("; "));
}

async function runTask(db: ReturnType<typeof createClient>, task: TaskRow, apiKey: string, mode: "dry-run" | "live", triggerType: string) {
  const started = new Date().toISOString();
  const summary: Record<string, number> = { created: 0, updated: 0, unchanged: 0, declined: 0, skipped: 0, missing: 0, errors: 0 };
  const { data: run, error: runError } = await db.from("roadmap_sync_runs").insert({ task_id: task.id, owner_hash: task.owner_hash, trigger_type: triggerType, mode, status: "running", started_at: started }).select().single();
  if (runError) throw runError;
  try {
    const config = task.config;
    const endpoint = config.sourceType === "risks"
      ? `/controlmap/v1/clients/${encodeURIComponent(config.clientId)}/risks`
      : `/controlmap/v1/clients/${encodeURIComponent(config.clientId)}/action-items/search`;
    const fetchedSource = await fetchAll(apiKey, endpoint, config.sourceType === "risks" ? "GET" : "POST");
    const syncAll = config.syncAll ?? !(config.selectedSourceIds || []).length;
    const selectedIds = new Set((config.selectedSourceIds || []).map(text));
    const source = syncAll ? fetchedSource : fetchedSource.filter((item) => selectedIds.has(text(item.id)));
    const destination = config.destination || "initiatives";
    const targets = destination === "action_items"
      ? await fetchAll(apiKey, `/lifecycle-manager/v1/action-items?filter[client.id]=eq:${encodeURIComponent(config.clientId)}`)
      : await fetchAll(apiKey, `/lifecycle-manager/v2/initiatives?filter[client.id]=eq:${encodeURIComponent(config.clientId)}&include_unscheduled=true`);
    const byCode = new Map(targets.map((item) => [text(item.name || item.title).split(" · ")[0], item]));
    const { data: stateRows, error: stateError } = await db.from("roadmap_sync_items").select("*").eq("task_id", task.id).eq("client_id", config.clientId).eq("source_type", config.sourceType);
    if (stateError) throw stateError;
    const state = new Map((stateRows || []).map((row) => [`${row.source_type}:${row.source_id}`, row]));
    const seen = new Set<string>();
    for (const item of source) {
      const sourceId = text(item.id);
      const key = `${config.sourceType}:${sourceId}`;
      seen.add(key);
      const status = normalized(item.status);
      if ((config.skipStatuses || ["Not Applicable"]).map(normalized).includes(status)) { summary.skipped++; continue; }
      const spec = sourceSpec(item, config);
      const row = state.get(key);
      let initiativeId = row?.initiative_id || byCode.get(spec.code)?.id;
      try {
        if (row?.source_fingerprint === spec.fingerprint && !row.retired) { summary.unchanged++; continue; }
        if (!initiativeId) {
          summary.created++;
          if (mode === "live") {
            const created = destination === "action_items"
              ? await spCall(apiKey, "/lifecycle-manager/v1/action-items", "POST", { client_key: { id: config.clientId }, title: spec.name, description_json: spec.summary, due_at: spec.dueAt, ...(spec.assignedUserIds.length ? { assigned_user_ids: spec.assignedUserIds } : {}) })
              : await spCall(apiKey, "/lifecycle-manager/v1/initiatives", "POST", { client_key: { id: config.clientId }, name: spec.name, executive_summary_json: spec.summary });
            initiativeId = text(created.id);
            await db.from("roadmap_sync_items").upsert({ task_id: task.id, owner_hash: task.owner_hash, client_id: config.clientId, source_type: config.sourceType, source_id: sourceId, source_code: spec.code, initiative_id: initiativeId, source_fingerprint: null, retired: false, last_status: "created" }, { onConflict: "task_id,client_id,source_type,source_id" });
            if (destination === "action_items") await applyActionItemSpec(apiKey, initiativeId, spec);
            else await applySpec(apiKey, initiativeId, spec, [], true);
          }
        } else {
          summary.updated++;
          const existing = targets.find((candidate) => text(candidate.id) === initiativeId);
          const existingBudget = (((existing?.budget as Record<string, unknown> | undefined)?.line_items || []) as Record<string, unknown>[]);
          if (mode === "live") {
            if (destination === "action_items") await applyActionItemSpec(apiKey, initiativeId, spec);
            else await applySpec(apiKey, initiativeId, spec, existingBudget, false);
          }
        }
        if (mode === "live") await db.from("roadmap_sync_items").upsert({ task_id: task.id, owner_hash: task.owner_hash, client_id: config.clientId, source_type: config.sourceType, source_id: sourceId, source_code: spec.code, initiative_id: initiativeId, source_fingerprint: spec.fingerprint, retired: false, last_status: "success", last_error: null, last_synced_at: new Date().toISOString() }, { onConflict: "task_id,client_id,source_type,source_id" });
      } catch (error) {
        summary.errors++;
        if (mode === "live") await db.from("roadmap_sync_items").upsert({ task_id: task.id, owner_hash: task.owner_hash, client_id: config.clientId, source_type: config.sourceType, source_id: sourceId, source_code: spec.code, initiative_id: initiativeId, source_fingerprint: null, retired: false, last_status: "error", last_error: error instanceof Error ? error.message : String(error) }, { onConflict: "task_id,client_id,source_type,source_id" });
      }
    }
    for (const row of stateRows || []) {
      const key = `${row.source_type}:${row.source_id}`;
      // Removing an item from a task is a scope change, not a source deletion.
      // Leave its existing initiative alone until the user explicitly chooses a removal policy.
      if (row.retired || seen.has(key) || !syncAll) continue;
      summary.declined++;
      if (mode === "live" && row.initiative_id && task.config.onRemoved !== "ignore") {
        if (destination === "initiatives") {
          try { await spCall(apiKey, `/lifecycle-manager/v1/initiatives/${row.initiative_id}/status`, "PUT", { status: "Declined" }); } catch { summary.errors++; }
        }
        await db.from("roadmap_sync_items").update({ retired: true, last_status: "declined", last_synced_at: new Date().toISOString() }).eq("id", row.id);
      }
    }
    const status = summary.errors ? (summary.created + summary.updated ? "partial" : "failed") : "success";
    await db.from("roadmap_sync_runs").update({ status, finished_at: new Date().toISOString(), summary }).eq("id", run.id);
    await db.from("scheduled_tasks").update({ last_run_at: new Date().toISOString(), last_run_status: status, last_run_summary: summary }).eq("id", task.id);
    return { task_id: task.id, status, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from("roadmap_sync_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_message: message }).eq("id", run.id);
    await db.from("scheduled_tasks").update({ last_run_at: new Date().toISOString(), last_run_status: "failed", last_run_summary: { error: message } }).eq("id", task.id);
    throw error;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json().catch(() => ({}));
    if (body.scheduled === true) {
      const { data: tasks, error } = await db.from("scheduled_tasks").select("*").eq("app_id", APP_ID).eq("schedule_enabled", true);
      if (error) throw error;
      const results = [];
      for (const task of (tasks || []) as TaskRow[]) {
        const { data: saved } = await db.from("saved_api_keys").select("api_key").eq("key_hash", task.owner_hash).maybeSingle();
        if (!saved?.api_key) continue;
        try { results.push(await runTask(db, task, saved.api_key, "live", "scheduled")); } catch (error) { results.push({ task_id: task.id, status: "failed", error: error instanceof Error ? error.message : String(error) }); }
      }
      return json({ ok: true, results });
    }
    const apiKey = (req.headers.get("x-scalepad-api-key") || "").trim();
    if (!apiKey) return json({ error: "Missing x-scalepad-api-key header" }, 401);
    const ownerHash = await hash(apiKey);
    const { data: task, error } = await db.from("scheduled_tasks").select("*").eq("id", text(body.taskId)).eq("owner_hash", ownerHash).eq("app_id", APP_ID).maybeSingle();
    if (error) throw error;
    if (!task) return json({ error: "Sync task not found" }, 404);
    const mode = body.mode === "live" ? "live" : "dry-run";
    return json(await runTask(db, task as TaskRow, apiKey, mode, "manual"));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
