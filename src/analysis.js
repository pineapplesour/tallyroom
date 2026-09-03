/**
 * Analysis engine.
 *
 * Everything an agent would otherwise have to eyeball row by row - merchant
 * clustering, recurring-charge detection, price-hike detection, robust outlier
 * scoring, duplicate detection, budget rollups - runs here, over the whole
 * dataset, in a few milliseconds. The agent asks a question; the page does the
 * arithmetic and hands back a small answer.
 *
 * This is the division of labour the whole project is built on: the page has
 * the data and the maths, the model has the judgement.
 */

// ---------------------------------------------------------------------------
// Merchant normalisation
// ---------------------------------------------------------------------------

const NOISE = [
  /\*+\s*[a-z0-9]{3,}/gi,        // "AIRBNB * HMXQ2"
  /\b\d{4,}\b/g,                 // long reference numbers
  /\b[a-z]{1,3}\d{3,}[a-z0-9]*\b/gi,
  /\b(주식회사|주\)|㈜|inc|llc|ltd|co)\b\.?/gi,
  /\b(kr|kor|seoul|korea)\b/gi,
];

const BRANCH = /\s*(\S{1,10}(점|지점|본점|역점|센터|支店))\s*$/;

/** Collapse "STARBUCKS  1147" and "스타벅스 성수역점" style noise into a stable key. */
export function merchantKey(description) {
  let s = String(description || "").trim();
  s = s.replace(BRANCH, " ");
  for (const re of NOISE) s = s.replace(re, " ");
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
  return s || String(description || "").trim().toLowerCase();
}

/** Human-facing label for a cluster: the most common original spelling. */
function commonest(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Group transactions by normalised merchant. This is what makes categorising
 * 1,000 rows tractable: ~120 clusters instead of 1,000 individual decisions.
 */
export function clusterMerchants(transactions, { onlyUncategorised = false } = {}) {
  const groups = new Map();
  for (const t of transactions) {
    if (onlyUncategorised && t.category) continue;
    const key = merchantKey(t.description);
    let g = groups.get(key);
    if (!g) { g = { key, label: "", variants: [], count: 0, total: 0, dates: [], amounts: [] }; groups.set(key, g); }
    g.variants.push(t.description);
    g.count++;
    g.total += t.amount;
    g.dates.push(t.date);
    g.amounts.push(t.amount);
  }
  const out = [...groups.values()].map((g) => ({
    key: g.key,
    label: commonest(g.variants),
    variants: [...new Set(g.variants)].slice(0, 6),
    count: g.count,
    total: r2(g.total),
    average: r2(g.total / g.count),
    firstSeen: g.dates.reduce((a, b) => (a < b ? a : b)),
    lastSeen: g.dates.reduce((a, b) => (a > b ? a : b)),
  }));
  out.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  return out;
}

// ---------------------------------------------------------------------------
// Small statistics helpers (robust: medians, not means)
// ---------------------------------------------------------------------------

/** Round to cents. The app is currency-agnostic, so never round to whole units:
 *  a 15.99 -> 18.99 subscription rise must not disappear into "16 -> 19". */
const r2 = (n) => Math.round(n * 100) / 100;

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const mad = (arr, med = median(arr)) => median(arr.map((v) => Math.abs(v - med)));

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// ---------------------------------------------------------------------------
// Recurring charges
// ---------------------------------------------------------------------------

const CADENCES = [
  { name: "weekly", days: 7, tol: 2 },
  { name: "biweekly", days: 14, tol: 3 },
  { name: "monthly", days: 30.4, tol: 4 },
  { name: "quarterly", days: 91, tol: 8 },
  { name: "yearly", days: 365, tol: 20 },
];

/**
 * Find charges that repeat on a schedule: subscriptions, rent, memberships.
 * Also reports amount drift, so a price rise you never noticed shows up.
 */
export function findRecurring(transactions, { minOccurrences = 3 } = {}) {
  const spend = transactions.filter((t) => t.amount < 0);
  const groups = new Map();
  for (const t of spend) {
    const key = merchantKey(t.description);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const results = [];
  for (const [key, items] of groups) {
    if (items.length < minOccurrences) continue;
    const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1].date, sorted[i].date));
    if (!gaps.length) continue;

    const medGap = median(gaps);
    const cadence = CADENCES.find((c) => Math.abs(medGap - c.days) <= c.tol);
    if (!cadence) continue;

    // How consistently does it land on schedule?
    const onSchedule = gaps.filter((g) => Math.abs(g - cadence.days) <= cadence.tol).length;
    const regularity = onSchedule / gaps.length;
    if (regularity < 0.6) continue;

    const amounts = sorted.map((t) => Math.abs(t.amount));
    const medAmt = median(amounts);
    const spread = mad(amounts, medAmt) / (medAmt || 1);

    // Price change: compare the first third with the last third.
    const third = Math.max(1, Math.floor(amounts.length / 3));
    const early = median(amounts.slice(0, third));
    const late = median(amounts.slice(-third));
    const changed = early > 0 && Math.abs(late - early) / early > 0.05;

    const lastDate = sorted[sorted.length - 1].date;
    results.push({
      key,
      label: commonest(sorted.map((t) => t.description)),
      cadence: cadence.name,
      occurrences: sorted.length,
      typicalAmount: r2(medAmt),
      amountStable: spread < 0.06,
      regularity: Math.round(regularity * 100) / 100,
      firstSeen: sorted[0].date,
      lastSeen: lastDate,
      annualisedCost: r2(medAmt * (365 / cadence.days)),
      priceChange: changed ? { from: r2(early), to: r2(late), pct: Math.round(((late - early) / early) * 1000) / 10 } : null,
      totalPaid: r2(amounts.reduce((a, b) => a + b, 0)),
      category: sorted[sorted.length - 1].category || null,
    });
  }
  results.sort((a, b) => b.annualisedCost - a.annualisedCost);
  return results;
}

