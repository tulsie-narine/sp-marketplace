import { describe, expect, it } from "vitest";
import {
  AUTOTASK_OWNER_ROLE_ID,
  batchActions,
  buildAutotaskTeamEntries,
  buildHaloTeamEntries,
  cleanRoleLabel,
  findRoleByLabel,
  HALO_SLOTS,
  buildPlan,
  isDue,
  psaCompanyIdFromLineage,
  applyClientLinks,
  applySyncScope,
  batchSegmentUpdates,
  buildFieldTeamEntries,
  buildSegmentPlan,
  fieldRoleId,
  memberForValue,
  type PsaFieldValue,
  type CsAssignment,
  type PlanConfig,
  type PsaMember,
  type PsaTeamEntry,
} from "../../supabase/functions/psa-role-sync/plan";

const members: PsaMember[] = [
  { id: "1", identifier: "asmith", name: "Alex Smith", email: "Alex.Smith@msp.example", inactive: false },
  { id: "2", identifier: "bjones", name: "Bo Jones", email: "bo@msp.example", inactive: false },
  { id: "3", identifier: "cgone", name: "Cy Gone", email: "cy@msp.example", inactive: true },
  { id: "4", identifier: "dnew", name: "Di New", email: "di@other.example", inactive: false },
];
const users = [
  { id: "u-alex", email: "alex.smith@msp.example", name: "Alex Smith" },
  { id: "u-bo", email: "bo@msp.example", name: "Bo Jones" },
  { id: "u-di", email: "di@msp.example", name: "Di New" },
];
const clients = [
  { id: "c-1", name: "Contoso", psaCompanyId: "100" },
  { id: "c-2", name: "Fabrikam", psaCompanyId: "200" },
  { id: "c-3", name: "No PSA Co", psaCompanyId: null },
];
const roles = [
  { id: "r-am", label: "Account Manager" },
  { id: "r-tech", label: "Technician" },
  { id: "r-vcio", label: "vCIO" },
];
const team = (companyId: string, memberId: string, teamRoleId: string, teamRoleName: string): PsaTeamEntry => ({
  companyId,
  companyName: companyId === "100" ? "Contoso" : "Fabrikam",
  memberId,
  teamRoleId,
  teamRoleName,
});
const config = (overrides: Partial<PlanConfig> = {}): PlanConfig => ({
  roleMap: { "10": "r-am", "20": "r-tech" },
  rolePriority: ["10", "20"],
  emailOverrides: {},
  overwriteRoles: false,
  ...overrides,
});
const plan = (teams: PsaTeamEntry[], assignments: CsAssignment[] = [], cfg = config()) =>
  buildPlan({ members, teams, users, clients, roles, assignments, config: cfg });

