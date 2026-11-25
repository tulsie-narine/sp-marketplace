// Maps whatever answer vocabulary a file uses (MET, Yes, Implemented, 75%,
// Partially in place...) onto ControlMap's fixed objective statuses. Built-in
// guesses cover common wording; the partner confirms or changes each distinct
// value on the Responses screen, and those choices always win.

export const CM_STATUSES = /** @type {const} */ (["Compliant", "Partially Compliant", "Not Compliant", "Not Applicable", "In Review", "Not Assessed"]);

/** Value meaning "leave this objective's status as it is". */
export const KEEP_STATUS = "__keep__";

const WORDS = {
  Compliant: ["yes", "y", "met", "fully met", "implemented", "fully implemented", "compliant", "fully compliant", "pass", "passed", "true", "complete", "completed", "satisfied", "in place", "effective", "done", "achieved", "conforms", "conformant", "adequate", "ok", "green", "1"],
  "Partially Compliant": ["partial", "partially", "partially met", "partly met", "partially implemented", "partially compliant", "partially in place", "in progress", "some", "mostly", "largely", "amber", "yellow", "limited", "alternative implementation", "compensating control"],
  "Not Compliant": ["no", "n", "not met", "unmet", "not implemented", "non compliant", "noncompliant", "not compliant", "fail", "failed", "false", "missing", "not in place", "gap", "red", "planned", "ineffective", "inadequate", "does not conform", "nonconformant", "0"],
  "Not Applicable": ["n/a", "na", "n.a.", "not applicable", "excluded", "out of scope", "not in scope", "inherited", "exempt"],
  "In Review": ["in review", "under review", "pending review", "review", "pending", "awaiting review", "to verify"],
  "Not Assessed": ["not assessed", "not started", "not answered", "unanswered", "unknown", "tbd", "to be determined", "not reviewed", "skipped", "-"],
};

const LOOKUP = new Map();
for (const [status, words] of Object.entries(WORDS)) for (const w of words) LOOKUP.set(w, status);

export function normalizeResponse(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[_]+/g, " ")
    .replace(/[^\p{L}\p{N}/%.\- ]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim();
}

/**
 * Best guess for one response value, or null when we have no idea.
 * @param {string} text
 * @returns {(typeof CM_STATUSES)[number] | null}
 */
export function guessStatus(text) {
  const t = normalizeResponse(text);
  if (!t) return null;
  if (LOOKUP.has(t)) return LOOKUP.get(t);

  // Percentages and fractions: 100% compliant, 0% not, anything between partial.
  const pct = t.match(/^(\d{1,3}(?:\.\d+)?)\s*%$/);
  if (pct) return percentStatus(Number(pct[1]));
  const frac = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac && Number(frac[2]) > 0) return percentStatus((100 * Number(frac[1])) / Number(frac[2]));

  // Phrases: check the most specific wording first ("not" before the bare word).
  if (/\b(not applicable|n\/a|out of scope)\b/.test(t)) return "Not Applicable";
  if (/\bpartial(ly)?\b/.test(t)) return "Partially Compliant";
  if (/\b(not|non|un)[ -]?(met|implemented|compliant|in place)\b|\bno\b/.test(t)) return "Not Compliant";
  if (/\breview\b/.test(t)) return "In Review";
  if (/\b(met|implemented|compliant|in place|yes)\b/.test(t)) return "Compliant";
  return null;
}

function percentStatus(p) {
  if (p >= 100) return "Compliant";
  if (p <= 0) return "Not Compliant";
  return "Partially Compliant";
}

export function isResponseValue(text) {
  return guessStatus(text) != null;
}

/**
 * Distinct response values in the file with counts and the suggested status,
 * most common first. Blank responses are grouped under "".
 * @param {{response: string}[]} records
 * @returns {{value: string, count: number, suggested: string | null}[]}
 */
export function responseSummary(records) {
  const counts = new Map();
  for (const r of records) {
    const key = r.response.trim();
    const k = normalizeResponse(key);
    const entry = counts.get(k) ?? { value: key, count: 0 };
    entry.count++;
    counts.set(k, entry);
  }
  return [...counts.values()]
    .map((e) => ({ ...e, suggested: e.value === "" ? KEEP_STATUS : guessStatus(e.value) }))
    .sort((a, b) => b.count - a.count);
}

/**
 * @param {string} response
 * @param {Record<string, string>} choices  normalized value -> CM status or KEEP_STATUS (from the Responses screen)
 * @returns {string | null} CM status, KEEP_STATUS, or null when unmapped
 */
export function resolveStatus(response, choices) {
  const k = normalizeResponse(response);
  if (k in choices) return choices[k];
  if (!k) return KEEP_STATUS;
  return guessStatus(response);
}

/**
 * Status for a parent objective whose children were all answered in the file
 * (CMMC practices from their [a], [b], ... assessment objectives).
 * @param {string[]} childStatuses
 */
export function rollUpStatus(childStatuses) {
  const s = childStatuses.filter((x) => x && x !== KEEP_STATUS && x !== "Not Assessed");
  if (!s.length) return null;
  const relevant = s.filter((x) => x !== "Not Applicable");
  if (!relevant.length) return "Not Applicable";
  if (relevant.every((x) => x === "Compliant")) return "Compliant";
  if (relevant.every((x) => x === "Not Compliant")) return "Not Compliant";
  if (relevant.some((x) => x === "In Review")) return "In Review";
  return "Partially Compliant";
}
