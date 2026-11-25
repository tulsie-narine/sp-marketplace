// Matches assessment rows to the client's ControlMap objectives. There are no
// per-framework tables: the catalog is whatever the API returns for the chosen
// client and framework, so any of CM's frameworks works the same way.
//
// Evidence is weighed in tiers, and every match carries a confidence and a
// plain-language reason for the review screen:
//   1. ID, exactly (after tidying case and separators)      AC.L2 3.1.1 -> AC.L2-3.1.1
//   2. ID number core, when it points at one objective       CIS-4.1, 3.1.1(a)
//   3. Name / description similarity (TF-IDF cosine)         reworded titles, no ID at all
// IDs are checked against the text: an ID whose objective reads nothing like
// the row, while another objective reads very like it, goes to review.
// No AI or network calls: everything runs locally and deterministically.

/**
 * @typedef {Object} Objective
 * @property {number} id
 * @property {string} code
 * @property {string} name
 * @property {string} description
 * @property {boolean} isChild
 * @property {string} parentCode
 * @property {string} status
 */

/**
 * @typedef {Object} Match
 * @property {number | null} objectiveId
 * @property {number} confidence   0..1
 * @property {"high" | "medium" | "low" | "none"} band
 * @property {"id-exact" | "id" | "id-ambiguous" | "text" | "conflict" | "none"} method
 * @property {string} reason
 * @property {{objectiveId: number, score: number}[]} alternatives  best text candidates, for the re-map picker
 */

export const HIGH = 0.85;
export const MEDIUM = 0.6;

/** Turns the API's objective shape into ours. */
export function toObjective(o) {
  return {
    id: o.id,
    code: String(o.code ?? "").trim(),
    name: stripHtml(o.name),
    description: stripHtml(o.description),
    isChild: !!o.is_child,
    parentCode: String(o.parent_code ?? "").trim(),
    status: o.status ?? "",
  };
}

