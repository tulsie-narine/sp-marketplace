// Works out the shape of an assessment sheet without any per-vendor template:
// which row holds the headers, what each column means, and which rows are real
// answers (as opposed to titles, section headings, blank lines and footers).
//
// Every guess is a suggestion the partner can change on the Columns screen.
// Guesses combine the header wording with what the column actually contains,
// so a column headed "Objective" that holds 3.1.1[a] is read as a code.

/** @typedef {import("../parse/workbook.js").Sheet} Sheet */
/** @typedef {"code" | "title" | "description" | "response" | "notes" | "evidence" | "ignore"} Role */

export const ROLES = /** @type {const} */ (["code", "title", "description", "response", "notes", "evidence", "ignore"]);
export const ROLE_LABELS = {
  code: "Objective ID",
  title: "Objective name",
  description: "Objective description",
  response: "Response / status",
  notes: "Notes",
  evidence: "Evidence",
  ignore: "Don't import",
};
/** Roles that can apply to several columns at once (their text is combined). */
export const MULTI_ROLES = new Set(["notes", "evidence"]);

const HEADER_WORDS = {
  code: ["id", "ref", "reference", "control #", "control id", "control no", "practice id", "requirement id", "req id", "objective id", "safeguard #", "safeguard id", "number", "no", "no.", "#", "code", "clause", "section", "control number", "objective"],
  title: ["title", "name", "safeguard", "control", "practice", "requirement", "control name", "safeguard title", "control title", "objective name", "practice name", "requirement name"],
  description: ["description", "statement", "requirement text", "practice statement", "determination statement", "control text", "control description", "details", "question", "text", "requirement description", "control statement"],
  response: ["status", "result", "answer", "response", "determination", "implementation status", "compliance", "compliance status", "score", "rating", "assessment result", "implemented", "met", "finding", "outcome", "maturity"],
  notes: ["notes", "note", "comments", "comment", "assessor comments", "assessor notes", "remarks", "observations", "observation", "explanation", "justification", "rationale", "implementation details", "implementation notes", "gap", "findings"],
  evidence: ["evidence", "artifacts", "artefacts", "supporting evidence", "evidence link", "evidence links", "proof", "documentation", "attachments", "evidence / artifacts", "artifact", "references"],
};

/**
 * Picks the sheet that most looks like the answers: the one with the most rows
 * that have several filled cells. Cover pages and legends lose.
 * @param {Sheet[]} sheets
 */
export function pickSheet(sheets) {
  let best = 0;
  let bestScore = -1;
  sheets.forEach((s, i) => {
    const score = s.rows.filter((r) => r.filter((c) => c.text).length >= 3).length;
    if (score > bestScore) [best, bestScore] = [i, score];
  });
  return best;
}

/**
 * The header row is the early row with the most header-like cells: short text,
 * no numbers, ideally known column words, followed by rows of data.
 * @param {Sheet} sheet
 * @returns {number} 0-based row index
 */
export function detectHeaderRow(sheet) {
  const limit = Math.min(sheet.rows.length, 30);
  let best = 0;
  let bestScore = -Infinity;
  for (let r = 0; r < limit; r++) {
    const cells = sheet.rows[r].filter((c) => c.text);
    if (cells.length < 2) continue;
    let score = 0;
    for (const c of cells) {
      if (c.isNumber) score -= 2;
      else if (c.text.length <= 40) score += 1;
      if (headerHits(c.text) > 0) score += 2;
    }
    // A header is followed by rows at least as wide as itself.
    const next = sheet.rows.slice(r + 1, r + 6).filter((row) => row.filter((c) => c.text).length >= Math.min(2, cells.length)).length;
    score += next;
    if (score > bestScore) [best, bestScore] = [r, score];
  }
  return best;
}

function norm(s) {
  return String(s).toLowerCase().replace(/[_\-:?*]+/g, " ").replace(/\s+/g, " ").trim();
}

function headerHits(text) {
  const h = norm(text);
  let hits = 0;
  for (const words of Object.values(HEADER_WORDS)) if (words.includes(h)) hits++;
  return hits;
}

