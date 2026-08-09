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
import { BM25 } from "./search/bm25.js";
import { BloomFilter } from "./search/bloom.js";
import { TfIdf } from "./search/tfidf.js";
import { MemoryManager } from "./storage/memory.js";
import { Archive } from "./storage/archive.js";
import { LLMTransport } from "./transport/llm.js";
import { ToolRegistry } from "./tools/registry.js";
import { Tool } from "./tools/base.js";
import { Pocket } from "./core/pocket.js";
import { Settings } from "./core/settings.js";

/**
 * Pluggable connection points. Pass any of these to the constructor to override the built-in
 * default; omit them and the library behaves exactly as before.
 *
 * @typedef {object} StorageAdapter  Cold storage for archived blocks.
 * @property {() => Promise<void>} init
 * @property {(key: string, nodes: object[]) => Promise<void>} store
 * @property {(key: string) => Promise<object[]>} retrieve
 * @property {(key: string) => Promise<void>} delete
 *
 * @typedef {object} Transport  Talks to the model.
 * @property {(messages: {role: string, content: string}[]) => Promise<{text: string, usage: object|null}>} complete
 * @property {(nodes: object[]) => Promise<object>} generateSummary
 *
 * @typedef {object} Summarizer  Writes the summary for an archived block.
 * @property {(nodes: object[]) => Promise<object>} generateSummary
 *
 * @callback NodeNamer  Names a split category node (runs off the hot path).
 * @param {object[]} memberNodes  the cluster's member nodes
 * @param {{categoryNode: object}} ctx
 * @returns {Promise<{label?: string, keywords?: string[]}|null>}  a nicer name, or null to keep the default
 *
 * @typedef {object} LuminalMemoryOptions  Config values (see src/config.js) plus the sockets:
 * @property {StorageAdapter} [storageAdapter]  default: built-in Archive (IndexedDB / in-memory)
 * @property {Transport} [transport]  default: built-in LLMTransport
 * @property {Summarizer} [summarizer]  default: the transport
 * @property {NodeNamer} [nodeNamer]  default: none (keep instant keyword names)
 */

