/**
 * WebMCP tool surface.
 *
 * Every tool here is a thin wrapper over a function the app's own UI already
 * calls. Nothing is agent-only: `focus_view` is the same code path as clicking
 * a filter chip, `propose_categories` stages the same review panel a human sees
 * when they bulk-edit. That is the point of WebMCP - the agent uses the app,
 * rather than a parallel API that drifts away from it.
 *
 * Design notes worth knowing:
 *  - Every result is capped. `query_transactions` returns at most 500 rows and
 *    always returns the aggregate, so an agent can answer "how much did I spend
 *    on coffee" without pulling a thousand rows into its context.
 *  - Every tool declares `openWorldHint: false`. It is literally true here:
 *    no tool can reach the network, because the page blocks outbound requests.
 *  - Bulk categorisation cannot be applied by an agent. It can only be staged.
 *    Approving it registers two more tools at runtime, so the tool list the
 *    agent sees changes with the state of the page.
 */

import * as store from "./store.js";
import { state } from "./store.js";
import {
  clusterMerchants, findRecurring, findAnomalies, summarize, trend, merchantKey,
} from "./analysis.js";
import { snapshot as egressSnapshot } from "./privacy.js";
import { money } from "./format.js";

const MAX_ROWS = 500;

/** The browser's WebMCP entry point, wherever this build of it lives. */
export function getModelContext() {
  return (typeof document !== "undefined" && document.modelContext)
      || (typeof navigator !== "undefined" && navigator.modelContext)
      || null;
}

