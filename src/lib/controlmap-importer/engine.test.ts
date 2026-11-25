import { describe, expect, it } from "vitest";
import { parseWorkbook } from "./workbook";
import { detectHeaderRow, extractRecords, guessColumns, looksLikeCode, pickSheet } from "./columns";
import { guessStatus, isResponseValue, KEEP_STATUS, resolveStatus, responseSummary, rollUpStatus } from "./responses";
import { buildIndex, codeKeys, matchAll, toObjective } from "./objectives";
import { buildPlan, runLogCsv } from "./plan";
import { createHttpClient, HttpError } from "./http";
import { describeError } from "./controlmap";

describe("ControlMap importer engine", () => {
  it("codeKeys tidies separators and sub-letters", () => {
    expect(codeKeys("AC.L2 3.1.1").full).toBe(codeKeys("AC.L2-3.1.1").full);
    expect(codeKeys("3.1.1(a)").core).toBe("3.1.1[a]");
    expect(codeKeys("3.1.1.a").core).toBe("3.1.1[a]");
    expect(codeKeys("3.1.1a").core).toBe("3.1.1[a]");
    expect(codeKeys("CIS-4.01").core).toBe("4.1");
    expect(codeKeys("Safeguard 16.10").core).toBe("16.10");
    expect(codeKeys("").core).toBe("");
  });

  it("looksLikeCode", () => {
    for (const c of ["AC.L2-3.1.1", "3.1.1[a]", "CIS 1.1", "A.5.15", "CC6.1", "PR.AC-1"]) expect(looksLikeCode(c), c).toBe(true);
    for (const c of ["Least Privilege", "Implemented", "https://x.com/a.pdf"]) expect(looksLikeCode(c), c).toBe(false);
  });

  it("response vocabulary", () => {
    expect(guessStatus("MET")).toBe("Compliant");
    expect(guessStatus("NOT MET")).toBe("Not Compliant");
    expect(guessStatus("Partially Implemented")).toBe("Partially Compliant");
    expect(guessStatus("n/a")).toBe("Not Applicable");
    expect(guessStatus("75%")).toBe("Partially Compliant");
    expect(guessStatus("100%")).toBe("Compliant");
    expect(guessStatus("0%")).toBe("Not Compliant");
    expect(guessStatus("3/4")).toBe("Partially Compliant");
    expect(guessStatus("Not Started")).toBe("Not Assessed");
    expect(guessStatus("Under review by CISO")).toBe("In Review");
    expect(guessStatus("banana")).toBe(null);
    expect(resolveStatus("", {})).toBe(KEEP_STATUS);
    expect(resolveStatus("banana", { banana: "Compliant" })).toBe("Compliant");
  });

  it("rolls up sub-objective statuses", () => {
    expect(rollUpStatus(["Compliant", "Compliant"])).toBe("Compliant");
    expect(rollUpStatus(["Compliant", "Not Applicable"])).toBe("Compliant");
    expect(rollUpStatus(["Not Compliant", "Not Compliant"])).toBe("Not Compliant");
    expect(rollUpStatus(["Compliant", "Not Compliant"])).toBe("Partially Compliant");
    expect(rollUpStatus(["Not Applicable"])).toBe("Not Applicable");
    expect(rollUpStatus([KEEP_STATUS])).toBe(null);
  });

  it("responseSummary groups values case-insensitively", () => {
    const s = responseSummary([{ response: "MET" }, { response: "met" }, { response: "" }, { response: "Weird" }]);
    expect(s.map((x) => [x.count, x.suggested])).toEqual([[2, "Compliant"], [1, KEEP_STATUS], [1, null]]);
  });

  it("keeps curly quotes and dashes from Windows Excel CSVs", () => {
    const text = "Control #,Notes\r\n1.1,Client’s inventory – café\r\n";
    const cp1252 = Uint8Array.from([...text].map((ch) => ({ "’": 0x92, "–": 0x96 })[ch] ?? ch.charCodeAt(0)));
    const utf8 = new TextEncoder().encode("﻿" + text);
    for (const bytes of [cp1252, utf8]) {
      const [sheet] = parseWorkbook(bytes, "x.csv");
      expect(sheet.rows[0][0].text).toBe("Control #");
      expect(sheet.rows[1][1].text).toBe("Client’s inventory – café");
      expect(sheet.rows[1][0].text).toBe("1.1");
    }
  });

  it("runs a small CSV end to end: columns, matching and the update plan", () => {
    const catalog = [
      { id: 11, code: "1.1", name: "Establish and Maintain Detailed Enterprise Asset Inventory", description: "", status: "Not Assessed" },
      { id: 12, code: "1.2", name: "Address Unauthorized Assets", description: "", status: "Not Assessed" },
      { id: 41, code: "4.1", name: "Establish and Maintain a Secure Configuration Process", description: "", status: "Compliant" },
    ].map(toObjective);
    const csv = [
      "Safeguard,Title,Status,Notes",
      "1.1,Establish and Maintain Detailed Enterprise Asset Inventory,Implemented,Asset list in RMM https://example.com/a",
      "1.2,Address Unauthorized Assets,Not Implemented,",
      "4.1,Establish and Maintain a Secure Configuration Process,Partially Implemented,Baseline drafted",
    ].join("\n");
    const sheets = parseWorkbook(new TextEncoder().encode(csv), "scorecard.csv");
    const sheet = sheets[pickSheet(sheets)];
    const headerRow = detectHeaderRow(sheet);
    const { headers, roles } = guessColumns(sheet, headerRow, { isResponseValue });
    expect(roles).toEqual(["code", "title", "response", "notes"]);
    const { records } = extractRecords(sheet, headerRow, roles, headers);
    expect(records).toHaveLength(3);

    const index = buildIndex(catalog);
    const { matches } = matchAll(records, index);
    expect(matches.map((m) => m.objectiveId)).toEqual([11, 12, 41]);
    expect(matches.every((m) => m.band === "high")).toBe(true);

    const statusChoices = Object.fromEntries(responseSummary(records).map((s) => [s.value.toLowerCase(), s.suggested]));
    const plan = buildPlan({
      records,
      decisions: matches.map((m) => m.objectiveId),
      statusChoices,
      targets: { notes: "implementation_details", evidence: "none" },
      rollUp: false,
      fileName: "scorecard.csv",
      index,
    });
    expect(plan.updates.map((u) => [u.code, u.body.status])).toEqual([
      ["1.1", "Compliant"],
      ["1.2", "Not Compliant"],
      ["4.1", "Partially Compliant"],
    ]);
    expect(plan.updates[0].body.implementation_details).toContain('<a href="https://example.com/a"');
    expect(plan.updates[0].body.implementation_details).toContain("Imported from scorecard.csv");

    const log = runLogCsv(plan.updates.map((u) => ({ ...u, ok: true })));
    expect(log.split("\n")[1]).toContain("Not Assessed,Compliant");
  });

  it("retries rate-limited requests and reports the last failure", async () => {
    const statuses = [429, 500, 200];
    const calls: string[] = [];
    const http = createHttpClient({
      transport: async (method, path) => {
        calls.push(`${method} ${path}`);
        const status = statuses.shift() ?? 200;
        return { status, body: status === 200 ? { ok: true } : { message: "slow down" } };
      },
      minIntervalMs: 0,
      sleep: async () => {},
    });
    expect(await http.get("/clients/health")).toEqual({ ok: true });
    expect(calls).toHaveLength(3);

    const denied = createHttpClient({
      transport: async () => ({ status: 403, body: { errors: [{ detail: "Missing scope" }] } }),
      minIntervalMs: 0,
      sleep: async () => {},
    });
    const err = await denied.patch("/x", {}).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(describeError(err)).toContain("Missing scope");
  });
});
