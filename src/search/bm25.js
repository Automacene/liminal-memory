/**
 * BM25, the default search engine.
 *
 * A search engine here takes terms in and gives ids and scores back. It never sees a node, a
 * pool, or a query string, which keeps it a pure function of what it has been told and makes
 * the same terms return the same ranking every time.
 *
 * Bring your own by implementing the same four methods: `add(id, terms)`, `remove(id)`,
 * `search(terms, limit)`, and `clear()`.
 */

export const BM25_DEFAULTS = {
  /** Term frequency saturation. Higher means repeated words keep adding score for longer. */
  k1: 1.2,
  /** Length normalization. Higher penalizes long documents more. Tuned low for short text. */
  b: 0.4
};

export class BM25 {
  /**
   * @param {object} [options]
   * @param {number} [options.k1]
   * @param {number} [options.b]
   */
  constructor(options = {}) {
    const { k1, b } = { ...BM25_DEFAULTS, ...options };
    this.k1 = k1;
    this.b = b;

    /**
     * term to (id to frequency). The inverted index, used at query time.
     * @type {Map<string, Map<string, number>>}
     */
    this._postings = new Map();

    /**
     * id to its term frequencies. Kept alongside the inverted index purely so removal can
     * touch only the terms a document actually had. Without it, dropping one document means
     * walking every term in the corpus, which turns evicting a thousand nodes into a thousand
     * full scans.
     * @type {Map<string, Map<string, number>>}
     */
    this._docs = new Map();

    this._totalLength = 0;
  }

  /**
   * Index a document. Re-adding an existing id replaces it.
   * @param {string} id
   * @param {string[]} terms
   */
  add(id, terms) {
    if (this._docs.has(id)) this.remove(id);
    if (!terms || terms.length === 0) return;

    const freqs = new Map();
    for (const term of terms) freqs.set(term, (freqs.get(term) || 0) + 1);

    for (const [term, freq] of freqs) {
      let posting = this._postings.get(term);
      if (!posting) {
        posting = new Map();
        this._postings.set(term, posting);
      }
      posting.set(id, freq);
    }

    this._docs.set(id, freqs);
    this._totalLength += terms.length;
  }

  /**
   * Drop a document. Costs only the number of distinct terms it had.
   * @param {string} id
   * @returns {boolean} whether the document was indexed
   */
  remove(id) {
    const freqs = this._docs.get(id);
    if (!freqs) return false;

    let length = 0;
    for (const [term, freq] of freqs) {
      length += freq;
      const posting = this._postings.get(term);
      if (!posting) continue;
      posting.delete(id);
      if (posting.size === 0) this._postings.delete(term);
    }

    this._docs.delete(id);
    this._totalLength -= length;
    return true;
  }

  /**
   * Rank documents against a set of query terms.
   *
   * Ties break on id rather than being left to the sort, so two documents that score
   * identically always come back in the same order. Insertion order would work today and
   * change the day a node is evicted and re-added.
   *
   * @param {string[]} terms
   * @param {number} [limit]
   * @returns {{id: string, score: number}[]} best first
   */
  search(terms, limit = 10) {
    if (!terms || terms.length === 0 || this._docs.size === 0) return [];

    const docCount = this._docs.size;
    const avgLength = this._totalLength / docCount;
    const scores = new Map();

    for (const term of terms) {
      const posting = this._postings.get(term);
      if (!posting) continue;

      const idf = Math.log(1 + (docCount - posting.size + 0.5) / (posting.size + 0.5));

      for (const [id, freq] of posting) {
        const length = this.length(id);
        const numerator = freq * (this.k1 + 1);
        const denominator = freq + this.k1 * (1 - this.b + this.b * (length / avgLength));
        scores.set(id, (scores.get(id) || 0) + idf * (numerator / denominator));
      }
    }

    return Array.from(scores, ([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  }

  /**
   * Total terms in a document, counting repeats.
   * @param {string} id
   * @returns {number}
   */
  length(id) {
    const freqs = this._docs.get(id);
    if (!freqs) return 0;

    let total = 0;
    for (const freq of freqs.values()) total += freq;
    return total;
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this._docs.has(id);
  }

  /**
   * How many documents are indexed.
   * @returns {number}
   */
  get size() {
    return this._docs.size;
  }

  /**
   * Empty the index.
   */
  clear() {
    this._postings.clear();
    this._docs.clear();
    this._totalLength = 0;
  }
}
