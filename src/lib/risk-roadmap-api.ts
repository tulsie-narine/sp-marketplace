/**
 * ControlMap to LMX Roadmap Builder API helpers.
 * All calls proxied through scalepad-proxy edge function.
 */

import { supabase } from "@/integrations/supabase/client";

const DELAY_MS = 120;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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
    throw new Error(detail);
  }

  if (json?.error) throw new Error(json.error);
  return json;
}

// --- Types ---

export interface HealthRecord {
  client: { id: string; name: string; tenant_id: string };
  compliance_score: {
    overall_score: number;
    score_label: string;
    trend: { last_30_days: number; last_60_days: number; last_90_days: number };
  };
  risk_score: {
    overall_score: number;
    risk_level: string;
    risk_breakdown: { severe: number; high: number; medium: number; low: number };
  };
  work_progress: {
    action_items: {
      completed: number;
      in_progress: number;
      not_started: number;
      total: number;
      completion_percentage: number;
    };
    evidence: { completion_percentage: number; total: number };
    controls: { implementation_percentage: number; total: number };
  };
}

export interface RiskSummaryRecord {
  client: { id: string; name: string; tenant_id: string };
  risk_summary: {
    overall_score: number;
    risk_level: string;
    risk_breakdown: { severe: number; high: number; medium: number; low: number };
  };
}

export interface ClientRisk {
  id: number;
  code: string;
  name: string;
  description: string;
  owner: { id: string; name: string; email: string } | null;
  status: string;
  department: string;
  risk_category: string;
  treatment: string;
  business_impact: string;
  inherent_risk_score: number;
  inherent_risk_label: string;
  current_risk_score: number;
  current_risk_label: string;
  target_risk_score: number;
  target_risk_label: string;
  created_at: string;
  updated_at: string;
}

export interface ActionItem {
  id: string;
  weakness_name: string;
  status: string;
  priority: string;
}

export interface PortfolioClient {
  id: string;
  name: string;
  tenant_id: string;
  risk_level: string;
  overall_risk_score: number;
  severe: number;
  high: number;
  medium: number;
  low: number;
  compliance_score: number;
  trend_30: number;
  action_item_pct: number;
  action_items_total: number;
}

// --- Fetchers ---

export async function fetchClientsHealth(apiKey: string): Promise<HealthRecord[]> {
  const all: HealthRecord[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({
      fields: "compliance_score,risk_score,work_progress",
      page_size: "200",
    });
    if (cursor) params.set("cursor", cursor);

    const json = await proxyCall(apiKey, `/controlmap/v1/clients/health?${params}`);
    all.push(...(json.data || []));
    cursor = json.next_cursor || null;
    if (cursor) await delay(DELAY_MS);
  } while (cursor);

  return all;
}

export async function fetchRisksSummary(apiKey: string): Promise<RiskSummaryRecord[]> {
  const all: RiskSummaryRecord[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({ page_size: "200" });
    if (cursor) params.set("cursor", cursor);

    const json = await proxyCall(apiKey, `/controlmap/v1/clients/risks-summary?${params}`);
    all.push(...(json.data || []));
    cursor = json.next_cursor || null;
    if (cursor) await delay(DELAY_MS);
  } while (cursor);

  return all;
}

export async function fetchClientRisks(apiKey: string, clientId: string): Promise<ClientRisk[]> {
  const all: ClientRisk[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({ page_size: "100", sort: "-current_risk" });
    if (cursor) params.set("cursor", cursor);

    const json = await proxyCall(apiKey, `/controlmap/v1/clients/${clientId}/risks?${params}`);
    all.push(...(json.risks?.data || []));
    cursor = json.risks?.next_cursor || null;
    if (cursor) await delay(DELAY_MS);
  } while (cursor);

  return all;
}

export async function fetchClientActionItems(apiKey: string, clientId: string): Promise<ActionItem[]> {
  const all: ActionItem[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({ page_size: "100" });
    if (cursor) params.set("cursor", cursor);

    const json = await proxyCall(apiKey, `/controlmap/v1/clients/${clientId}/action-items?${params}`);
    all.push(...(json.action_items?.data || []));
    cursor = json.action_items?.next_cursor || null;
    if (cursor) await delay(DELAY_MS);
  } while (cursor);

  return all;
}

