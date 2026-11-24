// PSA Role Sync
// -------------
// Reads PSA company team roles and assigns the matching ScalePad users to each client's CS
// account team with the mapped role. Each PSA is an adapter that returns the same shapes:
//   - ConnectWise: company Team tab rows carry a team role per member.
//   - Autotask: the company owner (Account Manager) gets a synthetic "owner" role, and each
//     Company Team member gets their default Autotask role.
//   - Halo: not yet supported.
//
// Modes:
//   - Manual (browser): x-scalepad-api-key header + { action, psaType?, ... }. Actions:
//     connection.status, connection.save, connection.delete, discover, run, runs.list.
//   - Scheduled (pg_cron): { scheduled: true } with the service-role bearer token. Runs every
//     enabled task whose interval (30 days by default) has passed.
//
// The sync only adds assignments. Unmatched members, unmapped roles and per-client failures are
// recorded as skips or errors so one bad record never stops the run.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";
import {
  AUTOTASK_OWNER_ROLE_ID,
  AUTOTASK_OWNER_ROLE_NAME,
  batchActions,
  buildAutotaskTeamEntries,
  buildPlan,
  isDue,
  matchMember,
  normalizeEmail,
  normalizeOverrides,
  psaCompanyIdFromLineage,
  type CsAssignment,
  type CsClient,
  type CsRole,
  type CsUser,
  type PsaMember,
  type PsaTeamEntry,
} from "./plan.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-scalepad-api-key",
};
const SCALEPAD_BASE = "https://api.scalepad.com";
const CS_PREFIX = "/app/v1";
const APP_ID = "psa-role-sync";
const DETAIL_LIMIT = 500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ScalePad and PSA payloads are untyped JSON; fields are read defensively with text().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiRow = any;

const PSA_TYPES = ["connectwise", "autotask"] as const;
type PsaType = (typeof PSA_TYPES)[number];
const PSA_LABELS: Record<PsaType, string> = { connectwise: "ConnectWise", autotask: "Autotask" };

type Config = {
  psaType?: PsaType;
  roleMap?: Record<string, string>;
  rolePriority?: string[];
  emailOverrides?: Record<string, string>;
  overwriteRoles?: boolean;
  syncIntervalDays?: 7 | 14 | 30;
};

type TaskRow = { id: string; owner_hash: string; name: string; config: Config; schedule_enabled: boolean; last_run_at: string | null };

/** settings: the non-secret fields for the PSA. secret: the decrypted private key / API secret. */
type Connection = { psaType: PsaType; settings: Record<string, string>; secret: string };

type Db = SupabaseClient<ApiRow, ApiRow, ApiRow>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const text = (value: unknown) => (value == null ? "" : String(value));
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const asPsaType = (value: unknown): PsaType | null => (PSA_TYPES as readonly string[]).includes(text(value)) ? (text(value) as PsaType) : null;

async function hash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Credential encryption (AES-GCM, key derived from PSA_CREDENTIALS_KEY) ----------

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

async function credentialKey() {
  const secret = Deno.env.get("PSA_CREDENTIALS_KEY");
  if (!secret) throw new Error("PSA_CREDENTIALS_KEY is not configured for the psa-role-sync function.");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await credentialKey(), new TextEncoder().encode(value));
  return { ciphertext: b64(new Uint8Array(data)), iv: b64(iv) };
}

async function decrypt(ciphertext: string, iv: string) {
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await credentialKey(), unb64(ciphertext));
  return new TextDecoder().decode(data);
}

// ---------- HTTP with retries ----------

async function fetchWithRetry(url: string, init: RequestInit, label: string) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await response.body?.cancel();
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
      continue;
    }
    const raw = await response.text();
    let data: ApiRow = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { response_text: raw }; }
    if (!response.ok) throw new Error(`${label} -> HTTP ${response.status}: ${raw.slice(0, 300)}`);
    return data;
  }
}

// ---------- ScalePad CS ----------

