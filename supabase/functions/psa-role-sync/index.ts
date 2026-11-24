// PSA Role Sync
// -------------
// Reads PSA company team roles (ConnectWise today; Autotask and Halo slot in as adapters)
// and assigns the matching ScalePad users to each client's CS account team with the mapped role.
//
// Modes:
//   - Manual (browser): x-scalepad-api-key header + { action, ... }. Actions: connection.status,
//     connection.save, connection.delete, discover, run, runs.list.
//   - Scheduled (pg_cron): { scheduled: true } with the service-role bearer token. Runs every
//     enabled task whose interval (30 days by default) has passed.
//
// The sync only adds assignments. Unmatched members, unmapped roles and per-client failures are
// recorded as skips or errors so one bad record never stops the run.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";
import {
  batchActions,
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

// ScalePad and ConnectWise payloads are untyped JSON; fields are read defensively with text().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiRow = any;

type PsaType = "connectwise";

type Config = {
  psaType?: PsaType;
  roleMap?: Record<string, string>;
  emailOverrides?: Record<string, string>;
  overwriteRoles?: boolean;
  syncIntervalDays?: 7 | 14 | 30;
};

type TaskRow = { id: string; owner_hash: string; name: string; config: Config; schedule_enabled: boolean; last_run_at: string | null };

type Connection = { site: string; companyId: string; publicKey: string; privateKey: string; clientId: string };

type Db = SupabaseClient<ApiRow, ApiRow, ApiRow>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const text = (value: unknown) => (value == null ? "" : String(value));
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

type PsaAdapter = {
  brandPattern: RegExp;
  test: () => Promise<void>;
  listMembers: () => Promise<PsaMember[]>;
  listTeamRoles: () => Promise<Array<{ id: string; name: string }>>;
  listCompanyTeam: (companyId: string, companyName: string) => Promise<PsaTeamEntry[]>;
};

function cwBaseUrl(site: string) {
  const host = site.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("ConnectWise site must be a host name such as api-na.myconnectwise.net");
  return `https://${host}/v4_6_release/apis/3.0`;
}

function connectWiseAdapter(conn: Connection): PsaAdapter {
  const base = cwBaseUrl(conn.site);
  const headers = {
    Authorization: `Basic ${btoa(`${conn.companyId}+${conn.publicKey}:${conn.privateKey}`)}`,
    clientId: conn.clientId,
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
    listCompanyTeam: async (companyId, companyName) => {
      const rows = await fetchAll(`/company/companies/${encodeURIComponent(companyId)}/teams`);
      // Team rows can name a contact instead of a member; only members can be CS users.
      return rows
        .filter((t) => t.member?.id != null && t.teamRole?.id != null)
        .map((t) => ({
          companyId,
          companyName,
          memberId: text(t.member.id),
          teamRoleId: text(t.teamRole.id),
          teamRoleName: text(t.teamRole.name),
        }));
    },
  };
}

function adapterFor(psaType: PsaType, conn: Connection): PsaAdapter {
  if (psaType === "connectwise") return connectWiseAdapter(conn);
  throw new Error(`PSA type ${psaType} is not supported yet.`);
}

async function loadConnection(db: Db, ownerHash: string, psaType: PsaType): Promise<Connection | null> {
  const { data, error } = await db.from("psa_connections").select("*").eq("owner_hash", ownerHash).eq("psa_type", psaType).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    site: data.site,
    companyId: data.company_id,
    publicKey: data.public_key,
    clientId: data.client_id,
    privateKey: await decrypt(data.private_key_ciphertext, data.private_key_iv),
  };
}

// ---------- Sync run ----------

