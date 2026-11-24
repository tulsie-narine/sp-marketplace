// PSA Role Sync planner. Pure functions only (no imports, no I/O) so the edge function
// and the Vitest suite share the same logic.
//
// Input: PSA members and company team entries, plus ScalePad CS users, clients, roles and
// the current CS assignments of the matched users. Output: the assignments to make and
// everything that was skipped, with a reason. Nothing here throws on bad records: an
// unmatched member or unmapped role becomes a skip so the run always completes.

export type PsaMember = {
  id: string;
  identifier: string;
  name: string;
  email: string;
  inactive: boolean;
};

export type PsaTeamEntry = {
  companyId: string;
  companyName: string;
  memberId: string;
  teamRoleId: string;
  teamRoleName: string;
};

export type CsUser = { id: string; email: string; name: string };
export type CsClient = { id: string; name: string; psaCompanyId: string | null };
export type CsRole = { id: string; label: string };
export type CsAssignment = { userId: string; clientId: string; roleId: string | null };

export type PlanConfig = {
  /** PSA team role id -> CS account role id. Roles not listed (or mapped to "") are not synced. */
  roleMap: Record<string, string>;
  /** PSA email or identifier (lowercase) -> CS email, for people whose emails differ. */
  emailOverrides: Record<string, string>;
  /** Replace a different role already set in CS. Off by default: conflicts are reported instead. */
  overwriteRoles: boolean;
  /**
   * PSA role ids in priority order, for a member who holds two mapped roles on one company.
   * Kept as a list because object key order can't carry it: number-like keys always sort first.
   */
  rolePriority?: string[];
};

export type PlanAction = {
  kind: "assign" | "set-role" | "change-role";
  clientId: string;
  clientName: string;
  userId: string;
  userLabel: string;
  roleId: string;
  roleLabel: string;
  previousRoleId: string | null;
  psaCompanyId: string;
  psaMemberId: string;
};

export type SkipReason =
  | "member-not-in-scalepad"
  | "member-inactive"
  | "member-unknown"
  | "role-not-mapped"
  | "role-missing-in-scalepad"
  | "duplicate-role"
  | "role-conflict";

export type PlanSkip = {
  reason: SkipReason;
  clientName: string;
  memberLabel: string;
  detail: string;
};

export type PlanNotInPsa = { clientName: string; userLabel: string; roleLabel: string };

export type PlanResult = {
  actions: PlanAction[];
  unchanged: number;
  skips: PlanSkip[];
  notInPsa: PlanNotInPsa[];
  matchedUserIds: string[];
  counts: Record<string, number>;
};

export const SKIP_LABELS: Record<SkipReason, string> = {
  "member-not-in-scalepad": "PSA member has no ScalePad user",
  "member-inactive": "PSA member is inactive",
  "member-unknown": "PSA member not found",
  "role-not-mapped": "PSA role is not mapped",
  "role-missing-in-scalepad": "Mapped ScalePad role no longer exists",
  "duplicate-role": "Member holds more than one mapped role on this company",
  "role-conflict": "Different role already set in ScalePad",
};

export const normalizeEmail = (value: string | null | undefined) => (value || "").trim().toLowerCase();

export type MemberMatch =
  | { status: "matched"; user: CsUser; via: "email" | "override" }
  | { status: "inactive" }
  | { status: "unmatched"; email: string };

/** Match one PSA member to a ScalePad user: override first, then email. */
export function matchMember(member: PsaMember, usersByEmail: Map<string, CsUser>, overrides: Record<string, string>): MemberMatch {
  if (member.inactive) return { status: "inactive" };
  const email = normalizeEmail(member.email);
  const overrideTarget = overrides[email] || overrides[normalizeEmail(member.identifier)];
  if (overrideTarget) {
    const user = usersByEmail.get(normalizeEmail(overrideTarget));
    if (user) return { status: "matched", user, via: "override" };
  }
  const user = email ? usersByEmail.get(email) : undefined;
  if (user) return { status: "matched", user, via: "email" };
  return { status: "unmatched", email };
}

export function normalizeOverrides(overrides: Record<string, string> | undefined) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    if (normalizeEmail(key) && normalizeEmail(value)) out[normalizeEmail(key)] = normalizeEmail(value);
  }
  return out;
}

const memberLabel = (member: PsaMember | undefined, fallbackId: string) =>
  member ? (member.name ? `${member.name} (${member.identifier})` : member.identifier) : `Member ${fallbackId}`;

const userLabel = (user: CsUser) => user.name || user.email;

