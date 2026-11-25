// Turns an uploaded CSV / XLSX into plain tables of cells. Runs entirely in the
// browser: the assessment file never leaves the partner's machine.
//
// Each cell keeps its display text and whether the spreadsheet stored it as a
// number. That flag matters: Excel turns a control number like 4.10 into the
// number 4.1, and the matcher has to know the code may have lost a trailing 0.

import * as XLSX from "@/vendor/xlsx.mjs";

/**
 * @typedef {Object} Cell
 * @property {string} text      trimmed display text ("" when empty)
 * @property {boolean} isNumber stored as a number by the spreadsheet
 */

/**
 * @typedef {Object} Sheet
 * @property {string} name
 * @property {Cell[][]} rows    every row of the sheet, ragged rows padded to the same width
 */

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * @param {ArrayBuffer | Uint8Array} data
 * @param {string} fileName  used to tell CSV from Excel
 * @returns {Sheet[]}
 */
export function parseWorkbook(data, fileName) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength > MAX_BYTES) throw new Error("This file is larger than 25 MB. Remove unused sheets and try again.");
  const isText = /\.(csv|tsv|txt)$/i.test(fileName);
  // raw: true keeps CSV fields as typed, so "1.10" stays "1.10" instead of 1.1.
  const opts = { raw: isText, cellDates: false, dense: true };
  const wb = isText ? XLSX.read(decodeText(bytes), { ...opts, type: "string" }) : XLSX.read(bytes, { ...opts, type: "array" });
  return wb.SheetNames.map((name) => ({ name, rows: sheetRows(wb.Sheets[name]) })).filter((s) => s.rows.length > 0);
}

function sheetRows(ws) {
  const values = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const texts = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", blankrows: true });
  const width = Math.max(0, ...values.map((r) => r.length));
  const rows = values.map((row, r) =>
    Array.from({ length: width }, (_, c) => {
      const v = row[c];
      const isNumber = typeof v === "number";
      // Prefer the raw number's own string over Excel's display format, which
      // can round (4.125 shown as 4.13) or add separators.
      const text = isNumber ? String(v) : clean(texts[r]?.[c] ?? v ?? "");
      return { text, isNumber };
    }),
  );
  // Drop trailing empty rows.
  while (rows.length && rows[rows.length - 1].every((c) => !c.text)) rows.pop();
  return rows;
}

/**
 * CSV text in whichever encoding it was saved with. Mac and "CSV UTF-8" exports
 * are UTF-8; Windows Excel's default "CSV (Comma delimited)" is Windows-1252,
 * where curly quotes and dashes are bytes that aren't valid UTF-8. Try UTF-8
 * strictly, and fall back to Windows-1252 so those characters survive.
 */
export function decodeText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function clean(s) {
  return String(s).replace(/^\uFEFF/, "").replace(/\u00A0/g, " ").trim();
}
