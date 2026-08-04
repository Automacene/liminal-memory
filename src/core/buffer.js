/**
 * Buffer — base class for token-budgeted node collections.
 * 
 * A buffer holds an ordered set of nodes and manages a token budget.
 * Subclasses implement different selection strategies:
 * - SlidingBuffer: takes the most recent N nodes that fit
 * - RecallBuffer: takes the most relevant nodes by score that fit
 * 
 * Buffers are ephemeral per-turn. They don't own the nodes — they just
 * select a subset from the chain for prompt building.
 */
export class Buffer {
  /**
   * @param {object} options
   * @param {number} options.maxTokens - maximum token budget for this buffer
   * @param {string} [options.name] - identifier for logging
   */
  constructor({ maxTokens, name = "buffer" }) {
    this.maxTokens = maxTokens;
    this.name = name;
    this.nodes = [];
    this._tokenTotal = 0;
  }

  /**
   * Current token usage.
   * @returns {number}
   */
  get tokenCount() {
    return this._tokenTotal;
  }

  /**
   * Remaining token capacity.
   * @returns {number}
   */
  get remaining() {
    return Math.max(0, this.maxTokens - this._tokenTotal);
  }

  /**
   * Number of nodes currently in the buffer.
   * @returns {number}
   */
  get length() {
    return this.nodes.length;
  }

  /**
   * Whether the buffer is empty.
   * @returns {boolean}
   */
  get isEmpty() {
    return this.nodes.length === 0;
  }

  /**
   * Try to add a node. Returns true if it fit, false if budget exceeded.
   * @param {import('./node.js').Node} node
   * @returns {boolean}
   */
  push(node) {
    if (this._tokenTotal + node.tokenCount > this.maxTokens) {
      return false;
    }
    this.nodes.push(node);
    this._tokenTotal += node.tokenCount;
    return true;
  }

  /**
   * Remove and return the last node.
   * @returns {import('./node.js').Node|undefined}
   */
  pop() {
    const node = this.nodes.pop();
    if (node) {
      this._tokenTotal -= node.tokenCount;
    }
    return node;
  }

  /**
   * Remove and return the first node.
   * @returns {import('./node.js').Node|undefined}
   */
  shift() {
    const node = this.nodes.shift();
    if (node) {
      this._tokenTotal -= node.tokenCount;
    }
    return node;
  }

  /**
   * Clear all nodes from the buffer.
   */
  clear() {
    this.nodes = [];
    this._tokenTotal = 0;
  }

  /**
   * Get all nodes as LLM message objects.
   * @returns {object[]}
   */
  toMessages() {
    const messages = [];
    for (const node of this.nodes) {
      const msg = node.toMessage ? node.toMessage() : { role: node.role, content: node.content };
      if (msg) messages.push(msg);
    }
    return messages;
  }

  /**
   * Debug info.
   * @returns {object}
   */
  status() {
    return {
      name: this.name,
      nodes: this.nodes.length,
      tokens: this._tokenTotal,
      maxTokens: this.maxTokens,
      utilization: this.maxTokens > 0 ? (this._tokenTotal / this.maxTokens) : 0
    };
  }
}

/**
 * SlidingBuffer — fills from the most recent nodes backwards until budget is full.
 * This is the "working memory" — the recent conversation the model sees.
 */
export class SlidingBuffer extends Buffer {
  /**
   * @param {object} options
   * @param {number} options.maxTokens - token budget
   * @param {number} options.maxNodes - max number of nodes regardless of tokens
   */
  constructor({ maxTokens, maxNodes = Infinity }) {
    super({ maxTokens, name: "sliding" });
    this.maxNodes = maxNodes;
  }

  /**
   * Fill the buffer from a chain, taking the most recent nodes that fit.
   * @param {import('./node.js').Node[]|object[]} allNodes - full chain of nodes (ordered oldest to newest)
   */
  fill(allNodes) {
    this.clear();
    // Walk backwards from most recent
    for (let i = allNodes.length - 1; i >= 0; i--) {
      const node = allNodes[i];
      const tokens = node.tokenCount || Math.ceil((node.content || "").length / 4);

      if (this.nodes.length >= this.maxNodes) break;
      if (this._tokenTotal + tokens > this.maxTokens) break;

      this.nodes.unshift(node);
      this._tokenTotal += tokens;
    }
  }
}

/**
 * RecallBuffer — fills with the highest-scoring retrieved nodes, pruning until budget fits.
 * This is the "long-term recall" — historical nodes pulled by the retrieval pipeline.
 */
export class RecallBuffer extends Buffer {
  constructor({ maxTokens }) {
    super({ maxTokens, name: "recall" });
  }

  /**
   * Fill the buffer with scored nodes, dropping lowest-scoring until they fit.
   * @param {{ node: object, score: number }[]} scoredNodes - nodes with relevance scores, sorted desc
   */
  fill(scoredNodes) {
    this.clear();
    // Nodes come in sorted by score (highest first)
    for (const { node } of scoredNodes) {
      const tokens = node.tokenCount || Math.ceil((node.content || "").length / 4);
      if (this._tokenTotal + tokens > this.maxTokens) break;
      this.nodes.push(node);
      this._tokenTotal += tokens;
    }
  }

  /**
   * Drop the lowest-scoring node until total fits within a new budget.
   * @param {number} newBudget
   */
  pruneToFit(newBudget) {
    while (this._tokenTotal > newBudget && this.nodes.length > 0) {
      this.pop(); // removes last (lowest score since we filled highest-first)
    }
  }
}