export function webmcpSupport() {
  const mc = getModelContext();
  if (!mc) return { available: false, surface: null, native: false };
  const native = !mc.__tallyroomShim;
  const surface = (typeof document !== "undefined" && document.modelContext === mc) ? "document.modelContext" : "navigator.modelContext";
  return { available: true, surface, native };
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** MCP-shaped result: one text block holding a summary line and JSON payload. */
function reply(summary, data) {
  const body = data === undefined ? { summary } : { summary, ...data };
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

function fail(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

function requireData() {
  if (!state.transactions.length) {
    throw new Error("No statement is loaded yet. Call load_sample_data, or ask the person to drop a CSV onto the page.");
  }
}

/** Apply the common filter arguments shared by several tools. */
function select({ from, to, category, account, search, flow, merchant, minAmount, maxAmount } = {}) {
  const q = (search || "").trim().toLowerCase();
  const mk = merchant ? merchantKey(merchant) : null;
  return state.transactions.filter((t) => {
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    if (category && (t.category || "Uncategorised") !== category) return false;
    if (account && !t.account.toLowerCase().includes(account.toLowerCase())) return false;
    if (flow === "spend" && t.amount >= 0) return false;
    if (flow === "income" && t.amount <= 0) return false;
    if (mk && !merchantKey(t.description).includes(mk)) return false;
    if (minAmount != null && Math.abs(t.amount) < minAmount) return false;
    if (maxAmount != null && Math.abs(t.amount) > maxAmount) return false;
    if (q && !(t.description.toLowerCase().includes(q) || (t.category || "").toLowerCase().includes(q))) return false;
    return true;
  });
}

const slim = (t) => ({
  id: t.id, date: t.date, description: t.description, amount: t.amount,
  category: t.category || "Uncategorised", account: t.account,
  ...(t.note ? { note: t.note } : {}), ...(t.flagged ? { flagged: true } : {}),
});

const FILTER_PROPS = {
  from: { type: "string", description: "Only include transactions on or after this date (YYYY-MM-DD)." },
  to: { type: "string", description: "Only include transactions on or before this date (YYYY-MM-DD)." },
  category: { type: "string", description: "Restrict to one category. Use 'Uncategorised' for rows with no category yet." },
  account: { type: "string", description: "Restrict to accounts whose name contains this text." },
  merchant: { type: "string", description: "Restrict to a merchant. Matching is fuzzy, so 'starbucks' catches every branch and spelling." },
  search: { type: "string", description: "Free-text match against the transaction description." },
  flow: { type: "string", enum: ["all", "spend", "income"], description: "Which side of the ledger to include. Defaults to all." },
  minAmount: { type: "number", description: "Minimum absolute amount." },
  maxAmount: { type: "number", description: "Maximum absolute amount." },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const registry = new Map();          // name -> AbortController
let onCall = () => {};               // set by the app so the UI can react

export function setCallReporter(fn) { onCall = fn; }

async function register(mc, def) {
  const controller = new AbortController();
  const wrapped = async (input = {}, options = {}) => {
    const started = performance.now();
    try {
      const result = await def.execute(input, options);
      const text = result?.content?.[0]?.text ?? "";
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* non-JSON result */ }
      onCall({
        tool: def.name, input, ok: !result?.isError,
        summary: parsed?.summary || parsed?.error || "done",
        ms: Math.round(performance.now() - started),
      });
      return result;
    } catch (err) {
      onCall({ tool: def.name, input, ok: false, summary: err.message, ms: Math.round(performance.now() - started) });
      return fail(err.message);
    }
  };

  await mc.registerTool({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema ?? { type: "object", properties: {} },
    annotations: {
      readOnlyHint: def.readOnly !== false,
      destructiveHint: !!def.destructive,
      idempotentHint: def.idempotent !== false,
      openWorldHint: false,           // no tool on this page can reach the network
      title: def.title,
    },
    execute: wrapped,
  }, { signal: controller.signal });

  registry.set(def.name, controller);
}

function unregister(name) {
  const c = registry.get(name);
  if (c) { c.abort(); registry.delete(name); }
}

export const registeredToolNames = () => [...registry.keys()];

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const READ_TOOLS = [
  {
    name: "get_overview",
    title: "Overview of the loaded statement",
    description:
      "Start here. Returns what is loaded (files, row count, date range, accounts, currencies), the money totals, how much of the data is still uncategorised, any budgets, what the person is currently looking at on screen, and the page's egress meter showing how many bytes have left the browser.",
    execute() {
      const txs = state.transactions;
      if (!txs.length) {
        return reply("No statement loaded yet. Call load_sample_data to try the app with a synthetic one, or ask the person to drop their CSV onto the page.", {
          loaded: false, privacy: egressSnapshot(),
        });
      }
      const spend = txs.filter((t) => t.amount < 0);
      const income = txs.filter((t) => t.amount > 0);
      const uncategorised = txs.filter((t) => !t.category);
      const outTotal = spend.reduce((s, t) => s - t.amount, 0);
      const inTotal = income.reduce((s, t) => s + t.amount, 0);
      const categories = [...new Set(txs.map((t) => t.category).filter(Boolean))].sort();
      return reply(
        `${txs.length} transactions from ${txs[0].date} to ${txs[txs.length - 1].date}. Money out ${money(outTotal)}, money in ${money(inTotal)}. ${uncategorised.length} rows still uncategorised.`,
        {
          loaded: true,
          files: state.meta.files,
          rows: txs.length,
          dateRange: { from: txs[0].date, to: txs[txs.length - 1].date },
          accounts: [...new Set(txs.map((t) => t.account))],
          currencies: [...new Set(txs.map((t) => t.currency))],
          totals: { spend: Math.round(outTotal), income: Math.round(inTotal), net: Math.round(inTotal - outTotal) },
          categories,
          uncategorisedRows: uncategorised.length,
          uncategorisedSpend: Math.round(uncategorised.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0)),
          rules: state.rules.length,
          budgets: state.budgets,
          staged: state.staged ? { summary: state.staged.summary, rowsAffected: state.staged.totalAffected } : null,
          currentView: state.view,
          privacy: {
            ...egressSnapshot(),
            note: "This page blocks outbound requests. Statement data has never left the browser.",
          },
        });
    },
  },

  {
    name: "query_transactions",
    title: "List individual transactions",
    description:
      "Return individual transactions matching a filter, newest first by default, together with the totals for the whole matching set. Use this when you need to look at specific rows. The row list is capped (default 50, maximum 500) but the totals always cover every match, so prefer summarize_spending when you only need a number.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILTER_PROPS,
        sort: { type: "string", enum: ["date-desc", "date-asc", "amount-desc", "amount-asc"], description: "Row ordering. Defaults to date-desc." },
        limit: { type: "number", description: "How many rows to return, 1-500. Defaults to 50." },
      },
    },
    execute(input = {}) {
      requireData();
      const rows = select(input);
      const limit = Math.min(Math.max(1, input.limit ?? 50), MAX_ROWS);
      const sorted = [...rows];
      const [key, dir] = (input.sort || "date-desc").split("-");
      const sign = dir === "asc" ? 1 : -1;
      sorted.sort((a, b) => key === "amount"
        ? sign * (Math.abs(a.amount) - Math.abs(b.amount))
        : sign * a.date.localeCompare(b.date));
      const spend = rows.reduce((s, t) => (t.amount < 0 ? s - t.amount : s), 0);
      const income = rows.reduce((s, t) => (t.amount > 0 ? s + t.amount : s), 0);
      return reply(
        `${rows.length} matching transactions. Money out ${money(spend)}, money in ${money(income)}. Showing ${Math.min(limit, rows.length)}.`,
        {
          matched: rows.length,
          totals: { spend: Math.round(spend), income: Math.round(income), net: Math.round(income - spend) },
          returned: Math.min(limit, sorted.length),
          transactions: sorted.slice(0, limit).map(slim),
        });
    },
  },

  {
    name: "summarize_spending",
    title: "Group and total spending",
    description:
      "Group the transactions and total each group - by category, merchant, month, account or day. This is the cheap way to answer almost any 'how much' question; it reads every matching row but returns only the groups.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILTER_PROPS,
        groupBy: { type: "string", enum: ["category", "merchant", "month", "account", "day"], description: "What to group by. Defaults to category." },
        top: { type: "number", description: "Keep only the largest N groups and fold the rest into 'Other'." },
      },
    },
    execute(input = {}) {
      requireData();
      const rows = select({ ...input, flow: input.flow || "spend" });
      const result = summarize(rows, { groupBy: input.groupBy || "category", flow: input.flow || "spend", top: input.top || 0 });
      const head = result.rows.slice(0, 3).map((r) => `${r.group} ${money(r.total)}`).join(", ");
      return reply(`${result.rows.length} groups totalling ${money(result.total)}. Largest: ${head}.`, result);
    },
  },

  {
    name: "get_trend",
    title: "Month-by-month trend",
    description:
      "Return a month-by-month series, optionally for one category or merchant, so you can talk about whether something is going up or down rather than just its total.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILTER_PROPS,
        groupBy: { type: "string", enum: ["category", "merchant", "account"], description: "Which dimension `value` refers to. Defaults to category." },
        value: { type: "string", description: "The single category, merchant or account to chart. Omit for everything." },
      },
    },
    execute(input = {}) {
      requireData();
      const rows = select(input);
      const series = trend(rows, { groupBy: input.groupBy || "category", value: input.value ?? null, flow: input.flow || "spend" });
      if (series.length < 2) return reply(`Only ${series.length} month(s) of data for that filter.`, { series });
      const first = series[0], last = series[series.length - 1];
      const change = first.total ? Math.round(((last.total - first.total) / first.total) * 1000) / 10 : 0;
      const avg = Math.round(series.reduce((s, p) => s + p.total, 0) / series.length);
      return reply(
        `${series.length} months, averaging ${money(avg)} per month. ${first.month} ${money(first.total)} to ${last.month} ${money(last.total)} (${change > 0 ? "+" : ""}${change}%).`,
        { series, monthlyAverage: avg, changePct: change });
    },
  },

  {
    name: "list_merchants",
    title: "Merchant clusters",
    description:
      "Group the raw description strings into merchants, collapsing branch names, card reference numbers and spelling variants. Ask for onlyUncategorised to get exactly the work that still needs deciding: a few dozen clusters instead of a thousand rows. This is the right input to propose_categories.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILTER_PROPS,
        onlyUncategorised: { type: "boolean", description: "Only clusters that have no category yet. Defaults to false." },
        limit: { type: "number", description: "How many clusters to return, largest spend first. Defaults to 60." },
      },
    },
    execute(input = {}) {
      requireData();
      const rows = select(input);
      const clusters = clusterMerchants(rows, { onlyUncategorised: !!input.onlyUncategorised });
      const limit = Math.min(input.limit ?? 60, 300);
      return reply(
        `${clusters.length} merchant${clusters.length === 1 ? "" : "s"}${input.onlyUncategorised ? " still uncategorised" : ""}. Showing ${Math.min(limit, clusters.length)}, biggest spend first.`,
        { merchants: clusters.slice(0, limit), totalClusters: clusters.length });
    },
  },

  {
    name: "find_recurring",
    title: "Recurring charges and subscriptions",
    description:
      "Detect charges that repeat on a schedule - subscriptions, rent, memberships - by clustering merchants and testing the gaps between charges for weekly, monthly, quarterly or yearly regularity. Reports the typical amount, the annualised cost, and any price change between the early and recent charges, which is how a quiet price rise gets caught.",
    inputSchema: {
      type: "object",
      properties: {
        minOccurrences: { type: "number", description: "How many charges before something counts as recurring. Defaults to 3." },
      },
    },
    execute(input = {}) {
      requireData();
      const found = findRecurring(state.transactions, { minOccurrences: input.minOccurrences ?? 3 });
      const yearly = found.reduce((s, r) => s + r.annualisedCost, 0);
      const hikes = found.filter((r) => r.priceChange && r.priceChange.pct > 0);
      return reply(
        `${found.length} recurring charges, costing about ${money(yearly)} a year.${hikes.length ? ` ${hikes.length} of them went up in price.` : ""}`,
        { recurring: found, annualisedTotal: Math.round(yearly), priceIncreases: hikes.length });
    },
  },

  {
    name: "find_anomalies",
    title: "Outliers, duplicates and unusual charges",
    description:
      "Flag transactions worth a second look: charges far outside the normal range for that same merchant (scored against the median and MAD, so one big charge cannot hide another), the same amount billed twice within two days, and unusually large one-off payments at merchants with no history.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILTER_PROPS,
        sensitivity: { type: "number", description: "Robust z-score threshold for outliers. Lower finds more. Defaults to 3.5." },
      },
    },
    execute(input = {}) {
      requireData();
      const rows = select(input);
      const found = findAnomalies(rows, { sensitivity: input.sensitivity ?? 3.5 });
      const byType = found.reduce((m, f) => ({ ...m, [f.type]: (m[f.type] || 0) + 1 }), {});
      return reply(
        `${found.length} transactions worth a look: ${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}.`,
        { anomalies: found.slice(0, 60), counts: byType });
    },
  },

  {
    name: "check_budgets",
    title: "Budgets versus actual spending",
    description:
      "Compare each category's monthly budget against what was actually spent, month by month, and report which months went over. Returns nothing useful until budgets exist - use set_budget first.",
    inputSchema: {
      type: "object",
      properties: {
        month: { type: "string", description: "Restrict to one month (YYYY-MM). Omit for every month." },
      },
    },
    execute(input = {}) {
      requireData();
      const budgets = state.budgets;
      if (!Object.keys(budgets).length) return reply("No budgets are set yet. Use set_budget to add one.", { budgets: {} });
      const out = [];
      for (const [category, limit] of Object.entries(budgets)) {
        const series = trend(state.transactions.filter((t) => (t.category || "Uncategorised") === category), { flow: "spend" });
        for (const point of series) {
          if (input.month && point.month !== input.month) continue;
          out.push({
            category, month: point.month, budget: limit, spent: point.total,
            over: point.total > limit, difference: Math.round(point.total - limit),
          });
        }
      }
      const overs = out.filter((r) => r.over);
      return reply(`${out.length} category-months checked, ${overs.length} over budget.`, { rows: out, overBudget: overs });
    },
  },
];