export function buildPlan(input: {
  members: PsaMember[];
  teams: PsaTeamEntry[];
  users: CsUser[];
  clients: CsClient[];
  roles: CsRole[];
  assignments: CsAssignment[];
  config: PlanConfig;
}): PlanResult {
  const { config } = input;
  const overrides = normalizeOverrides(config.emailOverrides);
  const usersByEmail = new Map(input.users.map((u) => [normalizeEmail(u.email), u]));
  const membersById = new Map(input.members.map((m) => [m.id, m]));
  const rolesById = new Map(input.roles.map((r) => [r.id, r]));
  const clientsByPsaId = new Map<string, CsClient>();
  for (const client of input.clients) if (client.psaCompanyId) clientsByPsaId.set(client.psaCompanyId, client);
  const current = new Map(input.assignments.map((a) => [`${a.clientId}:${a.userId}`, a]));
  // Priority when one member holds several mapped roles on a company; unlisted roles go last.
  const priority = new Map((config.rolePriority || []).map((id, index) => [id, index]));
  const rank = (roleId: string) => priority.get(roleId) ?? Number.MAX_SAFE_INTEGER;

  const actions: PlanAction[] = [];
  const skips: PlanSkip[] = [];
  const matched = new Set<string>();
  let unchanged = 0;

  // Group team entries per (company, member) so a member with two roles gets one decision.
  const grouped = new Map<string, PsaTeamEntry[]>();
  for (const entry of input.teams) {
    const key = `${entry.companyId}:${entry.memberId}`;
    grouped.set(key, [...(grouped.get(key) || []), entry]);
  }
  const desired = new Set<string>();

  for (const entries of grouped.values()) {
    const first = entries[0];
    const client = clientsByPsaId.get(first.companyId);
    if (!client) continue; // Teams are only fetched for linked companies; ignore defensively.
    const member = membersById.get(first.memberId);
    const label = memberLabel(member, first.memberId);
    if (!member) {
      skips.push({ reason: "member-unknown", clientName: client.name, memberLabel: label, detail: `No PSA member with id ${first.memberId}` });
      continue;
    }

    const mapped = entries
      .filter((e) => config.roleMap[e.teamRoleId])
      .sort((a, b) => rank(a.teamRoleId) - rank(b.teamRoleId));
    if (!mapped.length) {
      skips.push({ reason: "role-not-mapped", clientName: client.name, memberLabel: label, detail: entries.map((e) => e.teamRoleName).join(", ") });
      continue;
    }

    const match = matchMember(member, usersByEmail, overrides);
    if (match.status === "inactive") {
      skips.push({ reason: "member-inactive", clientName: client.name, memberLabel: label, detail: "Inactive in the PSA" });
      continue;
    }
    if (match.status === "unmatched") {
      skips.push({ reason: "member-not-in-scalepad", clientName: client.name, memberLabel: label, detail: match.email || "No email in the PSA" });
      continue;
    }
    matched.add(match.user.id);

    const chosen = mapped[0];
    if (mapped.length > 1) {
      skips.push({
        reason: "duplicate-role",
        clientName: client.name,
        memberLabel: label,
        detail: `Using ${chosen.teamRoleName}; also holds ${mapped.slice(1).map((e) => e.teamRoleName).join(", ")}`,
      });
    }

    const roleId = config.roleMap[chosen.teamRoleId];
    const role = rolesById.get(roleId);
    if (!role) {
      skips.push({ reason: "role-missing-in-scalepad", clientName: client.name, memberLabel: label, detail: `${chosen.teamRoleName} maps to a role id that no longer exists (${roleId})` });
      continue;
    }

    desired.add(`${client.id}:${match.user.id}`);
    const existing = current.get(`${client.id}:${match.user.id}`);
    const base = {
      clientId: client.id,
      clientName: client.name,
      userId: match.user.id,
      userLabel: userLabel(match.user),
      roleId: role.id,
      roleLabel: role.label,
      psaCompanyId: chosen.companyId,
      psaMemberId: member.id,
    };
    if (!existing) {
      actions.push({ ...base, kind: "assign", previousRoleId: null });
    } else if (existing.roleId === role.id) {
      unchanged++;
    } else if (!existing.roleId) {
      actions.push({ ...base, kind: "set-role", previousRoleId: null });
    } else if (config.overwriteRoles) {
      actions.push({ ...base, kind: "change-role", previousRoleId: existing.roleId });
    } else {
      const previous = rolesById.get(existing.roleId)?.label || existing.roleId;
      skips.push({ reason: "role-conflict", clientName: client.name, memberLabel: label, detail: `ScalePad has ${previous}, PSA says ${role.label}` });
    }
  }

  // Report-only: matched users assigned in CS to a linked client but not on that company's PSA team.
  const clientsById = new Map(input.clients.map((c) => [c.id, c]));
  const usersById = new Map(input.users.map((u) => [u.id, u]));
  const notInPsa: PlanNotInPsa[] = [];
  for (const a of input.assignments) {
    const client = clientsById.get(a.clientId);
    if (!client?.psaCompanyId || !matched.has(a.userId) || desired.has(`${a.clientId}:${a.userId}`)) continue;
    const user = usersById.get(a.userId);
    notInPsa.push({
      clientName: client.name,
      userLabel: user ? userLabel(user) : a.userId,
      roleLabel: (a.roleId && rolesById.get(a.roleId)?.label) || "No role",
    });
  }

  const counts: Record<string, number> = {
    assign: actions.filter((a) => a.kind === "assign").length,
    setRole: actions.filter((a) => a.kind === "set-role").length,
    changeRole: actions.filter((a) => a.kind === "change-role").length,
    unchanged,
    notInPsa: notInPsa.length,
  };
  for (const reason of Object.keys(SKIP_LABELS)) counts[reason] = skips.filter((s) => s.reason === reason).length;

  return { actions, unchanged, skips, notInPsa, matchedUserIds: [...matched], counts };
}