describe("buildPlan", () => {
  it("assigns a matched member with the mapped role, matching email case-insensitively", () => {
    const result = plan([team("100", "1", "10", "Account Manager")]);
    expect(result.actions).toEqual([
      expect.objectContaining({ kind: "assign", clientId: "c-1", userId: "u-alex", roleId: "r-am", roleLabel: "Account Manager" }),
    ]);
    expect(result.skips).toEqual([]);
  });

  it("skips members with no ScalePad user instead of failing", () => {
    const result = plan([team("100", "4", "10", "Account Manager")]);
    expect(result.actions).toEqual([]);
    expect(result.skips).toEqual([expect.objectContaining({ reason: "member-not-in-scalepad", detail: "di@other.example" })]);
  });

  it("uses an email override when the PSA and ScalePad emails differ", () => {
    const result = plan([team("100", "4", "10", "Account Manager")], [], config({ emailOverrides: { "DI@other.example": "di@msp.example" } }));
    expect(result.actions).toEqual([expect.objectContaining({ userId: "u-di", kind: "assign" })]);
  });

  it("matches an override keyed by PSA identifier", () => {
    const result = plan([team("100", "4", "10", "Account Manager")], [], config({ emailOverrides: { dnew: "di@msp.example" } }));
    expect(result.actions[0]?.userId).toBe("u-di");
  });

  it("skips inactive members and unmapped roles", () => {
    const result = plan([team("100", "3", "10", "Account Manager"), team("100", "2", "99", "Sales Rep")]);
    expect(result.actions).toEqual([]);
    expect(result.skips.map((s) => s.reason).sort()).toEqual(["member-inactive", "role-not-mapped"]);
  });

  it("leaves an existing identical assignment unchanged", () => {
    const result = plan([team("100", "1", "10", "Account Manager")], [{ userId: "u-alex", clientId: "c-1", roleId: "r-am" }]);
    expect(result.actions).toEqual([]);
    expect(result.unchanged).toBe(1);
  });

  it("fills in a role when the user is on the team with no role", () => {
    const result = plan([team("100", "1", "10", "Account Manager")], [{ userId: "u-alex", clientId: "c-1", roleId: null }]);
    expect(result.actions).toEqual([expect.objectContaining({ kind: "set-role" })]);
  });

  it("reports a different existing role as a conflict unless overwrite is on", () => {
    const existing = [{ userId: "u-alex", clientId: "c-1", roleId: "r-vcio" }];
    const safe = plan([team("100", "1", "10", "Account Manager")], existing);
    expect(safe.actions).toEqual([]);
    expect(safe.skips).toEqual([expect.objectContaining({ reason: "role-conflict", detail: "ScalePad has vCIO, PSA says Account Manager" })]);

    const overwrite = plan([team("100", "1", "10", "Account Manager")], existing, config({ overwriteRoles: true }));
    expect(overwrite.actions).toEqual([expect.objectContaining({ kind: "change-role", previousRoleId: "r-vcio" })]);
  });

  it("picks the highest-priority role when a member holds two mapped roles on one company", () => {
    const result = plan([team("100", "1", "20", "Technician"), team("100", "1", "10", "Account Manager")]);
    expect(result.actions).toEqual([expect.objectContaining({ roleId: "r-am" })]);
    expect(result.skips).toEqual([expect.objectContaining({ reason: "duplicate-role" })]);
  });

  it("follows rolePriority, not object key order, when picking between two mapped roles", () => {
    // Number-like keys always enumerate first in JS, so roleMap order alone would pick "10" here.
    const result = plan(
      [team("100", "1", "10", "Account Manager"), team("100", "1", "20", "Technician")],
      [],
      config({ rolePriority: ["20", "10"] }),
    );
    expect(result.actions).toEqual([expect.objectContaining({ roleId: "r-tech" })]);
  });

  it("skips a mapping that points at a deleted ScalePad role", () => {
    const result = plan([team("100", "1", "10", "Account Manager")], [], config({ roleMap: { "10": "r-gone" } }));
    expect(result.skips).toEqual([expect.objectContaining({ reason: "role-missing-in-scalepad" })]);
  });

  it("reports CS assignments on linked clients that the PSA team no longer has, without removing them", () => {
    const result = plan(
      [team("100", "1", "10", "Account Manager")],
      [
        { userId: "u-alex", clientId: "c-1", roleId: "r-am" },
        { userId: "u-alex", clientId: "c-2", roleId: "r-tech" },
        { userId: "u-alex", clientId: "c-3", roleId: "r-tech" },
      ],
    );
    expect(result.notInPsa).toEqual([{ clientName: "Fabrikam", userLabel: "Alex Smith", roleLabel: "Technician" }]);
    expect(result.actions).toEqual([]);
  });

  it("counts every outcome", () => {
    const result = plan([team("100", "1", "10", "Account Manager"), team("200", "2", "20", "Technician"), team("100", "4", "10", "Account Manager")]);
    expect(result.counts).toMatchObject({ assign: 2, unchanged: 0, "member-not-in-scalepad": 1 });
  });
});

describe("batchActions", () => {
  it("groups one user and role across clients, and chunks large groups", () => {
    const result = plan([team("100", "1", "10", "Account Manager"), team("200", "1", "10", "Account Manager"), team("200", "2", "20", "Technician")]);
    const batches = batchActions(result.actions);
    expect(batches).toHaveLength(2);
    expect(batches.find((b) => b.userId === "u-alex")?.clientIds.sort()).toEqual(["c-1", "c-2"]);
    expect(batchActions(result.actions, 1)).toHaveLength(3);
  });
});

describe("psaCompanyIdFromLineage", () => {
  const lineage = [
    { source_record_id: "0", integration_configuration: { vendor: { brand_name: "Datto RMM" } } },
    { source_record_id: "29683653", integration_configuration: { vendor: { brand_name: "ConnectWise PSA" } } },
  ];
  it("returns the source id from the PSA vendor entry", () => {
    expect(psaCompanyIdFromLineage(lineage, /connectwise/i)).toBe("29683653");
  });
  it("returns null when the client has no PSA lineage", () => {
    expect(psaCompanyIdFromLineage(lineage, /autotask/i)).toBeNull();
    expect(psaCompanyIdFromLineage(null, /connectwise/i)).toBeNull();
  });
});

