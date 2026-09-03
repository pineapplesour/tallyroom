/**
 * Charts: two forms, drawn as plain SVG, no library.
 *
 *  - a horizontal bar chart for magnitude-by-identity (categories, merchants,
 *    accounts), because the labels are words and words want horizontal room
 *  - a column chart for magnitude-over-time (months), with an optional budget
 *    reference line
 *
 * Both are single-series, so they carry no legend - the title names the series -
 * and use one hue rather than a colour per bar. Colour here encodes nothing;
 * length does. The one exception is a month that broke its budget, which is
 * drawn in the status colour and always carries a text label as well, never
 * colour alone.
 */

import { money as fmt, compact } from "./format.js";

const NS = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
  return node;
};

/** A rounded-end bar: square where it meets the baseline, rounded at the tip. */
function barPath(x, y, w, h, r, horizontal) {
  const rr = Math.max(0, Math.min(r, horizontal ? w : h));
  if (horizontal) {
    return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
  }
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

let tip;
function tooltip() {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}

function attachHover(node, host, html) {
  node.addEventListener("pointerenter", () => {
    const t = tooltip();
    t.innerHTML = html;
    t.hidden = false;
  });
  node.addEventListener("pointermove", (e) => {
    const t = tooltip();
    const pad = 14;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const r = t.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    t.style.left = `${x}px`;
    t.style.top = `${y}px`;
  });
  node.addEventListener("pointerleave", () => { tooltip().hidden = true; });
  host.addEventListener("pointerleave", () => { tooltip().hidden = true; });
}

// ---------------------------------------------------------------------------
// Horizontal bars — magnitude by identity
// ---------------------------------------------------------------------------

export function horizontalBars(host, rows, { onSelect, selected, valueLabel = "spent", max = 10 } = {}) {
  host.textContent = "";
  const data = rows.slice(0, max);
  if (!data.length) { host.appendChild(emptyNote("Nothing to chart yet.")); return; }

  const rowH = 30;
  const gap = 8;
  const labelW = 132;
  const valueW = 78;
  const height = data.length * (rowH + gap) - gap + 8;
  const width = Math.max(host.clientWidth || 520, 360);
  const plotW = Math.max(60, width - labelW - valueW - 12);
  const peak = Math.max(...data.map((d) => Math.abs(d.total)), 1);

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img" });
  svg.setAttribute("aria-label", `${valueLabel} by group, ${data.length} groups, largest ${fmt(peak)}`);

  data.forEach((d, i) => {
    const y = i * (rowH + gap) + 4;
    const w = (Math.abs(d.total) / peak) * plotW;
    const isSel = selected && d.group === selected;

    const g = el("g", { class: `bar-row${isSel ? " is-selected" : ""}`, tabindex: "0", role: "button" });
    g.setAttribute("aria-label", `${d.group}, ${fmt(d.total)}, ${d.count} transactions`);

    // full-width hit target, so hovering the label works too
    g.appendChild(el("rect", { x: 0, y: y - 3, width, height: rowH + 6, fill: "transparent" }));

    const label = el("text", { x: labelW - 10, y: y + rowH / 2, class: "bar-label", "text-anchor": "end", "dominant-baseline": "middle" });
    label.textContent = d.group.length > 18 ? d.group.slice(0, 17) + "…" : d.group;
    g.appendChild(label);

    g.appendChild(el("rect", { x: labelW, y, width: plotW, height: rowH, class: "bar-track", rx: 6 }));
    g.appendChild(el("path", { d: barPath(labelW, y, Math.max(w, 3), rowH, 4, true), class: "bar-fill" }));

    const value = el("text", { x: labelW + plotW + 10, y: y + rowH / 2, class: "bar-value", "dominant-baseline": "middle" });
    value.textContent = compact(d.total);
    g.appendChild(value);

    attachHover(g, host, `<strong>${escapeHtml(d.group)}</strong><br>${fmt(d.total)} ${escapeHtml(valueLabel)}<br>${d.count} transactions · ${d.share}% of total`);
    if (onSelect) {
      g.style.cursor = "pointer";
      g.addEventListener("click", () => onSelect(d.group));
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(d.group); } });
    }
    svg.appendChild(g);
  });

  host.appendChild(svg);
}

// ---------------------------------------------------------------------------
// Columns over time — magnitude by month
// ---------------------------------------------------------------------------

export function monthlyColumns(host, series, { budget = null, onSelect, selected } = {}) {
  host.textContent = "";
  if (!series.length) { host.appendChild(emptyNote("Nothing to chart yet.")); return; }

  const width = Math.max(host.clientWidth || 520, 360);
  const height = 208;
  const padL = 46, padR = 12, padT = 16, padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const peak = Math.max(...series.map((p) => p.total), budget || 0, 1);
  const slot = plotW / series.length;
  const barW = Math.max(6, Math.min(46, slot - 8));

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img" });
  svg.setAttribute("aria-label", `monthly spending, ${series.length} months, peak ${fmt(peak)}`);

  // recessive gridlines + axis ticks
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (peak / ticks) * i;
    const y = padT + plotH - (v / peak) * plotH;
    svg.appendChild(el("line", { x1: padL, x2: width - padR, y1: y, y2: y, class: i === 0 ? "axis-base" : "gridline" }));
    const t = el("text", { x: padL - 8, y, class: "axis-tick", "text-anchor": "end", "dominant-baseline": "middle" });
    t.textContent = compact(v);
    svg.appendChild(t);
  }

  series.forEach((p, i) => {
    const h = Math.max(2, (p.total / peak) * plotH);
    const x = padL + i * slot + (slot - barW) / 2;
    const y = padT + plotH - h;
    const over = budget != null && p.total > budget;
    const isSel = selected === p.month;

    const g = el("g", { class: `col${isSel ? " is-selected" : ""}`, tabindex: "0", role: "button" });
    g.setAttribute("aria-label", `${p.month}, ${fmt(p.total)}${over ? ", over budget" : ""}`);
    g.appendChild(el("rect", { x: padL + i * slot, y: padT, width: slot, height: plotH, fill: "transparent" }));
    g.appendChild(el("path", { d: barPath(x, y, barW, h, 4, false), class: over ? "col-fill is-over" : "col-fill" }));

    if (i % Math.ceil(series.length / 7) === 0 || series.length <= 8) {
      const lbl = el("text", { x: x + barW / 2, y: height - 10, class: "axis-tick", "text-anchor": "middle" });
      lbl.textContent = p.month.slice(2).replace("-", "/");
      svg.appendChild(lbl);
    }
    attachHover(g, host, `<strong>${p.month}</strong><br>${fmt(p.total)}${over ? `<br><span class="tip-warn">▲ over budget by ${fmt(p.total - budget)}</span>` : ""}`);
    if (onSelect) {
      g.style.cursor = "pointer";
      g.addEventListener("click", () => onSelect(p.month));
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(p.month); } });
    }
    svg.appendChild(g);
  });

  if (budget != null) {
    const y = padT + plotH - (budget / peak) * plotH;
    svg.appendChild(el("line", { x1: padL, x2: width - padR, y1: y, y2: y, class: "budget-line" }));
    const t = el("text", { x: width - padR, y: y - 6, class: "budget-label", "text-anchor": "end" });
    t.textContent = `budget ${compact(budget)}`;
    svg.appendChild(t);
  }

  host.appendChild(svg);
}

function emptyNote(text) {
  const p = document.createElement("p");
  p.className = "chart-empty";
  p.textContent = text;
  return p;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export { fmt, compact };
