/**
 * Node — a single unit of conversation (one user message or one AI response).
 * Every node tracks its own size, token count, and metadata for easy budgeting.
 */
export class Node {
  /**
   * @param {object} params
   * @param {number} params.id - sequential integer
   * @param {number} params.parentId - previous node's id (0 for first)
   * @param {string} params.role - "user" | "assistant" | "system" | "compaction"
   * @param {string} params.content - the text content
   * @param {object} [params.metadata] - optional extensible metadata
   * @param {number} [params.timestamp] - unix ms (defaults to now)
   */
  constructor({ id, parentId, role, content, metadata = {}, timestamp = Date.now() }) {
    this.id = id;
    this.parentId = parentId;
    this.role = role;
    this.content = content;
    this.metadata = metadata;
    this.timestamp = timestamp;
    this.keywords = []; // Extracted search terms from content
    this.graph = { edges_to: [], edges_from: [] }; // Directional edges to other node IDs

    // Pre-computed sizing
    this._tokenCount = null;
    this._memSize = null;
  }

  /**
   * Estimated token count (~4 chars per token for English).
   * Cached after first calculation.
   * @returns {number}
   */
  get tokenCount() {
    if (this._tokenCount === null) {
      this._tokenCount = Math.ceil((this.content || "").length / 4);
    }
    return this._tokenCount;
  }

  /**
   * Estimated memory size in bytes (JS strings are UTF-16 + object overhead).
   * @returns {number}
   */
  get memSize() {
    if (this._memSize === null) {
      this._memSize = (this.content || "").length * 2 + 200; // UTF-16 + object overhead
    }
    return this._memSize;
  }

  /**
   * Character count of the content.
   * @returns {number}
   */
  get charCount() {
    return (this.content || "").length;
  }

  /**
   * Word count of the content.
   * @returns {number}
   */
  get wordCount() {
    if (!this.content) return 0;
    return this.content.split(/\s+/).filter(w => w.length > 0).length;
  }

  /**
   * Whether this node is a compaction marker.
   * @returns {boolean}
   */
  get isCompaction() {
    return this.role === "compaction";
  }

  /**
   * Convert to a plain message object for the LLM API.
   * @returns {{ role: string, content: string }}
   */
  toMessage() {
    if (this.isCompaction) {
      const summary = this.metadata?.summary;
      if (summary) {
        return {
          role: "system",
          content: `[Archived summary - Nodes ${this.metadata.startNode}-${this.metadata.endNode}]: ${JSON.stringify(summary)}`
        };
      }
      return null;
    }
    return { role: this.role, content: this.content };
  }

  /**
   * Serialize to a plain object for storage/export.
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      parentId: this.parentId,
      role: this.role,
      content: this.content,
      timestamp: this.timestamp,
      tokenCount: this.tokenCount,
      metadata: this.metadata,
      keywords: this.keywords,
      graph: this.graph
    };
  }

  /**
   * Create a Node from a plain object (deserialization).
   * @param {object} obj
   * @returns {Node}
   */
  static from(obj) {
    const node = new Node({
      id: obj.id,
      parentId: obj.parentId,
      role: obj.role,
      content: obj.content,
      metadata: obj.metadata || {},
      timestamp: obj.timestamp || Date.now()
    });
    node.keywords = obj.keywords || [];
    node.graph = obj.graph || { edges_to: [], edges_from: [] };
    return node;
  }

  /**
   * Extract keywords from arbitrary content (string, object, array).
   * Flattens nested structures, strips stopwords, returns unique meaningful terms.
   * @param {any} content - the node's content (string, object, array, etc.)
   * @returns {string[]}
   */
  static extractKeywords(content) {
    // Flatten content to a single string regardless of type
    const text = Node._flattenToString(content);

    // Tokenize: split on non-word chars, lowercase, filter
    const stopwords = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','might','shall','can','may','must','need','this','that','these','those','which','what','who','whom','where','when','why','how','not','no','nor','but','and','or','if','then','else','than','too','very','just','about','all','also','any','because','before','between','both','by','each','few','for','from','further','here','in','into','its','more','most','of','on','once','only','other','out','over','own','same','so','some','such','their','them','there','through','to','under','until','up','us','we','with','you','your','our','it','they','he','she','him','her','his','my','me','i','am','at','as']);

    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !stopwords.has(w));

    // Deduplicate and return
    return Array.from(new Set(words));
  }

  /**
   * Recursively flatten any value to a string for keyword extraction.
   */
  static _flattenToString(val) {
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) return val.map(v => Node._flattenToString(v)).join(' ');
    if (val && typeof val === 'object') {
      return Object.values(val).map(v => Node._flattenToString(v)).join(' ');
    }
    return String(val || '');
  }
}
