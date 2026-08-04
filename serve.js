/**
 * Dev server — serves the project + API endpoints for the explorer tool.
 * Run: node serve.js
 * Then open: http://localhost:3000/demo/
 */
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = 3000;

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gif": "image/gif"
};

// Directories to skip when searching/listing
const SKIP = new Set(["node_modules", "dist", ".git", ".kiro", ".vscode"]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // === API: Read a file ===
  if (pathname === "/api/read") {
    const filePath = url.searchParams.get("path") || "";
    const full = resolve(__dirname, filePath);
    const root = resolve(__dirname);

    if (!full.startsWith(root)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "Access denied" }));
      return;
    }

    try {
      const content = await readFile(full, "utf8");
      const lines = content.split("\n").length;
      const truncated = content.length > 6000
        ? content.slice(0, 6000) + `\n\n... [truncated — ${content.length} chars total]`
        : content;
      const ext = extname(filePath).slice(1) || "text";
      const formatted = `## ${filePath} (${lines} lines)\n\n\`\`\`${ext}\n${truncated}\n\`\`\``;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: { path: filePath, lines, chars: content.length }, formatted }));
    } catch (err) {
      res.writeHead(404);
      res.end(JSON.stringify({ results: [], formatted: `Could not read "${filePath}": ${err.message}` }));
    }
    return;
  }

  // === API: List a directory ===
  if (pathname === "/api/list") {
    const dirPath = url.searchParams.get("path") || ".";
    const full = resolve(__dirname, dirPath);
    const root = resolve(__dirname);

    if (!full.startsWith(root)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "Access denied" }));
      return;
    }

    try {
      const entries = await readdir(full, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith(".") && !SKIP.has(e.name))
        .map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));

      const formatted = `## Directory: ${dirPath}\n\n` +
        items.map(i => (i.type === "dir" ? "📁 " : "  ") + i.name).join("\n");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: items, formatted }));
    } catch (err) {
      res.writeHead(404);
      res.end(JSON.stringify({ results: [], formatted: `Could not list "${dirPath}": ${err.message}` }));
    }
    return;
  }

  // === API: Search files ===
  if (pathname === "/api/search") {
    const query = (url.searchParams.get("q") || "").toLowerCase();
    if (!query) {
      res.writeHead(400);
      res.end(JSON.stringify({ results: [], formatted: "No search query provided." }));
      return;
    }

    const matches = [];

    async function walk(dir) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch { return; }

      for (const entry of entries) {
        if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(full);
        } else if (/\.(js|md|html|json|css)$/.test(entry.name)) {
          try {
            const content = await readFile(full, "utf8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query)) {
                matches.push({
                  file: relative(__dirname, full).replace(/\\/g, "/"),
                  line: i + 1,
                  content: lines[i].trim().slice(0, 120)
                });
                if (matches.length >= 20) return;
              }
            }
          } catch { /* skip */ }
        }
        if (matches.length >= 20) return;
      }
    }

    await walk(__dirname);

    let formatted;
    if (matches.length === 0) {
      formatted = `No matches for "${query}" in the project.`;
    } else {
      formatted = `## Search: "${query}" (${matches.length} matches)\n\n`;
      matches.forEach(m => {
        formatted += `- **${m.file}:${m.line}** — \`${m.content}\`\n`;
      });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: matches, formatted }));
    return;
  }

  // === Static file serving ===
  let filePath = join(__dirname, pathname === "/" ? "demo/index.html" : pathname);

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
  console.log(`  API endpoints:`);
  console.log(`    GET /api/read?path=src/config.js`);
  console.log(`    GET /api/list?path=src/core`);
  console.log(`    GET /api/search?q=BM25\n`);
});
