/**
 * Application state.
 *
 * One observable object holds everything: the transactions the user dropped in,
 * the categorisation rules, budgets, the current view, staged changes awaiting
 * human approval, and the log of every tool call an agent has made.
 *
 * The agent and the human write to exactly the same store through exactly the
 * same functions. There is no private agent copy of the data and no hidden
 * agent-only path - which is why the human can always see what the agent did,
 * and undo it.
 */

import { merchantKey } from "./analysis.js";
import { setCurrency } from "./format.js";

const listeners = new Set();
let nextId = 1;

export const state = {
  transactions: [],
  /** @type {Array<{id:string,match:{type:string,value:string},category:string,createdBy:string,note:string,createdAt:number}>} */
  rules: [],
  /** category -> monthly budget (positive number, in the dataset currency) */
  budgets: {},
  /** Changes an agent has proposed but a human has not approved yet. */
  staged: null,
  /** Everything an agent has done, newest last. */
  activity: [],
  /** Insights the agent or the user pinned to the board. */
  pinned: [],
  view: {
    search: "",
    category: null,
    account: null,
    from: null,
    to: null,
    flow: "all",
    sort: "date-desc",
    groupBy: "category",
    highlightIds: [],
    message: null,
  },
  meta: {
    files: [],
    loadedAt: null,
    bytesUploaded: 0,      // stays at 0 for the life of the session, by construction
    networkCalls: 0,
  },
  history: [],
};

export const DEFAULT_CATEGORIES = [
  "Groceries", "Dining", "Cafe", "Transport", "Housing", "Utilities",
  "Shopping", "Health", "Travel", "Subscriptions", "Income", "Transfer", "Other",
];

/** A deliberately small starter rule set: the obvious names only.
 *  Everything ambiguous is left for a human or an agent to decide. */
const STARTER_RULES = [
  ["payroll", "Income"], ["급여", "Income"],
  ["rent transfer", "Housing"], ["월세", "Housing"],
  ["city power", "Utilities"], ["시립전력", "Utilities"],
  ["gas utility", "Utilities"], ["도시가스", "Utilities"],
  ["water board", "Utilities"], ["수도", "Utilities"],
  ["telconnect", "Utilities"], ["텔커넥트", "Utilities"],
];

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function notify() { for (const fn of listeners) fn(state); }

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function addTransactions(transactions, fileLabel) {
  for (const t of transactions) t.id = `t${nextId++}`;
  state.transactions.push(...transactions);
  state.transactions.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  state.meta.files.push({ name: fileLabel, rows: transactions.length });
  state.meta.loadedAt = Date.now();
  setCurrency(state.transactions.map((t) => t.currency));
  if (!state.rules.length) {
    state.rules = STARTER_RULES.map(([value, category]) => ({
      id: `r${nextId++}`,
      match: { type: "contains", value },
      category,
      createdBy: "builtin",
      note: "shipped with the app",
      createdAt: Date.now(),
    }));
  }
  applyRules();
  notify();
  return transactions.length;
}

export function reset() {
  state.transactions = [];
  state.rules = [];
  state.budgets = {};
  state.staged = null;
  state.pinned = [];
  state.meta.files = [];
  state.view = { ...state.view, search: "", category: null, account: null, from: null, to: null, highlightIds: [], message: null };
  notify();
}

// ---------------------------------------------------------------------------
// Rules & categorisation
// ---------------------------------------------------------------------------

function ruleMatches(rule, t) {
  const { type, value } = rule.match;
  if (type === "merchantKey") return merchantKey(t.description) === value;
  if (type === "regex") {
    try { return new RegExp(value, "i").test(t.description); } catch { return false; }
  }
  return merchantKey(t.description).includes(String(value).toLowerCase())
      || t.description.toLowerCase().includes(String(value).toLowerCase());
}

/** Recompute every category from the rule list. Manual overrides always win. */
export function applyRules() {
  for (const t of state.transactions) {
    if (t.categorySource === "manual") continue;
    t.category = null;
    t.categorySource = null;
    for (const rule of state.rules) {
      if (ruleMatches(rule, t)) { t.category = rule.category; t.categorySource = rule.createdBy; break; }
    }
  }
}

/** How many rows a candidate rule would newly categorise. */
export function previewRule(rule) {
  const ids = [];
  for (const t of state.transactions) {
    if (t.categorySource === "manual") continue;
    if (ruleMatches(rule, t)) ids.push(t.id);
  }
  return ids;
}

export function addRules(rules, createdBy = "agent") {
  const created = rules.map((r) => ({
    id: `r${nextId++}`,
    match: r.match,
    category: r.category,
    createdBy,
    note: r.note || "",
    createdAt: Date.now(),
  }));
  pushHistory(`added ${created.length} rule(s)`);
  state.rules.push(...created);
  applyRules();
  notify();
  return created;
}

