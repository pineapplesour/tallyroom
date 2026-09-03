/**
 * Rendering.
 *
 * The whole page is a function of `state`. Every agent tool call ends in the
 * same `notify()` that a click ends in, so there is no way for the screen and
 * the conversation to disagree: if the agent filtered the table, the person is
 * looking at the filtered table.
 */

import * as store from "./store.js";
import { state } from "./store.js";
import { summarize, trend, GROUPERS } from "./analysis.js";
import { horizontalBars, monthlyColumns, escapeHtml } from "./charts.js";
import { money as fmt, compact, plain } from "./format.js";
import { snapshot as egressSnapshot } from "./privacy.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let tableLimit = 60;
let webmcpInfo = { available: false, native: false, surface: null, registered: 0 };

export function setWebmcpInfo(info) { webmcpInfo = { ...webmcpInfo, ...info }; }

// ---------------------------------------------------------------------------

export function render() {
  renderHeader();
  renderEmptyState();
  renderBoard();
  renderStaged();
  renderControls();
  renderCharts();
  renderMessage();
  renderTable();
  renderActivity();
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader() {
  const pill = $("#webmcp-pill");
  if (webmcpInfo.native) {
    pill.className = "pill pill-live";
    pill.innerHTML = `<span class="dot"></span>WebMCP live · ${webmcpInfo.registered} tools`;
    pill.title = `This browser implements WebMCP at ${webmcpInfo.surface}. An agent in this browser can use every tool on this page.`;
  } else if (webmcpInfo.available) {
    pill.className = "pill pill-shim";
    pill.innerHTML = `<span class="dot"></span>WebMCP shim · ${webmcpInfo.registered} tools`;
    pill.title = "This browser has no WebMCP yet, so the page installed a compatibility shim with the same API. Open the tool console to run the tools exactly as an agent would.";
  } else {
    pill.className = "pill pill-off";
    pill.textContent = "WebMCP unavailable";
  }

  const e = egressSnapshot();
  const meter = $("#egress");
  meter.innerHTML = `<strong>${e.bytesSent}</strong> bytes sent`;
  meter.title = `${e.appAssetRequests} request(s) for this app's own files. ${e.blockedAttempts} outbound request(s) blocked. Your statement has never left this tab.`;
  meter.classList.toggle("is-clean", e.bytesSent === 0);

  $("#undo-btn").disabled = !store.canUndo();
  $("#reset-btn").hidden = !state.transactions.length;
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function renderEmptyState() {
  const has = state.transactions.length > 0;
  $("#empty").hidden = has;
  $("#workspace").hidden = !has;
}

// ---------------------------------------------------------------------------
// Pinned insights
// ---------------------------------------------------------------------------

function renderBoard() {
  const host = $("#board");
  host.hidden = !state.pinned.length;
  host.textContent = "";
  for (const p of state.pinned) {
    const card = document.createElement("article");
    card.className = `insight tone-${p.tone || "neutral"}`;
    const link = p.transactionIds?.length
      ? `<button class="linkish" data-ids="${p.transactionIds.join(",")}">show ${p.transactionIds.length} transaction${p.transactionIds.length === 1 ? "" : "s"}</button>` : "";
    card.innerHTML = `
      <button class="insight-close" data-unpin="${p.id}" aria-label="Remove this insight">×</button>
      <h3>${escapeHtml(p.title)}</h3>
      ${p.amount != null ? `<p class="insight-amount">${fmt(p.amount)}</p>` : ""}
      ${p.detail ? `<p class="insight-detail">${escapeHtml(p.detail)}</p>` : ""}
      ${link}`;
    host.appendChild(card);
  }
  $$("[data-unpin]", host).forEach((b) => b.addEventListener("click", () => store.unpin(b.dataset.unpin)));
  $$("[data-ids]", host).forEach((b) => b.addEventListener("click", () => {
    const ids = b.dataset.ids.split(",");
    store.setView({ highlightIds: ids, search: "", category: null, message: "Showing the transactions from a pinned insight." });
  }));
}

// ---------------------------------------------------------------------------
// Staged change review
// ---------------------------------------------------------------------------

function renderStaged() {
  const host = $("#staged");
  const s = state.staged;
  host.hidden = !s;
  if (!s) return;
  host.innerHTML = `
    <div class="staged-head">
      <h2>Waiting for your approval</h2>
      <p>${escapeHtml(s.summary)} — <strong>${s.totalAffected}</strong> transactions would change. Nothing has been applied.</p>
    </div>
    <ul class="staged-list">
      ${s.rules.map((r) => `
        <li>
          <span class="staged-match">${escapeHtml(r.match.value)}</span>
          <span class="staged-arrow">→</span>
          <span class="staged-cat">${escapeHtml(r.category)}</span>
          <span class="staged-count">${r.affects} rows</span>
          ${r.note ? `<span class="staged-note">${escapeHtml(r.note)}</span>` : ""}
        </li>`).join("")}
    </ul>
    <div class="staged-actions">
      <button class="btn btn-primary" id="approve-staged">Apply all ${s.rules.length} rules</button>
      <button class="btn" id="discard-staged">Discard</button>
    </div>`;
  $("#approve-staged").addEventListener("click", async () => {
    const { unregisterStagingTools } = await import("./tools.js");
    store.applyStaged();
    unregisterStagingTools();
    store.logActivity({ tool: "(you)", ok: true, summary: "approved the staged rules", input: {} });
  });
  $("#discard-staged").addEventListener("click", async () => {
    const { unregisterStagingTools } = await import("./tools.js");
    store.discardStaged();
    unregisterStagingTools();
    store.logActivity({ tool: "(you)", ok: true, summary: "discarded the staged rules", input: {} });
  });
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function renderControls() {
  const v = state.view;
  const search = $("#search");
  if (search.value !== v.search) search.value = v.search;

  const cats = ["Uncategorised", ...new Set(state.transactions.map((t) => t.category).filter(Boolean))].sort();
  fillSelect($("#category-filter"), cats, v.category, "All categories");
  fillSelect($("#account-filter"), [...new Set(state.transactions.map((t) => t.account))].sort(), v.account, "All accounts");
  $("#flow-filter").value = v.flow;
  $("#groupby-filter").value = v.groupBy;
  $("#from-date").value = v.from || "";
  $("#to-date").value = v.to || "";

  const active = [v.category, v.account, v.search, v.from, v.to, v.flow !== "all" ? v.flow : null].filter(Boolean).length;
  $("#clear-filters").hidden = active === 0;
}

function fillSelect(sel, values, current, allLabel) {
  const want = JSON.stringify([values, allLabel]);
  if (sel.dataset.filled !== want) {
    sel.textContent = "";
    const o = document.createElement("option");
    o.value = ""; o.textContent = allLabel;
    sel.appendChild(o);
    for (const val of values) {
      const opt = document.createElement("option");
      opt.value = val; opt.textContent = val;
      sel.appendChild(opt);
    }
    sel.dataset.filled = want;
  }
  sel.value = current || "";
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function renderCharts() {
  const rows = store.visibleTransactions();
  const v = state.view;

  const grouped = summarize(rows, { groupBy: v.groupBy, flow: "spend", top: 10 });
  $("#chart-a-title").textContent = `Spending by ${v.groupBy}`;
  $("#chart-a-total").textContent = `${fmt(grouped.total)} total`;
  horizontalBars($("#chart-a"), grouped.rows, {
    valueLabel: "spent",
    selected: v.groupBy === "category" ? v.category : v.groupBy === "account" ? v.account : null,
    onSelect: (group) => {
      if (v.groupBy === "category") store.setView({ category: v.category === group ? null : group, message: null });
      else if (v.groupBy === "account") store.setView({ account: v.account === group ? null : group, message: null });
      else store.setView({ search: group, message: null });
    },
  });

  const series = trend(rows, { flow: "spend" });
  const budget = v.category ? state.budgets[v.category] ?? null : null;
  $("#chart-b-title").textContent = v.category ? `${v.category} per month` : "Spending per month";
  $("#chart-b-total").textContent = series.length ? `${compact(Math.round(series.reduce((s, p) => s + p.total, 0) / series.length))} avg/mo` : "";
  monthlyColumns($("#chart-b"), series, {
    budget,
    selected: v.from && v.from.slice(0, 7) === (v.to || "").slice(0, 7) ? v.from.slice(0, 7) : null,
    onSelect: (month) => {
      const isSame = v.from === `${month}-01`;
      store.setView(isSame ? { from: null, to: null } : { from: `${month}-01`, to: `${month}-31` });
    },
  });
}

// ---------------------------------------------------------------------------
// Agent message
// ---------------------------------------------------------------------------

function renderMessage() {
  const host = $("#agent-message");
  host.hidden = !state.view.message;
  if (state.view.message) host.innerHTML = `<span class="msg-mark">agent</span> ${escapeHtml(state.view.message)}`;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function renderTable() {
  const rows = store.visibleTransactions();
  const highlight = new Set(state.view.highlightIds || []);
  $("#table-count").textContent = `${rows.length.toLocaleString()} transaction${rows.length === 1 ? "" : "s"}`;

  const body = $("#tbody");
  body.textContent = "";
  const shown = rows.slice(0, tableLimit);
  for (const t of shown) {
    const tr = document.createElement("tr");
    if (highlight.has(t.id)) tr.className = "is-highlight";
    if (t.flagged) tr.classList.add("is-flagged");
    tr.innerHTML = `
      <td class="c-date">${t.date}</td>
      <td class="c-desc">
        <span class="desc">${escapeHtml(t.description)}</span>
        ${t.note ? `<span class="row-note">${escapeHtml(t.note)}</span>` : ""}
      </td>
      <td class="c-cat">${t.category
        ? `<span class="tag tag-${t.categorySource || "rule"}">${escapeHtml(t.category)}</span>`
        : `<span class="tag tag-none">Uncategorised</span>`}</td>
      <td class="c-acct">${escapeHtml(t.account)}</td>
      <td class="c-amt ${t.amount < 0 ? "out" : "in"}">${t.amount > 0 ? "+" : ""}${fmt(t.amount)}</td>`;
    body.appendChild(tr);
  }

  const more = $("#show-more");
  more.hidden = rows.length <= tableLimit;
  more.textContent = `Show ${Math.min(200, rows.length - tableLimit)} more of ${rows.length.toLocaleString()}`;
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

function renderActivity() {
  const host = $("#activity");
  const items = [...state.activity].reverse().slice(0, 60);
  $("#activity-count").textContent = state.activity.length ? `${state.activity.length}` : "";
  if (!items.length) {
    host.innerHTML = `<p class="activity-empty">Nothing yet. When an agent uses this page, every tool call it makes shows up here — what it called, what it passed, and what came back.</p>`;
    return;
  }
  host.innerHTML = items.map((a) => `
    <div class="act ${a.ok ? "" : "act-bad"}">
      <div class="act-head">
        <code>${escapeHtml(a.tool)}</code>
        <span class="act-ms">${a.ms != null ? a.ms + "ms" : ""}</span>
      </div>
      <div class="act-summary">${escapeHtml(a.summary || "")}</div>
      ${a.input && Object.keys(a.input).length
        ? `<details class="act-args"><summary>arguments</summary><pre>${escapeHtml(JSON.stringify(a.input, null, 2))}</pre></details>` : ""}
    </div>`).join("");
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function wireControls() {
  $("#search").addEventListener("input", (e) => store.setView({ search: e.target.value, message: null }));
  $("#category-filter").addEventListener("change", (e) => store.setView({ category: e.target.value || null }));
  $("#account-filter").addEventListener("change", (e) => store.setView({ account: e.target.value || null }));
  $("#flow-filter").addEventListener("change", (e) => store.setView({ flow: e.target.value }));
  $("#groupby-filter").addEventListener("change", (e) => store.setView({ groupBy: e.target.value }));
  $("#from-date").addEventListener("change", (e) => store.setView({ from: e.target.value || null }));
  $("#to-date").addEventListener("change", (e) => store.setView({ to: e.target.value || null }));
  $("#clear-filters").addEventListener("click", () => store.setView({
    search: "", category: null, account: null, from: null, to: null, flow: "all", highlightIds: [], message: null,
  }));
  $("#show-more").addEventListener("click", () => { tableLimit += 200; render(); });
  $("#undo-btn").addEventListener("click", () => {
    const label = store.undo();
    if (label) store.logActivity({ tool: "(you)", ok: true, summary: `undid: ${label}`, input: {} });
  });
  $("#reset-btn").addEventListener("click", () => {
    if (confirm("Clear the loaded statement and start over?")) { store.reset(); tableLimit = 60; }
  });
  $$("th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    const cur = state.view.sort;
    store.setView({ sort: cur === `${key}-desc` ? `${key}-asc` : `${key}-desc` });
  }));
}
