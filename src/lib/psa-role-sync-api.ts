/**
 * PSA Role Sync API helpers.
 * Sync settings are saved through the user-vault generic tasks (app_id "psa-role-sync").
 * PSA credentials, discovery and runs go through the psa-role-sync edge function, so PSA
 * secrets never come back to the browser.
 */

import { supabase } from "@/integrations/supabase/client";
import { deleteTask, listTasks, saveTask, setTaskSchedule, type ScheduledTask } from "@/lib/user-vault-api";

export const PSA_ROLE_SYNC_APP_ID = "psa-role-sync";

export type PsaType = "connectwise" | "autotask" | "halo";

export type PsaRoleSyncConfig = {
  psaType: PsaType;
  /** PSA role id -> ScalePad CS account role id. */
  roleMap: Record<string, string>;
  /** Mapped PSA role ids in on-screen order: the priority when a member holds two mapped roles on one company. */
  rolePriority: string[];
  /** PSA email or identifier -> ScalePad email. */
  emailOverrides: Record<string, string>;
  overwriteRoles: boolean;
  syncIntervalDays: 7 | 14 | 30;
  /** ConnectWise only: the custom field whose value sets each client's segment ("" = off). */
  segmentFieldId: string;
  /** Custom field value (lowercase, single spaces) -> ScalePad segment id. */
  segmentMap: Record<string, string>;
  /** ScalePad client id -> PSA company id, for clients the PSA integration didn't link. */
  clientLinks: Record<string, string>;
};

/** roleMap key for a ConnectWise custom field used as an account role. */
export const fieldRoleKey = (fieldId: string) => `field:${fieldId}`;
export const isFieldRoleKey = (key: string) => key.startsWith("field:");
/** The key a custom field value is mapped and matched by: lowercase with single spaces. */
export const valueKey = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

export const emptyPsaRoleSyncConfig = (psaType: PsaType = "connectwise"): PsaRoleSyncConfig => ({
  psaType,
  roleMap: {},
  rolePriority: [],
  emailOverrides: {},
  overwriteRoles: false,
  syncIntervalDays: 30,
  segmentFieldId: "",
  segmentMap: {},
  clientLinks: {},
});

// --- PSA catalog: what the picker shows and which connection fields each PSA needs ---

export type PsaField = {
  key: string;
  label: string;
  hint?: string;
  /** The secret field: write-only, encrypted server-side, blank on edit keeps the saved value. */
  secret?: boolean;
  /** Can be left blank. */
  optional?: boolean;
};

export type PsaOption = {
  id: PsaType;
  label: string;
  blurb: string;
  available: boolean;
  /** How the PSA's roles work, shown above the mapping table. */
  roleHelp: string;
  /** Permissions the API user needs, shown on the Connection tab. */
  accessHelp: string;
  fields: PsaField[];
};

export const PSA_OPTIONS: PsaOption[] = [
  {
    id: "connectwise",
    label: "ConnectWise PSA",
    blurb: "Company Team roles (Account Manager, Technician and so on) on each company.",
    available: true,
    roleHelp:
      "Pick the ScalePad account role for each ConnectWise team role. If someone holds two mapped roles on one company, the role higher in this list wins.",
    accessHelp:
      "Use an API member with read access to System > Members and Companies > Company Teams and Team Roles. The sync never writes to ConnectWise.",
    fields: [
      { key: "site", label: "Site" },
      { key: "companyId", label: "Company ID", hint: "The company you sign in to ConnectWise with" },
      { key: "clientId", label: "Client ID", hint: "From developer.connectwise.com" },
      { key: "publicKey", label: "Public key" },
      { key: "secret", label: "Private key", secret: true },
    ],
  },
  {
    id: "autotask",
    label: "Autotask PSA",
    blurb: "Each company's Account Manager, plus Company Team members by their default role.",
    available: true,
    roleHelp:
      "The company's Account Manager gets the role on the first row. Everyone else on the Company Team gets the role mapped from their default Autotask role. If someone matches two rows on one company, the higher row wins.",
    accessHelp:
      "Use an API-only user whose security level can read Resources, Roles, Companies and Company Teams. The sync never writes to Autotask.",
    fields: [
      { key: "username", label: "API username", hint: "The API user's full username; used to find your Autotask zone" },
      { key: "integrationCode", label: "API integration code", hint: "The tracking identifier on the API user's Security tab" },
      { key: "secret", label: "API secret", secret: true },
    ],
  },
  {
    id: "halo",
    label: "HaloPSA",
    blurb: "Each client's Account Manager, Primary Technician and Secondary Technician.",
    available: true,
    roleHelp:
      "Halo has no client team list; each client has these three agent slots. Pick the ScalePad role for each. If one agent fills two slots on a client, the higher row wins.",
    accessHelp:
      "Create an API application in Halo (Configuration > Integrations > HaloPSA API > Applications) using Client ID and Secret, with read access to agents and customers. The sync never writes to Halo.",
    fields: [
      { key: "url", label: "Halo URL", hint: "The address you sign in at, for example https://yourcompany.halopsa.com" },
      { key: "clientId", label: "Client ID" },
      { key: "tenant", label: "Tenant", hint: "Only if Halo gave you one; most can leave this blank", optional: true },
      { key: "secret", label: "Client secret", secret: true },
    ],
  },
];