const WRITE_TOOLS = [
  {
    name: "load_sample_data",
    title: "Load the synthetic sample statement",
    description:
      "Load the synthetic twelve-month statement that ships with this app, so the tools have something to work on. Entirely invented data - no real person's finances. Use this when nothing is loaded and you want to demonstrate the app.",
    readOnly: false,
    execute: async () => {
      const n = await state.__loadSample();
      return reply(`Loaded ${n} synthetic transactions covering twelve months across three accounts.`, { rows: n });
    },
  },

  {
    name: "focus_view",
    title: "Change what the person sees",
    description:
      "Drive the page the person is looking at: filter the table, change the sort or the chart grouping, highlight specific transactions, and leave a short message above the table explaining what you did. Use this constantly - it is what makes the conversation and the screen agree with each other. It only changes the view, never the data.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        ...FILTER_PROPS,
        sort: { type: "string", enum: ["date-desc", "date-asc", "amount-desc", "amount-asc"], description: "How to order the table." },
        groupBy: { type: "string", enum: ["category", "merchant", "month", "account"], description: "What the chart groups by." },
        highlightIds: { type: "array", items: { type: "string" }, description: "Transaction ids to mark in the table." },
        message: { type: "string", description: "A short line shown above the table, e.g. 'These are the three charges I think are duplicates.'" },
        reset: { type: "boolean", description: "Clear every filter first." },
      },
    },
    execute(input = {}) {
      const patch = input.reset
        ? { search: "", category: null, account: null, from: null, to: null, flow: "all", highlightIds: [], message: null }
        : {};
      for (const k of ["search", "category", "account", "from", "to", "flow", "sort", "groupBy", "message"]) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      if (input.merchant !== undefined) patch.search = input.merchant;
      if (input.highlightIds !== undefined) patch.highlightIds = input.highlightIds;
      const view = store.setView(patch);
      const shown = store.visibleTransactions().length;
      return reply(`View updated. ${shown} transactions on screen.`, { visible: shown, view });
    },
  },

  {
    name: "propose_categories",
    title: "Propose categorisation rules (needs approval)",
    description:
      "Propose rules that assign a category to every transaction matching a merchant. This does NOT change anything on its own: the rules are staged, the page shows the person exactly how many rows each rule would touch, and they approve or discard. Two extra tools - apply_staged_changes and discard_staged_changes - appear while something is staged. Build the rule list from list_merchants, and prefer one rule per merchant cluster using its `key`.",
    readOnly: false,
    idempotent: false,
    inputSchema: {
      type: "object",
      properties: {
        rules: {
          type: "array",
          description: "The rules to stage.",
          items: {
            type: "object",
            properties: {
              merchantKey: { type: "string", description: "A merchant `key` from list_merchants. Matches that cluster exactly. Preferred." },
              contains: { type: "string", description: "Alternative to merchantKey: match any description containing this text." },
              category: { type: "string", description: "The category to assign, e.g. Groceries, Dining, Transport, Subscriptions." },
              note: { type: "string", description: "Optional one-line reason, shown to the person in the review panel." },
            },
            required: ["category"],
          },
        },
        summary: { type: "string", description: "One line describing the batch, shown at the top of the review panel." },
      },
      required: ["rules"],
    },
    execute(input = {}) {
      requireData();
      const rules = (input.rules || []).map((r) => ({
        match: r.merchantKey ? { type: "merchantKey", value: r.merchantKey } : { type: "contains", value: r.contains || "" },
        category: r.category,
        note: r.note || "",
      })).filter((r) => r.match.value && r.category);
      if (!rules.length) throw new Error("No usable rules. Each rule needs a merchantKey (or contains) and a category.");

      const staged = store.stageRules(rules, input.summary);
      registerStagingTools();
      return reply(
        `Staged ${staged.rules.length} rules covering ${staged.totalAffected} transactions. Waiting for the person to approve - nothing has changed yet.`,
        {
          staged: staged.rules.map((r) => ({ match: r.match, category: r.category, affects: r.affects, note: r.note })),
          totalAffected: staged.totalAffected,
          nextStep: "The person approves in the review panel, or you can call apply_staged_changes once they say yes.",
        });
    },
  },

  {
    name: "set_transaction_category",
    title: "Categorise specific transactions",
    description:
      "Set the category on a small, explicit list of transaction ids. Use this for one-off corrections; for anything that should apply to a whole merchant, use propose_categories so the person can see the blast radius first. A manual category always wins over a rule.",
    readOnly: false,
    idempotent: false,
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Transaction ids, from query_transactions. At most 50." },
        category: { type: "string", description: "The category to assign." },
      },
      required: ["ids", "category"],
    },
    execute(input = {}) {
      requireData();
      const ids = (input.ids || []).slice(0, 50);
      if (!ids.length) throw new Error("Give at least one transaction id.");
      const n = store.setCategoryManually(ids, input.category);
      return reply(`Categorised ${n} transaction(s) as ${input.category}.`, { updated: n });
    },
  },

  {
    name: "set_budget",
    title: "Set or clear a monthly budget",
    description: "Set a monthly budget for one category, or clear it by omitting the amount. Budgets show up as a line on the chart and feed check_budgets.",
    readOnly: false,
    idempotent: false,
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "The category to budget." },
        monthlyAmount: { type: "number", description: "Monthly limit. Omit to clear the budget." },
      },
      required: ["category"],
    },
    execute(input = {}) {
      store.setBudget(input.category, input.monthlyAmount ?? null);
      return reply(input.monthlyAmount == null
        ? `Cleared the budget for ${input.category}.`
        : `Budget for ${input.category} set to ${money(input.monthlyAmount)} a month.`, { budgets: state.budgets });
    },
  },

  {
    name: "annotate_transaction",
    title: "Add a note or flag to a transaction",
    description: "Attach a short note to one transaction, and optionally flag it so it stands out in the table. Useful for marking something the person should follow up on, like a duplicate charge to dispute.",
    readOnly: false,
    idempotent: false,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The transaction id." },
        note: { type: "string", description: "The note to attach." },
        flagged: { type: "boolean", description: "Whether to flag the row." },
      },
      required: ["id"],
    },
    execute(input = {}) {
      const t = store.annotate(input.id, { note: input.note, flagged: input.flagged });
      if (!t) throw new Error(`No transaction with id ${input.id}.`);
      return reply(`Annotated ${t.date} ${t.description}.`, { transaction: slim(t) });
    },
  },

  {
    name: "pin_insight",
    title: "Pin a finding to the board",
    description:
      "Put a finding on the board at the top of the page so it survives the conversation: a title, one line of detail, an optional number, and optionally the transaction ids it refers to so the person can click straight through to them. Pin the things worth acting on, not everything you noticed.",
    readOnly: false,
    idempotent: false,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short headline, a few words." },
        detail: { type: "string", description: "One sentence of explanation." },
        amount: { type: "number", description: "The number that matters, if there is one." },
        tone: { type: "string", enum: ["neutral", "good", "warning", "critical"], description: "How the card is coloured. Defaults to neutral." },
        transactionIds: { type: "array", items: { type: "string" }, description: "Transactions this refers to, so the card can link to them." },
      },
      required: ["title"],
    },
    execute(input = {}) {
      const entry = store.pin({
        title: input.title, detail: input.detail || "", amount: input.amount ?? null,
        tone: input.tone || "neutral", transactionIds: input.transactionIds || [],
      });
      return reply(`Pinned "${entry.title}".`, { pinned: entry.id });
    },
  },
];