// ---------------------------------------------------------------------------
// Anomalies
// ---------------------------------------------------------------------------

/**
 * Two independent detectors:
 *  - "outlier": a charge far outside the normal range for that same merchant
 *  - "duplicate": identical merchant + amount within a couple of days
 */
export function findAnomalies(transactions, { sensitivity = 3.5 } = {}) {
  const spend = transactions.filter((t) => t.amount < 0);
  const byKey = new Map();
  for (const t of spend) {
    const key = merchantKey(t.description);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }

  const found = [];

  for (const [key, items] of byKey) {
    // --- outliers, only where there is enough history to have a "normal" ---
    if (items.length >= 5) {
      const amounts = items.map((t) => Math.abs(t.amount));
      const med = median(amounts);
      const dev = mad(amounts, med) || med * 0.15;
      for (const t of items) {
        const score = (Math.abs(t.amount) - med) / (dev * 1.4826);
        if (score >= sensitivity && Math.abs(t.amount) > med * 1.8) {
          found.push({
            type: "outlier",
            id: t.id, date: t.date, description: t.description, amount: t.amount,
            merchant: key,
            typicalAmount: r2(med),
            multiple: Math.round((Math.abs(t.amount) / med) * 10) / 10,
            reason: `${Math.round((Math.abs(t.amount) / med) * 10) / 10}x the usual charge at this merchant (usual ${r2(med).toLocaleString()})`,
          });
        }
      }
    }
    // --- duplicates ---
    const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      if (a.amount === b.amount && Math.abs(daysBetween(a.date, b.date)) <= 2) {
        found.push({
          type: "duplicate",
          id: b.id, date: b.date, description: b.description, amount: b.amount,
          merchant: key,
          pairedWith: a.id,
          reason: `Identical amount charged again ${daysBetween(a.date, b.date)} day(s) after ${a.date}`,
        });
      }
    }
  }

  // --- large one-offs: charges with no merchant history to compare against,
  //     judged instead against the overall distribution of spending ---
  const allAmounts = spend.map((t) => Math.abs(t.amount));
  if (allAmounts.length >= 20) {
    const med = median(allAmounts);
    // Relative to this dataset's own median, so the rule works in any currency.
    const threshold = med * 12;
    const already = new Set(found.map((f) => f.id));
    for (const t of spend) {
      if (already.has(t.id)) continue;
      if (byKey.get(merchantKey(t.description)).length >= 5) continue;  // covered above
      if (Math.abs(t.amount) >= threshold) {
        found.push({
          type: "large",
          id: t.id, date: t.date, description: t.description, amount: t.amount,
          merchant: merchantKey(t.description),
          typicalAmount: r2(med),
          multiple: Math.round((Math.abs(t.amount) / med) * 10) / 10,
          reason: `Unusually large one-off: ${Math.round(Math.abs(t.amount) / med)}x the median transaction, and this merchant has little history`,
        });
      }
    }
  }

  found.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  return found;
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