export function removeRule(id) {
  pushHistory("removed a rule");
  state.rules = state.rules.filter((r) => r.id !== id);
  applyRules();
  notify();
}

export function setCategoryManually(ids, category) {
  pushHistory(`set category on ${ids.length} row(s)`);
  const set = new Set(ids);
  let n = 0;
  for (const t of state.transactions) {
    if (!set.has(t.id)) continue;
    t.category = category;
    t.categorySource = "manual";
    n++;
  }
  notify();
  return n;
}

// ---------------------------------------------------------------------------
// Staged changes: the human approval gate
// ---------------------------------------------------------------------------

/**
 * An agent proposing bulk categorisation does not get to apply it. It gets to
 * stage it. The page renders exactly what would change and a human presses the
 * button. While something is staged, two extra tools appear on the page - which
 * is also a live demonstration of dynamic tool registration.
 */
export function stageRules(rules, summary) {
  const withPreview = rules.map((r) => {
    const ids = previewRule({ match: r.match, category: r.category });
    return { ...r, affects: ids.length, sampleIds: ids.slice(0, 5) };
  });
  state.staged = {
    kind: "rules",
    rules: withPreview,
    summary: summary || `${withPreview.length} categorisation rule(s)`,
    totalAffected: withPreview.reduce((s, r) => s + r.affects, 0),
    createdAt: Date.now(),
  };
  notify();
  return state.staged;
}

export function applyStaged() {
  if (!state.staged) return null;
  const applied = addRules(state.staged.rules.map((r) => ({ match: r.match, category: r.category, note: r.note })), "agent");
  const result = { applied: applied.length, rows: state.staged.totalAffected };
  state.staged = null;
  notify();
  return result;
}

export function discardStaged() {
  const had = state.staged;
  state.staged = null;
  notify();
  return had;
}

// ---------------------------------------------------------------------------
// Budgets, notes, flags, pins
// ---------------------------------------------------------------------------

export function setBudget(category, monthlyAmount) {
  pushHistory(`budget for ${category}`);
  if (monthlyAmount == null) delete state.budgets[category];
  else state.budgets[category] = Math.abs(Math.round(monthlyAmount));
  notify();
}

export function annotate(id, { note, flagged }) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return null;
  pushHistory("annotated a transaction");
  if (note !== undefined) t.note = note;
  if (flagged !== undefined) t.flagged = !!flagged;
  notify();
  return t;
}

export function pin(insight) {
  const entry = { id: `p${nextId++}`, ...insight, createdAt: Date.now() };
  state.pinned.unshift(entry);
  state.pinned = state.pinned.slice(0, 12);
  notify();
  return entry;
}

export function unpin(id) {
  state.pinned = state.pinned.filter((p) => p.id !== id);
  notify();
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function setView(patch) {
  Object.assign(state.view, patch);
  notify();
  return state.view;
}

/** The rows currently on screen, after every active filter. */
export function visibleTransactions() {
  const v = state.view;
  const q = v.search.trim().toLowerCase();
  let rows = state.transactions.filter((t) => {
    if (v.from && t.date < v.from) return false;
    if (v.to && t.date > v.to) return false;
    if (v.category && (t.category || "Uncategorised") !== v.category) return false;
    if (v.account && t.account !== v.account) return false;
    if (v.flow === "spend" && t.amount >= 0) return false;
    if (v.flow === "income" && t.amount <= 0) return false;
    if (q && !(t.description.toLowerCase().includes(q) || (t.category || "").toLowerCase().includes(q) || t.account.toLowerCase().includes(q))) return false;
    return true;
  });
  const [key, dir] = v.sort.split("-");
  const sign = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    if (key === "amount") return sign * (Math.abs(a.amount) - Math.abs(b.amount));
    if (key === "merchant") return sign * a.description.localeCompare(b.description);
    return sign * a.date.localeCompare(b.date);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Activity log & undo
// ---------------------------------------------------------------------------

export function logActivity(entry) {
  state.activity.push({ at: Date.now(), ...entry });
  if (state.activity.length > 200) state.activity.shift();
  notify();
}

function pushHistory(label) {
  state.history.push({
    label,
    at: Date.now(),
    rules: JSON.parse(JSON.stringify(state.rules)),
    budgets: { ...state.budgets },
    manual: state.transactions.filter((t) => t.categorySource === "manual").map((t) => [t.id, t.category]),
  });
  if (state.history.length > 40) state.history.shift();
}

export function undo() {
  const snap = state.history.pop();
  if (!snap) return null;
  state.rules = snap.rules;
  state.budgets = snap.budgets;
  for (const t of state.transactions) { if (t.categorySource === "manual") { t.categorySource = null; t.category = null; } }
  applyRules();
  for (const [id, cat] of snap.manual) {
    const t = state.transactions.find((x) => x.id === id);
    if (t) { t.category = cat; t.categorySource = "manual"; }
  }
  notify();
  return snap.label;
}

export const canUndo = () => state.history.length > 0;