async function runTask(db: Db, task: TaskRow, apiKey: string, mode: "dry-run" | "live", triggerType: string) {
  const config = task.config || {};
  const psaType = config.psaType || "connectwise";
  const { data: run, error: runError } = await db.from("psa_role_sync_runs")
    .insert({ task_id: task.id, owner_hash: task.owner_hash, trigger_type: triggerType, mode, status: "running" })
    .select().single();
  if (runError) throw runError;

  const errors: string[] = [];
  try {
    const conn = await loadConnection(db, task.owner_hash, psaType);
    if (!conn) throw new Error("No ConnectWise connection saved. Add one on the Connection tab.");
    const psa = adapterFor(psaType, conn);

    const [sp, members] = await Promise.all([loadScalePad(apiKey, psa.brandPattern), psa.listMembers()]);
    const linked = sp.clients.filter((c) => c.psaCompanyId);

    // Company teams, one call per linked client. A failure skips that client only.
    const teams: PsaTeamEntry[] = [];
    for (const client of linked) {
      try { teams.push(...(await psa.listCompanyTeam(client.psaCompanyId!, client.name))); }
      catch (error) { errors.push(`${client.name}: could not read PSA team (${errorMessage(error)})`); }
      await sleep(50);
    }

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
      config: { roleMap: config.roleMap || {}, emailOverrides: overrides, overwriteRoles: config.overwriteRoles === true },
    });
    const skips = plan.skips;

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
      actions: plan.actions.slice(0, DETAIL_LIMIT).map((a) => ({
        kind: a.kind,
        clientName: a.clientName,
        userLabel: a.userLabel,
        roleLabel: a.roleLabel,
        failed: failedActions.includes(`${a.clientName}:${a.userId}`),
      })),
      skips: skips.slice(0, DETAIL_LIMIT),
      notInPsa: plan.notInPsa.slice(0, DETAIL_LIMIT),
      errors: errors.slice(0, DETAIL_LIMIT),
    };
    const status = errors.length ? (mode === "live" && plan.actions.length && !applied ? "failed" : "partial") : "success";
    await db.from("psa_role_sync_runs").update({ status, finished_at: new Date().toISOString(), summary, details }).eq("id", run.id);
    await db.from("scheduled_tasks").update({ last_run_at: new Date().toISOString(), last_run_status: status, last_run_summary: summary }).eq("id", task.id);
    return { task_id: task.id, run_id: run.id, mode, status, summary, details };
  } catch (error) {
    const message = errorMessage(error);
    await db.from("psa_role_sync_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_message: message, details: { errors } }).eq("id", run.id);
    await db.from("scheduled_tasks").update({ last_run_at: new Date().toISOString(), last_run_status: "failed", last_run_summary: { error: message } }).eq("id", task.id);
    throw error;
  }
}

// ---------- Discovery (feeds the mapping and member tables in the UI) ----------

async function discover(db: Db, ownerHash: string, apiKey: string, psaType: PsaType, overrides: Record<string, string>) {
  const conn = await loadConnection(db, ownerHash, psaType);
  if (!conn) throw new Error("No ConnectWise connection saved. Add one on the Connection tab.");
  const psa = adapterFor(psaType, conn);
  const [sp, members, psaRoles] = await Promise.all([loadScalePad(apiKey, psa.brandPattern), psa.listMembers(), psa.listTeamRoles()]);
  const usersByEmail = new Map(sp.users.map((u) => [normalizeEmail(u.email), u]));
  const normalized = normalizeOverrides(overrides);
  return {
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
  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
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
    const psaType: PsaType = "connectwise";
    const action = text(body.action);

    switch (action) {
      case "connection.status": {
        const { data } = await db.from("psa_connections").select("site, company_id, public_key, client_id, verified_at, updated_at")
          .eq("owner_hash", ownerHash).eq("psa_type", psaType).maybeSingle();
        return json({ connected: !!data, connection: data || null });
      }
      case "connection.save": {
        const site = text(body.site).trim();
        const companyId = text(body.companyId).trim();
        const publicKey = text(body.publicKey).trim();
        const clientId = text(body.clientId).trim();
        let privateKey = text(body.privateKey).trim();
        if (!site || !companyId || !publicKey || !clientId) return json({ error: "Site, company ID, public key and client ID are required." }, 400);
        if (!privateKey) {
          const existing = await loadConnection(db, ownerHash, psaType);
          if (!existing) return json({ error: "Private key is required." }, 400);
          privateKey = existing.privateKey;
        }
        const conn = { site, companyId, publicKey, privateKey, clientId };
        try { await adapterFor(psaType, conn).test(); }
        catch (error) { return json({ error: `ConnectWise rejected these details: ${errorMessage(error)}` }, 400); }
        const sealed = await encrypt(privateKey);
        const { error } = await db.from("psa_connections").upsert({
          owner_hash: ownerHash,
          psa_type: psaType,
          site,
          company_id: companyId,
          public_key: publicKey,
          client_id: clientId,
          private_key_ciphertext: sealed.ciphertext,
          private_key_iv: sealed.iv,
          verified_at: new Date().toISOString(),
        }, { onConflict: "owner_hash,psa_type" });
        if (error) throw error;
        return json({ connected: true });
      }
      case "connection.delete": {
        await db.from("psa_connections").delete().eq("owner_hash", ownerHash).eq("psa_type", psaType);
        await db.from("scheduled_tasks").update({ schedule_enabled: false }).eq("owner_hash", ownerHash).eq("app_id", APP_ID);
        return json({ connected: false });
      }
      case "discover":
        return json(await discover(db, ownerHash, apiKey, psaType, (body.emailOverrides as Record<string, string>) || {}));
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