const monthOf = (d) => d.slice(0, 7);

export const GROUPERS = {
  category: (t) => t.category || "Uncategorised",
  merchant: (t) => merchantKey(t.description),
  month: (t) => monthOf(t.date),
  account: (t) => t.account || "(unknown)",
  day: (t) => t.date,
};

/**
 * Group and total. `flow` picks which side of the ledger to count:
 * "spend" (money out, reported positive), "income", or "net".
 */
export function summarize(transactions, { groupBy = "category", flow = "spend", top = 0 } = {}) {
  const g = GROUPERS[groupBy];
  if (!g) throw new Error(`Unknown groupBy "${groupBy}". Use one of: ${Object.keys(GROUPERS).join(", ")}`);

  const rows = transactions.filter((t) =>
    flow === "spend" ? t.amount < 0 : flow === "income" ? t.amount > 0 : true);

  const acc = new Map();
  for (const t of rows) {
    const k = g(t);
    let e = acc.get(k);
    if (!e) { e = { group: k, total: 0, count: 0, amounts: [] }; acc.set(k, e); }
    const v = flow === "spend" ? -t.amount : t.amount;
    e.total += v;
    e.count++;
    e.amounts.push(v);
  }

  let out = [...acc.values()].map((e) => ({
    group: e.group,
    total: r2(e.total),
    count: e.count,
    average: r2(e.total / e.count),
    largest: r2(Math.max(...e.amounts.map(Math.abs))),
  }));

  out.sort(groupBy === "month" || groupBy === "day"
    ? (a, b) => a.group.localeCompare(b.group)
    : (a, b) => b.total - a.total);

  const grand = r2(out.reduce((s, r) => s + r.total, 0));
  for (const r of out) r.share = grand ? Math.round((r.total / grand) * 1000) / 10 : 0;
  if (top > 0 && out.length > top) {
    const head = out.slice(0, top);
    const tail = out.slice(top);
    head.push({
      group: "Other", total: r2(tail.reduce((s, r) => s + r.total, 0)),
      count: tail.reduce((s, r) => s + r.count, 0), average: 0, largest: 0,
      share: Math.round((tail.reduce((s, r) => s + r.total, 0) / (grand || 1)) * 1000) / 10,
    });
    out = head;
  }
  return { groupBy, flow, total: grand, rows: out };
}

/** Month-over-month movement for one grouping value. */
export function trend(transactions, { groupBy = "category", value = null, flow = "spend" } = {}) {
  const g = GROUPERS[groupBy];
  const rows = transactions.filter((t) => {
    if (flow === "spend" && t.amount >= 0) return false;
    if (flow === "income" && t.amount <= 0) return false;
    return value == null || g(t) === value;
  });
  const byMonth = new Map();
  for (const t of rows) {
    const m = monthOf(t.date);
    byMonth.set(m, (byMonth.get(m) || 0) + (flow === "spend" ? -t.amount : t.amount));
  }
  return [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, total]) => ({ month, total: r2(total) }));
}

export { median, mad, daysBetween, monthOf, r2 };
