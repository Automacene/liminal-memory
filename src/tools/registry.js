/**
 * Tool Registry — manages tool discovery and execution.
 * 
 * Tools are stored as indexed nodes. When a query comes in,
 * BM25 searches tool descriptions to find relevant tools.
 * Matched tools get their schemas injected into the prompt for that turn.
 */
import { BM25 } from "../search/bm25.js";

export class ToolRegistry {
  constructor(config = {}) {
    this.tools = new Map();         // name → Tool instance
    this.bm25 = new BM25(config.bm25 || { k1: 1.2, b: 0.4 });
    this.matchThreshold = config.toolMatchThreshold || 0.3;

    console.log("[ToolRegistry] Initialized | threshold:", this.matchThreshold);
  }

  /**
   * Register a tool. Indexes its description for BM25 retrieval.
   * @param {import('./base.js').Tool} tool
   */
  register(tool) {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Tool "${tool.name}" already registered, overwriting`);
    }

    this.tools.set(tool.name, tool);
    this.bm25.add(tool.toNode());
    tool._registered = true;

    console.log(`[ToolRegistry] Registered "${tool.name}" | total tools: ${this.tools.size}`);
  }

  /**
   * Retrieve tools relevant to a query via BM25.
   * Scores are normalized to 0-1 (relative to best match) for linear threshold behavior.
   * @param {string} query
   * @returns {{ tool: import('./base.js').Tool, score: number }[]}
   */
  retrieve(query) {
    if (this.tools.size === 0) return [];

    const results = this.bm25.search(query, 5);
    if (results.length === 0) {
      console.log(`[ToolRegistry] No tools matched for: "${query.slice(0, 50)}"`);
      return [];
    }

    // Normalize scores to 0-1 range (linear)
    const maxScore = results[0].score;
    if (maxScore === 0) return [];

    const matched = [];

    for (const r of results) {
      const normalized = r.score / maxScore; // 0-1 linear scale
      if (normalized < this.matchThreshold) continue;

      const toolName = r.nodeId;
      const tool = this.tools.get(toolName);

      if (tool) {
        matched.push({ tool, score: normalized });
        console.log(`[ToolRegistry] Match: "${tool.name}" score=${normalized.toFixed(3)} (raw: ${r.score.toFixed(3)}) for query: "${query.slice(0, 50)}"`);
      }
    }

    if (matched.length === 0) {
      console.log(`[ToolRegistry] No tools above threshold ${this.matchThreshold} for: "${query.slice(0, 50)}" (best raw: ${maxScore.toFixed(3)})`);
    }

    return matched;
  }

  /**
   * Execute a tool by name.
   * @param {string} name
   * @param {object} params
   * @param {object} context
   * @returns {object} { success, result, error, elapsed }
   */
  async execute(name, params, context = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      console.error(`[ToolRegistry] Tool not found: "${name}"`);
      return { success: false, result: null, error: `Tool "${name}" not registered` };
    }
    return tool.run(params, context);
  }

  /**
   * Get all registered tool schemas (for debugging/inspection).
   * @returns {object[]}
   */
  listTools() {
    return Array.from(this.tools.values()).map(t => t.toSchema());
  }

  /**
   * Get a tool by name.
   * @param {string} name
   * @returns {import('./base.js').Tool|undefined}
   */
  get(name) {
    return this.tools.get(name);
  }
}
