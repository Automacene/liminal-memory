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
  b: 0.4,

  /**
   * Where the calibration curve turns over, on a scale where 1.0 means the document carries the
   * query's entire term weight at typical length. Below this a document reads as incidental
   * overlap, above it as a real match. Raise it to be stricter.
   */
  inflection: 0.5,

  /**
   * How sharply the curve moves from near 0 to near 1 around the inflection point. Higher gives
   * a more decisive, more binary-looking score. Lower keeps more gradation in the middle.
   */
  slope: 6,

  /**
   * Set false for plain unbounded BM25, where `score` is the textbook figure and matches what
   * any other implementation would give you. Ordering is identical either way, since the curve
   * is monotonic, so this only changes what the numbers look like and what `minScore` compares
   * against.
   */
  calibrated: true
};

export class BM25 {
  /**
   * @param {object} [options]
   * @param {number} [options.k1]
   * @param {number} [options.b]
   * @param {number} [options.inflection]
   * @param {number} [options.slope]
   * @param {boolean} [options.calibrated]  false for plain unbounded BM25
   */
  constructor(options = {}) {
    const { k1, b, inflection, slope, calibrated } = { ...BM25_DEFAULTS, ...options };
    this.k1 = k1;
    this.b = b;
    this.inflection = inflection;
    this.slope = slope;
    this.calibrated = calibrated;

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
   * Scores come back between 0 and 1 so a caller can set one threshold and keep it. Raw BM25 is
   * unbounded and, worse, its magnitude tracks how many terms the query had, so a two word query
   * and a ten word query live on different scales and no fixed cutoff works for both. Dividing by
   * the top hit does not fix that either, because then a pool full of rubbish still yields a 1.0.
   *
   * Two steps get there. First the raw score is divided by the query's achievable weight, the
   * summed idf of every query term the pool actually contains. Query terms the pool lacks are
   * left out, since no document could have matched them. That quotient is near 1 when a document
   * of typical length carries the query's whole weight, and it means the same thing whatever the
   * query length, which is what makes a threshold portable.
   *
   * Then that quotient goes through a logistic curve, `1 / (1 + e^(-slope * (r - inflection)))`.
   * The curve is what stops high scores piling up against the ceiling and keeps the useful
   * gradation in the middle of the range, where the decision to keep or drop actually gets made.
   * Both constants are on `BM25_DEFAULTS` and are meant to be calibrated against your own corpus:
   * set `inflection` to where your results stop being incidental overlap and start being real
   * matches.
   *
   * All of this is switchable. `calibrated: false` makes `score` the plain unbounded BM25 figure,
   * identical to any textbook implementation, and `raw` is present on every hit either way. The
   * ordering never changes, because the curve is monotonic.
   *
   * Note what this does not preserve. For a single term query, every returned document contains
   * that term, so idf is the same for all of them and cancels. The score then reflects term
   * frequency and length alone. Rarity still matters across a multi term query, where a document
   * matching the rare word carries far more of the query's weight than one matching only the
   * common word.
   *
   * Ordering is untouched, since every score is divided by the same figure. Ties break on id
   * rather than being left to the sort, so two documents that score identically always come
   * back in the same order. Insertion order would work today and change the day a node is
   * evicted and re-added.
   *
   * @param {string[]} terms
   * @param {number} [limit]
   * @returns {{id: string, score: number, raw: number}[]} best first, `score` in 0 to 1
   */
  search(terms, limit = 10) {
    if (!terms || terms.length === 0 || this._docs.size === 0) return [];

    const docCount = this._docs.size;
    const avgLength = this._totalLength / docCount;
    const scores = new Map();
    let achievable = 0;

    for (const term of terms) {
      const posting = this._postings.get(term);
      if (!posting) continue;

      const idf = Math.log(1 + (docCount - posting.size + 0.5) / (posting.size + 0.5));
      achievable += idf;

      for (const [id, freq] of posting) {
        const length = this.length(id);
        const numerator = freq * (this.k1 + 1);
        const denominator = freq + this.k1 * (1 - this.b + this.b * (length / avgLength));
        scores.set(id, (scores.get(id) || 0) + idf * (numerator / denominator));
      }
    }

    if (achievable === 0) return [];

    return Array.from(scores, ([id, raw]) => ({
      id,
      score: this.calibrated ? this.calibrate(raw / achievable) : raw,
      raw
    }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  }

  /**
   * Put a normalized score through the calibration curve. Monotonic, so it never reorders
   * anything, and bounded strictly inside 0 to 1.
   * @param {number} ratio  share of the query's achievable weight this document carries
   * @returns {number}
   */
  calibrate(ratio) {
    return 1 / (1 + Math.exp(-this.slope * (ratio - this.inflection)));
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