export type AssignBatch = { roleId: string; userId: string; clientIds: string[]; actions: PlanAction[] };

/**
 * Group actions into PUT /clients/account-team calls: one user + role across many clients.
 * The API assigns every listed member to every listed client, so a batch must hold one member.
 */
export function batchActions(actions: PlanAction[], maxClients = 100): AssignBatch[] {
  const byKey = new Map<string, PlanAction[]>();
  for (const action of actions) {
    const key = `${action.userId}:${action.roleId}`;
    byKey.set(key, [...(byKey.get(key) || []), action]);
  }
  const batches: AssignBatch[] = [];
  for (const group of byKey.values()) {
    for (let i = 0; i < group.length; i += maxClients) {
      const slice = group.slice(i, i + maxClients);
      batches.push({ roleId: slice[0].roleId, userId: slice[0].userId, clientIds: slice.map((a) => a.clientId), actions: slice });
    }
  }
  return batches;
}

/** The PSA company id from a ScalePad client's record_lineage, matched by vendor brand name. */
export function psaCompanyIdFromLineage(lineage: unknown, brandPattern: RegExp): string | null {
  if (!Array.isArray(lineage)) return null;
  type LineageEntry = { source_record_id?: unknown; integration_configuration?: { vendor?: { brand_name?: unknown } } };
  for (const entry of lineage as LineageEntry[]) {
    const brand = String(entry?.integration_configuration?.vendor?.brand_name || "");
    const id = entry?.source_record_id;
    if (brandPattern.test(brand) && id != null && String(id).trim()) return String(id).trim();
  }
  return null;
}

/** Synthetic Autotask "role" for the company's Account Manager (Companies.ownerResourceID). */
export const AUTOTASK_OWNER_ROLE_ID = "owner";
export const AUTOTASK_OWNER_ROLE_NAME = "Account Manager (company owner)";

/**
 * Autotask company teams carry no role. Build team entries the same shape as ConnectWise's:
 * the company owner gets the synthetic owner role, and each Company Team member gets their
 * default Autotask role (ResourceRoleDepartments.isDefault). A member with no default role gets
 * an empty role id, which the planner reports as "role not mapped".
 */
export function buildAutotaskTeamEntries(input: {
  companies: Array<{ id: string; name: string; ownerResourceId: string | null }>;
  teamRows: Array<{ companyId: string; resourceId: string }>;
  defaultRoleByResource: Map<string, string>;
  roleNames: Map<string, string>;
}): PsaTeamEntry[] {
  const entries: PsaTeamEntry[] = [];
  const names = new Map(input.companies.map((c) => [c.id, c.name]));
  for (const company of input.companies) {
    if (!company.ownerResourceId) continue;
    entries.push({
      companyId: company.id,
      companyName: company.name,
      memberId: company.ownerResourceId,
      teamRoleId: AUTOTASK_OWNER_ROLE_ID,
      teamRoleName: AUTOTASK_OWNER_ROLE_NAME,
    });
  }
  for (const row of input.teamRows) {
    if (!names.has(row.companyId)) continue;
    const roleId = input.defaultRoleByResource.get(row.resourceId) || "";
    entries.push({
      companyId: row.companyId,
      companyName: names.get(row.companyId) || "",
      memberId: row.resourceId,
      teamRoleId: roleId,
      teamRoleName: roleId ? input.roleNames.get(roleId) || `Role ${roleId}` : "No default role",
    });
  }
  return entries;
}

/**
 * Halo has no client team list: each client has three fixed agent slots. These are its "roles",
 * in priority order for an agent who fills more than one slot on the same client.
 */
export const HALO_SLOTS = [
  { id: "accountmanagertech", name: "Account Manager" },
  { id: "pritech", name: "Primary Technician" },
  { id: "sectech", name: "Secondary Technician" },
] as const;

/** Build team entries from Halo clients' agent slots. 0 means empty and 1 is Halo's "Unassigned" agent. */
export function buildHaloTeamEntries(clients: Array<{ id: string; name: string; slots: Record<string, unknown> }>): PsaTeamEntry[] {
  const entries: PsaTeamEntry[] = [];
  for (const client of clients) {
    for (const slot of HALO_SLOTS) {
      const agentId = client.slots[slot.id];
      if (agentId == null) continue;
      const memberId = String(agentId).trim();
      if (!memberId || memberId === "0" || memberId === "1") continue;
      entries.push({ companyId: client.id, companyName: client.name, memberId, teamRoleId: slot.id, teamRoleName: slot.name });
    }
  }
  return entries;
}

/** True when a task is due, given its interval in days and last run time. */
export function isDue(lastRunAt: string | null, intervalDays: number, now = Date.now()) {
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt).getTime();
  if (Number.isNaN(last)) return true;
  return now - last >= intervalDays * 24 * 60 * 60 * 1000;
}