function spCall(apiKey: string, endpoint: string, method = "GET", body?: unknown) {
  return fetchWithRetry(`${SCALEPAD_BASE}${endpoint}`, {
    method,
    headers: { "x-api-key": apiKey, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, `${method} ${endpoint}`);
}

async function spFetchAll(apiKey: string, endpoint: string) {
  const all: ApiRow[] = [];
  let cursor = "";
  for (let page = 0; page < 200; page++) {
    const url = `${endpoint}${endpoint.includes("?") ? "&" : "?"}page_size=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const result = await spCall(apiKey, url);
    const rows = (result.data || []) as ApiRow[];
    all.push(...rows);
    cursor = text(result.next_cursor);
    if (!cursor || rows.length === 0) break;
    await sleep(100);
  }
  return all;
}

async function loadScalePad(apiKey: string, brandPattern: RegExp) {
  const [rawClients, usersResult, rolesResult] = await Promise.all([
    spFetchAll(apiKey, "/core/v1/clients"),
    spCall(apiKey, `${CS_PREFIX}/users`),
    spCall(apiKey, `${CS_PREFIX}/account-team/roles`),
  ]);
  const clients: CsClient[] = rawClients.map((c) => ({
    id: text(c.id),
    name: text(c.name),
    psaCompanyId: psaCompanyIdFromLineage(c.record_lineage, brandPattern),
  }));
  const users: CsUser[] = ((usersResult.data || []) as ApiRow[])
    .filter((u) => u.email)
    .map((u) => ({ id: text(u.user_id), email: text(u.email), name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() }));
  const roles: CsRole[] = ((rolesResult.data || []) as ApiRow[]).map((r) => ({ id: text(r.account_team_member_role_id), label: text(r.role_label) }));
  return { clients, users, roles };
}

async function loadUserAssignments(apiKey: string, userId: string): Promise<CsAssignment[]> {
  const rows = await spFetchAll(apiKey, `${CS_PREFIX}/users/${encodeURIComponent(userId)}/account-team-assignments`);
  return rows.map((r) => ({ userId, clientId: text(r.client_id), roleId: r.team_role_id ? text(r.team_role_id) : null }));
}

// ---------- PSA adapters ----------

type LinkedCompany = { id: string; name: string };

type PsaAdapter = {
  /** Matches the vendor brand name in a ScalePad client's record_lineage. */
  brandPattern: RegExp;
  test: () => Promise<void>;
  listMembers: () => Promise<PsaMember[]>;
  /** The roles shown on the mapping screen, in priority order. */
  listTeamRoles: () => Promise<Array<{ id: string; name: string }>>;
  /** Team entries for the linked companies. A company that fails is reported, not thrown. */
  listTeams: (companies: LinkedCompany[]) => Promise<{ entries: PsaTeamEntry[]; errors: string[] }>;
};

// ConnectWise Manage: Basic auth (companyId+publicKey:privateKey) plus a clientId header.

function cwBaseUrl(site: string) {
  const host = site.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("ConnectWise site must be a host name such as api-na.myconnectwise.net");
  return `https://${host}/v4_6_release/apis/3.0`;
}

function connectWiseAdapter(conn: Connection): PsaAdapter {
  const { site, companyId, publicKey, clientId } = conn.settings;
  const base = cwBaseUrl(site);
  const headers = {
    Authorization: `Basic ${btoa(`${companyId}+${publicKey}:${conn.secret}`)}`,
    clientId,
    Accept: "application/json",
  };
  const call = (path: string) => fetchWithRetry(`${base}${path}`, { headers }, `ConnectWise GET ${path.split("?")[0]}`);
  const fetchAll = async (path: string) => {
    const all: ApiRow[] = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await call(`${path}${path.includes("?") ? "&" : "?"}pageSize=1000&page=${page}`);
      if (!Array.isArray(rows)) break;
      all.push(...rows);
      if (rows.length < 1000) break;
    }
    return all;
  };
  return {
    brandPattern: /connectwise/i,
    test: async () => { await call("/system/info"); },
    listMembers: async () => {
      const rows = await fetchAll("/system/members?fields=id,identifier,firstName,lastName,primaryEmail,officeEmail,inactiveFlag");
      return rows.map((m) => ({
        id: text(m.id),
        identifier: text(m.identifier),
        name: [m.firstName, m.lastName].filter(Boolean).join(" ").trim(),
        email: text(m.primaryEmail || m.officeEmail),
        inactive: m.inactiveFlag === true,
      }));
    },
    listTeamRoles: async () => (await fetchAll("/company/teamRoles?fields=id,name")).map((r) => ({ id: text(r.id), name: text(r.name) })),
    listTeams: async (companies) => {
      const entries: PsaTeamEntry[] = [];
      const errors: string[] = [];
      for (const company of companies) {
        try {
          const rows = await fetchAll(`/company/companies/${encodeURIComponent(company.id)}/teams`);
          // Team rows can name a contact instead of a member; only members can be CS users.
          for (const t of rows) {
            if (t.member?.id == null || t.teamRole?.id == null) continue;
            entries.push({ companyId: company.id, companyName: company.name, memberId: text(t.member.id), teamRoleId: text(t.teamRole.id), teamRoleName: text(t.teamRole.name) });
          }
        } catch (error) {
          errors.push(`${company.name}: could not read ConnectWise team (${errorMessage(error)})`);
        }
        await sleep(50);
      }
      return { entries, errors };
    },
  };
}

// Autotask: UserName / Secret / ApiIntegrationCode headers against the user's zone.

async function autotaskZoneUrl(username: string) {
  const result = await fetchWithRetry(
    `https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation?user=${encodeURIComponent(username)}`,
    { headers: { Accept: "application/json" } },
    "Autotask zone lookup",
  );
  const url = text(result.url);
  if (!/^https:\/\/[a-z0-9.-]+\.autotask\.net\//i.test(url)) throw new Error("Autotask did not return a zone for that username. Check it is the full API user name.");
  return url.endsWith("/") ? url : `${url}/`;
}

function autotaskAdapter(conn: Connection): PsaAdapter {
  const { username, integrationCode, zoneUrl } = conn.settings;
  if (!/^https:\/\/[a-z0-9.-]+\.autotask\.net\//i.test(zoneUrl || "")) throw new Error("Autotask connection has no valid zone. Save the connection again.");
  const base = `${zoneUrl}v1.0`;
  const headers = {
    UserName: username,
    Secret: conn.secret,
    ApiIntegrationCode: integrationCode,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // POST {Entity}/query, following pageDetails.nextPageUrl with the same body (500 per page).
  const query = async (entity: string, filter: unknown[], fields: string[]) => {
    const body = JSON.stringify({ filter, MaxRecords: 500, IncludeFields: fields });
    const all: ApiRow[] = [];
    let url: string | null = `${base}/${entity}/query`;
    for (let page = 0; url && page < 200; page++) {
      if (!url.startsWith(zoneUrl)) throw new Error(`Autotask returned an unexpected paging URL for ${entity}`);
      const result: ApiRow = await fetchWithRetry(url, { method: "POST", headers, body }, `Autotask ${entity} query`);
      all.push(...((result.items || []) as ApiRow[]));
      url = result.pageDetails?.nextPageUrl || null;
    }
    return all;
  };
  const chunks = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

  let roleCache: Promise<ApiRow[]> | null = null;
  const roles = () => (roleCache ||= query("Roles", [{ op: "eq", field: "isActive", value: true }], ["id", "name"]));

  return {
    brandPattern: /autotask/i,
    test: async () => { await query("Roles", [{ op: "eq", field: "id", value: 0 }], ["id"]); },
    listMembers: async () => {
      const rows = await query("Resources", [{ op: "exist", field: "id" }], ["id", "userName", "firstName", "lastName", "email", "isActive"]);
      return rows.map((r) => ({
        id: text(r.id),
        identifier: text(r.userName),
        name: [r.firstName, r.lastName].filter(Boolean).join(" ").trim(),
        email: text(r.email),
        inactive: r.isActive === false,
      }));
    },
    listTeamRoles: async () => [
      { id: AUTOTASK_OWNER_ROLE_ID, name: AUTOTASK_OWNER_ROLE_NAME },
      ...(await roles()).map((r) => ({ id: text(r.id), name: text(r.name) })).sort((a, b) => a.name.localeCompare(b.name)),
    ],
    listTeams: async (companies) => {
      const errors: string[] = [];
      const ids = companies.map((c) => Number(c.id)).filter((id) => Number.isFinite(id));
      const companyRows: ApiRow[] = [];
      const teamRows: ApiRow[] = [];
      // Bulk reads with "in" filters; a failed chunk is reported and the rest carry on.
      for (const chunk of chunks(ids, 200)) {
        try { companyRows.push(...(await query("Companies", [{ op: "in", field: "id", value: chunk }], ["id", "companyName", "ownerResourceID"]))); }
        catch (error) { errors.push(`Could not read ${chunk.length} Autotask companies (${errorMessage(error)})`); }
        try { teamRows.push(...(await query("CompanyTeams", [{ op: "in", field: "companyID", value: chunk }], ["id", "companyID", "resourceID"]))); }
        catch (error) { errors.push(`Could not read Company Teams for ${chunk.length} companies (${errorMessage(error)})`); }
      }
      const defaults = await query("ResourceRoleDepartments", [
        { op: "eq", field: "isDefault", value: true },
        { op: "eq", field: "isActive", value: true },
      ], ["id", "resourceID", "roleID"]);
      const names = new Map(companies.map((c) => [c.id, c.name]));
      const entries = buildAutotaskTeamEntries({
        companies: companyRows.map((c) => ({
          id: text(c.id),
          name: names.get(text(c.id)) || text(c.companyName),
          ownerResourceId: c.ownerResourceID != null ? text(c.ownerResourceID) : null,
        })),
        teamRows: teamRows.map((t) => ({ companyId: text(t.companyID), resourceId: text(t.resourceID) })),
        defaultRoleByResource: new Map(defaults.map((d) => [text(d.resourceID), text(d.roleID)])),
        roleNames: new Map((await roles()).map((r) => [text(r.id), text(r.name)])),
      });
      return { entries, errors };
    },
  };
}

function adapterFor(conn: Connection): PsaAdapter {
  if (conn.psaType === "connectwise") return connectWiseAdapter(conn);
  if (conn.psaType === "autotask") return autotaskAdapter(conn);
  throw new Error(`PSA type ${conn.psaType} is not supported yet.`);
}

/** Validates the form for a PSA. Returns the non-secret settings to store. */
async function connectionSettings(psaType: PsaType, body: ApiRow): Promise<Record<string, string>> {
  const field = (name: string) => text(body[name]).trim();
  if (psaType === "connectwise") {
    const settings = { site: field("site"), companyId: field("companyId"), publicKey: field("publicKey"), clientId: field("clientId") };
    if (Object.values(settings).some((v) => !v)) throw new Error("Site, company ID, public key and client ID are required.");
    return settings;
  }
  const username = field("username");
  const integrationCode = field("integrationCode");
  if (!username || !integrationCode) throw new Error("API username and integration code are required.");
  return { username, integrationCode, zoneUrl: await autotaskZoneUrl(username) };
}

async function loadConnection(db: Db, ownerHash: string, psaType: PsaType): Promise<Connection | null> {
  const { data, error } = await db.from("psa_connections").select("*").eq("owner_hash", ownerHash).eq("psa_type", psaType).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { psaType, settings: (data.settings || {}) as Record<string, string>, secret: await decrypt(data.secret_ciphertext, data.secret_iv) };
}

async function requireAdapter(db: Db, ownerHash: string, psaType: PsaType) {
  const conn = await loadConnection(db, ownerHash, psaType);
  if (!conn) throw new Error(`No ${PSA_LABELS[psaType]} connection saved. Add one on the Connection tab.`);
  return adapterFor(conn);
}

// ---------- Sync run ----------

async function runTask(db: Db, task: TaskRow, apiKey: string, mode: "dry-run" | "live", triggerType: string) {
  const config = task.config || {};
  const psaType = asPsaType(config.psaType) || "connectwise";
  const { data: run, error: runError } = await db.from("psa_role_sync_runs")
    .insert({ task_id: task.id, owner_hash: task.owner_hash, trigger_type: triggerType, mode, status: "running" })
    .select().single();
  if (runError) throw runError;

  const errors: string[] = [];
  try {
    const psa = await requireAdapter(db, task.owner_hash, psaType);
    const [sp, members] = await Promise.all([loadScalePad(apiKey, psa.brandPattern), psa.listMembers()]);
    const linked = sp.clients.filter((c) => c.psaCompanyId);

    // Team entries for every linked client. A company that fails is skipped, not fatal.
    const teamResult = await psa.listTeams(linked.map((c) => ({ id: c.psaCompanyId!, name: c.name })));
    const teams = teamResult.entries;
    errors.push(...teamResult.errors);

    // Current CS assignments, read only for users who match a PSA member on some team.
    const overrides = normalizeOverrides(config.emailOverrides);
    const usersByEmail = new Map(sp.users.map((u) => [normalizeEmail(u.email), u]));
    const membersById = new Map(members.map((m) => [m.id, m]));
    const userIdByMember = new Map<string, string>();
    for (const entry of teams) {
      const member = membersById.get(entry.memberId);
      if (!member) continue;
      const match = matchMember(member, usersByEmail, overrides);
      if (match.status === "matched") userIdByMember.set(member.id, match.user.id);
    }
    const candidateUserIds = new Set(userIdByMember.values());
    const assignments: CsAssignment[] = [];
    const unreadable = new Set<string>();
    for (const userId of candidateUserIds) {
      try { assignments.push(...(await loadUserAssignments(apiKey, userId))); }
      catch (error) {
        unreadable.add(userId);
        const user = sp.users.find((u) => u.id === userId);
        errors.push(`${user?.email || userId}: could not read current assignments, skipped this run (${errorMessage(error)})`);
      }
      await sleep(50);
    }

    // Members whose current CS state could not be read sit this run out (already logged as errors).
    const plannable = teams.filter((entry) => !unreadable.has(userIdByMember.get(entry.memberId) || ""));
    const plan = buildPlan({
      members,
      teams: plannable,
      users: sp.users,
      clients: sp.clients,
      roles: sp.roles,
      assignments,
      config: {
        roleMap: config.roleMap || {},
        rolePriority: Array.isArray(config.rolePriority) ? config.rolePriority.map(text) : [],
        emailOverrides: overrides,
        overwriteRoles: config.overwriteRoles === true,
      },
    });

    let applied = 0;
    const failedActions: string[] = [];
    if (mode === "live") {
      for (const batch of batchActions(plan.actions)) {
        try {
          await spCall(apiKey, `${CS_PREFIX}/clients/account-team`, "PUT", {
            client_ids: batch.clientIds,
            members: [{ user_id: batch.userId, account_team_member_role_id: batch.roleId }],
          });
          applied += batch.actions.length;
          const now = new Date().toISOString();
          await db.from("psa_role_sync_assignments").upsert(batch.actions.map((a) => ({
            task_id: task.id,
            owner_hash: task.owner_hash,
            client_id: a.clientId,
            user_id: a.userId,
            role_id: a.roleId,
            psa_company_id: a.psaCompanyId,
            psa_member_id: a.psaMemberId,
            last_status: a.kind,
            last_synced_at: now,
          })), { onConflict: "task_id,client_id,user_id" });
        } catch (error) {
          const label = batch.actions[0]?.userLabel || batch.userId;
          errors.push(`${label} as ${batch.actions[0]?.roleLabel}: assignment failed for ${batch.clientIds.length} client(s) (${errorMessage(error)})`);
          failedActions.push(...batch.actions.map((a) => `${a.clientName}:${a.userId}`));
        }
        await sleep(100);
      }
    }

    const summary = {
      ...plan.counts,
      linkedClients: linked.length,
      unlinkedClients: sp.clients.length - linked.length,
      psaMembers: members.length,
      planned: plan.actions.length,
      applied,
      errors: errors.length,
    };
    const details = {
      psaType,
      actions: plan.actions.slice(0, DETAIL_LIMIT).map((a) => ({
        kind: a.kind,
        clientName: a.clientName,
        userLabel: a.userLabel,
        roleLabel: a.roleLabel,
        failed: failedActions.includes(`${a.clientName}:${a.userId}`),
      })),
      skips: plan.skips.slice(0, DETAIL_LIMIT),
      notInPsa: plan.notInPsa.slice(0, DETAIL_LIMIT),
      errors: errors.slice(0, DETAIL_LIMIT),
    };
    const status = errors.length ? (mode === "live" && plan.actions.length && !applied ? "failed" : "partial") : "success";
    await db.from("psa_role_sync_runs").update({ status, finished_at: new Date().toISOString(), summary, details }).eq("id", run.id);
    await db.from("scheduled_tasks").update({ last_run_at: new Date().toISOString(), last_run_status: status, last_run_summary: summary }).eq("id", task.id);
    return { task_id: task.id, run_id: run.id, mode, status, summary, details };
  } catch (error) {
    const message = errorMessage(error);
    await db.from("psa_role_sync_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_message: message, details: { psaType, errors } }).eq("id", run.id);
    await db.from("scheduled_tasks").update({ last_run_at: new Date().toISOString(), last_run_status: "failed", last_run_summary: { error: message } }).eq("id", task.id);
    throw error;
  }
}

// ---------- Discovery (feeds the mapping and member tables in the UI) ----------

async function discover(db: Db, ownerHash: string, apiKey: string, psaType: PsaType, overrides: Record<string, string>) {
  const psa = await requireAdapter(db, ownerHash, psaType);
  const [sp, members, psaRoles] = await Promise.all([loadScalePad(apiKey, psa.brandPattern), psa.listMembers(), psa.listTeamRoles()]);
  const usersByEmail = new Map(sp.users.map((u) => [normalizeEmail(u.email), u]));
  const normalized = normalizeOverrides(overrides);
  return {
    psaType,
    psaRoles,
    csRoles: sp.roles,
    members: members.map((m) => {
      const match = matchMember(m, usersByEmail, normalized);
      return {
        id: m.id,
        identifier: m.identifier,
        name: m.name,
        email: m.email,
        status: match.status,
        via: match.status === "matched" ? match.via : null,
        csEmail: match.status === "matched" ? match.user.email : null,
      };
    }),
    clients: {
      total: sp.clients.length,
      linked: sp.clients.filter((c) => c.psaCompanyId).length,
      unlinked: sp.clients.filter((c) => !c.psaCompanyId).map((c) => c.name).slice(0, DETAIL_LIMIT),
    },
  };
}

// ---------- Handler ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db: Db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  try {
    const body = await req.json().catch(() => ({}));

    if (body.scheduled === true) {
      // Only pg_cron (holding the service-role key) may trigger scheduled runs.
      if (req.headers.get("authorization") !== `Bearer ${serviceKey}`) return json({ error: "Unauthorized" }, 401);
      const { data: tasks, error } = await db.from("scheduled_tasks").select("*").eq("app_id", APP_ID).eq("schedule_enabled", true);
      if (error) throw error;
      const results = [];
      for (const task of (tasks || []) as TaskRow[]) {
        if (!isDue(task.last_run_at, Number(task.config?.syncIntervalDays || 30))) continue;
        const { data: saved } = await db.from("saved_api_keys").select("api_key").eq("key_hash", task.owner_hash).maybeSingle();
        if (!saved?.api_key) continue;
        try { results.push(await runTask(db, task, saved.api_key, "live", "scheduled")); }
        catch (error) { results.push({ task_id: task.id, status: "failed", error: errorMessage(error) }); }
      }
      return json({ ok: true, results });
    }

    const apiKey = (req.headers.get("x-scalepad-api-key") || "").trim();
    if (!apiKey || apiKey.length > 1000) return json({ error: "Missing x-scalepad-api-key header" }, 401);
    const ownerHash = await hash(apiKey);
    const action = text(body.action);
    const psaType = asPsaType(body.psaType);
    const needsPsa = ["connection.save", "connection.delete", "discover"].includes(action);
    if (needsPsa && !psaType) return json({ error: "Choose ConnectWise or Autotask." }, 400);

    switch (action) {
      case "connection.status": {
        // Every saved connection for this key, without secrets.
        const { data, error } = await db.from("psa_connections").select("psa_type, settings, verified_at, updated_at").eq("owner_hash", ownerHash);
        if (error) throw error;
        return json({ connections: data || [] });
      }
      case "connection.save": {
        let settings: Record<string, string>;
        try { settings = await connectionSettings(psaType!, body); }
        catch (error) { return json({ error: errorMessage(error) }, 400); }
        let secret = text(body.secret).trim();
        if (!secret) {
          const existing = await loadConnection(db, ownerHash, psaType!);
          if (!existing) return json({ error: `${psaType === "autotask" ? "API secret" : "Private key"} is required.` }, 400);
          secret = existing.secret;
        }
        try { await adapterFor({ psaType: psaType!, settings, secret }).test(); }
        catch (error) { return json({ error: `${PSA_LABELS[psaType!]} rejected these details: ${errorMessage(error)}` }, 400); }
        const sealed = await encrypt(secret);
        const { error } = await db.from("psa_connections").upsert({
          owner_hash: ownerHash,
          psa_type: psaType,
          settings,
          secret_ciphertext: sealed.ciphertext,
          secret_iv: sealed.iv,
          verified_at: new Date().toISOString(),
        }, { onConflict: "owner_hash,psa_type" });
        if (error) throw error;
        return json({ connected: true });
      }
      case "connection.delete": {
        await db.from("psa_connections").delete().eq("owner_hash", ownerHash).eq("psa_type", psaType);
        // Turn off schedules that sync from this PSA.
        const { data: tasks } = await db.from("scheduled_tasks").select("id, config").eq("owner_hash", ownerHash).eq("app_id", APP_ID);
        for (const task of tasks || []) {
          if ((asPsaType(task.config?.psaType) || "connectwise") === psaType) {
            await db.from("scheduled_tasks").update({ schedule_enabled: false }).eq("id", task.id);
          }
        }
        return json({ connected: false });
      }
      case "discover":
        return json(await discover(db, ownerHash, apiKey, psaType!, (body.emailOverrides as Record<string, string>) || {}));
      case "runs.list": {
        const { data, error } = await db.from("psa_role_sync_runs").select("*")
          .eq("owner_hash", ownerHash).eq("task_id", text(body.taskId)).order("started_at", { ascending: false }).limit(20);
        if (error) throw error;
        return json({ data });
      }
      case "run": {
        const { data: task, error } = await db.from("scheduled_tasks").select("*")
          .eq("id", text(body.taskId)).eq("owner_hash", ownerHash).eq("app_id", APP_ID).maybeSingle();
        if (error) throw error;
        if (!task) return json({ error: "Sync settings not found. Save them first." }, 404);
        const mode = body.mode === "live" ? "live" : "dry-run";
        return json(await runTask(db, task as TaskRow, apiKey, mode, "manual"));
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});
