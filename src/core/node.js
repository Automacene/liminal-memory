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
      metadata: this.metadata
    };
  }

  /**
   * Create a Node from a plain object (deserialization).
   * @param {object} obj
   * @returns {Node}
   */
  static from(obj) {
    return new Node({
      id: obj.id,
      parentId: obj.parentId,
      role: obj.role,
      content: obj.content,
      metadata: obj.metadata || {},
      timestamp: obj.timestamp || Date.now()
    });
  }
}