// Tools that exist only while a change set is waiting for approval.
const STAGING_TOOLS = [
  {
    name: "apply_staged_changes",
    title: "Apply the staged changes",
    description: "Apply the categorisation rules currently staged for review. Only call this after the person has agreed. This tool only exists while something is staged.",
    readOnly: false,
    idempotent: false,
    execute() {
      if (!state.staged) throw new Error("Nothing is staged.");
      const result = store.applyStaged();
      unregisterStagingTools();
      return reply(`Applied ${result.applied} rules, categorising ${result.rows} transactions. The person can undo this from the header.`, result);
    },
  },
  {
    name: "discard_staged_changes",
    title: "Discard the staged changes",
    description: "Throw away the staged categorisation rules without applying them. This tool only exists while something is staged.",
    readOnly: false,
    destructive: true,
    idempotent: false,
    execute() {
      const had = store.discardStaged();
      unregisterStagingTools();
      return reply(had ? `Discarded ${had.rules.length} staged rules.` : "Nothing was staged.", {});
    },
  },
];

let stagingRegistered = false;

export async function registerStagingTools() {
  const mc = getModelContext();
  if (!mc || stagingRegistered) return;
  for (const def of STAGING_TOOLS) await register(mc, def);
  stagingRegistered = true;
}

export function unregisterStagingTools() {
  if (!stagingRegistered) return;
  for (const def of STAGING_TOOLS) unregister(def.name);
  stagingRegistered = false;
}

/**
 * Register the whole surface. Returns a description of what happened so the UI
 * can tell the person whether their browser actually supports WebMCP.
 */
export async function registerAllTools() {
  const mc = getModelContext();
  if (!mc) return { registered: 0, ...webmcpSupport() };
  for (const def of [...READ_TOOLS, ...WRITE_TOOLS]) await register(mc, def);
  if (state.staged) await registerStagingTools();
  return { registered: registry.size, ...webmcpSupport() };
}

export const ALL_TOOL_DEFS = [...READ_TOOLS, ...WRITE_TOOLS, ...STAGING_TOOLS];
