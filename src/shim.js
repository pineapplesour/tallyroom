/**
 * A minimal, spec-shaped fallback for `document.modelContext`.
 *
 * WebMCP ships in ChatGPT's in-app browser and behind a flag in Chrome 149+.
 * Everywhere else the API simply is not there, and a page that only works in
 * one browser is not much of an argument for a web standard. So: if the real
 * thing is present we use it and never touch this file's code path; if it is
 * absent we install an implementation of the same surface - registerTool,
 * getTools, executeTool, and the toolchange event - which is enough for the
 * page's own tool console to drive every tool exactly as a browser agent would.
 *
 * This is a compatibility shim, not a fake agent. It does not answer questions
 * and it never pretends a model is present; it only provides the plumbing the
 * browser would otherwise provide. The header always says which one is live.
 */

class ShimModelContext extends EventTarget {
  constructor() {
    super();
    this.__tallyroomShim = true;
    this._tools = new Map();
  }

  async registerTool(descriptor, options = {}) {
    const { name } = descriptor;
    if (!name) throw new TypeError("registerTool requires a name.");
    this._tools.set(name, { ...descriptor, origin: location.origin });
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        this._tools.delete(name);
        this.dispatchEvent(new Event("toolchange"));
      }, { once: true });
    }
    this.dispatchEvent(new Event("toolchange"));
    return undefined;
  }

  async getTools() {
    return [...this._tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      origin: t.origin,
    }));
  }

  async executeTool(tool, input = {}, options = {}) {
    const name = typeof tool === "string" ? tool : tool?.name;
    const entry = this._tools.get(name);
    if (!entry) throw new Error(`No tool named "${name}" is registered.`);
    return entry.execute(input, options);
  }
}

/** Install the shim only if the browser has no WebMCP of its own. */
export function ensureModelContext() {
  if (typeof document === "undefined") return null;
  if (document.modelContext) return { context: document.modelContext, native: true, surface: "document.modelContext" };
  if (navigator.modelContext) return { context: navigator.modelContext, native: true, surface: "navigator.modelContext" };

  const shim = new ShimModelContext();
  try {
    Object.defineProperty(document, "modelContext", { value: shim, configurable: true, writable: false });
  } catch {
    document.modelContext = shim;
  }
  return { context: shim, native: false, surface: "document.modelContext (compatibility shim)" };
}