/** Score of a header against a role: exact word 3, contains a word 1.5. */
function headerScore(header, role) {
  const h = norm(header);
  if (!h) return 0;
  const words = HEADER_WORDS[role];
  if (words.includes(h)) return 3;
  if (words.some((w) => w.length > 2 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&")}\\b`).test(h))) return 1.5;
  return 0;
}

/**
 * @param {Sheet} sheet
 * @param {number} headerRow
 * @param {{isResponseValue: (text: string) => boolean}} vocab
 * @returns {{headers: string[], roles: Role[]}}
 */
export function guessColumns(sheet, headerRow, vocab) {
  const headers = sheet.rows[headerRow].map((c) => c.text);
  const body = sheet.rows.slice(headerRow + 1, headerRow + 400);
  const profiles = headers.map((_, col) => profile(body.map((r) => r[col]).filter((c) => c && c.text), vocab));

  // Score every (column, role) pair, then assign greedily, best pairs first.
  const pairs = [];
  headers.forEach((h, col) => {
    const p = profiles[col];
    if (p.filled === 0) return;
    const content = {
      code: p.codeLike * 4 - (p.avgLen > 30 ? 2 : 0),
      title: p.avgLen >= 8 && p.avgLen <= 90 && p.codeLike < 0.3 ? 1.5 - p.distinctRatioPenalty : 0,
      description: p.avgLen > 60 ? 2 + Math.min(p.avgLen / 200, 1) : 0,
      response: p.responseLike * 4 + (p.distinct <= 12 && p.avgLen < 25 ? 0.5 : 0),
      notes: p.avgLen > 15 && p.codeLike < 0.2 && p.responseLike < 0.3 ? 0.8 : 0,
      evidence: p.urlLike * 3 + p.fileLike * 2,
    };
    for (const role of ROLES) {
      if (role === "ignore") continue;
      const score = headerScore(h, role) + content[role];
      if (score >= 1.5) pairs.push({ col, role, score });
    }
  });
  pairs.sort((a, b) => b.score - a.score);

  const roles = headers.map(() => /** @type {Role} */ ("ignore"));
  const taken = new Set();
  for (const { col, role } of pairs) {
    if (roles[col] !== "ignore") continue;
    if (!MULTI_ROLES.has(role) && taken.has(role)) continue;
    roles[col] = role;
    taken.add(role);
  }
  return { headers, roles };
}

function profile(cells, vocab) {
  const n = cells.length;
  if (!n) return { filled: 0, codeLike: 0, responseLike: 0, urlLike: 0, fileLike: 0, avgLen: 0, distinct: 0, distinctRatioPenalty: 0 };
  const texts = cells.map((c) => c.text);
  const distinct = new Set(texts.map((t) => t.toLowerCase())).size;
  return {
    filled: n,
    codeLike: cells.filter((c) => looksLikeCode(c.text, c.isNumber)).length / n,
    responseLike: texts.filter((t) => vocab.isResponseValue(t)).length / n,
    urlLike: texts.filter((t) => /https?:\/\//i.test(t)).length / n,
    fileLike: texts.filter((t) => /\.(pdf|docx?|xlsx?|png|jpe?g|csv|json|txt)\b|screenshot|export|report/i.test(t)).length / n,
    avgLen: texts.reduce((s, t) => s + t.length, 0) / n,
    distinct,
    // A title column has mostly unique values; a repeated one (Owner, Domain) is not a title.
    distinctRatioPenalty: distinct / n < 0.6 ? 2 : 0,
  };
}

const CODE_PREFIX_WORDS = new Set(["cis", "safeguard", "control", "practice", "req", "requirement", "clause", "section", "annex", "objective", "nist", "iso", "soc", "pci", "hipaa", "cmmc", "csf", "ref", "id", "no"]);

/**
 * A code is short, has a digit, and is built from short alphanumeric pieces
 * joined by . - _ : or brackets: AC.L2-3.1.1, 3.1.1[a], CIS 1.1, A.5.15, CC6.1,
 * PR.AC-1, 164.308(a)(1). Long words only count as known prefixes ("Safeguard").
 */
export function looksLikeCode(text, isNumber = false) {
  if (isNumber) return /^\d+\.\d+$/.test(text);
  const t = text.trim();
  if (t.length > 32 || !/\d/.test(t) || /https?:|\.(pdf|docx?|xlsx?|png)\b/i.test(t)) return false;
  if (!/^[A-Za-z0-9]+(?:[\s.\-_:()[\]]+[A-Za-z0-9]+)*[)\]]?$/.test(t)) return false;
  const words = t.split(/[\s.\-_:()[\]]+/).filter((w) => /^[A-Za-z]{4,}$/.test(w));
  return words.every((w) => CODE_PREFIX_WORDS.has(w.toLowerCase())) && t.split(/\s+/).length <= 3;
}

/**
 * @typedef {Object} SourceRecord
 * @property {number} rowNumber   1-based, as the partner sees it in Excel
 * @property {string} code
 * @property {boolean} codeIsNumber
 * @property {string} title
 * @property {string} description
 * @property {string} response
 * @property {string[]} notes      one entry per notes column, labelled with its header
 * @property {string[]} evidence
 */

/**
 * Turns body rows into records, skipping rows that are not answers: blank
 * lines, section headings ("ACCESS CONTROL (AC)") and footers. A row counts
 * if it identifies an objective (code, title or description) and carries
 * something to import (a response, notes or evidence).
 * @param {Sheet} sheet
 * @param {number} headerRow
 * @param {Role[]} roles
 * @param {string[]} headers
 * @returns {{records: SourceRecord[], skipped: {rowNumber: number, reason: string}[]}}
 */
export function extractRecords(sheet, headerRow, roles, headers) {
  const colsOf = (role) => roles.flatMap((r, i) => (r === role ? [i] : []));
  const [codeCol] = colsOf("code");
  const [titleCol] = colsOf("title");
  const [descCol] = colsOf("description");
  const [respCol] = colsOf("response");
  const noteCols = colsOf("notes");
  const evCols = colsOf("evidence");

  const records = [];
  const skipped = [];
  sheet.rows.slice(headerRow + 1).forEach((row, i) => {
    const rowNumber = headerRow + i + 2;
    const filled = row.filter((c) => c.text).length;
    if (filled === 0) return;
    const get = (col) => (col == null ? "" : row[col]?.text ?? "");
    const rec = {
      rowNumber,
      code: get(codeCol),
      codeIsNumber: codeCol != null && !!row[codeCol]?.isNumber,
      title: get(titleCol),
      description: get(descCol),
      response: get(respCol),
      notes: labelled(noteCols, row, headers),
      evidence: labelled(evCols, row, headers),
    };
    const identifies = rec.code || rec.title || rec.description;
    const carries = rec.response || rec.notes.length || rec.evidence.length;
    if (!identifies || !carries || (filled === 1 && !rec.response)) {
      skipped.push({ rowNumber, reason: filled === 1 ? "Looks like a section heading or note" : "Nothing to import on this row" });
      return;
    }
    records.push(rec);
  });
  return { records, skipped };
}

function labelled(cols, row, headers) {
  const out = [];
  for (const c of cols) {
    const t = row[c]?.text;
    if (t) out.push(cols.length > 1 && headers[c] ? `${headers[c]}: ${t}` : t);
  }
  return out;
}
