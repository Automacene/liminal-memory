/**
 * Tiny dev server — serves the project directory on localhost.
 * Run: node serve.js
 * Then open: http://localhost:3000/demo/
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = 3000;

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = createServer(async (req, res) => {
  let filePath = join(__dirname, req.url === "/" ? "demo/index.html" : req.url);

  // If path ends with / serve index.html
  if (filePath.endsWith("/") || filePath.endsWith("\\")) {
    filePath = join(filePath, "index.html");
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "text/plain" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`\n  Luminal Memory dev server running at:\n`);
  console.log(`  → http://localhost:${PORT}/demo/\n`);
  console.log(`  Make sure your llama-server is running with --cors flag.\n`);
});
