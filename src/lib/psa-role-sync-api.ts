/**
 * PSA Role Sync API helpers.
 * Sync settings are saved through the user-vault generic tasks (app_id "psa-role-sync").
 * PSA credentials, discovery and runs go through the psa-role-sync edge function, so the
 * ConnectWise private key never comes back to the browser.
 */

import { supabase } from "@/integrations/supabase/client";
import { deleteTask, listTasks, saveTask, setTaskSchedule, type ScheduledTask } from "@/lib/user-vault-api";

export const PSA_ROLE_SYNC_APP_ID = "psa-role-sync";

export type PsaRoleSyncConfig = {
  psaType: "connectwise";
  /** PSA team role id -> ScalePad CS account role id. Listed order is the priority when a member holds two roles. */
  roleMap: Record<string, string>;
  /** PSA email or identifier -> ScalePad email. */
  emailOverrides: Record<string, string>;
  overwriteRoles: boolean;
  syncIntervalDays: 7 | 14 | 30;
};

export const emptyPsaRoleSyncConfig = (): PsaRoleSyncConfig => ({
  psaType: "connectwise",
  roleMap: {},
  emailOverrides: {},
  overwriteRoles: false,
  syncIntervalDays: 30,
});

export type PsaConnection = {
  site: string;
  company_id: string;
  public_key: string;
  client_id: string;
  verified_at: string | null;
  updated_at: string;
};

export type DiscoveredMember = {
  id: string;
  identifier: string;
  name: string;
  email: string;
  status: "matched" | "inactive" | "unmatched";
  via: "email" | "override" | null;
  csEmail: string | null;
};

export type Discovery = {
  psaRoles: Array<{ id: string; name: string }>;
  csRoles: Array<{ id: string; label: string }>;
  members: DiscoveredMember[];
  clients: { total: number; linked: number; unlinked: string[] };
};

export type RunDetails = {
  actions: Array<{ kind: "assign" | "set-role" | "change-role"; clientName: string; userLabel: string; roleLabel: string; failed: boolean }>;
  skips: Array<{ reason: string; clientName: string; memberLabel: string; detail: string }>;
  notInPsa: Array<{ clientName: string; userLabel: string; roleLabel: string }>;
  errors: string[];
};

export type RunResult = {
  task_id: string;
  run_id: string;
  mode: "dry-run" | "live";
  status: "success" | "partial" | "failed";
  summary: Record<string, number>;
  details: RunDetails;
};

export type RunRecord = {
  id: string;
  trigger_type: string;
  mode: "dry-run" | "live";
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: Record<string, number>;
  details: Partial<RunDetails>;
  error_message: string | null;
};

async function callSync<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const apiKey = sessionStorage.getItem("sp_api_key") || "";
  if (!apiKey || apiKey === "admin-key") throw new Error("Sign in with a ScalePad API key to use PSA Role Sync.");
  const { data, error } = await supabase.functions.invoke("psa-role-sync", {
    body: { action, ...payload },
    headers: { "x-scalepad-api-key": apiKey },
  });
  if (data?.error) throw new Error(data.error);
  if (error) {
    let msg = error.message || "PSA Role Sync request failed";
    try {
      const ctx = await (error as { context?: { json?: () => Promise<{ error?: string }> } }).context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return data as T;
}

export const getPsaConnection = () => callSync<{ connected: boolean; connection: PsaConnection | null }>("connection.status");

export const savePsaConnection = (input: { site: string; companyId: string; publicKey: string; privateKey: string; clientId: string }) =>
  callSync<{ connected: boolean }>("connection.save", input);

export const deletePsaConnection = () => callSync<{ connected: boolean }>("connection.delete");

export const discoverPsa = (emailOverrides: Record<string, string>) => callSync<Discovery>("discover", { emailOverrides });

export const runPsaRoleSync = (taskId: string, mode: "dry-run" | "live") => callSync<RunResult>("run", { taskId, mode });

export const listPsaRoleSyncRuns = async (taskId: string) => (await callSync<{ data: RunRecord[] }>("runs.list", { taskId })).data || [];

export const listPsaRoleSyncTasks = () => listTasks(PSA_ROLE_SYNC_APP_ID) as Promise<ScheduledTask<PsaRoleSyncConfig>[]>;

export const savePsaRoleSyncTask = (input: { id?: string; name: string; config: PsaRoleSyncConfig; scheduleEnabled: boolean }) =>
  saveTask({ ...input, appId: PSA_ROLE_SYNC_APP_ID }) as Promise<ScheduledTask<PsaRoleSyncConfig>>;

export const setPsaRoleSyncSchedule = (id: string, enabled: boolean) => setTaskSchedule(id, enabled);
export const deletePsaRoleSyncTask = (id: string) => deleteTask(id);

export const CW_SITES = [
  { value: "api-na.myconnectwise.net", label: "North America (api-na.myconnectwise.net)" },
  { value: "api-eu.myconnectwise.net", label: "Europe (api-eu.myconnectwise.net)" },
  { value: "api-au.myconnectwise.net", label: "Australia (api-au.myconnectwise.net)" },
];

export const SKIP_REASON_LABELS: Record<string, string> = {
  "member-not-in-scalepad": "No ScalePad user",
  "member-inactive": "Inactive in PSA",
  "member-unknown": "Unknown PSA member",
  "role-not-mapped": "Role not mapped",
  "role-missing-in-scalepad": "Mapped role deleted",
  "duplicate-role": "Several mapped roles",
  "role-conflict": "Different role in ScalePad",
};
