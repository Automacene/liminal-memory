/**
 * Project Explorer Tool — browse, read, and search the project repo.
 * In browser: routes through the dev server API (/api/read, /api/list, /api/search)
 * In Node: uses fs directly.
 */
import { Tool } from "../tools/base.js";

/**
 * Create a project explorer tool.
 * @param {object} [config]
 * @param {string} [config.serverUrl] - dev server base URL (default: '' for relative)
 * @returns {Tool}
 */
export function createProjectGrepTool(config = {}) {
  const serverUrl = config.serverUrl || '';

  return new Tool({
    name: "project_explorer",
    description: "Explore the Luminal Memory project repository. Can read source files, list directory contents, or search for code patterns across the codebase. Use when you need to find where something is implemented, read a specific file, show code, or understand the project layout. [Synonyms: read file, show code, open file, find in code, search source, grep, look at, project structure, codebase, repo, repository, source code, implementation, where is, how does]",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "One of: 'read' (show file contents), 'list' (directory tree), 'search' (grep for pattern). Example: 'read'"
        },
        target: {
          type: "string",
          description: "File path to read, directory to list, or search term. Examples: 'src/config.js', 'src/core', 'BM25'"
        }
      },
      required: ["action", "target"]
    },
    execute: async function (params) {
      const action = (params.action || '').toLowerCase().trim();
      const target = (params.target || '').trim();

      if (!target) throw new Error("target is required");

      console.log(`[Explorer] ${action}: "${target}"`);

      let endpoint;
      if (action === 'read' || action === 'open' || action === 'show') {
        endpoint = `${serverUrl}/api/read?path=${encodeURIComponent(target)}`;
      } else if (action === 'list' || action === 'ls' || action === 'tree') {
        endpoint = `${serverUrl}/api/list?path=${encodeURIComponent(target)}`;
      } else if (action === 'search' || action === 'grep' || action === 'find') {
        endpoint = `${serverUrl}/api/search?q=${encodeURIComponent(target)}`;
      } else {
        // Infer: if looks like a path, read it; otherwise search
        if (target.includes('.') || target.includes('/') || target.includes('\\')) {
          endpoint = `${serverUrl}/api/read?path=${encodeURIComponent(target)}`;
        } else {
          endpoint = `${serverUrl}/api/search?q=${encodeURIComponent(target)}`;
        }
      }

      const response = await fetch(endpoint);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Explorer API error: ${response.status} — ${text}`);
      }

      const data = await response.json();
      console.log(`[Explorer] Response:`, data.formatted ? data.formatted.slice(0, 100) + '...' : data);
      return data;
    }
  });
}
