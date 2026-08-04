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
   * Full chat cycle: append → retrieve → build prompt → call LLM → append response.
   * Uses the ConversationManager to calculate budgets for recall + sliding buffers.
   * @param {string} message - user's message
   * @returns {string} assistant's response
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

    // 2. Retrieve relevant historical nodes (pure math — BM25 + bloom + TF-IDF)
    const { nodes: retrievedNodes, deepResponse } = await this.retrieval.retrieve(
      message, this.window.select(this.chain)
    );

    // 3. If deep retrieval handled it, use that response directly
    let response;
    if (deepResponse) {
      response = deepResponse;
    } else {
      // 4. Use ConversationManager to build the prompt with proper budgeting
      //    It handles: system prompt + attached context + recall buffer + sliding window
      const scoredRetrieved = retrievedNodes.map((node, i) => ({
        node,
        score: retrievedNodes.length - i // simple rank-based score
      }));

      const { messages } = this.conversationManager.buildPrompt(
        this.chain.all(),
        scoredRetrieved
      );

      // 5. Call LLM
      response = await this.transport.complete(messages);
    }

    // 6. Append assistant response as new node
    const assistantNode = this.chain.append("assistant", response);
    this.bm25.add(assistantNode);

    return response;
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
