/**
 * Dev server — serves the project + API endpoints for the explorer tool.
 * Run: node serve.js
 * Then open: http://localhost:3000/demo/
 */
import { createServer } from "node:http";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { load as cheerioLoad } from "cheerio";
import TurndownService from "turndown";
import { chromium } from "playwright";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = 3000;
const STATE_DIR = join(__dirname, "data");
const STATE_FILE = join(STATE_DIR, "memory-state.json");

// === Playwright browser instance (reused across requests) ===
let _browser = null;
async function getBrowser() {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--start-maximized'
      ]
    });
  }
  return _browser;
}

/**
 * Human-like delay — wide random range so timing patterns don't emerge.
 * @param {number} min - minimum ms
 * @param {number} max - maximum ms
 */
function humanDelay(min = 800, max = 3200) {
  // Use gaussian-ish distribution (sum of randoms) to cluster toward middle
  const r = (Math.random() + Math.random() + Math.random()) / 3;
  const delay = min + r * (max - min);
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Type text character by character with human-like timing.
 * Variable speed: some chars fast, some slow, occasional micro-pauses.
 */
async function humanType(page, selector, text) {
  await page.click(selector);
  await humanDelay(200, 600);

  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    if (Math.random() < 0.12) {
      await humanDelay(150, 500);
    } else {
      const charDelay = 40 + Math.random() * 110;
      await new Promise(r => setTimeout(r, charDelay));
    }
  }
}

/**
 * Chunk a document (text, markdown, code) into node-sized pieces.
 * Splits by headings for markdown, by function/class boundaries for code,
 * and by paragraph for plain text. Each chunk is { heading, content }.
 */
function chunkDocument(text, filename = '') {
  const ext = extname(filename).toLowerCase();
  const isMarkdown = ext === '.md' || ext === '.txt';
  const isCode = ['.js', '.ts', '.jsx', '.tsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.kt', '.svelte', '.vue', '.astro', '.css', '.html', '.yaml', '.yml', '.toml', '.json'].includes(ext);

  if (isMarkdown || (!isCode && text.includes('\n## '))) {
    return chunkMarkdown(text, filename);
  } else {
    return chunkCode(text, filename);
  }
}

function chunkMarkdown(text, filename) {
  const lines = text.split('\n');
  const sections = [];
  let currentHeading = filename;
  let currentContent = [];

  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('### ') || line.startsWith('# ')) {
      if (currentContent.length > 0) {
        const content = currentContent.join('\n').trim();
        if (content.length > 30) {
          sections.push({ heading: currentHeading, content });
        }
      }
      currentHeading = line.replace(/^#+\s*/, '');
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0) {
    const content = currentContent.join('\n').trim();
    if (content.length > 30) {
      sections.push({ heading: currentHeading, content });
    }
  }

  // Split large sections into ~2000 char chunks
  const chunks = [];
  for (const section of sections) {
    if (section.content.length <= 2000) {
      chunks.push(section);
    } else {
      const paragraphs = section.content.split(/\n\n+/);
      let currentChunk = '';
      let chunkIdx = 0;

      for (const para of paragraphs) {
        if (currentChunk.length + para.length > 2000 && currentChunk.length > 100) {
          chunkIdx++;
          chunks.push({
            heading: section.heading + (chunkIdx > 1 ? ' (part ' + chunkIdx + ')' : ''),
            content: currentChunk.trim()
          });
          currentChunk = para;
        } else {
          currentChunk += (currentChunk ? '\n\n' : '') + para;
        }
      }
      if (currentChunk.trim().length > 30) {
        chunkIdx++;
        chunks.push({
          heading: section.heading + (chunkIdx > 1 ? ' (part ' + chunkIdx + ')' : ''),
          content: currentChunk.trim()
        });
      }
    }
  }

  return chunks;
}

