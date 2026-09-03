/**
 * The in-page tool console.
 *
 * WebMCP's own API includes `getTools()` and `executeTool()` for agents running
 * inside the page, and this panel is exactly that: a first-party agent-side
 * client. It asks the browser what tools this document has registered and calls
 * them through the same mediated path a browser agent would use.
 *
 * Two reasons it exists. First, anyone can inspect and exercise the whole tool
 * surface without a WebMCP-capable browser - which matters when the standard is
 * a month old. Second, it makes the contract visible: the descriptions and JSON
 * schemas shown here are the literal strings a model receives, so if a tool is
 * badly described you can see why.
 */

import { getModelContext } from "./tools.js";
import { escapeHtml } from "./charts.js";

const EXAMPLES = {
  get_overview: {},
  query_transactions: { flow: "spend", sort: "amount-desc", limit: 10 },
  summarize_spending: { groupBy: "category", flow: "spend" },
  get_trend: { groupBy: "category", value: "Uncategorised" },
  list_merchants: { onlyUncategorised: true, limit: 20 },
  find_recurring: { minOccurrences: 3 },
  find_anomalies: { sensitivity: 3.5 },
  check_budgets: {},
  load_sample_data: {},
  focus_view: { search: "coffee", message: "Here is every coffee run." },
  propose_categories: {
    summary: "First pass at the uncategorised merchants",
    rules: [
      { merchantKey: "blue heron coffee", category: "Cafe", note: "clustered across three spellings" },
      { merchantKey: "greenfield market", category: "Groceries" },
    ],
  },
  set_transaction_category: { ids: ["t1"], category: "Dining" },
  set_budget: { category: "Dining", monthlyAmount: 400 },
  annotate_transaction: { id: "t1", note: "check this", flagged: true },
  pin_insight: { title: "Duplicate charge", detail: "URBANTHREAD billed 128.00 twice on the same day.", amount: 128, tone: "warning" },
  apply_staged_changes: {},
  discard_staged_changes: {},
};

let tools = [];
let selected = null;

export function initConsole() {
  const mc = getModelContext();
  const panel = document.getElementById("console-panel");
  const toggle = document.getElementById("console-toggle");
  const closeBtn = document.getElementById("console-close");

  const open = () => { panel.hidden = false; toggle.setAttribute("aria-expanded", "true"); refresh(); };
  const close = () => { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); };

  toggle.addEventListener("click", () => (panel.hidden ? open() : close()));
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) close(); });

  if (mc?.addEventListener) mc.addEventListener("toolchange", () => { if (!panel.hidden) refresh(); });

  document.getElementById("console-run").addEventListener("click", run);
  document.getElementById("console-args").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
  });
}

async function refresh() {
  const mc = getModelContext();
  const list = document.getElementById("console-list");
  if (!mc) { list.innerHTML = `<p class="console-note">No WebMCP surface is available in this browser.</p>`; return; }

  tools = await mc.getTools();
  tools.sort((a, b) => Number(!!b.annotations?.readOnlyHint) - Number(!!a.annotations?.readOnlyHint) || a.name.localeCompare(b.name));

  list.innerHTML = tools.map((t) => {
    const ro = t.annotations?.readOnlyHint;
    return `<button class="console-tool${selected === t.name ? " is-active" : ""}" data-tool="${t.name}">
      <span class="ct-name">${escapeHtml(t.name)}</span>
      <span class="ct-kind ${ro ? "ct-read" : "ct-write"}">${ro ? "reads" : "writes"}</span>
    </button>`;
  }).join("");

  document.getElementById("console-toolcount").textContent = `${tools.length} tools registered`;
  for (const btn of list.querySelectorAll("[data-tool]")) {
    btn.addEventListener("click", () => selectTool(btn.dataset.tool));
  }
  if (selected && !tools.some((t) => t.name === selected)) selected = null;
  if (!selected && tools.length) selectTool(tools[0].name);
  else if (selected) selectTool(selected);
}

function selectTool(name) {
  selected = name;
  const tool = tools.find((t) => t.name === name);
  if (!tool) return;
  for (const b of document.querySelectorAll(".console-tool")) b.classList.toggle("is-active", b.dataset.tool === name);

  document.getElementById("console-detail").innerHTML = `
    <h4>${escapeHtml(tool.name)}</h4>
    <p class="console-desc">${escapeHtml(tool.description || "")}</p>
    <details class="console-schema"><summary>input schema</summary><pre>${escapeHtml(JSON.stringify(tool.inputSchema, null, 2))}</pre></details>`;

  document.getElementById("console-args").value = JSON.stringify(EXAMPLES[name] ?? {}, null, 2);
  document.getElementById("console-result").textContent = "";
}

async function run() {
  const out = document.getElementById("console-result");
  const tool = tools.find((t) => t.name === selected);
  if (!tool) return;

  let args;
  try {
    args = JSON.parse(document.getElementById("console-args").value || "{}");
  } catch (err) {
    out.textContent = `Arguments are not valid JSON: ${err.message}`;
    out.className = "console-result is-error";
    return;
  }

  out.textContent = "running…";
  out.className = "console-result";
  try {
    const mc = getModelContext();
    const result = await mc.executeTool(tool, args);
    const text = result?.content?.[0]?.text ?? JSON.stringify(result, null, 2);
    out.textContent = text;
    out.className = `console-result${result?.isError ? " is-error" : ""}`;
  } catch (err) {
    out.textContent = String(err?.message || err);
    out.className = "console-result is-error";
  }
}
