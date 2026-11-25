// Turns reviewed matches into the exact PATCH calls to make, one per objective.
// This is what the Import screen shows before anything is written, and what
// the run log records (with each objective's status before the import).

import { resolveStatus, rollUpStatus, KEEP_STATUS } from "./responses";

/** Where notes / evidence text can go on a CM objective. */
export const TEXT_TARGETS = { implementation_details: "Implementation details", remarks: "Remarks", none: "Don't import" };

/**
 * @typedef {Object} PlannedUpdate
 * @property {number} objectiveId
 * @property {string} code
 * @property {string} name
 * @property {string} statusBefore
 * @property {Record<string, string>} body       the PATCH body
 * @property {number[]} rows                      source rows (1-based) that fed it
 * @property {string} [note]                      e.g. "Rolled up from 4 sub-objectives"
 */

/**
 * @param {Object} p
 * @param {import("./columns.js").SourceRecord[]} p.records
 * @param {(number | null)[]} p.decisions          chosen objective id per record (null = skip)
 * @param {Record<string, string>} p.statusChoices normalized response -> CM status / KEEP_STATUS
 * @param {{notes: string, evidence: string}} p.targets  TEXT_TARGETS keys
 * @param {boolean} p.rollUp                       derive practice status from all-answered sub-objectives
 * @param {string} p.fileName
 * @param {ReturnType<import("../matching/objectives.js").buildIndex>} p.index
 * @returns {{updates: PlannedUpdate[], unmappedResponses: string[]}}
 */
export function buildPlan({ records, decisions, statusChoices, targets, rollUp, fileName, index }) {
  const groups = new Map();
  records.forEach((rec, i) => {
    const id = decisions[i];
    if (id == null) return;
    groups.set(id, [...(groups.get(id) ?? []), rec]);
  });

  const unmapped = new Set();
  const updates = [];
  const statusById = new Map();

  for (const [objectiveId, recs] of groups) {
    const o = index.byId.get(objectiveId);
    const statuses = recs.map((r) => {
      const s = resolveStatus(r.response, statusChoices);
      if (s == null) unmapped.add(r.response);
      return s;
    });
    const known = statuses.filter((s) => s && s !== KEEP_STATUS);
    // Several rows for one objective: they must all agree to say Compliant.
    const status = known.length === 0 ? null : known.length === 1 ? known[0] : rollUpStatus(known) ?? known[0];

    const body: Record<string, string> = {};
    if (status) body.status = status;
    addText(body, targets, recs, fileName);
    if (status) statusById.set(objectiveId, status);
    if (Object.keys(body).length) {
      updates.push({ objectiveId, code: o.code, name: o.name, statusBefore: o.status, body, rows: recs.map((r) => r.rowNumber) });
    }
  }

  if (rollUp) {
    const children = new Map();
    for (const o of index.objectives) if (o.isChild && o.parentCode) children.set(o.parentCode, [...(children.get(o.parentCode) ?? []), o]);
    for (const parent of index.objectives) {
      const kids = children.get(parent.code);
      if (!kids || groups.has(parent.id)) continue;
      const kidStatuses = kids.map((k) => statusById.get(k.id));
      // Only when every sub-objective was answered: a half-answered practice
      // isn't evidence that the practice is met.
      if (kidStatuses.some((s) => !s)) continue;
      const status = rollUpStatus(kidStatuses);
      if (!status) continue;
      updates.push({ objectiveId: parent.id, code: parent.code, name: parent.name, statusBefore: parent.status, body: { status }, rows: [], note: `Rolled up from ${kids.length} sub-objective${kids.length === 1 ? "" : "s"}` });
    }
  }

  updates.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return { updates, unmappedResponses: [...unmapped] };
}

function addText(body, targets, recs, fileName) {
  const parts = { implementation_details: [], remarks: [] };
  const many = recs.length > 1;
  for (const r of recs) {
    const prefix = many ? `Row ${r.rowNumber}: ` : "";
    if (targets.notes in parts) for (const n of r.notes) parts[targets.notes].push({ label: "Notes", text: prefix + n });
    if (targets.evidence in parts) for (const e of r.evidence) parts[targets.evidence].push({ label: "Evidence", text: prefix + e });
  }
  const source = `Imported from ${fileName}`;
  if (parts.implementation_details.length) body.implementation_details = toHtml(parts.implementation_details, source);
  if (parts.remarks.length) body.remarks = `${parts.remarks.map((p) => `${p.label}: ${p.text}`).join("\n")}\n(${source})`;
}

/** Notes and evidence as simple HTML, links made clickable, everything escaped. */
export function toHtml(parts, source) {
  const byLabel = new Map();
  for (const p of parts) byLabel.set(p.label, [...(byLabel.get(p.label) ?? []), p.text]);
  let html = "";
  for (const [label, texts] of byLabel) {
    html += `<p><strong>${escapeHtml(label)}</strong></p>`;
    html += texts.length === 1 ? `<p>${linkify(texts[0])}</p>` : `<ul>${texts.map((t) => `<li>${linkify(t)}</li>`).join("")}</ul>`;
  }
  return html + `<p><em>${escapeHtml(source)}</em></p>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function linkify(text) {
  return escapeHtml(text).replace(/https?:\/\/[^\s<>"']+/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

/** CSV of the run, including each objective's status before, so a partner can see or undo what changed. */
export function runLogCsv(results) {
  const head = ["Objective ID", "Code", "Name", "Status before", "Status after", "Fields updated", "Source rows", "Result", "Error"];
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = results.map((r) => [r.objectiveId, r.code, r.name, r.statusBefore, r.body.status ?? "(unchanged)", Object.keys(r.body).join(" + "), r.rows.join(" "), r.ok ? "Updated" : "Failed", r.error ?? ""].map(esc).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}