/**
 * Infinite-context memory for any LLM. Construct it, `init()`, then call `chat()` / `trim()` /
 * `search()` etc. Public methods are the API; `_`-prefixed methods are internal.
 * @param {LuminalMemoryOptions} [userConfig]
 */
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
    // Pluggable connection points — pass your own to override (shapes: see LuminalMemoryOptions above).
    this.archive = userConfig.storageAdapter || new Archive();
    this.memoryManager = new MemoryManager(this.chain, this.config);
    this.transport = userConfig.transport || new LLMTransport(this.config);
    this.summarizer = userConfig.summarizer || this.transport; // defaults to the transport
    this.nodeNamer = userConfig.nodeNamer || null;
    if (this.nodeNamer) this.chain.recordCategoryNaming = true; // splits queue nodes for enrichCategoryNames()
    this.compaction = new Compaction(
      this.chain, this.bm25, this.bloom, this.tfidf, this.archive, this.config
    );
    this.retrieval = new Retrieval(
      this.chain, this.bm25, this.bloom, this.tfidf, this.compaction, this.archive, this.transport, this.config
    );

    // Tool system
    this.toolRegistry = new ToolRegistry(this.config);

    // Pocket — parallel instruction queue
    this.pocket = new Pocket();

    // Settings — runtime config management with schema
    this.settings = new Settings(this.config, this.transport);

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
        } else {
          console.warn(`[Chat] Tool "${toolDecision.name}" failed: ${result.error}`);
        }
      }
    }

    // 4. Retrieve relevant historical nodes (pure math — BM25 + graph + bloom + TF-IDF)
    // Passing userNode.id lets retrieval create graph edges from this turn to whatever
    // gets recalled, so the graph builds itself through use (see ROADMAP.md Phase 1/3).
    const { nodes: retrievedNodes } = await this.retrieval.retrieve(
      message, this.window.select(this.chain), userNode.id
    );

    // 5. Build prompt with tool results + recall + sliding window
    let response;
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

    // 6. Call LLM
    const result = await this.transport.complete(messages);
    response = result.text;

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
      const { text: decision } = await this.transport.complete(messages);

      // Clean up common model formatting issues before parsing
      let cleaned = decision
        .replace(/<\|channel>thought<channel\|>[\s\S]*?<\|channel>response<channel\|>/g, '') // strip channel thinking
        .replace(/<\|channel>\w+<channel\|>/g, '') // strip any remaining channel tags
        .replace(/<\|?think\|?>[\s\S]*?<\|?\/?think\|?>/g, '') // strip think tags
        .replace(/```json\s*/gi, '')   // strip markdown json fences
        .replace(/```\s*/g, '')        // strip closing fences
        .replace(/^\s*`+|`+\s*$/g, '') // strip stray backticks
        .trim();

      // Try parsing as JSON first
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (!parsed.use) return null;
          return { name: parsed.tool, params: parsed.params || {} };
        } catch (e) {
          // fall through to the alternate model formats below
        }
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
        return { name: toolName, params };
      }

      // Parse generic function call format: tool_name("query")
      const funcMatch = decision.match(/(\w+)\(["']([^"']+)["']\)/);
      if (funcMatch) {
        return { name: funcMatch[1], params: { query: funcMatch[2] } };
      }

      // If the model just said it wants to search, extract a short query
      var searchIntent = decision.match(/search(?:ing)?\s+(?:for\s+)?["']([^"']+)["']/i);
      if (searchIntent && this.toolRegistry && this.toolRegistry.get('web_search')) {
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
   * Add a pocket note (correction/annotation) to an existing node.
   * Re-indexes the node in BM25 so the correction is searchable.
   * @param {number} nodeId
   * @param {string} note - the correction text
   * @returns {object|null} the updated node
   */
  addPocketNote(nodeId, note) {
    const node = this.chain.addPocketNote(nodeId, note);
    if (node) {
      // Re-index so the correction terms are searchable
      this.bm25.remove(nodeId);
      this.bm25.add(node);
    }
    return node;
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
   * Append a complete turn (user + assistant paired) as a single node.
   * Useful for importing existing conversations or bulk-loading history.
   * @param {string} userMessage - the user's message
   * @param {string} assistantMessage - the assistant's response
   * @returns {object} the created turn node
   */
  appendTurn(userMessage, assistantMessage) {
    const node = this.chain.appendTurn(userMessage, assistantMessage);
    this.bm25.add(node);
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
      summary = await this.summarizer.generateSummary(nodes);
    }

    return this.compaction.trim(from, to, summary);
  }

  /**
   * Archive an arbitrary, non-contiguous set of node ids as one cold-storage block — for
   * topic clusters that don't occupy a contiguous range.
   * @param {number[]} nodeIds - the exact set of node ids to archive
   * @param {object} [summary] - optional manual summary (auto-generated from the nodes if omitted)
   * @returns {object} compaction marker
   */
  async trimSet(nodeIds, summary = null) {
    if (!this._initialized) await this.init();

    if (!summary) {
      const ids = new Set(nodeIds);
      const nodes = this.chain.all().filter(n => ids.has(n.id) && n.role !== "compaction");
      if (nodes.length > 0) {
        summary = await this.summarizer.generateSummary(nodes);
      }
    }

    return this.compaction.trimSet(nodeIds, summary);
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
        summary = await this.summarizer.generateSummary(nodesToTrim);
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
   * Upgrade category-node names via the plugged-in nodeNamer, OFF the hot path — call after a turn
   * or on idle. Splits only set the instant keyword name and queue the node; the (possibly slow)
   * namer runs only here, so it never blocks a split or recall. No-op without a nodeNamer.
   * @returns {Promise<number>} how many category nodes were renamed
   */
  async enrichCategoryNames() {
    if (!this.nodeNamer) return 0;
    const queue = this.chain.pendingCategoryNaming;
    if (!queue || queue.length === 0) return 0;

    const pending = queue.splice(0, queue.length); // drain and clear
    let renamed = 0;
    for (const { categoryId, memberIds } of pending) {
      const categoryNode = this.chain.get(categoryId);
      if (!categoryNode) continue; // may have been re-split or archived since
      const memberNodes = memberIds.map(id => this.chain.get(id)).filter(Boolean);
      try {
        const result = await this.nodeNamer(memberNodes, { categoryNode });
        if (result && result.label) categoryNode.content = result.label;
        if (result && Array.isArray(result.keywords) && result.keywords.length) {
          categoryNode.keywords = result.keywords;
        }
        if (result && (result.label || result.keywords)) renamed++;
      } catch (e) {
        console.warn(`[NodeNamer] failed to name category ${categoryId}: ${e.message}`);
      }
    }
    return renamed;
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
        summary = await this.summarizer.generateSummary(allNodes.slice(-50));
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
export { BM25 } from "./search/bm25.js";
export { BloomFilter } from "./search/bloom.js";
export { TfIdf } from "./search/tfidf.js";
export { Archive } from "./storage/archive.js";
export { MemoryManager } from "./storage/memory.js";
export { LLMTransport } from "./transport/llm.js";
export { createConfig, defaultConfig } from "./config.js";
export { Tool } from "./tools/base.js";
export { ToolRegistry } from "./tools/registry.js";
export { createEphemeralMindTool, parseEphemeralPayload, validateTension } from "./extensions/ephemeral-mind.js";
export { createWebSearchTool } from "./extensions/web-search.js";
export { Pocket } from "./core/pocket.js";
export { Settings } from "./core/settings.js";
