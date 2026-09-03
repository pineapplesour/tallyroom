#!/usr/bin/env node
/**
 * Generates the synthetic statements shipped in data/.
 *
 * Every merchant, employer, person and amount below is invented. No real
 * company names, no real cardholder, no scraped data - the files exist so a
 * first-time visitor (or a judge) has something to click on, and so the
 * detectors have known answers to find.
 *
 * Two files, deliberately different shapes, because handling both is the point:
 *   sample-statement-usd.csv  - an English chequing/card export, one signed
 *                               Amount column, ISO dates
 *   sample-statement-krw.csv  - a Korean bank export: BOM, CRLF, separate
 *                               withdrawal/deposit columns, dotted datetimes,
 *                               a running balance
 *
 * Deterministic (seeded), so regenerating gives byte-identical output.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let _s = 0;
const seed = (n) => { _s = n >>> 0; };
function rnd() {
  _s |= 0; _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + rnd() * (b - a);
const cents = (n) => Math.round(n * 100) / 100;

// --- invented merchants. The duplicated spellings are on purpose: real exports
// --- write the same shop three different ways, and clustering them is the job.
const M = {
  grocery: ["GREENFIELD MARKET", "GREENFIELD MKT #214", "Greenfield Market - Elm St", "NORTHGATE GROCERS", "PANTRY EXPRESS"],
  cafe: ["BLUE HERON COFFEE", "BLUEHERON COFFEE #1147", "BLUE HERON COFFEE  1147", "MORNING SPOON CAFE", "ROASTWORKS ESPRESSO"],
  dining: ["NOODLE YARD", "SILVER FORK BISTRO", "PIZZA CANTINA", "BENTO BOX EXPRESS", "TAKO STREET KITCHEN", "NOODLEYARD ONLINE"],
  transport: ["METRO TRANSIT CARD", "METROCARD RELOAD", "SWIFTCAB *TRIP", "SWIFT CAB", "RAILLINK INTERCITY"],
  shopping: ["URBANTHREAD", "URBAN THREAD ONLINE", "DAILYGOODS DEPOT", "NORDVELL HOME", "PIXEL AND PAPER"],
  utility: ["CITY POWER AND LIGHT", "NORTHERN GAS UTILITY", "AQUAWORKS WATER BOARD"],
  health: ["ELM STREET CLINIC", "GOODHEALTH PHARMACY", "IRONWORKS GYM"],
  travel: ["SKYBRIDGE AIRWAYS", "STAYNEST.COM", "STAYNEST * BK92LM", "DUTY FREE TERMINAL 2"],
};

const SUBS = [
  { name: "STREAMLY.COM",              day: 4,  amount: 15.99, bumpMonth: "2026-03", bumpTo: 18.99 },
  { name: "TUNEBOX PREMIUM",           day: 11, amount: 10.99 },
  { name: "CLOUDNEST STORAGE 200GB",   day: 17, amount: 2.99 },
  { name: "PRIMEBOX MEMBERSHIP",       day: 21, amount: 8.99 },
  { name: "DEVFORGE COPILOT",          day: 24, amount: 10.00 },
  { name: "ZENFLOW YOGA STUDIO",       day: 2,  amount: 129.00 },
  { name: "VAULTBACK PRO ANNUALSAVE",  day: 9,  amount: 9.99 },   // the one nobody remembers
];

const ACCOUNTS = { checking: "Everyday Checking ****2210", card: "Horizon Rewards Card ****4417" };

const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

function build() {
  seed(20260904);
  const rows = [];
  const start = new Date(2025, 8, 1);
  const end = new Date(2026, 7, 31);

  const push = (date, desc, amount, account) => {
    const d = new Date(date);
    d.setHours(Math.floor(between(7, 23)), Math.floor(between(0, 60)), Math.floor(between(0, 60)));
    rows.push({ date: d, desc, amount: cents(amount), account });
  };

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDate(), dow = d.getDay();

    if (day === 25) push(d, "MERIDIAN SOFTWARE LTD PAYROLL", 4850.00, ACCOUNTS.checking);
    if (day === 1) push(d, "RENT TRANSFER - J MOORE", -1850.00, ACCOUNTS.checking);
    if (day === 15) push(d, pick(M.utility), -between(38, 142), ACCOUNTS.checking);
    if (day === 16) push(d, "TELCONNECT MOBILE", -54.00, ACCOUNTS.checking);

    for (const s of SUBS) {
      if (day !== s.day) continue;
      const amt = s.bumpMonth && ym(d) >= s.bumpMonth ? s.bumpTo : s.amount;
      push(d, s.name, -amt, s.name === "VAULTBACK PRO ANNUALSAVE" ? ACCOUNTS.card : ACCOUNTS.checking);
    }

    const nCafe = rnd() < 0.62 ? (rnd() < 0.3 ? 2 : 1) : 0;
    for (let i = 0; i < nCafe; i++) push(d, pick(M.cafe), -between(3.4, 9.2), ACCOUNTS.checking);
    if (rnd() < 0.45) push(d, pick(M.dining), -between(11, 48), ACCOUNTS.checking);
    if (rnd() < 0.30) push(d, pick(M.grocery), -between(18, 132), ACCOUNTS.checking);
    if (rnd() < 0.70) push(d, pick(M.transport), -between(2.4, 16.5), ACCOUNTS.checking);
    if (rnd() < 0.14) push(d, pick(M.shopping), -between(19, 210), ACCOUNTS.card);
    if (rnd() < 0.05) push(d, pick(M.health), -between(9, 78), ACCOUNTS.card);
    if (dow === 6 && rnd() < 0.25) push(d, pick(M.dining), -between(34, 96), ACCOUNTS.card);
  }

  // --- planted findings, so the detectors have known right answers ---
  push(new Date(2026, 2, 14), "URBANTHREAD", -128.00, ACCOUNTS.card);          // duplicate pair
  push(new Date(2026, 2, 14), "URBANTHREAD", -128.00, ACCOUNTS.card);
  push(new Date(2026, 2, 20), "URBANTHREAD REFUND", 128.00, ACCOUNTS.card);
  push(new Date(2026, 4, 2), "SKYBRIDGE AIRWAYS", -1284.00, ACCOUNTS.card);    // travel spike
  push(new Date(2026, 4, 3), "STAYNEST.COM", -742.50, ACCOUNTS.card);
  push(new Date(2026, 4, 5), "DUTY FREE TERMINAL 2", -318.00, ACCOUNTS.card);
  push(new Date(2025, 11, 24), "GREENFIELD MARKET", -412.00, ACCOUNTS.checking); // outlier vs its own history

  rows.sort((a, b) => a.date - b.date);
  return rows;
}

function usdCsv(rows) {
  const out = ["Date,Description,Amount,Currency,Account"];
  for (const r of rows) {
    out.push([isoDate(r.date), `"${r.desc}"`, r.amount.toFixed(2), "USD", `"${r.account}"`].join(","));
  }
  return out.join("\n") + "\n";
}

/** A second file in a deliberately awkward shape: BOM, CRLF, split debit/credit
 *  columns, dotted datetimes, running balance, Korean headers. Invented shops. */