describe("buildAutotaskTeamEntries", () => {
  const roleNames = new Map([["29682833", "Technician"], ["29682834", "vCIO"]]);
  const defaults = new Map([["10", "29682833"], ["11", "29682834"]]);

  it("gives the company owner the owner role and team members their default role", () => {
    const entries = buildAutotaskTeamEntries({
      companies: [{ id: "100", name: "Contoso", ownerResourceId: "11" }],
      teamRows: [{ companyId: "100", resourceId: "10" }],
      defaultRoleByResource: defaults,
      roleNames,
    });
    expect(entries).toEqual([
      { companyId: "100", companyName: "Contoso", memberId: "11", teamRoleId: AUTOTASK_OWNER_ROLE_ID, teamRoleName: "Account Manager (company owner)" },
      { companyId: "100", companyName: "Contoso", memberId: "10", teamRoleId: "29682833", teamRoleName: "Technician" },
    ]);
  });

  it("leaves a member with no default role unmapped, and ignores companies without an owner or link", () => {
    const entries = buildAutotaskTeamEntries({
      companies: [{ id: "100", name: "Contoso", ownerResourceId: null }],
      teamRows: [{ companyId: "100", resourceId: "99" }, { companyId: "555", resourceId: "10" }],
      defaultRoleByResource: defaults,
      roleNames,
    });
    expect(entries).toEqual([{ companyId: "100", companyName: "Contoso", memberId: "99", teamRoleId: "", teamRoleName: "No default role" }]);
  });

  it("plans the owner role first when the owner is also on the Company Team", () => {
    const atMembers: PsaMember[] = [{ id: "11", identifier: "alex", name: "Alex Smith", email: "alex.smith@msp.example", inactive: false }];
    const teams = buildAutotaskTeamEntries({
      companies: [{ id: "100", name: "Contoso", ownerResourceId: "11" }],
      teamRows: [{ companyId: "100", resourceId: "11" }],
      defaultRoleByResource: defaults,
      roleNames,
    });
    const result = buildPlan({
      members: atMembers,
      teams,
      users,
      clients,
      roles,
      assignments: [],
      config: config({ roleMap: { [AUTOTASK_OWNER_ROLE_ID]: "r-am", "29682834": "r-vcio" }, rolePriority: [AUTOTASK_OWNER_ROLE_ID, "29682834"] }),
    });
    expect(result.actions).toEqual([expect.objectContaining({ userId: "u-alex", roleId: "r-am" })]);
    expect(result.skips).toEqual([expect.objectContaining({ reason: "duplicate-role" })]);
  });
});

describe("buildHaloTeamEntries", () => {
  it("turns filled agent slots into team entries and skips empty or Unassigned slots", () => {
    const entries = buildHaloTeamEntries([
      { id: "100", name: "Contoso", slots: { accountmanagertech: 11, pritech: 0, sectech: 1 } },
      { id: "200", name: "Fabrikam", slots: { accountmanagertech: null, pritech: 12, sectech: 13 } },
    ]);
    expect(entries).toEqual([
      { companyId: "100", companyName: "Contoso", memberId: "11", teamRoleId: "accountmanagertech", teamRoleName: "Account Manager" },
      { companyId: "200", companyName: "Fabrikam", memberId: "12", teamRoleId: "pritech", teamRoleName: "Primary Technician" },
      { companyId: "200", companyName: "Fabrikam", memberId: "13", teamRoleId: "sectech", teamRoleName: "Secondary Technician" },
    ]);
  });

  it("gives an agent in two slots on one client the higher-priority role", () => {
    const haloMembers: PsaMember[] = [{ id: "11", identifier: "alex", name: "Alex Smith", email: "alex.smith@msp.example", inactive: false }];
    const teams = buildHaloTeamEntries([{ id: "100", name: "Contoso", slots: { accountmanagertech: 11, pritech: 11 } }]);
    const result = buildPlan({
      members: haloMembers,
      teams,
      users,
      clients,
      roles,
      assignments: [],
      config: config({ roleMap: { accountmanagertech: "r-am", pritech: "r-tech" }, rolePriority: HALO_SLOTS.map((s) => s.id) }),
    });
    expect(result.actions).toEqual([expect.objectContaining({ userId: "u-alex", roleId: "r-am" })]);
  });
});

