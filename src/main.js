/**
 * Entry point. Order matters here:
 *
 *   1. install the egress meter before anything can make a request
 *   2. make sure a modelContext exists (native, or the shim)
 *   3. register the tools
 *   4. wire the UI and paint
 */

import { installEgressMeter, onEgress } from "./privacy.js";
import { ensureModelContext } from "./shim.js";
import { registerAllTools, setCallReporter, webmcpSupport } from "./tools.js";
import * as store from "./store.js";
import { state } from "./store.js";
import { readStatement, decodeFile } from "./csv.js";
import { render, wireControls, setWebmcpInfo } from "./ui.js";
import { initConsole } from "./console.js";

installEgressMeter();

// ---------------------------------------------------------------------------
// Loading statements
// ---------------------------------------------------------------------------

async function loadFile(file) {
  const text = await decodeFile(file);
  const { transactions, warnings } = readStatement(text, { source: file.name });
  if (!transactions.length) {
    showNotice(warnings[0] || `Could not read any transactions out of ${file.name}.`, "error");
    return 0;
  }
  const n = store.addTransactions(transactions, file.name);
  showNotice(`Loaded ${n} transactions from ${file.name}.${warnings.length ? " " + warnings.join(" ") : ""}`, "ok");
  return n;
}

/** Fetches a file that ships with the app. Same-origin, no statement data involved. */
async function loadSample(which = "usd") {
  const name = which === "krw" ? "sample-statement-krw.csv" : "sample-statement-usd.csv";
  const res = await fetch(`./data/${name}`);
  const buf = await res.arrayBuffer();
  const file = new File([buf], name, { type: "text/csv" });
  return loadFile(file);
}
state.__loadSample = loadSample;

function showNotice(text, kind = "ok") {
  const el = document.getElementById("notice");
  el.textContent = text;
  el.className = `notice notice-${kind}`;
  el.hidden = false;
  clearTimeout(showNotice._t);
  showNotice._t = setTimeout(() => { el.hidden = true; }, 6000);
}

// ---------------------------------------------------------------------------
// Drag and drop / file picker
// ---------------------------------------------------------------------------

function wireLoading() {
  const drop = document.getElementById("dropzone");
  const input = document.getElementById("file-input");

  document.getElementById("pick-file").addEventListener("click", () => input.click());
  document.getElementById("pick-file-2").addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    for (const f of input.files) await loadFile(f);
    input.value = "";
  });

  for (const id of ["load-sample", "load-sample-2"]) {
    document.getElementById(id).addEventListener("click", () => loadSample("usd"));
  }
  document.getElementById("load-sample-krw").addEventListener("click", () => loadSample("krw"));

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  for (const ev of ["dragenter", "dragover"]) {
    document.addEventListener(ev, (e) => { stop(e); drop.classList.add("is-over"); });
  }
  for (const ev of ["dragleave", "drop"]) {
    document.addEventListener(ev, (e) => { stop(e); if (e.type === "drop" || e.target === drop) drop.classList.remove("is-over"); });
  }
  document.addEventListener("drop", async (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    for (const f of files) await loadFile(f);
  });
}

// ---------------------------------------------------------------------------
// Suggested prompts
// ---------------------------------------------------------------------------

/** Clicking a suggestion copies it, so it can be pasted straight into an agent. */
function wirePrompts() {
  for (const btn of document.querySelectorAll(".prompt")) {
    btn.addEventListener("click", async () => {
      const text = btn.textContent.trim();
      try { await navigator.clipboard.writeText(text); } catch { /* no clipboard permission */ }
      const previous = btn.textContent;
      btn.classList.add("is-copied");
      btn.textContent = "copied — paste it to your agent";
      setTimeout(() => { btn.textContent = previous; btn.classList.remove("is-copied"); }, 1600);
    });
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function wireTheme() {
  const btn = document.getElementById("theme-toggle");
  const stored = (() => { try { return localStorage.getItem("tallyroom-theme"); } catch { return null; } })();
  if (stored) document.documentElement.dataset.theme = stored;
  btn.addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme === "dark"
      || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("tallyroom-theme", next); } catch { /* private mode */ }
    render();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const ctx = ensureModelContext();

  setCallReporter((call) => {
    store.logActivity(call);
    const panel = document.getElementById("activity-panel");
    if (panel) panel.classList.add("just-called");
    setTimeout(() => panel?.classList.remove("just-called"), 700);
  });

  const info = await registerAllTools();
  setWebmcpInfo({ ...info, ...webmcpSupport(), native: ctx?.native ?? false, surface: ctx?.surface });

  store.subscribe(render);
  onEgress(render);
  wireControls();
  wireLoading();
  wireTheme();
  wirePrompts();
  initConsole();
  render();

  const support = webmcpSupport();
  console.info(
    `%cTallyroom%c ${info.registered} WebMCP tools registered on ${ctx?.surface}.`
    + (support.native ? "" : "\nThis browser has no native WebMCP, so a compatibility shim is providing the API. Open the tool console to drive the tools."),
    "font-weight:bold", "font-weight:normal",
  );
  if (new URLSearchParams(location.search).has("sample")) loadSample("usd");
}

boot();
