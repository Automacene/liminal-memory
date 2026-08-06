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

  // === API: Web Search via DuckDuckGo HTML ===
  if (pathname === "/api/websearch") {
    const query = url.searchParams.get("q") || "";
    if (!query) {
      res.writeHead(400);
      res.end(JSON.stringify({ results: [], formatted: "No query." }));
      return;
    }

    try {
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const ddgRes = await fetch(ddgUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
      });
      const html = await ddgRes.text();

      // Parse DDG results — extract links and snippets
      const results = [];
      const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      while ((match = resultRegex.exec(html)) !== null && results.length < 5) {
        const href = decodeURIComponent(match[1].replace(/.*uddg=/, '').replace(/&.*/, ''));
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        const snippet = match[3].replace(/<[^>]+>/g, '').trim();
        if (href.startsWith('http')) {
          results.push({ url: href, title, snippet });
        }
      }

      // Fallback: simpler regex if the above didn't match
      if (results.length === 0) {
        const linkRegex = /<a[^>]+class="result__url"[^>]*href="([^"]+)"[^>]*>/g;
        const titleRegex = /<a[^>]+class="result__a"[^>]*>([^<]+)<\/a>/g;
        let linkMatch, titleMatch;
        while ((linkMatch = linkRegex.exec(html)) !== null && results.length < 5) {
          titleMatch = titleRegex.exec(html);
          const href = decodeURIComponent(linkMatch[1].replace(/.*uddg=/, '').replace(/&.*/, ''));
          if (href.startsWith('http')) {
            results.push({ url: href, title: titleMatch ? titleMatch[1].trim() : href, snippet: '' });
          }
        }
      }

      const formatted = results.length > 0
        ? results.map((r, i) => `[${i+1}] **${r.title}**\n${r.snippet}\n${r.url}`).join('\n\n')
        : 'No results found.';

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results, formatted }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ results: [], formatted: "Search failed: " + err.message }));
    }
    return;
  }

  // === API: Fetch & Parse URL to Markdown ===
  if (pathname === "/api/fetch") {
    const targetUrl = url.searchParams.get("url") || "";
    if (!targetUrl) {
      res.writeHead(400);
      res.end(JSON.stringify({ formatted: "No URL." }));
      return;
    }

    try {
      const pageRes = await fetch(targetUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(8000)
      });
      const html = await pageRes.text();

      // Parse headings and paragraphs into markdown
      let markdown = '';
      
      // Extract title
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch) markdown += `# ${titleMatch[1].trim()}\n\n`;

      // Extract headings (h1-h4) and paragraphs
      const contentRegex = /<(h[1-4]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
      let contentMatch;
      while ((contentMatch = contentRegex.exec(html)) !== null) {
        const tag = contentMatch[1].toLowerCase();
        let text = contentMatch[2]
          .replace(/<[^>]+>/g, '')  // strip inner HTML tags
          .replace(/\s+/g, ' ')     // collapse whitespace
          .trim();
        
        if (!text || text.length < 10) continue;

        if (tag === 'h1') markdown += `# ${text}\n\n`;
        else if (tag === 'h2') markdown += `## ${text}\n\n`;
        else if (tag === 'h3') markdown += `### ${text}\n\n`;
        else if (tag === 'h4') markdown += `#### ${text}\n\n`;
        else if (tag === 'li') markdown += `- ${text}\n`;
        else markdown += `${text}\n\n`;
      }

      // Cap at 4000 chars
      if (markdown.length > 4000) {
        markdown = markdown.slice(0, 4000) + '\n\n... [truncated]';
      }

      if (!markdown.trim()) markdown = 'Could not extract readable content from this page.';

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ formatted: markdown, url: targetUrl }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ formatted: "Fetch failed: " + err.message, url: targetUrl }));
    }
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

    const { exec } = await import("node:child_process");
    exec(cmd, { cwd: __dirname, timeout: 5000 }, (err, stdout, stderr) => {
      const output = stdout || stderr || (err ? err.message : 'no output');
      const formatted = `## Shell: \`${cmd}\`\n\n\`\`\`\n${output.slice(0, 4000)}\n\`\`\``;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: output, formatted: formatted }));
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
  console.log(`\n  Luminal Memory dev server running at:\n`);
  console.log(`  → http://localhost:${PORT}/demo/\n`);
  console.log(`  API endpoints:`);
  console.log(`    GET /api/read?path=src/config.js`);
  console.log(`    GET /api/list?path=src/core`);
  console.log(`    GET /api/search?q=BM25\n`);
});
