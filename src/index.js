/**
 * Luminal Memory — Zero-dependency infinite context memory for any LLM.
 * Main entrypoint and public API.
 */
import { createConfig } from "./config.js";
import { Node } from "./core/node.js";
import { Chain } from "./core/chain.js";
import { Window } from "./core/window.js";
import { Buffer, SlidingBuffer, RecallBuffer } from "./core/buffer.js";
import { ConversationManager } from "./core/conversation-manager.js";
import { Compaction } from "./core/compaction.js";
import { Retrieval } from "./core/retrieval.js";
import { DeepRetrieval } from "./core/deep-retrieval.js";
import { BM25 } from "./search/bm25.js";
import { BloomFilter } from "./search/bloom.js";
import { TfIdf } from "./search/tfidf.js";
import { MemoryManager } from "./storage/memory.js";
import { Archive } from "./storage/archive.js";
import { LLMTransport } from "./transport/llm.js";
import { ToolRegistry } from "./tools/registry.js";
import { Tool } from "./tools/base.js";

export class LuminalMemory {
  constructor(userConfig = {}) {
    this.config = createConfig(userConfig);

    // Core components
    this.chain = new Chain();
    this.window = new Window(this.config);
    this.conversationManager = new ConversationManager(this.config);
    this.bm25 = new BM25(this.config.bm25);
    this.bloom = new BloomFilter(this.config.bloom);
    this.tfidf = new TfIdf();
    this.archive = new Archive();
    this.memoryManager = new MemoryManager(this.chain, this.config);
    this.transport = new LLMTransport(this.config);
    this.compaction = new Compaction(
      this.chain, this.bm25, this.bloom, this.tfidf, this.archive, this.config
    );
    this.retrieval = new Retrieval(
      this.chain, this.bm25, this.bloom, this.tfidf, this.compaction, this.archive, this.transport, this.config
    );

    // Tool system
    this.toolRegistry = new ToolRegistry(this.config);

    this._initialized = false;
  }

  /**
   * Initialize the memory system (sets up IndexedDB if available).
   */
  async init() {
    await this.archive.init();
    this._initialized = true;
    return this;
  }

  /**
   * Full chat cycle: append → retrieve → discover tools → build prompt → call LLM → execute tools → append response.
   * @param {string} message - user's message
   * @returns {{ response: string, toolsUsed: object[] }}
   */
  async chat(message) {
    if (!this._initialized) await this.init();

    // Check memory before appending
    const memCheck = this.memoryManager.check();
    if (!memCheck.ok) {
      throw new Error(
        `Memory limit reached (${memCheck.usageMB.toFixed(1)}MB / ${this.config.memoryLimitMB}MB). ` +
        `Please trim or branch to free memory.`
      );
    }

    // 1. Append user message as new node
    const userNode = this.chain.append("user", message);
    this.bm25.add(userNode);

    // 2. Discover relevant tools for this query
    const matchedTools = this.toolRegistry.retrieve(message);
    const toolsUsed = [];

    // 3. If tools matched, ask the LLM to decide whether to use them
    let toolResults = [];
    if (matchedTools.length > 0) {
      const toolDecision = await this._askToolDecision(message, matchedTools);
      
      if (toolDecision) {
        // Execute the tool
        const result = await this.toolRegistry.execute(toolDecision.name, toolDecision.params, {
          query: message,
          chain: this.chain,
          config: this.config
        });
        
        if (result.success) {
          toolResults.push({ name: toolDecision.name, result: result.result });
          toolsUsed.push({ name: toolDecision.name, params: toolDecision.params, result: result.result, elapsed: result.elapsed });
          console.log(`[Chat] Tool "${toolDecision.name}" executed successfully in ${result.elapsed}ms`);
        } else {
          console.warn(`[Chat] Tool "${toolDecision.name}" failed: ${result.error}`);
        }
      }
    }

    // 4. Retrieve relevant historical nodes (pure math — BM25 + bloom + TF-IDF)
    const { nodes: retrievedNodes, deepResponse } = await this.retrieval.retrieve(
      message, this.window.select(this.chain)
    );

    // 5. If deep retrieval handled it, use that response directly
    let response;
    if (deepResponse) {
      response = deepResponse;
    } else {
      // 6. Build prompt with tool results + recall + sliding window
      const scoredRetrieved = retrievedNodes.map((node, i) => ({
        node,
        score: retrievedNodes.length - i
      }));

      const { messages } = this.conversationManager.buildPrompt(
        this.chain.all(),
        scoredRetrieved
      );

      // Inject tool results before the user's message if any
      if (toolResults.length > 0) {
        const toolContext = toolResults.map(t => {
          const resultText = typeof t.result === "string" ? t.result : JSON.stringify(t.result, null, 2);
          return `[Tool: ${t.name}]\n${resultText}`;
        }).join("\n\n");

        // Insert tool context as a system message before the last user message
        const lastIdx = messages.length - 1;
        messages.splice(lastIdx, 0, {
          role: "system",
          content: `The following tool was used to gather information for this response:\n\n${toolContext}`
        });
      }

      // 7. Call LLM
      response = await this.transport.complete(messages);
    }

    // 8. Append assistant response as new node
    const assistantNode = this.chain.append("assistant", response);
    this.bm25.add(assistantNode);

    return { response, toolsUsed };
  }