export function mergePortfolioData(
  health: HealthRecord[],
  summaries: RiskSummaryRecord[]
): PortfolioClient[] {
  const summaryMap = new Map(summaries.map((s) => [s.client.id, s]));

  return health.map((h) => {
    const s = summaryMap.get(h.client.id);
    const rb = h.risk_score?.risk_breakdown || s?.risk_summary?.risk_breakdown || { severe: 0, high: 0, medium: 0, low: 0 };

    return {
      id: h.client.id,
      name: h.client.name,
      tenant_id: h.client.tenant_id,
      risk_level: h.risk_score?.risk_level || s?.risk_summary?.risk_level || "Unknown",
      overall_risk_score: h.risk_score?.overall_score || s?.risk_summary?.overall_score || 0,
      severe: rb.severe || 0,
      high: rb.high || 0,
      medium: rb.medium || 0,
      low: rb.low || 0,
      compliance_score: h.compliance_score?.overall_score || 0,
      trend_30: h.compliance_score?.trend?.last_30_days || 0,
      action_item_pct: h.work_progress?.action_items?.completion_percentage || 0,
      action_items_total: h.work_progress?.action_items?.total || 0,
    };
  });
}

// --- Action Item creation ---

export interface ActionItemPayload {
  weakness_name: string;
  weakness_description?: string;
  corrective_action?: string;
  status?: string;
  priority: string;
  roadmap?: string;
  responsible_person?: string;
  responsible_department?: string;
  efforts_in_hours?: number;
  cost?: number;
  currency: string;
  planned_start_date?: string;
  planned_end_date?: string;
  milestones?: string;
}

export async function createActionItem(
  apiKey: string,
  clientId: string,
  payload: ActionItemPayload
) {
  return proxyCall(
    apiKey,
    `/controlmap/v1/clients/${clientId}/action-items`,
    "POST",
    payload as unknown as Record<string, unknown>
  );
}

// --- Initiative creation (6-step orchestration) ---

export type InitStepStatus = "pending" | "running" | "success" | "error";

export interface InitiativeForm {
  name: string;
  executive_summary: string;
  status: string;
  priority: string;
  fiscal_quarter: { year: number; quarter: number } | null;
  budget_line_items: { label: string; amount: string; cost_type: "Fixed" | "PerAsset" }[];
  recurring_line_items: { label: string; amount: string; cost_type: "Fixed" | "PerAsset"; frequency: "Monthly" | "Yearly" }[];
}

export async function deployInitiative(
  apiKey: string,
  clientId: string,
  form: InitiativeForm,
  onStep: (step: number, status: InitStepStatus, error?: string) => void
) {
  const dollarsToCents = (v: string) => Math.round(parseFloat(v || "0") * 100);

  // Step 1: Create
  onStep(0, "running");
  let id: string;
  try {
    const json = await proxyCall(apiKey, "/lifecycle-manager/v1/initiatives", "POST", {
      client_key: { id: clientId },
      name: form.name,
      executive_summary: form.executive_summary,
    });
    id = json.id;
    onStep(0, "success");
  } catch (e: any) {
    onStep(0, "error", e.message);
    throw e;
  }

  await delay(DELAY_MS);

  // Step 2: Status
  onStep(1, "running");
  try {
    await proxyCall(apiKey, `/lifecycle-manager/v1/initiatives/${id}/status`, "PUT", { status: form.status });
    onStep(1, "success");
  } catch (e: any) {
    onStep(1, "error", e.message);
    throw e;
  }

  await delay(DELAY_MS);

  // Step 3: Priority
  onStep(2, "running");
  try {
    await proxyCall(apiKey, `/lifecycle-manager/v1/initiatives/${id}/priority`, "PUT", { priority: form.priority });
    onStep(2, "success");
  } catch (e: any) {
    onStep(2, "error", e.message);
    throw e;
  }

  await delay(DELAY_MS);

  // Step 4: Schedule
  onStep(3, "running");
  try {
    await proxyCall(apiKey, `/lifecycle-manager/v1/initiatives/${id}/schedule`, "PUT", {
      fiscal_quarter: form.fiscal_quarter,
    });
    onStep(3, "success");
  } catch (e: any) {
    onStep(3, "error", e.message);
    throw e;
  }

  await delay(DELAY_MS);

  // Step 5: Budget
  onStep(4, "running");
  try {
    await proxyCall(apiKey, `/lifecycle-manager/v1/initiatives/${id}/budget`, "PUT", {
      budget_line_items: form.budget_line_items.map((i) => ({
        label: i.label,
        cost_subunits: dollarsToCents(i.amount),
        cost_type: i.cost_type,
      })),
    });
    onStep(4, "success");
  } catch (e: any) {
    onStep(4, "error", e.message);
    throw e;
  }

  await delay(DELAY_MS);

  // Step 6: Recurring
  onStep(5, "running");
  try {
    await proxyCall(apiKey, `/lifecycle-manager/v1/initiatives/${id}/recurring`, "PUT", {
      recurring_line_items: form.recurring_line_items.map((i) => ({
        label: i.label,
        cost_subunits: dollarsToCents(i.amount),
        cost_type: i.cost_type,
        frequency: i.frequency,
      })),
    });
    onStep(5, "success");
  } catch (e: any) {
    onStep(5, "error", e.message);
    throw e;
  }
}