export function stripHtml(s) {
  return String(s ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// IDs

/**
 * Full key: case and separators unified. "AC.L2 3.1.1" and "ac.l2-3.1.1" agree.
 * Core key: the dotted number plus any sub-letter. "CIS-4.01" -> "4.1",
 * "3.1.1(a)" / "3.1.1.a" / "3.1.1a" -> "3.1.1[a]".
 */
export function codeKeys(code) {
  const raw = String(code ?? "").trim().toLowerCase();
  if (!raw) return { full: "", core: "" };
  const m = raw.match(/(\d+(?:\.\d+)+)\s*(?:\[([a-z])\]|\(([a-z])\)|\.([a-z])\b|([a-z]))?\s*$/);
  let core = "";
  if (m) {
    const num = m[1].split(".").map((seg) => String(parseInt(seg, 10))).join(".");
    const sub = m[2] || m[3] || m[4] || m[5];
    core = sub ? `${num}[${sub}]` : num;
  }
  const full = raw
    .replace(/\s*(?:\(([a-z])\)|\.([a-z]))\s*$/, (_, a, b) => `[${a || b}]`)
    .replace(/[\s_:\-–]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/(^|[^0-9])0+(?=\d)/g, "$1"); // PR.AC-01 == PR.AC-1
  return { full, core };
}

/**
 * Codes a spreadsheet number might have been before Excel dropped trailing
 * zeros: 4.1 could be 4.1 or 4.10, 3.2 could be 3.20.
 */
function numericVariants(core) {
  if (!/^\d+\.\d+$/.test(core)) return [core];
  return [core, `${core}0`, `${core}00`];
}

// ---------------------------------------------------------------------------
// Text

const STOP = new Set("a an and are as at be by for from has have in into is it its of on or that the their this to with within which who whom will shall must should may can all any each other such than then there these those use used using ensure establish maintain process enterprise organization organizational system systems information".split(" "));

export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

function stem(t) {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function vectorize(tokens, idf) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const v = new Map();
  let norm = 0;
  for (const [t, n] of tf) {
    const w = (1 + Math.log(n)) * (idf.get(t) ?? idf.get("\u0000"));
    v.set(t, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm);
  if (norm) for (const [t, w] of v) v.set(t, w / norm);
  return v;
}

function cosine(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [t, w] of small) {
    const o = big.get(t);
    if (o) s += w * o;
  }
  return s;
}

// ---------------------------------------------------------------------------

/**
 * Builds the lookup structures once per catalog.
 * @param {Objective[]} objectives
 */
export type CmObjective = ReturnType<typeof toObjective>;

export function buildIndex(objectives: CmObjective[]) {
  const byFull = new Map();
  const byCore = new Map();
  const push = (map, k, o) => k && map.set(k, [...(map.get(k) ?? []), o]);
  for (const o of objectives) {
    const { full, core } = codeKeys(o.code);
    push(byFull, full, o);
    push(byCore, core, o);
  }

  // IDF over every objective's name + description.
  const docs = objectives.map((o) => new Set(tokenize(`${o.name} ${o.description}`)));
  const df = new Map();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const N = objectives.length || 1;
  const idf = new Map([["\u0000", Math.log(1 + N)]]); // unseen words: rare, so informative
  for (const [t, n] of df) idf.set(t, Math.log(1 + N / n));

  const vecs = objectives.map((o) => ({
    name: vectorize(tokenize(o.name), idf),
    desc: vectorize(tokenize(o.description), idf),
    both: vectorize(tokenize(`${o.name} ${o.description}`), idf),
    nameKey: normText(o.name),
  }));

  // Letters used in this framework's IDs (the "ac", "l2" of AC.L2-3.1.1, the "a"
  // of A.5.15). A file ID whose prefix uses other letters belongs to another
  // scheme, so its bare number must not be read as one of ours.
  const prefixLetters = new Set(objectives.flatMap((o) => prefixTokens(o.code)));

  return { objectives, byId: new Map<number, CmObjective>(objectives.map((o) => [o.id, o])), byFull, byCore, idf, vecs, prefixLetters };
}

// Words that often lead an ID without being part of it: "CIS-1.1", "Safeguard 4.1".
const GENERIC_PREFIX = new Set(["cis", "safeguard", "control", "controls", "practice", "req", "requirement", "clause", "section", "annex", "objective", "nist", "iso", "soc", "pci", "hipaa", "cmmc", "csf", "ref", "id", "no", "v", "item", "question", "q"]);

/** Letter groups before the ID's dotted number: "Q-AST-02.2" -> ["q", "ast"]. */
function prefixTokens(code) {
  const raw = String(code ?? "").toLowerCase();
  const m = raw.match(/\d+(?:\.\d+)+/);
  const head = m ? raw.slice(0, m.index) : raw.replace(/\d.*$/, "");
  return head.split(/[^a-z]+/).filter(Boolean);
}

/** True when the record's ID prefix uses letters this framework's IDs never use. */
function foreignPrefix(code, index) {
  return prefixTokens(code).some((t) => !GENERIC_PREFIX.has(t) && !index.prefixLetters.has(t));
}

function normText(s) {
  return tokenize(s).join(" ");
}

/**
 * Text similarity of one record to every objective, best first.
 * @returns {{objective: Objective, score: number}[]}
 */
function textScores(record, index, prefer) {
  const title = record.title ?? "";
  const desc = record.description ?? "";
  if (!title && !desc) return [];
  // A small nudge toward the level (practice vs assessment objective) the rest
  // of the file is written at, so a practice whose only sub-objective repeats
  // its wording lands on the practice in a practice-level file.
  const nudge = (o) => (prefer == null ? 0 : (prefer === "child") === o.isChild ? 0.02 : 0);
  const tv = vectorize(tokenize(title), index.idf);
  const dv = vectorize(tokenize(desc), index.idf);
  const bv = vectorize(tokenize(`${title} ${desc}`), index.idf);
  const titleKey = normText(title);
  return index.objectives
    .map((o, i) => {
      const v = index.vecs[i];
      if (titleKey && titleKey === v.nameKey) return { objective: o, score: 1 };
      const score = Math.max(cosine(tv, v.name), cosine(dv, v.desc), cosine(bv, v.both), 0.9 * cosine(tv, v.both), 0.9 * cosine(dv, v.name));
      return { objective: o, score: Math.min(1, score + (score > 0.3 ? nudge(o) : 0)) };
    })
    .sort((a, b) => b.score - a.score);
}

function band(c) {
  return c >= HIGH ? "high" : c >= MEDIUM ? "medium" : c > 0 ? "low" : "none";
}

/**
 * @param {import("../mapping/columns.js").SourceRecord} record
 * @param {ReturnType<typeof buildIndex>} index
 * @param {{prefer?: "parent" | "child" | null}} [opts]
 * @returns {Match}
 */
export function matchRecord(record, index, { prefer = null } = {}) {
  const text = textScores(record, index, prefer);
  const hasText = text.length > 0;
  const scoreOf = (o) => text.find((t) => t.objective === o)?.score ?? 0;
  const alternatives = text.slice(0, 6).filter((t) => t.score > 0.05).map((t) => ({ objectiveId: t.objective.id, score: round(t.score) }));
  const result = (objective, confidence, method, reason) => ({
    objectiveId: objective?.id ?? null,
    confidence: round(confidence),
    band: objective ? band(confidence) : "none",
    method,
    reason,
    alternatives,
  });

  // --- Tier 1 and 2: the ID.
  const { full, core } = codeKeys(record.code);
  let idHit = null;
  // A number cell can't be trusted as an exact ID (4.10 arrives as 4.1), so it
  // always goes through the variants check below.
  if (full && !record.codeIsNumber && index.byFull.get(full)?.length === 1) {
    idHit = { objective: index.byFull.get(full)[0], confidence: 1, method: "id-exact", reason: "ID matches exactly" };
  } else if (core && !foreignPrefix(record.code, index)) {
    const cores = record.codeIsNumber ? numericVariants(core) : [core];
    const cands = cores.flatMap((k) => index.byCore.get(k) ?? []);
    if (cands.length === 1) {
      idHit = { objective: cands[0], confidence: 0.95, method: "id", reason: `ID ${record.code} matches ${cands[0].code}` };
    } else if (cands.length > 1) {
      // Several objectives share the number (4.1 vs 4.10 from Excel, or the same
      // number under two prefixes). Let the text decide, if it clearly can.
      const ranked = cands.map((o) => ({ o, s: scoreOf(o) })).sort((a, b) => b.s - a.s);
      const margin = ranked[0].s - ranked[1].s;
      const confident = hasText && ranked[0].s >= 0.3 && margin >= 0.15;
      idHit = {
        objective: ranked[0].o,
        confidence: confident ? 0.88 : 0.55,
        method: "id-ambiguous",
        reason: `ID ${record.code} could be ${cands.map((o) => o.code).join(" or ")}; ${confident ? "the name settles it" : "please confirm"}`,
      };
    }
  }

  let best = text[0];
  let second = text[1];
  // In a practice-level file, a sub-objective that wins on wording defers to its
  // own practice when the practice reads nearly as close (CM practices often
  // carry extra reference text, like FAR / NIST citations, that dilutes them).
  if (prefer === "parent" && best?.objective.isChild) {
    const parent = text.find((t) => t.objective.code === best.objective.parentCode);
    if (parent && parent.score >= best.score - 0.3) {
      second = best;
      best = parent;
    }
  }

  if (idHit) {
    if (!hasText) return result(idHit.objective, idHit.confidence, idHit.method, idHit.reason);
    const idText = scoreOf(idHit.objective);
    // The ID and the wording disagree: the ID's objective reads nothing like the
    // row while another objective reads very much like it. Typo'd or shifted IDs
    // are common, so suggest the text match but make the partner decide.
    if (idText < 0.2 && best && best.objective !== idHit.objective && best.score >= 0.45) {
      return result(best.objective, 0.5, "conflict", `ID ${record.code} points to ${idHit.objective.code}, but the wording matches ${best.objective.code}`);
    }
    if (idText < 0.12 && idHit.method !== "id-exact") {
      return result(idHit.objective, Math.min(idHit.confidence, 0.7), idHit.method, `${idHit.reason}, but the wording looks different`);
    }
    return result(idHit.objective, idHit.confidence, idHit.method, idHit.reason);
  }

  // --- Tier 3: text only.
  if (!best || best.score < 0.15) {
    const why = record.code ? `ID ${record.code} isn't in this framework and nothing reads similar` : "Nothing in this framework reads similar";
    return result(null, 0, "none", why);
  }
  const margin = best.score - (second?.score ?? 0);
  // A runner-up that is the same requirement one level up or down (practice and
  // its lone sub-objective) is not real ambiguity once the level nudge applied.
  const sameFamily = second && prefer && (second.objective.parentCode === best.objective.code || best.objective.parentCode === second.objective.code);
  // Map raw similarity to confidence; close runners-up lower it.
  let confidence = best.score >= 0.999 ? 0.92 : Math.min(0.9, 0.25 + best.score * 0.75);
  if (sameFamily) confidence -= 0.05;
  else if (margin < 0.05) confidence -= 0.2;
  else if (margin < 0.12) confidence -= 0.08;
  const what = record.title ? "name" : "description";
  const reason = record.code
    ? `ID ${record.code} isn't in this framework; matched on ${what} (${pct(best.score)} similar)`
    : `Matched on ${what} (${pct(best.score)} similar)`;
  return result(best.objective, Math.max(0.05, confidence), "text", reason);
}

/**
 * Matches every record, then flags objectives claimed by more than one row.
 * @param {import("../mapping/columns.js").SourceRecord[]} records
 * @param {ReturnType<typeof buildIndex>} index
 */
export function matchAll(records, index) {
  // Pass 1 finds which level the file is written at from its confident ID
  // matches; pass 2 re-runs text-only matches with that preference.
  let matches = records.map((r) => matchRecord(r, index));
  const confident = matches.filter((m) => m.band === "high" && m.method.startsWith("id")).map((m) => index.byId.get(m.objectiveId));
  const childShare = confident.length ? confident.filter((o) => o.isChild).length / confident.length : 0.5;
  const prefer = confident.length >= 5 && (childShare >= 0.8 || childShare <= 0.2) ? (childShare >= 0.8 ? "child" : "parent") : null;
  if (prefer) matches = matches.map((m, i) => (m.method.startsWith("id") ? m : matchRecord(records[i], index, { prefer })));
  const claims = new Map();
  matches.forEach((m, i) => m.objectiveId != null && claims.set(m.objectiveId, [...(claims.get(m.objectiveId) ?? []), i]));
  const duplicates = new Map();
  for (const [objectiveId, rows] of claims) if (rows.length > 1) duplicates.set(objectiveId, rows);
  return { matches, duplicates };
}

/**
 * How well the file fits this framework overall. A low share of confident
 * matches usually means the partner picked the wrong framework.
 */
export function fitSummary(matches) {
  const n = matches.length || 1;
  const count = (b) => matches.filter((m) => m.band === b).length;
  const high = count("high");
  const medium = count("medium");
  // Only matches that something real backs up count toward "this file fits":
  // an exact ID, an ID whose wording agrees, or wording that clearly matches.
  // A bare number with unrelated wording is not evidence of the right framework.
  const supported = matches.filter(
    (m) => m.method === "id-exact" || (m.method === "id" && m.confidence >= 0.9) || (m.method === "id-ambiguous" && m.confidence >= HIGH) || (m.method === "text" && m.confidence >= MEDIUM),
  ).length;
  return { total: matches.length, high, medium, low: count("low"), none: count("none"), supported, likelyWrongFramework: matches.length >= 10 && supported / n < 0.3 };
}

function round(x) {
  return Math.round(x * 100) / 100;
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}