  /**
   * Ask the LLM whether it should use a matched tool, and with what parameters.
   * @param {string} query
   * @param {{ tool: import('./tools/base.js').Tool, score: number }[]} matchedTools
   * @returns {{ name: string, params: object }|null}
   */
  async _askToolDecision(query, matchedTools) {
    const toolSchemas = matchedTools.map(m => m.tool.toSchema());
    
    const messages = [
      {
        role: "system",
        content: `You are a tool router. Output ONLY JSON, nothing else.\n\n${toolSchemas.map(t => t.instruction).join("\n")}`
      },
      {
        role: "user",
        content: "whats the weather in tokyo"
      },
      {
        role: "assistant",
        content: '{"use": true, "tool": "web_search", "params": {"query": "weather tokyo today"}}'
      },
      {
        role: "user",
        content: query
      }
    ];

    try {
      const decision = await this.transport.complete(messages);
      console.log(`[Chat] Tool decision raw: ${decision.slice(0, 300)}`);

      // Try parsing as JSON first
      const jsonMatch = decision.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (!parsed.use) return null;
          return { name: parsed.tool, params: parsed.params || {} };
        } catch (e) { /* fall through to other formats */ }
      }

      // Parse Gemma-style tool calls: <|tool_call>call:name{...}<tool_call|>
      const gemmaMatch = decision.match(/call:(\w+)\{([^}]*)\}/);
      if (gemmaMatch) {
        const toolName = gemmaMatch[1];
        const paramsRaw = gemmaMatch[2];
        // Extract key:value pairs from the params (handles quoted values)
        const params = {};
        const kvMatches = paramsRaw.matchAll(/(\w+):\s*["<|]*([^"<|,}]+)/g);
        for (const kv of kvMatches) {
          params[kv[1]] = kv[2].trim().replace(/^>+/, '').replace(/>+$/, '');
        }
        console.log(`[Chat] Parsed Gemma tool call: ${toolName}`, params);
        return { name: toolName, params };
      }

      // Parse generic function call format: tool_name("query")
      const funcMatch = decision.match(/(\w+)\(["']([^"']+)["']\)/);
      if (funcMatch) {
        console.log(`[Chat] Parsed function-style call: ${funcMatch[1]}("${funcMatch[2]}")`);
        return { name: funcMatch[1], params: { query: funcMatch[2] } };
      }

      // If the model just said it wants to search, extract a short query
      var searchIntent = decision.match(/search(?:ing)?\s+(?:for\s+)?["']([^"']+)["']/i);
      if (searchIntent && this.toolRegistry && this.toolRegistry.get('web_search')) {
        console.log(`[Chat] Inferred search intent: "${searchIntent[1].trim()}"`);
        return { name: 'web_search', params: { query: searchIntent[1].trim().slice(0, 80) } };
      }

      return null;
    } catch (err) {
      console.warn("[Chat] Tool decision failed:", err.message);
      return null;
    }
  }

  /**
   * Register a tool with the system.
   * @param {import('./tools/base.js').Tool} tool
   */
  registerTool(tool) {
    this.toolRegistry.register(tool);
  }

  /**
   * Manually append a node (for importing existing conversations).
   * @param {string} role - "user" | "assistant" | "system"
   * @param {string} content
   * @returns {object} the created node
   */
  append(role, content) {
    const node = this.chain.append(role, content);
    if (role !== "compaction") {
      this.bm25.add(node);
    }
    return node;
  }

  /**
   * Get the current sliding window nodes.
   * @returns {object[]}
   */
  getWindow() {
    return this.window.select(this.chain);
  }

  /**
   * Search all in-memory nodes.
   * @param {string} query
   * @param {number} topK
   * @returns {{ nodeId: number, score: number, node: object }[]}
   */
  search(query, topK = 10) {
    const results = this.bm25.search(query, topK);
    return results.map(r => ({
      ...r,
      node: this.chain.get(r.nodeId)
    }));
  }

  /**
   * Attach additional context (PDF, code, etc.) to be included in prompts.
   * @param {string} type - label ("pdf", "code", "page")
   * @param {string} content - the text
   */
  attachContext(type, content) {
    this.conversationManager.attachContext(type, content);
  }

  /**
   * Clear attached context.
   */
  clearContext() {
    this.conversationManager.clearContext();
  }

  /**
   * Trim a specific node range to cold storage.
   * @param {{ from: number, to: number }} range
   * @param {object} [summary] - optional manual summary
   * @returns {object} compaction marker
   */
  async trim({ from, to }, summary = null) {
    if (!this._initialized) await this.init();

    if (!summary) {
      const nodes = this.chain.range(from, to);
      summary = await this.transport.generateSummary(nodes);
    }

    return this.compaction.trim(from, to, summary);
  }

  /**
   * Trim keeping only a specified range — archives everything OUTSIDE the range.
   * @param {{ keepStart: number, keepEnd: number }} range - node IDs to KEEP
   * @param {object} [beforeSummary] - summary for the before-block
   * @param {object} [afterSummary] - summary for the after-block
   * @returns {{ before: object|null, after: object|null }}
   */
  async trimKeepRange({ keepStart, keepEnd }, beforeSummary = null, afterSummary = null) {
    if (!this._initialized) await this.init();
    return this.compaction.trimKeepRange(keepStart, keepEnd, beforeSummary, afterSummary);
  }

  /**
   * Branch from a specific node — archives everything BEFORE it.
   * @param {number} fromNodeId - the node to branch from (stays active)
   * @param {object} [summary]
   * @returns {object|null}
   */
  async branchFrom(fromNodeId, summary = null) {
    if (!this._initialized) await this.init();
    return this.compaction.branchFrom(fromNodeId, summary);
  }

  /**
   * Trim everything before the current sliding window.
   * @param {object} [summary]
   * @returns {object|null}
   */
  async trimFromHere(summary = null) {
    if (!this._initialized) await this.init();

    if (!summary) {
      const windowNodes = this.window.select(this.chain);
      const allNodes = this.chain.all();
      const windowIds = new Set(windowNodes.map(n => n.id));
      const nodesToTrim = allNodes.filter(n => !windowIds.has(n.id));
      if (nodesToTrim.length > 0) {
        summary = await this.transport.generateSummary(nodesToTrim);
      }
    }

    return this.compaction.trimBeforeWindow(this.config.windowSize, summary);
  }

  /**
   * Restore an archived block back into active memory.
   * @param {string} archiveKey
   */
  async restore(archiveKey) {
    if (!this._initialized) await this.init();
    return this.compaction.restore(archiveKey);
  }

  /**
   * Branch to a new session. Archives everything, starts fresh.
   * @param {object} [summary]
   * @returns {string} archive key of the branched session
   */
  async branch(summary = null) {
    if (!this._initialized) await this.init();

    if (!summary) {
      const allNodes = this.chain.all();
      if (allNodes.length > 0) {
        summary = await this.transport.generateSummary(allNodes.slice(-50));
      }
    }

    return this.compaction.branch(summary);
  }

  /**
   * Get system status.
   * @returns {object}
   */
  status() {
    return {
      ...this.memoryManager.status(),
      archiveBlocks: this.compaction.markers.length
    };
  }

  /**
   * Register an event listener.
   * @param {string} event - "memory-warning"
   * @param {function} callback
   */
  on(event, callback) {
    this.memoryManager.on(event, callback);
  }

  /**
   * Export full state (for backup/migration).
   * @returns {object}
   */
  async export() {
    return {
      version: "1.0.0",
      config: this.config,
      chain: this.chain.export(),
      bm25: this.bm25.export(),
      bloom: this.bloom.export(),
      tfidf: this.tfidf.export(),
      compaction: this.compaction.export(),
      archives: await this.archive.exportAll()
    };
  }

  /**
   * Import full state from a previous export.
   * @param {object} data
   */
  async import(data) {
    if (!this._initialized) await this.init();

    if (data.config) this.config = createConfig(data.config);
    if (data.chain) this.chain.import(data.chain);
    if (data.bm25) this.bm25.import(data.bm25);
    if (data.bloom) this.bloom.import(data.bloom);
    if (data.tfidf) this.tfidf.import(data.tfidf);
    if (data.compaction) this.compaction.import(data.compaction);
    if (data.archives) await this.archive.importAll(data.archives);
  }
}

// Named exports for granular usage
export { Node } from "./core/node.js";
export { Chain } from "./core/chain.js";
export { Window } from "./core/window.js";
export { Buffer, SlidingBuffer, RecallBuffer } from "./core/buffer.js";
export { ConversationManager } from "./core/conversation-manager.js";
export { Compaction } from "./core/compaction.js";
export { Retrieval } from "./core/retrieval.js";
export { DeepRetrieval } from "./core/deep-retrieval.js";
export { BM25 } from "./search/bm25.js";
export { BloomFilter } from "./search/bloom.js";
export { TfIdf } from "./search/tfidf.js";
export { Archive } from "./storage/archive.js";
export { MemoryManager } from "./storage/memory.js";
export { LLMTransport } from "./transport/llm.js";
export { createConfig, defaultConfig } from "./config.js";
export { Tool } from "./tools/base.js";
export { ToolRegistry } from "./tools/registry.js";
export { createWebSearchTool } from "./extensions/web-search.js";
export { createDateTimeTool } from "./extensions/datetime.js";