function chunkCode(text, filename) {
  const chunks = [];
  const lines = text.split('\n');

  // For code: chunk by ~80 lines or natural boundaries (blank lines between functions)
  let currentChunk = [];
  let chunkIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    currentChunk.push(lines[i]);

    // Split at natural boundaries: blank line after 40+ lines, or hard cap at 100 lines
    const atBoundary = lines[i].trim() === '' && currentChunk.length >= 40;
    const atCap = currentChunk.length >= 100;

    if (atBoundary || atCap || i === lines.length - 1) {
      const content = currentChunk.join('\n').trim();
      if (content.length > 30) {
        chunkIdx++;
        chunks.push({
          heading: filename + (chunkIdx > 1 ? ' (part ' + chunkIdx + ')' : ''),
          content: content
        });
      }
      currentChunk = [];
    }
  }

  return chunks;
}

/**
 * Basic PDF text extraction — pulls text streams from the PDF binary.
 * This handles simple PDFs with embedded text. Image-only PDFs will return empty.
 */
function extractPdfText(buffer) {
  const raw = buffer.toString('latin1');
  const textChunks = [];

  // Extract text between BT (begin text) and ET (end text) markers
  const btEtRegex = /BT\s([\s\S]*?)ET/g;
  let match;
  while ((match = btEtRegex.exec(raw)) !== null) {
    const block = match[1];
    // Extract text from Tj and TJ operators
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let tj;
    while ((tj = tjRegex.exec(block)) !== null) {
      textChunks.push(tj[1]);
    }
    // TJ arrays: [(text) kern (text) kern ...]
    const tjArrayRegex = /\[(.*?)\]\s*TJ/g;
    let tja;
    while ((tja = tjArrayRegex.exec(block)) !== null) {
      const inner = tja[1];
      const parts = inner.match(/\(([^)]*)\)/g);
      if (parts) {
        textChunks.push(parts.map(p => p.slice(1, -1)).join(''));
      }
    }
  }

  // Decode common PDF escape sequences
  let text = textChunks.join(' ')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, ' ')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

/**
 * Recursively delete a directory.
 */
