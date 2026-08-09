/**
 * Node Chain — the linear history of all conversation turns.
 * Everything lives in memory. Sequential IDs, single linked list via parentId.
 * 
 * Each node is a TURN (user query + assistant response paired together).
 */
import { maybeSplit } from "./node-split.js";

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
      pocketNotes: [],
      metadata,
      keywords: extractKeywordsFromContent(content),
      graph: { edges_to: [], edges_from: [] }
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
      pocketNotes: [],
      metadata,
      keywords: extractKeywordsFromContent(content),
      graph: { edges_to: [], edges_from: [] }
    };
    this.nodes.push(node);
    this.nextId++;
    return node;
  }

  /**
   * Add a pocket note (correction/annotation) to an existing node.
   * Re-estimates token count to include the note.
   * @param {number} nodeId
   * @param {string} note - the correction text
   * @returns {object|null} the updated node, or null if not found
   */
  addPocketNote(nodeId, note) {
    const node = this.get(nodeId);
    if (!node) return null;
    if (!node.pocketNotes) node.pocketNotes = [];
    node.pocketNotes.push({
      timestamp: Date.now(),
      content: note
    });
    // Update token count to reflect the added note
    const fullContent = node.content + ' ' + node.pocketNotes.map(n => n.content).join(' ');
    node.tokenCount = estimateTokens(fullContent);
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
   * Create a directional edge from one node to another.
   * The "from" node discovered/referenced the "to" node.
   * @param {number} fromNodeId - the node that triggered the discovery
   * @param {number} toNodeId - the node that was found/referenced
   */
  link(fromNodeId, toNodeId) {
    if (fromNodeId === toNodeId) return;
    const from = this.get(fromNodeId);
    const to = this.get(toNodeId);
    if (!from || !to) return;
    if (!from.graph) from.graph = { edges_to: [], edges_from: [] };
    if (!to.graph) to.graph = { edges_to: [], edges_from: [] };
    if (!from.graph.edges_to.includes(toNodeId)) from.graph.edges_to.push(toNodeId);
    if (!to.graph.edges_from.includes(fromNodeId)) to.graph.edges_from.push(fromNodeId);

    // Phase 3: the node that just gained a child may now be overflowing. Hand it to the
    // splitter (src/core/node-split.js), which owns the clustering algorithm so Chain stays
    // a plain data structure. Only `from` gains a child on a link, so only it can overflow.
    maybeSplit(this, from);
  }

  /**
   * Distinct neighbor IDs of a node (union of both edge directions).
   * @param {object} node
   * @returns {number[]}
   */
  _neighborIds(node) {
    const g = node.graph || { edges_to: [], edges_from: [] };
    return Array.from(new Set([...(g.edges_to || []), ...(g.edges_from || [])]));
  }

  _neighborCount(node) {
    return this._neighborIds(node).length;
  }

  /** Add a directional edge a→b directly, bypassing the overflow check (used mid-split). */
  _rawLink(a, b) {
    if (!a.graph.edges_to.includes(b.id)) a.graph.edges_to.push(b.id);
    if (!b.graph.edges_from.includes(a.id)) b.graph.edges_from.push(a.id);
  }

  /** Remove any edges between two nodes, in both directions. */
  _unlink(a, b) {
    a.graph.edges_to = a.graph.edges_to.filter(id => id !== b.id);
    a.graph.edges_from = a.graph.edges_from.filter(id => id !== b.id);
    b.graph.edges_to = b.graph.edges_to.filter(id => id !== a.id);
    b.graph.edges_from = b.graph.edges_from.filter(id => id !== a.id);
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

const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','might','shall','can','may','must','need','this','that','these','those','which','what','who','whom','where','when','why','how','not','no','nor','but','and','or','if','then','else','than','too','very','just','about','all','also','any','because','before','between','both','by','each','few','for','from','further','here','in','into','its','more','most','of','on','once','only','other','out','over','own','same','so','some','such','their','them','there','through','to','under','until','up','us','we','with','you','your','our','it','they','he','she','him','her','his','my','me','i','am','at','as']);

/**
 * Extract keywords from content (string or object).
 * Flattens to text, tokenizes, removes stopwords, deduplicates.
 * @param {any} content
 * @returns {string[]}
 */
function extractKeywordsFromContent(content) {
  const text = flattenContent(content);
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
  return Array.from(new Set(words));
}

function flattenContent(val) {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(flattenContent).join(' ');
  if (val && typeof val === 'object') return Object.values(val).map(flattenContent).join(' ');
  return String(val || '');
}
