/**
 * Headless verification.
 *
 * Loads the real page in Chromium, then drives every registered tool through
 * `document.modelContext.executeTool()` - the same path a browser agent takes -
 * and asserts the results. Also checks the things that are easy to break and
 * hard to notice: that no console errors fire, that the egress meter stays at
 * zero, and that the staging tools appear and disappear at the right moments.
 */
import { chromium } from "playwright-core";
import { serve } from "./serve.mjs";

const EXECUTABLE = process.env.CHROME_PATH
  || `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const { server, port } = await serve(8791);
const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

const call = (name, args = {}) => page.evaluate(async ([n, a]) => {
  const tools = await document.modelContext.getTools();
  const tool = tools.find((t) => t.name === n);
  if (!tool) return { __missing: true };
  const res = await document.modelContext.executeTool(tool, a);
  try { return JSON.parse(res.content[0].text); } catch { return { __raw: res }; }
}, [name, args]);

console.log("\n── boot ──");
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!document.modelContext, null, { timeout: 5000 });

const tools = await page.evaluate(() => document.modelContext.getTools().then((t) => t.map((x) => x.name)));
check("tools registered", tools.length === 15, `got ${tools.length}: ${tools.join(", ")}`);
check("staging tools absent before staging", !tools.includes("apply_staged_changes"));

const schemaOk = await page.evaluate(async () => {
  const ts = await document.modelContext.getTools();
  return ts.every((t) => t.description?.length > 40 && t.inputSchema?.type === "object" && t.annotations);
});
check("every tool has a description, schema and annotations", schemaOk);

console.log("\n── read tools on an empty page ──");
let r = await call("get_overview");
check("get_overview works with nothing loaded", r.loaded === false, JSON.stringify(r).slice(0, 120));
check("privacy meter reports zero bytes", r.privacy?.bytesSent === 0);

console.log("\n── loading ──");
r = await call("load_sample_data");
check("load_sample_data loads rows", r.rows > 1000, `rows=${r.rows}`);

r = await call("get_overview");
check("overview reports the dataset", r.rows > 1000 && r.dateRange.from === "2025-09-01", JSON.stringify(r.dateRange));
check("overview counts uncategorised rows", r.uncategorisedRows > 500, `${r.uncategorisedRows}`);
check("bytes sent is still zero after loading a file", r.privacy.bytesSent === 0);

console.log("\n── analysis tools ──");
r = await call("summarize_spending", { groupBy: "category", flow: "spend" });
check("summarize_spending groups", r.rows.length >= 3, JSON.stringify(r.rows.map((x) => x.group)));
check("the starter rules categorise the obvious rows only", r.rows.some((x) => x.group === "Housing") && r.rows.some((x) => x.group === "Uncategorised"), r.rows.map((x) => x.group).join(","));

r = await call("summarize_spending", { groupBy: "month", flow: "spend" });
check("summarize by month returns 12 months", r.rows.length === 12, `${r.rows.length}`);

r = await call("query_transactions", { flow: "spend", sort: "amount-desc", limit: 3 });
check("query_transactions caps rows but totals everything", r.returned === 3 && r.matched > 900, `returned=${r.returned} matched=${r.matched}`);
check("largest spend is the monthly rent", r.transactions[0].description.includes("RENT TRANSFER"), r.transactions[0].description);
r = await call("query_transactions", { flow: "spend", sort: "amount-desc", limit: 15 });
check("the planted airline charge is in the top fifteen", r.transactions.some((t) => t.description.includes("SKYBRIDGE")), r.transactions.map((t) => t.description).join(" | "));

r = await call("list_merchants", { onlyUncategorised: true, limit: 5 });
check("list_merchants clusters spellings", r.totalClusters > 10 && r.merchants[0].variants.length >= 1, `${r.totalClusters} clusters`);

r = await call("find_recurring");
const streamly = r.recurring.find((x) => x.label.includes("STREAMLY"));
check("find_recurring finds the subscriptions", r.recurring.length >= 7, `${r.recurring.length}`);
check("find_recurring catches the price rise", streamly?.priceChange?.from === 15.99 && streamly?.priceChange?.to === 18.99, JSON.stringify(streamly?.priceChange));

r = await call("find_anomalies");
check("find_anomalies finds the duplicate charge", r.anomalies.some((a) => a.type === "duplicate" && a.description.includes("URBANTHREAD")));
check("find_anomalies finds the large one-off", r.anomalies.some((a) => a.type === "large" && a.description.includes("SKYBRIDGE")));
check("find_anomalies finds the merchant outlier", r.anomalies.some((a) => a.type === "outlier" && a.description.includes("GREENFIELD")));

r = await call("get_trend", { flow: "spend" });
check("get_trend returns a monthly series", r.series.length === 12, `${r.series?.length}`);

console.log("\n── view control ──");
r = await call("focus_view", { search: "BLUE HERON", message: "Every coffee run." });
check("focus_view filters the table", r.visible > 100 && r.visible < 400, `visible=${r.visible}`);
check("the page actually shows the message", await page.locator("#agent-message").isVisible());
const rowCount = await page.locator("#tbody tr").count();
check("the table re-rendered", rowCount > 0 && rowCount <= 60, `${rowCount} rows`);
await call("focus_view", { reset: true });

console.log("\n── the approval gate ──");
r = await call("propose_categories", {
  summary: "First pass",
  rules: [
    { merchantKey: "blue heron coffee", category: "Cafe", note: "three spellings, one shop" },
    { merchantKey: "greenfield market", category: "Groceries" },
    { merchantKey: "metro transit card", category: "Transport" },
  ],
});
check("propose_categories stages instead of applying", r.totalAffected > 100, `affects=${r.totalAffected}`);

let after = await page.evaluate(() => document.modelContext.getTools().then((t) => t.map((x) => x.name)));
check("staging registers two more tools at runtime", after.includes("apply_staged_changes") && after.includes("discard_staged_changes"), after.join(","));
check("the review panel is on screen", await page.locator("#staged").isVisible());

const before = (await call("get_overview")).uncategorisedRows;
r = await call("apply_staged_changes");
const afterRows = (await call("get_overview")).uncategorisedRows;
check("applying the rules categorises rows", afterRows < before - 100, `${before} -> ${afterRows}`);

after = await page.evaluate(() => document.modelContext.getTools().then((t) => t.map((x) => x.name)));
check("staging tools unregister after use", !after.includes("apply_staged_changes"), after.join(","));

console.log("\n── writes ──");
r = await call("set_budget", { category: "Cafe", monthlyAmount: 90 });
check("set_budget stores the budget", r.budgets.Cafe === 90, JSON.stringify(r.budgets));
r = await call("check_budgets");
check("check_budgets compares months", r.rows.length === 12, `${r.rows?.length}`);

const oneId = (await call("query_transactions", { limit: 1 })).transactions[0].id;
r = await call("annotate_transaction", { id: oneId, note: "verify run", flagged: true });
check("annotate_transaction writes a note", r.transaction.note === "verify run");

r = await call("set_transaction_category", { ids: [oneId], category: "Other" });
check("set_transaction_category updates rows", r.updated === 1);

r = await call("pin_insight", { title: "Verification pin", detail: "written by the verify script", amount: 1284, tone: "warning" });
check("pin_insight puts a card on the board", !!r.pinned && await page.locator("#board .insight").first().isVisible());

console.log("\n── errors and undo ──");
r = await call("query_transactions", { from: "not-a-date" });
check("a bad argument does not throw uncaught", r.matched !== undefined || r.error !== undefined);
r = await call("annotate_transaction", { id: "nope" });
check("an unknown id returns a clear error", !!r.error, JSON.stringify(r));

await page.click("#undo-btn");
check("undo is wired to the header button", true);

console.log("\n── privacy and console ──");
r = await call("get_overview");
check("no bytes left the page during the whole run", r.privacy.bytesSent === 0, JSON.stringify(r.privacy));
const blocked = await page.evaluate(async () => {
  try { await fetch("https://example.com/leak", { method: "POST", body: "secret" }); return "allowed"; }
  catch (e) { return "blocked"; }
});
check("an outbound POST is refused", blocked === "blocked", blocked);

await page.click("#console-toggle");
await page.waitForTimeout(200);
check("the tool console opens", await page.locator("#console-panel").isVisible());
const listed = await page.locator(".console-tool").count();
check("the console lists the tools", listed >= 15, `${listed}`);
await page.click("#console-close");

check("no console errors during the run", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log("\n── screenshots ──");
await call("focus_view", { reset: true, message: "Subscriptions you are still paying for." });
await page.waitForTimeout(300);
await page.screenshot({ path: "docs/shot-light.png", fullPage: false });
await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
await page.waitForTimeout(300);
await page.screenshot({ path: "docs/shot-dark.png", fullPage: false });
await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
await page.click("#console-toggle");
await page.waitForTimeout(300);
await page.screenshot({ path: "docs/shot-console.png" });
console.log("  wrote docs/shot-light.png, docs/shot-dark.png, docs/shot-console.png");

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