function krwCsv(rows) {
  const KR = {
    "GREENFIELD MARKET": "초록들마트", "GREENFIELD MKT #214": "초록들마트 214호점",
    "Greenfield Market - Elm St": "초록들마트 느티나무점", "NORTHGATE GROCERS": "북문상회",
    "PANTRY EXPRESS": "찬장특급", "BLUE HERON COFFEE": "푸른왜가리커피",
    "BLUEHERON COFFEE #1147": "푸른왜가리커피 1147", "BLUE HERON COFFEE  1147": "푸른왜가리커피  1147",
    "MORNING SPOON CAFE": "아침숟가락", "ROASTWORKS ESPRESSO": "로스트웍스",
    "NOODLE YARD": "국수마당", "SILVER FORK BISTRO": "은수저식당", "PIZZA CANTINA": "피자칸티나",
    "BENTO BOX EXPRESS": "도시락특급", "TAKO STREET KITCHEN": "타코거리", "NOODLEYARD ONLINE": "국수마당 온라인",
    "METRO TRANSIT CARD": "누리교통카드", "METROCARD RELOAD": "누리카드 충전",
    "SWIFTCAB *TRIP": "빠른택시 *운행", "SWIFT CAB": "빠른택시", "RAILLINK INTERCITY": "레일링크 고속",
    "URBANTHREAD": "도시실타래", "URBAN THREAD ONLINE": "도시실타래 온라인",
    "DAILYGOODS DEPOT": "매일생활잡화", "NORDVELL HOME": "노르드벨 홈", "PIXEL AND PAPER": "픽셀앤페이퍼",
    "CITY POWER AND LIGHT": "시립전력공사", "NORTHERN GAS UTILITY": "북부도시가스",
    "AQUAWORKS WATER BOARD": "아쿠아웍스 수도", "ELM STREET CLINIC": "느티나무의원",
    "GOODHEALTH PHARMACY": "좋은건강약국", "IRONWORKS GYM": "무쇠공작소 짐",
    "SKYBRIDGE AIRWAYS": "하늘다리항공", "STAYNEST.COM": "머무름둥지",
    "STAYNEST * BK92LM": "머무름둥지 *BK92LM", "DUTY FREE TERMINAL 2": "면세 제2터미널",
    "STREAMLY.COM": "스트림리", "TUNEBOX PREMIUM": "튠박스 프리미엄",
    "CLOUDNEST STORAGE 200GB": "클라우드네스트 200GB", "PRIMEBOX MEMBERSHIP": "프라임박스 멤버십",
    "DEVFORGE COPILOT": "데브포지 코파일럿", "ZENFLOW YOGA STUDIO": "선류요가원",
    "VAULTBACK PRO ANNUALSAVE": "볼트백 프로 연간",
    "MERIDIAN SOFTWARE LTD PAYROLL": "(주)머리디언소프트 급여", "RENT TRANSFER - J MOORE": "월세 이체 J무어",
    "TELCONNECT MOBILE": "텔커넥트 모바일", "URBANTHREAD REFUND": "도시실타래 환불",
  };
  const rate = 1350;
  let balance = 3_200_000;
  const out = ["거래일시,적요,출금액,입금액,잔액,거래구분"];
  for (const r of rows) {
    const won = Math.round(r.amount * rate / 10) * 10;
    balance += won;
    const d = r.date;
    const dt = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    out.push([
      dt, `"${KR[r.desc] || r.desc}"`,
      won < 0 ? String(-won) : "", won > 0 ? String(won) : "",
      String(balance), r.account.includes("Card") ? "카드결제" : "입출금",
    ].join(","));
  }
  return "﻿" + out.join("\r\n") + "\r\n";
}

const rows = build();
mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(join(ROOT, "data", "sample-statement-usd.csv"), usdCsv(rows), "utf8");
writeFileSync(join(ROOT, "data", "sample-statement-krw.csv"), krwCsv(rows), "utf8");
console.log(`rows: ${rows.length}`);
console.log(`span: ${isoDate(rows[0].date)} .. ${isoDate(rows[rows.length - 1].date)}`);
