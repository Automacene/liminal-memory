/**
 * Node Chain — the linear history of all conversation turns.
 * Everything lives in memory. Sequential IDs, single linked list via parentId.
 * 
 * Each node is a TURN (user query + assistant response paired together).
 */
export class Chain {
  constructor() {
    this.nodes = [];
    this.nextId = 1;
  }

  /**
   * Append a complete turn (user query + assistant response) as a single node.
   * @param {string} query - the user's message
   * @param {string} response - the assistant's response
   * @param {object} metadata - optional extra data
   * @returns {object} the created node
   */
  appendTurn(query, response, metadata = {}) {
    const content = `[user]: ${query}\n[assistant]: ${response}`;
    const node = {
      id: this.nextId,
      parentId: this.nextId > 1 ? this.nextId - 1 : 0,
      role: "turn",
      query,
      response,
      content,
      timestamp: Date.now(),
      tokenCount: estimateTokens(content),
      metadata
    };
    this.nodes.push(node);
    this.nextId++;
    return node;
  }

  /**
   * Append a single-role node (for system messages, compaction markers, or pending user queries).
   * @param {string} role - "user" | "assistant" | "system" | "compaction"
   * @param {string} content - the text content
   * @param {object} metadata - optional extra data
   * @returns {object} the created node
   */
  append(role, content, metadata = {}) {
    const node = {
      id: this.nextId,
      parentId: this.nextId > 1 ? this.nextId - 1 : 0,
      role,
      query: role === "user" ? content : "",
      response: role === "assistant" ? content : "",
      content,
      timestamp: Date.now(),
      tokenCount: estimateTokens(content),
      metadata
    };
    this.nodes.push(node);
    this.nextId++;
    return node;
  }

  /**
   * Get the last N nodes (the sliding window).
   * @param {number} n - number of nodes to retrieve
   * @returns {object[]} array of nodes
   */
  tail(n) {
    return this.nodes.slice(-n);
  }

  /**
   * Get all nodes currently in memory.
   * @returns {object[]}
   */
  all() {
    return this.nodes;
  }

  /**
   * Get a specific node by ID.
   * @param {number} id
   * @returns {object|undefined}
   */
  get(id) {
    return this.nodes.find(n => n.id === id);
  }

  /**
   * Get nodes in a specific ID range (inclusive).
   * @param {number} startId
   * @param {number} endId
   * @returns {object[]}
   */
  range(startId, endId) {
    return this.nodes.filter(n => n.id >= startId && n.id <= endId);
  }

  /**
   * Remove nodes by ID range and return the removed nodes.
   * @param {number} startId
   * @param {number} endId
   * @returns {object[]} removed nodes
   */
  remove(startId, endId) {
    const removed = [];
    this.nodes = this.nodes.filter(n => {
      if (n.id >= startId && n.id <= endId) {
        removed.push(n);
        return false;
      }
      return true;
    });
    return removed;
  }

  /**
   * Insert a node at the correct position by ID order.
   * @param {object} node
   */
  insert(node) {
    const idx = this.nodes.findIndex(n => n.id > node.id);
    if (idx === -1) {
      this.nodes.push(node);
    } else {
      this.nodes.splice(idx, 0, node);
    }
    if (node.id >= this.nextId) {
      this.nextId = node.id + 1;
    }
  }

  /**
   * Insert multiple nodes at their correct positions.
   * @param {object[]} nodes
   */
  insertMany(nodes) {
    for (const node of nodes) {
      this.insert(node);
    }
  }

  /**
   * Remove a single node by ID.
   * @param {number} id
   */
  removeById(id) {
    this.nodes = this.nodes.filter(n => n.id !== id);
  }

  /**
   * Total number of nodes in memory.
   * @returns {number}
   */
  get length() {
    return this.nodes.length;
  }

  /**
   * Estimate total memory usage in bytes.
   * @returns {number}
   */
  get memorySizeBytes() {
    let total = 0;
    for (const node of this.nodes) {
      total += (node.content || "").length * 2;
      total += 200;
    }
    return total;
  }

  /**
   * Export chain state for serialization.
   * @returns {object}
   */
  export() {
    return {
      nodes: this.nodes,
      nextId: this.nextId
    };
  }

  /**
   * Import chain state from serialized data.
   * @param {object} data
   */
  import(data) {
    this.nodes = data.nodes || [];
    this.nextId = data.nextId || 1;
  }
}

/**
 * Rough token estimation (~4 chars per token for English text).
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
