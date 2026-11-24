import { describe, expect, it } from "vitest";
import {
  AUTOTASK_OWNER_ROLE_ID,
  batchActions,
  buildAutotaskTeamEntries,
  buildPlan,
  isDue,
  psaCompanyIdFromLineage,
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

describe("isDue", () => {
  const now = Date.parse("2026-11-24T00:00:00Z");
  it("runs when never run, and after the interval passes", () => {
    expect(isDue(null, 30, now)).toBe(true);
    expect(isDue("2026-10-20T00:00:00Z", 30, now)).toBe(true);
    expect(isDue("2026-11-10T00:00:00Z", 30, now)).toBe(false);
  });
});
