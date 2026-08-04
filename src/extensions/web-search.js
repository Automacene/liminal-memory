/**
 * Web Search Tool — uses Firecrawl's keyless search endpoint.
 * No API key required (rate-limited free tier).
 * 
 * Searches the web, scrapes top results for full content,
 * and returns comprehensive excerpts for the LLM to synthesize.
 */
import { Tool } from "../tools/base.js";

/**
 * Create a web search tool instance.
 * @param {object} [config]
 * @param {string} [config.endpoint] - Firecrawl API endpoint (default: hosted)
 * @param {number} [config.searchLimit] - how many results to fetch (default: 6)
 * @param {number} [config.excerptLength] - chars per result to keep (default: 2000)
 * @returns {Tool}
 */
export function createWebSearchTool(config = {}) {
  const endpoint = config.endpoint || "https://api.firecrawl.dev/v2/search";
  const searchLimit = config.searchLimit || 6;
  const excerptLength = config.excerptLength || 2000;

  return new Tool({
    name: "web_search",
    description: "Search the web for current information, news, documentation, tutorials, or answers to questions that require up-to-date knowledge. Use when the user asks about something that might not be in the conversation history or needs fresh data from the internet. [Synonyms: google, lookup, look up, check online, find on web, latest, current, search for, what is, who is, news about, price of, weather, release date, version]",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A short, specific search query using keywords. Write it like you would type into Google. No full sentences. Example: 'gemma 4 release date 2024' not 'what is the latest gemma model'"
        }
      },
      required: ["query"]
    },
    execute: async function (params) {
      const query = params.query;
      if (!query) throw new Error("query parameter is required");

      console.log(`[WebSearch] Searching: "${query}" (limit: ${searchLimit})`);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: query,
          limit: searchLimit,
          scrapeOptions: {
            formats: ["markdown"]
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[WebSearch] HTTP ${response.status}: ${errorText.slice(0, 200)}`);
        throw new Error(`Search failed: HTTP ${response.status}`);
      }

      const data = await response.json();

      // Firecrawl v2 nests results under data.web or data directly
      var results_raw = null;
      if (data.data && Array.isArray(data.data)) {
        results_raw = data.data;
      } else if (data.data && Array.isArray(data.data.web)) {
        results_raw = data.data.web;
      } else if (Array.isArray(data.results)) {
        results_raw = data.results;
      }

      console.log(`[WebSearch] Got ${results_raw?.length || 0} results`);

      if (!results_raw || results_raw.length === 0) {
        return { results: [], formatted: "No results found." };
      }

      // Process all results with full content
      const results = results_raw.map(function (item, idx) {
        const result = {
          rank: idx + 1,
          title: item.title || "Untitled",
          url: item.url || "",
          content: (item.markdown || item.description || "").slice(0, excerptLength)
        };
        console.log(`[WebSearch]   ${result.rank}. ${result.title} — ${result.url}`);
        return result;
      });

      // Build formatted context for the LLM with reference-style links
      var formatted = "Search results for: " + query + "\n\n";
      results.forEach(function (r, i) {
        formatted += "---\n";
        formatted += "**[" + (i + 1) + "] " + r.title + "**\n";
        formatted += r.content + "\n\n";
      });
      formatted += "---\nSources:\n";
      results.forEach(function (r, i) {
        formatted += "[" + (i + 1) + "] " + r.title + ": " + r.url + "\n";
      });

      return { results: results, formatted: formatted };
    }
  });
}
