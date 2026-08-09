/**
 * Dev server — serves the project + API endpoints for the explorer tool.
 * Run: node serve.js
 * Then open: http://localhost:3000/demo/
 */
import { createServer } from "node:http";
import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { join, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { load as cheerioLoad } from "cheerio";
import TurndownService from "turndown";
import { extractPdfText, chunkDocument } from "./src/extensions/ingest-file.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const STATE_DIR = join(__dirname, "data");
const STATE_FILE = join(STATE_DIR, "memory-state.json");

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

// === Dev control channel (Server-Sent Events) ===
// Lets whoever is running the server (including Claude, via curl) drive the open demo
// tab: push a UI refresh after a rebuild, or inject a prompt into Sovereign, then read
// the mirrored console output back from /api/log. Purely a local dev aid — it lives in
// serve.js (built on top of the library), never in the shipped library itself.
const sseClients = new Set();
function broadcastControl(event, dataObj) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(dataObj || {})}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { /* client gone — cleaned up on its 'close' */ }
  }
  return sseClients.size;
}

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

  // === API: Web Search (DISABLED — see web-search-notes.md) ===
  if (pathname === "/api/websearch") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: [], formatted: "Web search is disabled." }));
    return;
  }

  // === API: DocGen — Generate documentation for a folder (SSE progress) ===
  if (pathname === "/api/docgen" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { rootDir } = JSON.parse(body);
        if (!rootDir) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No rootDir provided" }));
          return;
        }

        const fullRoot = resolve(__dirname, rootDir);
        const outputPath = join(fullRoot, 'DOCUMENTATION.md');

        // Use SSE to stream progress
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        const sendEvent = (type, data) => {
          res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
        };

        const { generateDocumentation } = await import("./src/extensions/docgen.js");
        const result = await generateDocumentation(fullRoot, outputPath, {
          llmConfig: {
            endpoint: 'http://127.0.0.1:11434',
            apiFormat: 'ollama',
            model: 'gemma4-e4b:gpu',
            thinking: false
          },
          onProgress: (msg) => {
            console.log('[DocGen]', msg);
            sendEvent('progress', msg);
          }
        });

        sendEvent('done', { filesDocumented: result.filesDocumented, totalFunctions: result.totalFunctions, outputPath });
        res.end();
      } catch (err) {
        console.error('[DocGen] Error:', err.message);
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', data: err.message })}\n\n`);
        } catch {}
        res.end();
      }
    });
    return;
  }

  // === API: Fetch & Parse URL to Markdown (cheerio + turndown) ===
  if (pathname === "/api/fetch") {
    const targetUrl = url.searchParams.get("url") || "";
    if (!targetUrl) {
      res.writeHead(400);
      res.end(JSON.stringify({ formatted: "No URL." }));
      return;
    }

    try {
      const pageRes = await fetch(targetUrl, {
        headers: {
          "User-Agent": "LiminalMemory/1.0 (Research Bot; respectful; single-page fetch)",
          "Accept": "text/html,application/xhtml+xml"
        },
        signal: AbortSignal.timeout(8000)
      });
      const html = await pageRes.text();

      // Parse with cheerio — strip noise
      const $ = cheerioLoad(html);

      // Remove non-content elements
      $('script, style, nav, footer, header, aside, iframe, noscript, .sidebar, .nav, .footer, .header, .ads, .advertisement, [role="navigation"], [role="banner"]').remove();

      // Try to find main content container
      let contentEl = $('article, main, [role="main"], .content, .post, .article-body, .entry-content').first();
      if (!contentEl.length) contentEl = $('body');

      // Get cleaned HTML
      const cleanedHtml = contentEl.html() || '';

      // Convert to Markdown with turndown
      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-'
      });

      // Keep code blocks intact
      turndown.addRule('pre', {
        filter: ['pre'],
        replacement: function (content, node) {
          return '\n```\n' + content.trim() + '\n```\n';
        }
      });

      let markdown = turndown.turndown(cleanedHtml);

      // Extract title
      const title = $('title').text().trim() || $('h1').first().text().trim() || '';
      if (title) markdown = '# ' + title + '\n\n' + markdown;

      // Cap at 4000 chars
      if (markdown.length > 4000) {
        markdown = markdown.slice(0, 4000) + '\n\n... [truncated]';
      }

      if (!markdown.trim() || markdown.length < 50) {
        markdown = 'Could not extract readable content from this page.';
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ formatted: markdown, url: targetUrl, title: title }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ formatted: "Fetch failed: " + err.message, url: targetUrl }));
    }
    return;
  }

  // === API: Ingest File (PDF, markdown, text, code) ===
  if (pathname === "/api/ingest/file" && req.method === "POST") {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';
        let text = '';
        let filename = url.searchParams.get('filename') || 'upload';

        if (contentType.includes('application/pdf')) {
          console.log('[Ingest:File] PDF detected, buffer size:', buffer.length, 'bytes');
          text = await extractPdfText(buffer, { dataDir: STATE_DIR });
          console.log('[Ingest:File] Extracted text length:', text.length);
          if (!text || text.length < 50) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Could not extract text from PDF. It may be image-only (scanned) with no recognizable text.", nodes: [] }));
            return;
          }
        } else {
          text = buffer.toString('utf8');
        }

        if (!text || text.length < 20) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "File is empty or too short to ingest.", nodes: [] }));
          return;
        }

        const nodeChunks = chunkDocument(text, filename);
        console.log('[Ingest:File] "' + filename + '" → ' + nodeChunks.length + ' chunks');

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          nodes: nodeChunks,
          filename: filename,
          totalChunks: nodeChunks.length,
          totalChars: text.length
        }));
      } catch (err) {
        console.error('[Ingest:File] Error:', err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message, nodes: [] }));
      }
    });
    return;
  }

  // === API: Shell (read-only git commands) ===
  if (pathname === "/api/shell") {
    const cmd = url.searchParams.get("cmd") || "";
    
    // Only allow safe read-only commands
    const allowed = ['git diff', 'git log', 'git status', 'git show', 'git branch'];
    const isSafe = allowed.some(prefix => cmd.startsWith(prefix));
    
    if (!isSafe) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "Command not allowed. Only git read commands permitted." }));
      return;
    }

    exec(cmd, { cwd: __dirname, timeout: 5000 }, (err, stdout, stderr) => {
      const output = stdout || stderr || (err ? err.message : 'no output');
      const formatted = `## Shell: \`${cmd}\`\n\n\`\`\`\n${output.slice(0, 4000)}\n\`\`\``;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: output, formatted: formatted }));
    });
    return;
  }

  // === API: Log Relay — mirrors browser console output to the terminal + a file on disk ===
  // Lets Claude (or anyone without eyes on the actual browser) read what happened during
  // a real session after the fact. See demo/ui/js/internal/log-relay.js for the client side.
  if (pathname === "/api/log" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { level, text, timestamp } = JSON.parse(body);
        const time = new Date(timestamp || Date.now()).toISOString();
        const line = `[${time}] [browser:${level || 'log'}] ${text}\n`;

        // Print to the terminal running `node serve.js`
        process.stdout.write(line);

        // Also append to a durable log file so it can be read after the fact
        const logDir = join(__dirname, "tmp");
        if (!existsSync(logDir)) await mkdir(logDir, { recursive: true });
        const { appendFile } = await import("node:fs/promises");
        await appendFile(join(logDir, "browser-console.log"), line, "utf8");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // === API: Dev control channel ===
  // The demo page holds /api/control/stream open (SSE) and reacts to pushed events.
  // POST /api/control/refresh and /api/control/prompt broadcast to every open tab.
  if (pathname === "/api/control/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closing */ } }, 20000);
    req.on("close", () => { clearInterval(heartbeat); sseClients.delete(res); });
    return;
  }

  if (pathname === "/api/control/refresh" && req.method === "POST") {
    const clients = broadcastControl("refresh", { at: Date.now() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, clients }));
    return;
  }

  if (pathname === "/api/control/prompt" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let text = '';
      try { text = (JSON.parse(body || '{}').text || '').toString(); } catch { text = ''; }
      if (!text.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing 'text'" }));
        return;
      }
      const clients = broadcastControl("prompt", { text });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, clients, text }));
    });
    return;
  }

  // === API: Save/Load Settings (persistent across restarts) ===
  if (pathname === "/api/settings/save" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        if (!existsSync(STATE_DIR)) await mkdir(STATE_DIR, { recursive: true });
        await writeFile(join(STATE_DIR, 'settings.json'), body, 'utf8');
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (pathname === "/api/settings/load") {
    const settingsPath = join(STATE_DIR, 'settings.json');
    try {
      await stat(settingsPath);
      const data = await readFile(settingsPath, 'utf8');
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
    }
    return;
  }

  // === API: Save memory state ===
  if (pathname === "/api/state/save" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        if (!existsSync(STATE_DIR)) await mkdir(STATE_DIR, { recursive: true });
        // Save to active profile
        const { getActiveProfile, getProfilePath } = await import("./src/extensions/memory-profiles.js");
        const active = await getActiveProfile(STATE_DIR);
        const savePath = getProfilePath(STATE_DIR, active);
        await writeFile(savePath, body, 'utf8');
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, size: body.length, profile: active }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // === API: Load memory state ===
  if (pathname === "/api/state/load") {
    try {
      const { getActiveProfile, getProfilePath } = await import("./src/extensions/memory-profiles.js");
      const active = await getActiveProfile(STATE_DIR);
      const loadPath = getProfilePath(STATE_DIR, active);
      try {
        await stat(loadPath);
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No saved state", profile: active }));
        return;
      }
      const data = await readFile(loadPath, 'utf8');
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // === API: Memory Profiles ===
  if (pathname === "/api/profiles" && req.method === "GET") {
    const { listProfiles, getActiveProfile } = await import("./src/extensions/memory-profiles.js");
    const profiles = await listProfiles(STATE_DIR);
    const active = await getActiveProfile(STATE_DIR);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ profiles, active }));
    return;
  }

  if (pathname === "/api/profiles/active" && req.method === "GET") {
    const { getActiveProfile, getProfilePath } = await import("./src/extensions/memory-profiles.js");
    const active = await getActiveProfile(STATE_DIR);
    const path = getProfilePath(STATE_DIR, active);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ active, path }));
    return;
  }

  if (pathname === "/api/profiles/create" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const { name } = JSON.parse(body);
      const { createProfile } = await import("./src/extensions/memory-profiles.js");
      const result = await createProfile(STATE_DIR, name);
      res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (pathname === "/api/profiles/switch" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const { name } = JSON.parse(body);
      const { setActiveProfile, getProfilePath } = await import("./src/extensions/memory-profiles.js");
      const profilePath = getProfilePath(STATE_DIR, name);
      try {
        await stat(profilePath);
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: 'Profile not found.' }));
        return;
      }
      await setActiveProfile(STATE_DIR, name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, active: name }));
    });
    return;
  }

  if (pathname === "/api/profiles/delete" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const { name } = JSON.parse(body);
      const { deleteProfile } = await import("./src/extensions/memory-profiles.js");
      const result = await deleteProfile(STATE_DIR, name);
      res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
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
  const demoUrl = `http://localhost:${PORT}/demo/`;

  console.log(`\n  Liminal Memory dev server running at:\n`);
  console.log(`  → ${demoUrl}\n`);
  console.log(`  API endpoints:`);
  console.log(`    GET /api/read?path=src/config.js`);
  console.log(`    GET /api/list?path=src/core`);
  console.log(`    GET /api/search?q=BM25`);
  console.log(`    GET /api/websearch?q=your+query (Playwright headless Chrome)\n`);
  console.log(`  Dev control channel (drives the open demo tab):`);
  console.log(`    POST /api/control/refresh              — reload the UI`);
  console.log(`    POST /api/control/prompt  {"text":"…"} — send a prompt to Sovereign\n`);

  // Auto-open the demo in the default browser so it's not easy to miss — but only
  // for a human running `npm run demo` directly. Set LM_NO_OPEN=1 to suppress it
  // (e.g. when Claude drives the demo through the Browser pane, so a second system
  // browser doesn't also connect and double every control-channel prompt).
  if (process.env.LM_NO_OPEN === "1") {
    console.log(`  (LM_NO_OPEN=1 — not auto-opening a browser; open ${demoUrl} yourself if needed)\n`);
  } else {
    const openCommand = process.platform === "win32" ? `start "" "${demoUrl}"`
      : process.platform === "darwin" ? `open "${demoUrl}"`
      : `xdg-open "${demoUrl}"`;

    exec(openCommand, (err) => {
      if (err) console.log(`  (Could not auto-open a browser — open ${demoUrl} manually)\n`);
    });
  }
});

// Graceful shutdown
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
