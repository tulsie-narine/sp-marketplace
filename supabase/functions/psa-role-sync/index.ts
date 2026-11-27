// PSA Role Sync
// -------------
// Reads PSA company team roles and assigns the matching ScalePad users to each client's CS
// account team with the mapped role. Each PSA is an adapter that returns the same shapes:
//   - ConnectWise: company Team tab rows carry a team role per member.
//   - Autotask: the company owner (Account Manager) gets a synthetic "owner" role, and each
//     Company Team member gets their default Autotask role.
//   - Halo: each client's three agent slots (Account Manager, Primary and Secondary Technician)
//     act as the roles.
// ConnectWise custom fields on the company record can also feed account roles (the value names a
// person) and the client's segment (the value maps to a ScalePad segment). Clients the PSA
// integration didn't link can be linked by hand (config.clientLinks).
//
// Modes:
//   - Manual (browser): x-scalepad-api-key header + { action, psaType?, ... }. Actions:
//     connection.status, connection.save, connection.delete, discover, roles.create, run, runs.list.
//   - Scheduled (pg_cron): { scheduled: true } with the service-role bearer token. Runs every
//     enabled task whose interval (30 days by default) has passed.
//
// The sync only adds assignments. Unmatched members, unmapped roles and per-client failures are
// recorded as skips or errors so one bad record never stops the run.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";
import {
  applyClientLinks,
  applySyncScope,
  AUTOTASK_OWNER_ROLE_ID,
  AUTOTASK_OWNER_ROLE_NAME,
  batchActions,
  batchSegmentUpdates,
  buildFieldTeamEntries,
  buildSegmentPlan,
  FIELD_ROLE_PREFIX,
  memberForValue,
  normalizeValue,
  valueMember,
  type CsSegment,
  type PsaFieldValue,
  buildAutotaskTeamEntries,
  buildHaloTeamEntries,
  buildPlan,
  cleanRoleLabel,
  findRoleByLabel,
  HALO_SLOTS,
  isDue,
  matchMember,
  normalizeEmail,
  normalizeOverrides,
  psaCompanyIdFromLineage,
  type CsAssignment,
  type CsClient,
  type SyncScope,
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

const PSA_TYPES = ["connectwise", "autotask", "halo"] as const;
type PsaType = (typeof PSA_TYPES)[number];
const PSA_LABELS: Record<PsaType, string> = { connectwise: "ConnectWise", autotask: "Autotask", halo: "Halo" };

type Config = {
  psaType?: PsaType;
  roleMap?: Record<string, string>;
  rolePriority?: string[];
  emailOverrides?: Record<string, string>;
  overwriteRoles?: boolean;
  syncIntervalDays?: 7 | 14 | 30;
  /** ConnectWise custom field whose value sets the client's segment ("" = off). */
  segmentFieldId?: string;
  /** Normalized custom field value -> ScalePad segment id. */
  segmentMap?: Record<string, string>;
  /** ScalePad client id -> PSA company id, for clients the PSA integration didn't link. */
  clientLinks?: Record<string, string>;
  /** "selected" limits runs to scopeClientIds, for a test before syncing every client. */
  syncScope?: SyncScope;
  scopeClientIds?: string[];
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

async function loadScalePad(apiKey: string, brandPattern: RegExp, clientLinks?: Record<string, string>) {
  const [rawClients, usersResult, rolesResult] = await Promise.all([
    spFetchAll(apiKey, "/core/v1/clients"),
    spCall(apiKey, `${CS_PREFIX}/users`),
    spCall(apiKey, `${CS_PREFIX}/account-team/roles`),
  ]);
  const lineageClients: CsClient[] = rawClients.map((c) => ({
    id: text(c.id),
    name: text(c.name),
    psaCompanyId: psaCompanyIdFromLineage(c.record_lineage, brandPattern),
  }));
  const clients = applyClientLinks(lineageClients, clientLinks);
  const users: CsUser[] = ((usersResult.data || []) as ApiRow[])
    .filter((u) => u.email)
    .map((u) => ({ id: text(u.user_id), email: text(u.email), name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() }));
  const roles: CsRole[] = ((rolesResult.data || []) as ApiRow[]).map((r) => ({ id: text(r.account_team_member_role_id), label: text(r.role_label) }));
  const autoLinked = new Set(lineageClients.filter((c) => c.psaCompanyId).map((c) => c.id));
  return { clients, users, roles, autoLinked };
}

/** ScalePad segments, without the "Not assigned" placeholder. */
async function loadSegments(apiKey: string): Promise<CsSegment[]> {
  const result = await spCall(apiKey, `${CS_PREFIX}/segments`);
  return ((result.data || []) as ApiRow[])
    .filter((s) => s.segment_id && text(s.segment_id) !== "__EMPTY__")
    .map((s) => ({ id: text(s.segment_id), label: text(s.title) }));
}

/** Each client's current segment id (null when none), from the CS client list. */
async function loadCurrentSegments(apiKey: string) {
  const rows = await spFetchAll(apiKey, `${CS_PREFIX}/clients`);
  const current = new Map<string, string | null>();
  for (const row of rows) {
    const id = text(row.client?.client_id);
    const segmentId = text(row.segment?.segment_id);
    if (id) current.set(id, segmentId && segmentId !== "__EMPTY__" ? segmentId : null);
  }
  return current;
}

async function listCsRoles(apiKey: string): Promise<CsRole[]> {
  const result = await spCall(apiKey, `${CS_PREFIX}/account-team/roles`);
  return ((result.data || []) as ApiRow[]).map((r) => ({ id: text(r.account_team_member_role_id), label: text(r.role_label) }));
}

/**
 * Creates CS account team roles for the given labels. A label that matches an existing role
 * (ignoring case and spacing) reuses that role instead of creating a duplicate. Each label is
 * handled on its own, so one failure doesn't stop the rest. Existing roles are never changed.
 */
async function createCsRoles(apiKey: string, labels: string[]) {
  const roles = await listCsRoles(apiKey);
  const results: Array<{ label: string; id: string | null; created: boolean; error?: string }> = [];
  for (const raw of labels) {
    const label = cleanRoleLabel(raw);
    if (!label) continue;
    const existing = findRoleByLabel(roles, label);
    if (existing) {
      results.push({ label: existing.label, id: existing.id, created: false });
      continue;
    }
    try {
      const created = await spCall(apiKey, `${CS_PREFIX}/account-team/member/role/create`, "POST", { role_label: label, is_primary: false });
      const id = text(created.role_id);
      if (!id) throw new Error("ScalePad did not return the new role's id");
      roles.push({ id, label });
      results.push({ label, id, created: true });
    } catch (error) {
      results.push({ label, id: null, created: false, error: errorMessage(error) });
    }
    await sleep(100);
  }
  return { results, csRoles: roles };
}

async function loadUserAssignments(apiKey: string, userId: string): Promise<CsAssignment[]> {
  const rows = await spFetchAll(apiKey, `${CS_PREFIX}/users/${encodeURIComponent(userId)}/account-team-assignments`);
  return rows.map((r) => ({ userId, clientId: text(r.client_id), roleId: r.team_role_id ? text(r.team_role_id) : null }));
}

// ---------- PSA adapters ----------

type LinkedCompany = { id: string; name: string };

/** A PSA company for manual linking; ConnectWise companies also carry their custom field values. */
type PsaCompany = { id: string; name: string; fields?: Array<{ id: string; caption: string; value: string }> };

type PsaAdapter = {
  /** Matches the vendor brand name in a ScalePad client's record_lineage. */
  brandPattern: RegExp;
  test: () => Promise<void>;
  listMembers: () => Promise<PsaMember[]>;
  /** The roles shown on the mapping screen, in priority order. */
  listTeamRoles: () => Promise<Array<{ id: string; name: string }>>;
  /** Team entries for the linked companies. A company that fails is reported, not thrown. */
  listTeams: (companies: LinkedCompany[]) => Promise<{ entries: PsaTeamEntry[]; errors: string[] }>;
  /** Every active PSA company (for manual links and, on ConnectWise, custom fields). */
  listCompanies: () => Promise<PsaCompany[]>;
};

// ConnectWise Manage: Basic auth (companyId+publicKey:privateKey) plus a clientId header.

function cwBaseUrl(site: string) {
  const host = site.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("ConnectWise site must be a host name such as api-na.myconnectwise.net");
  return `https://${host}/v4_6_release/apis/3.0`;
}

/**
 * ConnectWise wants one client ID per integration, so it comes from the CW_CLIENT_ID secret.
 * Connections saved before that keep working with the client ID they were saved with.
 */
const cwClientId = (settings: Record<string, string>) => (Deno.env.get("CW_CLIENT_ID") || "").trim() || text(settings.clientId).trim();

function connectWiseAdapter(conn: Connection): PsaAdapter {
  const { site, companyId, publicKey } = conn.settings;
  const clientId = cwClientId(conn.settings);
  if (!clientId) throw new Error("The ConnectWise client ID isn't set up yet. Ask your admin to set the CW_CLIENT_ID secret.");
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
    listCompanies: async () => {
      const rows = await fetchAll("/company/companies?fields=id,name,customFields&conditions=deletedFlag=false&orderBy=name");
      return rows.map((c) => ({
        id: text(c.id),
        name: text(c.name),
        fields: ((c.customFields || []) as ApiRow[])
          .filter((f) => f?.id != null && text(f.caption))
          .map((f) => ({ id: text(f.id), caption: text(f.caption), value: typeof f.value === "object" ? "" : text(f.value) })),
      }));
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
    listCompanies: async () =>
      (await query("Companies", [{ op: "eq", field: "isActive", value: true }], ["id", "companyName"]))
        .map((c) => ({ id: text(c.id), name: text(c.companyName) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// HaloPSA: OAuth client credentials against {url}/auth/token, then Bearer calls to {url}/api.
// The API allows 700 requests per rolling 5 minutes, so per-client reads are paced.

function haloBaseUrl(url: string) {
  let parsed: URL;
  try { parsed = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`); }
  catch { throw new Error("Halo URL must look like https://yourcompany.halopsa.com"); }
  if (parsed.protocol !== "https:" || !/^[a-z0-9.-]+$/i.test(parsed.hostname)) throw new Error("Halo URL must be an https address such as https://yourcompany.halopsa.com");
  return `https://${parsed.host}`;
}

function haloAdapter(conn: Connection): PsaAdapter {
  const { url, clientId, tenant } = conn.settings;
  const base = haloBaseUrl(url);
  let token: { value: string; expiresAt: number } | null = null;
  const accessToken = async () => {
    if (token && Date.now() < token.expiresAt) return token.value;
    const result = await fetchWithRetry(`${base}/auth/token${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: conn.secret, scope: "all" }).toString(),
    }, "Halo sign-in");
    const value = text(result.access_token);
    if (!value) throw new Error("Halo did not return an access token. Check the client ID and secret.");
    token = { value, expiresAt: Date.now() + Math.max(60, Number(result.expires_in) || 3600) * 1000 - 30_000 };
    return value;
  };
  const call = async (path: string) =>
    fetchWithRetry(`${base}/api${path}`, { headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json" } }, `Halo GET ${path.split("?")[0]}`);

  return {
    brandPattern: /halo/i,
    test: async () => { await call("/Client?count=1"); },
    listMembers: async () => {
      const result = await call("/Agent?includedisabled=true&includeenabled=true");
      const rows = (Array.isArray(result) ? result : result.results || result.agents || []) as ApiRow[];
      return rows
        .filter((a) => text(a.id) !== "1") // Halo's built-in "Unassigned" agent
        .map((a) => ({
          id: text(a.id),
          identifier: text(a.email) || `agent-${text(a.id)}`,
          name: text(a.name) || [a.firstname, a.surname].filter(Boolean).join(" ").trim(),
          email: text(a.email),
          inactive: a.isdisabled === true,
        }));
    },
    listTeamRoles: async () => HALO_SLOTS.map((slot) => ({ id: slot.id, name: slot.name })),
    listTeams: async (companies) => {
      // pritech / sectech are only on the single-client response, so read each linked client.
      const clients: Array<{ id: string; name: string; slots: Record<string, unknown> }> = [];
      const errors: string[] = [];
      for (const company of companies) {
        try {
          const row = await call(`/Client/${encodeURIComponent(company.id)}`);
          clients.push({ id: company.id, name: company.name, slots: { accountmanagertech: row.accountmanagertech, pritech: row.pritech, sectech: row.sectech } });
        } catch (error) {
          errors.push(`${company.name}: could not read Halo client (${errorMessage(error)})`);
        }
        await sleep(450);
      }
      return { entries: buildHaloTeamEntries(clients), errors };
    },
    listCompanies: async () => {
      const all: PsaCompany[] = [];
      for (let page = 1; page <= 50; page++) {
        const result = await call(`/Client?pageinate=true&page_size=500&page_no=${page}&includeinactive=false`);
        const rows = (Array.isArray(result) ? result : result.clients || []) as ApiRow[];
        all.push(...rows.map((c) => ({ id: text(c.id), name: text(c.name) })));
        if (rows.length < 500) break;
        await sleep(450);
      }
      return all.sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

function adapterFor(conn: Connection): PsaAdapter {
  if (conn.psaType === "connectwise") return connectWiseAdapter(conn);
  if (conn.psaType === "autotask") return autotaskAdapter(conn);
  if (conn.psaType === "halo") return haloAdapter(conn);
  throw new Error(`PSA type ${conn.psaType} is not supported yet.`);
}

/** Validates the form for a PSA. Returns the non-secret settings to store. */
async function connectionSettings(psaType: PsaType, body: ApiRow): Promise<Record<string, string>> {
  const field = (name: string) => text(body[name]).trim();
  if (psaType === "connectwise") {
    const settings = { site: field("site"), companyId: field("companyId"), publicKey: field("publicKey") };
    if (Object.values(settings).some((v) => !v)) throw new Error("Site, company ID and public key are required.");
    if (!cwClientId(settings)) throw new Error("The ConnectWise client ID isn't set up yet. Ask your admin to set the CW_CLIENT_ID secret.");
    return settings;
  }
  if (psaType === "halo") {
    const url = field("url");
    const clientId = field("clientId");
    if (!url || !clientId) throw new Error("Halo URL and client ID are required.");
    return { url: haloBaseUrl(url), clientId, tenant: field("tenant") };
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
    const [sp, psaMembers] = await Promise.all([loadScalePad(apiKey, psa.brandPattern, config.clientLinks), psa.listMembers()]);
    // A test scope leaves every other client out of the run; links themselves are untouched.
    const clients = applySyncScope(sp.clients, config.syncScope, Array.isArray(config.scopeClientIds) ? config.scopeClientIds.map(text) : []);
    const linked = clients.filter((c) => c.psaCompanyId);
    const roleMap = config.roleMap || {};
    const overrides = normalizeOverrides(config.emailOverrides);

    // ConnectWise custom fields: person fields mapped to roles, and the segment field.
    const fieldIds = Object.keys(roleMap).filter((id) => id.startsWith(FIELD_ROLE_PREFIX) && roleMap[id]).map((id) => id.slice(FIELD_ROLE_PREFIX.length));
    const segmentFieldId = psaType === "connectwise" ? text(config.segmentFieldId) : "";
    const fieldValues: PsaFieldValue[] = [];
    if (psaType === "connectwise" && (fieldIds.length || segmentFieldId)) {
      const linkedNames = new Map(linked.map((c) => [c.psaCompanyId!, c.name]));
      for (const company of await psa.listCompanies()) {
        if (!linkedNames.has(company.id)) continue;
        for (const f of company.fields || []) {
          fieldValues.push({ companyId: company.id, companyName: linkedNames.get(company.id)!, fieldId: f.id, caption: f.caption, value: f.value });
        }
      }
    }

    // Team entries for every linked client, when a team role is mapped. A company that fails is skipped, not fatal.
    const teamRolesMapped = Object.keys(roleMap).some((id) => !id.startsWith(FIELD_ROLE_PREFIX) && roleMap[id]);
    const teamResult = teamRolesMapped
      ? await psa.listTeams(linked.map((c) => ({ id: c.psaCompanyId!, name: c.name })))
      : { entries: [] as PsaTeamEntry[], errors: [] as string[] };
    errors.push(...teamResult.errors);
    const fieldTeams = buildFieldTeamEntries({ values: fieldValues, fieldIds, members: psaMembers, overrides });
    const teams = [...teamResult.entries, ...fieldTeams.entries];
    const members = [...psaMembers, ...fieldTeams.extraMembers];

    // Current CS assignments, read only for users who match a PSA member on some team.
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
      clients,
      roles: sp.roles,
      assignments,
      config: {
        roleMap,
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

    // Segments from the custom field. A blank value never changes a client's segment.
    let segmentPlan: ReturnType<typeof buildSegmentPlan> = { updates: [], unchanged: 0, skips: [] };
    let segmentsApplied = 0;
    const failedSegments = new Set<string>();
    if (segmentFieldId) {
      try {
        const [segments, currentSegment] = await Promise.all([loadSegments(apiKey), loadCurrentSegments(apiKey)]);
        segmentPlan = buildSegmentPlan({ clients: linked, values: fieldValues, fieldId: segmentFieldId, valueMap: config.segmentMap || {}, segments, currentSegment });
      } catch (error) {
        errors.push(`Could not read ScalePad segments, so segments were skipped this run (${errorMessage(error)})`);
      }
      if (mode === "live") {
        for (const batch of batchSegmentUpdates(segmentPlan.updates)) {
          try {
            await spCall(apiKey, `${CS_PREFIX}/clients`, "PATCH", { client_ids: batch.clientIds, segment_id: batch.segmentId });
            segmentsApplied += batch.updates.length;
          } catch (error) {
            errors.push(`Segment ${batch.updates[0]?.segmentLabel}: update failed for ${batch.clientIds.length} client(s) (${errorMessage(error)})`);
            for (const u of batch.updates) failedSegments.add(u.clientId);
          }
          await sleep(100);
        }
      }
    }

    const summary = {
      ...plan.counts,
      segmentPlanned: segmentPlan.updates.length,
      segmentApplied: segmentsApplied,
      segmentUnchanged: segmentPlan.unchanged,
      linkedClients: linked.length,
      unlinkedClients: clients.length - linked.length,
      scopedClients: config.syncScope === "selected" ? clients.length : 0,
      psaMembers: psaMembers.length,
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
      skips: [...plan.skips, ...segmentPlan.skips].slice(0, DETAIL_LIMIT),
      segmentChanges: segmentPlan.updates.slice(0, DETAIL_LIMIT).map((u) => ({
        clientName: u.clientName,
        value: u.value,
        from: u.previousLabel,
        to: u.segmentLabel,
        failed: failedSegments.has(u.clientId),
      })),
      notInPsa: plan.notInPsa.slice(0, DETAIL_LIMIT),
      errors: errors.slice(0, DETAIL_LIMIT),
    };
    const planned = plan.actions.length + segmentPlan.updates.length;
    const status = errors.length ? (mode === "live" && planned && !applied && !segmentsApplied ? "failed" : "partial") : "success";
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

type DiscoverInput = { emailOverrides: Record<string, string>; clientLinks: Record<string, string> };

async function discover(db: Db, ownerHash: string, apiKey: string, psaType: PsaType, input: DiscoverInput) {
  const psa = await requireAdapter(db, ownerHash, psaType);
  const warnings: string[] = [];
  const [sp, members, psaRoles, companies, segments] = await Promise.all([
    loadScalePad(apiKey, psa.brandPattern, input.clientLinks),
    psa.listMembers(),
    psa.listTeamRoles(),
    psa.listCompanies().catch((error) => {
      warnings.push(`Couldn't list ${PSA_LABELS[psaType]} companies for manual linking (${errorMessage(error)})`);
      return [] as PsaCompany[];
    }),
    loadSegments(apiKey).catch((error) => {
      warnings.push(`Couldn't load ScalePad segments (${errorMessage(error)})`);
      return [] as CsSegment[];
    }),
  ]);
  const usersByEmail = new Map(sp.users.map((u) => [normalizeEmail(u.email), u]));
  const normalized = normalizeOverrides(input.emailOverrides);
  const companyNames = new Map(companies.map((c) => [c.id, c.name]));
  const linkedCompanyIds = new Set(sp.clients.filter((c) => c.psaCompanyId).map((c) => c.psaCompanyId!));

  // Custom fields (ConnectWise): every field seen on any company, with the values on linked companies.
  const fields = new Map<string, { id: string; caption: string; values: Map<string, { value: string; count: number }> }>();
  for (const company of companies) {
    for (const f of company.fields || []) {
      const entry = fields.get(f.id) || { id: f.id, caption: f.caption, values: new Map() };
      fields.set(f.id, entry);
      const key = normalizeValue(f.value);
      if (!key || !linkedCompanyIds.has(company.id)) continue;
      const v = entry.values.get(key) || { value: f.value.replace(/\s+/g, " ").trim(), count: 0 };
      v.count++;
      entry.values.set(key, v);
    }
  }
  const customFields = [...fields.values()]
    .sort((a, b) => a.caption.localeCompare(b.caption))
    .map((f) => ({
      id: f.id,
      caption: f.caption,
      values: [...f.values.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[1].value.localeCompare(b[1].value))
        .map(([key, v]) => {
          // How this value would match a person, for fields used as a role.
          const found = normalized[key] ? { member: null, ambiguous: false } : memberForValue(v.value, members);
          const member = found.member || valueMember(v.value);
          const match = matchMember(member, usersByEmail, normalized);
          return {
            key,
            value: v.value,
            count: v.count,
            memberName: found.member ? found.member.name || found.member.identifier : null,
            ambiguous: found.ambiguous,
            status: match.status,
            via: match.status === "matched" ? (found.member ? match.via : "override") : null,
            csEmail: match.status === "matched" ? match.user.email : null,
          };
        }),
    }));

  const manualLinks = Object.entries(input.clientLinks || {})
    .map(([clientId, companyId]) => {
      const client = sp.clients.find((c) => c.id === clientId);
      return client ? { clientId, clientName: client.name, companyId, companyName: companyNames.get(companyId) || `Company ${companyId}` } : null;
    })
    .filter(Boolean);

  return {
    psaType,
    psaRoles,
    csRoles: sp.roles,
    segments,
    customFields,
    warnings,
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
      unlinked: sp.clients.filter((c) => !c.psaCompanyId).map((c) => ({ id: c.id, name: c.name })).slice(0, 2000),
      // Linked clients, for picking a test scope.
      linkedList: sp.clients.filter((c) => c.psaCompanyId).map((c) => ({ id: c.id, name: c.name })).slice(0, 5000),
      manual: manualLinks,
    },
    // PSA companies not yet linked to a client, for the manual link picker.
    psaCompanies: companies.filter((c) => !linkedCompanyIds.has(c.id)).map((c) => ({ id: c.id, name: c.name })).slice(0, 5000),
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
    if (needsPsa && !psaType) return json({ error: "Choose ConnectWise, Autotask or Halo." }, 400);

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
          if (!existing) return json({ error: `${{ connectwise: "Private key", autotask: "API secret", halo: "Client secret" }[psaType!]} is required.` }, 400);
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
        return json(await discover(db, ownerHash, apiKey, psaType!, {
          emailOverrides: (body.emailOverrides as Record<string, string>) || {},
          clientLinks: (body.clientLinks as Record<string, string>) || {},
        }));
      case "roles.create": {
        const labels = Array.isArray(body.labels) ? body.labels.map(text).slice(0, 100) : [];
        if (!labels.length) return json({ error: "No role names given." }, 400);
        return json(await createCsRoles(apiKey, labels));
      }
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