export const psaOption = (psaType: PsaType) => PSA_OPTIONS.find((o) => o.id === psaType)!;
export const psaShortName = (psaType: PsaType) => ({ connectwise: "ConnectWise", autotask: "Autotask", halo: "Halo" })[psaType];

// --- Types returned by the edge function ---

export type PsaConnection = {
  psa_type: PsaType;
  /** Non-secret connection fields (see PSA_OPTIONS fields). */
  settings: Record<string, string>;
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

export type DiscoveredFieldValue = {
  key: string;
  value: string;
  /** Linked clients with this value. */
  count: number;
  /** The PSA member the value names, if any. */
  memberName: string | null;
  ambiguous: boolean;
  status: "matched" | "inactive" | "unmatched";
  via: "email" | "override" | null;
  csEmail: string | null;
};

export type DiscoveredField = { id: string; caption: string; values: DiscoveredFieldValue[] };

export type Discovery = {
  psaType: PsaType;
  psaRoles: Array<{ id: string; name: string }>;
  csRoles: Array<{ id: string; label: string }>;
  segments: Array<{ id: string; label: string }>;
  /** ConnectWise company custom fields; empty for other PSAs. */
  customFields: DiscoveredField[];
  warnings: string[];
  members: DiscoveredMember[];
  clients: {
    total: number;
    linked: number;
    unlinked: Array<{ id: string; name: string }>;
    manual: Array<{ clientId: string; clientName: string; companyId: string; companyName: string }>;
  };
  /** PSA companies not linked to any ScalePad client, for manual linking. */
  psaCompanies: Array<{ id: string; name: string }>;
};

export type RunDetails = {
  actions: Array<{ kind: "assign" | "set-role" | "change-role"; clientName: string; userLabel: string; roleLabel: string; failed: boolean }>;
  skips: Array<{ reason: string; clientName: string; memberLabel: string; detail: string }>;
  notInPsa: Array<{ clientName: string; userLabel: string; roleLabel: string }>;
  segmentChanges?: Array<{ clientName: string; value: string; from: string; to: string; failed: boolean }>;
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

export const getPsaConnections = async () => (await callSync<{ connections: PsaConnection[] }>("connection.status")).connections || [];

/** fields: the PSA's form values keyed by PsaField.key; an empty secret keeps the saved one. */
export const savePsaConnection = (psaType: PsaType, fields: Record<string, string>) =>
  callSync<{ connected: boolean }>("connection.save", { psaType, ...fields });

export const deletePsaConnection = (psaType: PsaType) => callSync<{ connected: boolean }>("connection.delete", { psaType });

export const discoverPsa = (psaType: PsaType, emailOverrides: Record<string, string>, clientLinks: Record<string, string> = {}) =>
  callSync<Discovery>("discover", { psaType, emailOverrides, clientLinks });

export type CreatedRoleResult = { label: string; id: string | null; created: boolean; error?: string };

/**
 * Creates ScalePad CS account team roles from PSA role names. A name matching an existing CS role
 * (ignoring case) reuses it instead. Returns a result per name plus the updated CS role list.
 */
export const createCsRoles = (labels: string[]) =>
  callSync<{ results: CreatedRoleResult[]; csRoles: Array<{ id: string; label: string }> }>("roles.create", { labels });

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
  "field-value-unmatched": "Field value not matched",
  "segment-not-mapped": "Segment not mapped",
  "segment-missing-in-scalepad": "Mapped segment deleted",
};