describe("role labels", () => {
  it("tidies PSA role names into ScalePad role labels", () => {
    expect(cleanRoleLabel("  Help   Desk ")).toBe("Help Desk");
    expect(cleanRoleLabel("x".repeat(150))).toHaveLength(100);
  });

  it("finds an existing ScalePad role ignoring case and spacing, so creation never duplicates", () => {
    expect(findRoleByLabel(roles, "  account   MANAGER")?.id).toBe("r-am");
    expect(findRoleByLabel(roles, "Help Desk")).toBeUndefined();
  });
});

describe("isDue", () => {
  const now = Date.parse("2026-11-24T00:00:00Z");
  it("runs when never run, and after the interval passes", () => {
    expect(isDue(null, 30, now)).toBe(true);
    expect(isDue("2026-10-20T00:00:00Z", 30, now)).toBe(true);
    expect(isDue("2026-11-10T00:00:00Z", 30, now)).toBe(false);
  });
});

describe("ConnectWise custom fields", () => {
  const field = (companyId: string, fieldId: string, caption: string, value: string): PsaFieldValue => ({
    companyId,
    companyName: companyId === "100" ? "Contoso" : "Fabrikam",
    fieldId,
    caption,
    value,
  });

  it("finds the member a value names by login, email, name or Last, First", () => {
    expect(memberForValue("asmith", members).member?.id).toBe("1");
    expect(memberForValue("BO@msp.example", members).member?.id).toBe("2");
    expect(memberForValue("  alex   smith ", members).member?.id).toBe("1");
    expect(memberForValue("Smith, Alex", members).member?.id).toBe("1");
    expect(memberForValue("Nobody Here", members).member).toBeNull();
    expect(memberForValue("", members).member).toBeNull();
  });

  it("prefers the one active member when a name is shared, else reports it as ambiguous", () => {
    const twins: PsaMember[] = [
      { id: "a", identifier: "jlee1", name: "Jo Lee", email: "jo1@x", inactive: true },
      { id: "b", identifier: "jlee2", name: "Jo Lee", email: "jo2@x", inactive: false },
    ];
    expect(memberForValue("Jo Lee", twins).member?.id).toBe("b");
    const both = twins.map((m) => ({ ...m, inactive: false }));
    expect(memberForValue("Jo Lee", both)).toEqual({ member: null, ambiguous: true });
  });

  it("turns person fields into role entries the planner assigns like team roles", () => {
    const values = [
      field("100", "7", "Strategic Advisor", "Alex Smith"),
      field("200", "7", "Strategic Advisor", "Mystery Person"),
      field("200", "9", "Customer Segment", "Gold"),
      field("100", "8", "Technical Alignment", ""),
    ];
    const { entries, extraMembers } = buildFieldTeamEntries({ values, fieldIds: ["7", "8"], members, overrides: {} });
    expect(entries.map((e) => [e.companyId, e.memberId, e.teamRoleId])).toEqual([
      ["100", "1", "field:7"],
      ["200", "value:mystery person", "field:7"],
    ]);
    const plan = buildPlan({
      members: [...members, ...extraMembers],
      teams: entries,
      users,
      clients,
      roles,
      assignments: [],
      config: { roleMap: { [fieldRoleId("7")]: "r-vcio" }, emailOverrides: {}, overwriteRoles: false },
    });
    expect(plan.actions.map((a) => [a.clientName, a.userId, a.roleLabel])).toEqual([["Contoso", "u-alex", "vCIO"]]);
    expect(plan.skips).toEqual([
      expect.objectContaining({ reason: "field-value-unmatched", clientName: "Fabrikam", memberLabel: "Mystery Person" }),
    ]);
  });

  it("matches a value through an email override keyed by the value", () => {
    const values = [field("200", "7", "Strategic Advisor", "Mystery  Person")];
    const overrides = { "mystery person": "di@msp.example" };
    const { entries, extraMembers } = buildFieldTeamEntries({ values, fieldIds: ["7"], members, overrides });
    const plan = buildPlan({
      members: [...members, ...extraMembers],
      teams: entries,
      users,
      clients,
      roles,
      assignments: [],
      config: { roleMap: { "field:7": "r-vcio" }, emailOverrides: overrides, overwriteRoles: false },
    });
    expect(plan.actions.map((a) => [a.clientName, a.userId])).toEqual([["Fabrikam", "u-di"]]);
  });

  it("lets a field role and a team role on the same person follow the role priority", () => {
    const values = [field("100", "7", "Strategic Advisor", "asmith")];
    const { entries } = buildFieldTeamEntries({ values, fieldIds: ["7"], members, overrides: {} });
    const plan = buildPlan({
      members,
      teams: [team("100", "1", "11", "Account Manager"), ...entries],
      users,
      clients,
      roles,
      assignments: [],
      config: { roleMap: { "11": "r-am", "field:7": "r-vcio" }, rolePriority: ["field:7", "11"], emailOverrides: {}, overwriteRoles: false },
    });
    expect(plan.actions.map((a) => a.roleLabel)).toEqual(["vCIO"]);
    expect(plan.skips[0]).toEqual(expect.objectContaining({ reason: "duplicate-role" }));
  });
});

