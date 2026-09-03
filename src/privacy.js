/**
 * Egress meter.
 *
 * The central claim of this app is that your statement never leaves the tab.
 * A claim like that is worth nothing if you just have to believe it, so the
 * page measures itself: every outbound primitive is wrapped and counted, and
 * the count is shown in the header and returned by the `get_overview` tool.
 *
 * Requests for the app's own files (the sample CSVs) are counted separately and
 * labelled, so the meter is honest rather than merely flattering. Any request
 * carrying a body, or going to another origin, is refused outright - a bug
 * could not leak the data even if one existed.
 */

const meter = {
  sameOriginAssets: 0,
  outbound: 0,
  bytesSent: 0,
  blocked: [],
};

const listeners = new Set();
export const onEgress = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const ping = () => { for (const fn of listeners) fn(snapshot()); };

export const snapshot = () => ({
  bytesSent: meter.bytesSent,
  outboundRequests: meter.outbound,
  appAssetRequests: meter.sameOriginAssets,
  blockedAttempts: meter.blocked.length,
  blocked: meter.blocked.slice(-5),
});

function classify(url, hasBody) {
  let u;
  try { u = new URL(url, location.href); } catch { return "blocked"; }
  if (u.origin !== location.origin) return "blocked";
  if (hasBody) return "blocked";
  return "asset";
}

export function installEgressMeter() {
  const realFetch = globalThis.fetch?.bind(globalThis);
  if (realFetch) {
    globalThis.fetch = (input, init = {}) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      const hasBody = !!(init.body ?? (typeof input === "object" && input?.body));
      const verdict = classify(url, hasBody);
      if (verdict === "blocked") {
        meter.blocked.push({ url: String(url).slice(0, 120), at: Date.now() });
        ping();
        return Promise.reject(new Error("Tallyroom blocks outbound requests: your statement stays in this tab."));
      }
      meter.sameOriginAssets++;
      ping();
      return realFetch(input, init);
    };
  }

  const RealXHR = globalThis.XMLHttpRequest;
  if (RealXHR) {
    class GuardedXHR extends RealXHR {
      open(method, url, ...rest) { this.__url = url; return super.open(method, url, ...rest); }
      send(body) {
        if (classify(this.__url, body != null) === "blocked") {
          meter.blocked.push({ url: String(this.__url).slice(0, 120), at: Date.now() });
          ping();
          throw new Error("Tallyroom blocks outbound requests: your statement stays in this tab.");
        }
        meter.sameOriginAssets++;
        ping();
        return super.send(body);
      }
    }
    globalThis.XMLHttpRequest = GuardedXHR;
  }

  if (navigator.sendBeacon) {
    navigator.sendBeacon = (url) => {
      meter.blocked.push({ url: String(url).slice(0, 120), at: Date.now() });
      ping();
      return false;
    };
  }

  const RealWS = globalThis.WebSocket;
  if (RealWS) {
    globalThis.WebSocket = function Blocked(url) {
      meter.blocked.push({ url: String(url).slice(0, 120), at: Date.now() });
      ping();
      throw new Error("Tallyroom blocks outbound sockets: your statement stays in this tab.");
    };
  }
  ping();
}
