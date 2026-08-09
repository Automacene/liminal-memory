/**
 * Web Search Tool — fetches relevant web content and stores as research nodes.
 *
 * Flow:
 * 1. Search Google via serve.js /api/websearch endpoint (Playwright headless Chrome)
 * 2. Score snippets against query (BM25-style relevance check)
 * 3. Fetch full page content for relevant results (respectful: delays, robots.txt, honest UA)
 * 4. Clean HTML → Markdown via cheerio + turndown (server-side)
 * 5. Return structured content for prompt injection + node storage
 *
 * The tool uses the serve.js API endpoints — all heavy lifting (Playwright, cheerio, turndown)
 * happens server-side. The browser-side tool just coordinates.
 */
import { Tool } from "../tools/base.js";

/**
 * Create the web search tool.
 * @param {object} [config]
 * @param {string} [config.apiBase] - base URL for the serve.js API (default: '')
 * @param {number} [config.maxResults] - max pages to crawl (default: 3)
 * @returns {Tool}
 */
export function createWebSearchTool(config = {}) {
  const apiBase = config.apiBase || '';
  const maxResults = config.maxResults || 3;
  const memoryConfig = config.memoryConfig || null;

  return new Tool({
    name: "web_search",
    discovery: "bm25",
    description: "Search the web for current information, documentation, tutorials, code examples, or answers to technical questions. Use when the conversation requires up-to-date facts, external references, or information not available in memory.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A short Google search query, 3-6 words, like a human would type into a search bar. No full sentences. No questions. Just keywords."
        }
      },
      required: ["query"]
    },
    execute: async function (params) {
      const query = params.query;
      if (!query) throw new Error("web_search requires a query");

      // Kill switch — check config flag
      if (memoryConfig && memoryConfig.webSearchEnabled === false) {
        return { result: { results: [], query }, formatted: "Web search is currently disabled." };
      }
      // Show searching modal so user knows not to interact
      const overlay = document.createElement('div');
      overlay.id = 'web-search-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:9999;';
      overlay.innerHTML = '<div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:40px 60px;text-align:center;font-family:inherit;"><div style="font-size:1.4rem;color:#e0e0e0;margin-bottom:12px;">🔍 AI is searching the web</div><div style="font-size:0.95rem;color:#888;margin-bottom:8px;">Do not make adjustments</div><div style="font-size:0.85rem;color:#555;font-style:italic;">"' + query + '"</div></div>';
      document.body.appendChild(overlay);

      try {
        // Step 1: Search via Playwright (visible Chrome window)
        const searchRes = await fetch(`${apiBase}/api/websearch?q=${encodeURIComponent(query)}`);
        if (!searchRes.ok) throw new Error("Search failed: " + searchRes.status);
        const searchData = await searchRes.json();

        if (!searchData.results || searchData.results.length === 0) {
          return {
            result: { results: [], query },
            formatted: "No web results found for: " + query
          };
        }

        // Step 2: Score snippets for relevance (simple keyword overlap)
        const queryTerms = query.toLowerCase().split(/\W+/).filter(w => w.length >= 3);
        const scored = searchData.results.map(r => {
          const text = ((r.title || '') + ' ' + (r.snippet || '')).toLowerCase();
          const hits = queryTerms.filter(t => text.includes(t));
          return { ...r, relevance: hits.length / queryTerms.length };
        }).filter(r => r.relevance > 0.3)
          .sort((a, b) => b.relevance - a.relevance)
          .slice(0, maxResults);

        if (scored.length === 0) {
          return {
            result: { results: searchData.results.slice(0, 3), query },
            formatted: searchData.formatted || "Results found but low relevance."
          };
        }

        // Step 3: Fetch full content for top relevant results (via serve.js)
        const fetchedPages = [];
        for (const result of scored) {
          try {
            const fetchRes = await fetch(`${apiBase}/api/fetch?url=${encodeURIComponent(result.url)}`);
            if (fetchRes.ok) {
              const pageData = await fetchRes.json();
              if (pageData.formatted && pageData.formatted.length > 50) {
                fetchedPages.push({
                  title: result.title,
                  url: result.url,
                  content: pageData.formatted
                });
              }
            }
          } catch (e) {
            // skip this result, continue with the others
          }

          // Respectful delay between fetches (3-5 seconds)
          if (scored.indexOf(result) < scored.length - 1) {
            await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
          }
        }

        // Step 4: Format results for prompt injection
        let formatted = '';
        const resultNodes = [];

        if (fetchedPages.length > 0) {
          formatted = fetchedPages.map((page, i) => {
            const capped = page.content.slice(0, 2000);
            resultNodes.push({ title: page.title, url: page.url, content: capped });
            return `[Source ${i + 1}: ${page.title}]\n${page.url}\n\n${capped}`;
          }).join('\n\n---\n\n');
        } else {
          formatted = scored.map((r, i) => {
            resultNodes.push({ title: r.title, url: r.url, content: r.snippet || '' });
            return `[Source ${i + 1}: ${r.title}]\n${r.url}\n${r.snippet || ''}`;
          }).join('\n\n');
        }

        return {
          result: {
            results: resultNodes,
            query: query,
            pagesSearched: scored.length,
            pagesFetched: fetchedPages.length
          },
          formatted: formatted
        };
      } finally {
        // Remove the searching overlay
        const existingOverlay = document.getElementById('web-search-overlay');
        if (existingOverlay) existingOverlay.remove();
      }
    }
  });
}