describe("segments", () => {
  const segments = [
    { id: "s-gold", label: "Strategic" },
    { id: "s-std", label: "Standard" },
  ];
  const values: PsaFieldValue[] = [
    { companyId: "100", companyName: "Contoso", fieldId: "9", caption: "Customer Segment", value: "Gold" },
    { companyId: "200", companyName: "Fabrikam", fieldId: "9", caption: "Customer Segment", value: "Bronze" },
  ];

  it("plans segment changes, leaves blank and matching clients alone, and reports unmapped values", () => {
    const plan = buildSegmentPlan({
      clients: [...clients, { id: "c-4", name: "Blank Co", psaCompanyId: "400" }],
      values,
      fieldId: "9",
      valueMap: { gold: "s-gold" },
      segments,
      currentSegment: new Map([["c-1", null]]),
    });
    expect(plan.updates).toEqual([
      { clientId: "c-1", clientName: "Contoso", segmentId: "s-gold", segmentLabel: "Strategic", previousLabel: "Not assigned", value: "Gold" },
    ]);
    expect(plan.skips.map((s) => [s.reason, s.clientName])).toEqual([["segment-not-mapped", "Fabrikam"]]);

    const again = buildSegmentPlan({ clients, values, fieldId: "9", valueMap: { gold: "s-gold", bronze: "s-std" }, segments, currentSegment: new Map([["c-1", "s-gold"], ["c-2", "s-gold"]]) });
    expect(again.unchanged).toBe(1);
    expect(again.updates.map((u) => [u.clientName, u.previousLabel, u.segmentLabel])).toEqual([["Fabrikam", "Strategic", "Standard"]]);
  });

  it("reports a value mapped to a deleted segment", () => {
    const plan = buildSegmentPlan({ clients, values, fieldId: "9", valueMap: { gold: "s-gone", bronze: "s-std" }, segments, currentSegment: new Map() });
    expect(plan.skips.map((s) => s.reason)).toEqual(["segment-missing-in-scalepad"]);
  });

  it("batches segment updates per segment, at most 100 clients a call", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ clientId: `c${i}`, clientName: `C${i}`, segmentId: i < 120 ? "a" : "b", segmentLabel: "", previousLabel: "", value: "" }));
    expect(batchSegmentUpdates(many).map((b) => [b.segmentId, b.clientIds.length])).toEqual([["a", 100], ["a", 20], ["b", 30]]);
  });
});

describe("manual client links", () => {
  it("links unlinked clients and moves a company linked by hand away from its old client", () => {
    const linked = applyClientLinks(clients, { "c-3": "200" });
    expect(linked.map((c) => [c.id, c.psaCompanyId])).toEqual([["c-1", "100"], ["c-2", null], ["c-3", "200"]]);
    expect(applyClientLinks(clients, {})).toBe(clients);
  });
});

describe("sync scope", () => {
  it("keeps every client for all, only the picked ones for selected", () => {
    expect(applySyncScope(clients, "all", ["c-1"])).toBe(clients);
    expect(applySyncScope(clients, undefined, undefined)).toBe(clients);
    expect(applySyncScope(clients, "selected", ["c-2"]).map((c) => c.id)).toEqual(["c-2"]);
    expect(applySyncScope(clients, "selected", [])).toEqual([]);
  });
});