async function rmDir(dir) {
  const { rm } = await import("node:fs/promises");
  try {
    await rm(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

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

  // === API: Web Search via Playwright (visible Chrome, human-like) ===
  if (pathname === "/api/websearch") {
    const query = url.searchParams.get("q") || "";
    if (!query) {
      res.writeHead(400);
      res.end(JSON.stringify({ results: [], formatted: "No query." }));
      return;
    }

    try {
      console.log('[WebSearch] Query:', query.slice(0, 80));
      const browser = await getBrowser();
      const context = await browser.newContext({
        viewport: { width: 1280 + Math.floor(Math.random() * 300), height: 800 + Math.floor(Math.random() * 200) },
        locale: 'en-US',
        timezoneId: 'America/New_York'
      });

      const page = await context.newPage();

      // Navigate to Google homepage
      await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded' });

      // Human arrives at page — looks around first
      await humanDelay(2000, 5500);

      // Handle consent popup if it appears
      try {
        const consentBtn = page.locator('button:has-text("Accept all"), button:has-text("I agree"), button:has-text("Accept")');
        if (await consentBtn.isVisible({ timeout: 2000 })) {
          await humanDelay(800, 2500);
          await consentBtn.first().click();
          await humanDelay(1500, 3500);
        }
      } catch { /* No consent popup */ }

      // Find the search input and click it
      const searchInput = page.locator('textarea[name="q"], input[name="q"]').first();
      await searchInput.click();
      await humanDelay(600, 1800);

      // Type the query character by character with human timing
      for (let i = 0; i < query.length; i++) {
        await page.keyboard.type(query[i]);
        if (Math.random() < 0.1) {
          // 10% chance of a longer pause (thinking, glancing at screen)
          await humanDelay(200, 700);
        } else {
          // Normal typing speed — variable
          const charDelay = 50 + Math.random() * 130;
          await new Promise(r => setTimeout(r, charDelay));
        }
      }

      // Pause after typing — human reads what they typed
      await humanDelay(800, 2500);

      // Press Enter
      await page.keyboard.press('Enter');

      // Wait for results page to load
      await page.waitForLoadState('domcontentloaded');
      await humanDelay(2000, 4500);

      // Small scroll down like a human scanning results
      await page.mouse.wheel(0, Math.floor(100 + Math.random() * 200));
      await humanDelay(1500, 3500);

      // Extract results from the rendered page
      const results = await page.evaluate(() => {
        const items = [];

        // Google organic results
        const resultEls = document.querySelectorAll('#search .g, #rso .g, div[data-hveid] .g');
        for (const el of resultEls) {
          if (items.length >= 8) break;
          const linkEl = el.querySelector('a[href^="http"]');
          const titleEl = el.querySelector('h3');
          const snippetEl = el.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"], .lEBKkf span, .IsZvec');
          if (linkEl && titleEl) {
            const url = linkEl.getAttribute('href');
            const title = titleEl.textContent.trim();
            const snippet = snippetEl ? snippetEl.textContent.trim() : '';
            if (url && !url.includes('google.com/') && title.length > 3) {
              items.push({ url, title, snippet });
            }
          }
        }

        // Fallback: broader selector
        if (items.length === 0) {
          const allLinks = document.querySelectorAll('#search a[href^="http"], #rso a[href^="http"]');
          for (const link of allLinks) {
            if (items.length >= 8) break;
            const href = link.getAttribute('href');
            const h3 = link.querySelector('h3');
            if (h3 && href && !href.includes('google.com')) {
              items.push({ url: href, title: h3.textContent.trim(), snippet: '' });
            }
          }
        }

        return items;
      });

      console.log('[WebSearch] Extracted', results.length, 'results');

      // Debug: if 0 results, log what we see
      if (results.length === 0) {
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || 'empty');
        console.log('[WebSearch] DEBUG — 0 results. Page text preview:', bodyText.slice(0, 300));
        try {
          await page.screenshot({ path: join(__dirname, 'data', 'search-debug.png'), fullPage: false });
          console.log('[WebSearch] DEBUG screenshot saved to data/search-debug.png');
        } catch (e) { /* non-critical */ }
      }

      // Human pauses before closing — looks at results briefly
      await humanDelay(1000, 3000);
      await context.close();

      const formatted = results.length > 0
        ? results.map((r, i) => `[${i+1}] **${r.title}**\n${r.snippet}\n${r.url}`).join('\n\n')
        : 'No results found.';

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results, formatted }));
    } catch (err) {
      console.error('[WebSearch] Error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ results: [], formatted: "Search failed: " + err.message }));
    }
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
          "User-Agent": "LuminalMemory/1.0 (Research Bot; respectful; single-page fetch)",
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
          // PDF: extract text using pdf-parse-like approach (basic text layer extraction)
          // For now, use a simple regex-based text extraction from PDF binary
          text = extractPdfText(buffer);
          if (!text || text.length < 50) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Could not extract text from PDF. It may be image-based.", nodes: 0 }));
            return;
          }
        } else {
          // Everything else: treat as text (markdown, code, plain text)
          text = buffer.toString('utf8');
        }

        if (!text || text.length < 20) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "File is empty or too short to ingest.", nodes: 0 }));
          return;
        }

        // Chunk the content
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
        res.end(JSON.stringify({ error: err.message, nodes: 0 }));
      }
    });
    return;
  }

  // === API: Ingest Git Repo ===
  if (pathname === "/api/ingest/repo" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { url: repoUrl, ignores: customIgnores } = JSON.parse(body);
        if (!repoUrl) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No repo URL provided.", nodes: 0 }));
          return;
        }

        console.log('[Ingest:Repo] Cloning:', repoUrl);

        // Create temp directory
        const tempDir = join(__dirname, 'data', '_temp_repo_' + Date.now());
        await mkdir(tempDir, { recursive: true });

        // Clone (shallow, single branch)
        const { execSync } = await import("node:child_process");
        try {
          execSync(`git clone --depth 1 --single-branch "${repoUrl}" "${tempDir}"`, { 
            timeout: 60000,
            stdio: 'pipe'
          });
        } catch (cloneErr) {
          await rmDir(tempDir);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Git clone failed: " + cloneErr.message, nodes: 0 }));
          return;
        }

        console.log('[Ingest:Repo] Cloned. Walking files...');

        // Default ignores + user-provided ignores
        const defaultIgnores = new Set([
          'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
          '.next', '.nuxt', '.svelte-kit', '__pycache__', '.pytest_cache',
          'coverage', '.nyc_output', '.cache', '.parcel-cache',
          '.vscode', '.idea', '.kiro', '.DS_Store',
          'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
          'go.sum', 'composer.lock', 'Gemfile.lock', 'poetry.lock'
        ]);
        if (customIgnores && Array.isArray(customIgnores)) {
          customIgnores.forEach(i => defaultIgnores.add(i));
        }

        // Walk and collect files
        const allChunks = [];
        const validExts = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.kt', '.md', '.txt', '.yaml', '.yml', '.toml', '.json', '.css', '.html', '.svelte', '.vue', '.astro']);

        async function walkRepo(dir, relPath = '') {
          let entries;
          try { entries = await readdir(dir, { withFileTypes: true }); }
          catch { return; }

          for (const entry of entries) {
            if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
            if (defaultIgnores.has(entry.name)) continue;

            const fullPath = join(dir, entry.name);
            const rel = relPath ? relPath + '/' + entry.name : entry.name;

            if (entry.isDirectory()) {
              await walkRepo(fullPath, rel);
            } else {
              const ext = extname(entry.name).toLowerCase();
              if (!validExts.has(ext)) continue;

              try {
                const content = await readFile(fullPath, 'utf8');
                if (content.length < 30) continue; // Skip trivial files
                if (content.length > 50000) continue; // Skip huge generated files

                const fileChunks = chunkDocument(content, rel);
                allChunks.push(...fileChunks);
              } catch { /* skip binary/unreadable files */ }
            }
          }
        }

        await walkRepo(tempDir);
        console.log('[Ingest:Repo] Found ' + allChunks.length + ' chunks from repo');

        // Clean up temp directory
        await rmDir(tempDir);
        console.log('[Ingest:Repo] Temp directory cleaned up');

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          nodes: allChunks,
          repoUrl: repoUrl,
          totalChunks: allChunks.length
        }));
      } catch (err) {
        console.error('[Ingest:Repo] Error:', err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message, nodes: 0 }));
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

    const { exec } = await import("node:child_process");
    exec(cmd, { cwd: __dirname, timeout: 5000 }, (err, stdout, stderr) => {
      const output = stdout || stderr || (err ? err.message : 'no output');
      const formatted = `## Shell: \`${cmd}\`\n\n\`\`\`\n${output.slice(0, 4000)}\n\`\`\``;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: output, formatted: formatted }));
    });
    return;
  }

  // === API: Save memory state ===
  if (pathname === "/api/state/save" && req.method === "POST") {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        // Ensure data directory exists
        if (!existsSync(STATE_DIR)) await mkdir(STATE_DIR, { recursive: true });
        await writeFile(STATE_FILE, body, 'utf8');
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, size: body.length }));
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
      if (!existsSync(STATE_FILE)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No saved state" }));
        return;
      }
      const data = await readFile(STATE_FILE, 'utf8');
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
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
  console.log(`    GET /api/search?q=BM25`);
  console.log(`    GET /api/websearch?q=your+query (Playwright headless Chrome)\n`);
});

// Graceful shutdown — close Playwright browser
process.on('SIGINT', async () => {
  if (_browser) await _browser.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  if (_browser) await _browser.close();
  process.exit(0);
});
