// Minimal static server for local development and the verification run.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".csv": "text/csv", ".json": "application/json", ".svg": "image/svg+xml" };

export function serve(port = 8791) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith("/")) p += "index.html";
      const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await serve(Number(process.argv[2]) || 8791);
  console.log(`Tallyroom on http://localhost:${port}/`);
}
