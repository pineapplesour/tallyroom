/**
 * CSV / statement parsing.
 *
 * Real bank and card exports are messy: BOM headers, CRLF, quoted fields with
 * commas, legacy Korean encodings, separate debit/credit columns, thousands
 * separators, dates in half a dozen shapes. All of that is handled here, in the
 * page, so neither the user nor the agent has to think about it.
 *
 * Nothing in this file performs any network request. Parsing happens on the
 * bytes the user dropped into the tab and nowhere else.
 */

/** Split CSV text into rows of string cells. Handles quotes and CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(cell); cell = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Decode a file's bytes. Korean statement exports are still routinely CP949 /
 * EUC-KR. We try UTF-8 first and fall back when the result contains the
 * replacement character.
 */
export async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("�")) return stripBom(utf8);
  try {
    const euckr = new TextDecoder("euc-kr").decode(buf);
    if (!euckr.includes("�")) return stripBom(euckr);
  } catch { /* decoder unavailable */ }
  return stripBom(utf8);
}

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// ---------------------------------------------------------------------------
// Column detection
// ---------------------------------------------------------------------------

const HEADER_HINTS = {
  date: ["거래일시", "거래일자", "거래날짜", "이용일", "이용일자", "승인일자", "날짜", "일자", "date", "transaction date", "posted", "post date"],
  description: ["적요", "내용", "가맹점", "가맹점명", "이용하신곳", "거래내용", "적요명", "description", "merchant", "details", "memo", "narrative", "payee"],
  amount: ["금액", "거래금액", "이용금액", "승인금액", "amount", "value"],
  debit: ["출금액", "출금", "지급액", "결제금액", "withdrawal", "debit", "paid out", "money out"],
  credit: ["입금액", "입금", "예금액", "deposit", "credit", "paid in", "money in"],
  balance: ["잔액", "거래후잔액", "balance"],
  account: ["거래점", "거래구분", "계좌", "계좌번호", "카드", "카드명", "account", "card"],
  currency: ["통화", "currency"],
};

const norm = (s) => String(s || "").replace(/[\s_\-()[\]]/g, "").toLowerCase();

/** Map header cells onto our canonical field names. */
export function detectColumns(header) {
  const map = {};
  header.forEach((raw, i) => {
    const h = norm(raw);
    if (!h) return;
    for (const [field, hints] of Object.entries(HEADER_HINTS)) {
      if (map[field] !== undefined) continue;
      if (hints.some((hint) => h === norm(hint))) { map[field] = i; return; }
    }
    for (const [field, hints] of Object.entries(HEADER_HINTS)) {
      if (map[field] !== undefined) continue;
      if (hints.some((hint) => h.includes(norm(hint)))) { map[field] = i; return; }
    }
  });
  return map;
}

/** "1,234,500원" / "(1,234)" / "-1234.00" -> number */
export function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[^0-9.\-+]/g, "");
  if (!s || s === "-" || s === "+") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/** Accepts 2026-01-31, 2026.01.31 14:03:22, 31/01/2026, 20260131, ... */
export function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})/);
  if (m) return iso(+m[3], +m[2], +m[1]);   // day-first (non-US exports)
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * Turn raw CSV text into transaction records.
 * Returns { transactions, columns, warnings, headerRow }.
 */
export function readStatement(text, { source = "upload", defaultAccount = "" } = {}) {
  const rows = parseCsv(text);
  const warnings = [];
  if (!rows.length) return { transactions: [], columns: {}, warnings: ["The file is empty."] };

  // A statement export sometimes carries preamble lines before the header.
  let headerIdx = 0;
  let columns = detectColumns(rows[0]);
  const usable = (c) => c.date !== undefined && (c.amount !== undefined || c.debit !== undefined || c.credit !== undefined);
  if (!usable(columns)) {
    for (let i = 1; i < Math.min(rows.length, 12); i++) {
      const c = detectColumns(rows[i]);
      if (usable(c)) { headerIdx = i; columns = c; break; }
    }
  }
  if (!usable(columns)) {
    return { transactions: [], columns, warnings: ["Could not find a date column and an amount column in this file."] };
  }

  const transactions = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = parseDate(r[columns.date]);
    if (!date) { skipped++; continue; }

    let amount = null;
    if (columns.amount !== undefined) amount = parseAmount(r[columns.amount]);
    if (amount === null && (columns.debit !== undefined || columns.credit !== undefined)) {
      const out = columns.debit !== undefined ? parseAmount(r[columns.debit]) : null;
      const inn = columns.credit !== undefined ? parseAmount(r[columns.credit]) : null;
      if (out) amount = -Math.abs(out);
      else if (inn) amount = Math.abs(inn);
    }
    if (amount === null || amount === 0) { skipped++; continue; }

    const description = String(r[columns.description] ?? "").trim() || "(no description)";
    transactions.push({
      id: "",                                   // assigned by the store
      date,
      description,
      amount,
      currency: (columns.currency !== undefined ? String(r[columns.currency] || "").trim() : "") || "KRW",
      account: (columns.account !== undefined ? String(r[columns.account] || "").trim() : "") || defaultAccount || source,
      balance: columns.balance !== undefined ? parseAmount(r[columns.balance]) : null,
      category: null,
      categorySource: null,
      note: "",
      flagged: false,
    });
  }
  if (skipped) warnings.push(`${skipped} row${skipped === 1 ? "" : "s"} skipped (no readable date or amount).`);
  return { transactions, columns, warnings, headerRow: rows[headerIdx] };
}
