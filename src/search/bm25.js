/**
 * BM25 — Best Matching 25 scoring engine.
 * Pure JavaScript implementation. No dependencies.
 * Operates over an in-memory inverted index of nodes.
 */
export class BM25 {
  constructor(config = {}) {
    this.k1 = config.k1 || 1.2;
    this.b = config.b || 0.4;

    // Inverted index: term -> [{ nodeId, freq }]
    this.index = new Map();
    // Document lengths: nodeId -> wordCount
    this.docLengths = new Map();
    // Total documents indexed
    this.docCount = 0;
    // Sum of all document lengths (for avgdl)
    this.totalLength = 0;
  }

  /**
   * Add a node to the index.
   * Uses node.keywords array if available, falls back to tokenizing content.
   * @param {object} node
   */
  add(node) {
    const terms = (node.keywords && node.keywords.length > 0)
      ? node.keywords
      : tokenize(node.content);
    const termFreqs = countTerms(terms);

    this.docLengths.set(node.id, terms.length);
    this.docCount++;
    this.totalLength += terms.length;

    for (const [term, freq] of termFreqs) {
      if (!this.index.has(term)) {
        this.index.set(term, []);
      }
      this.index.get(term).push({ nodeId: node.id, freq });
    }
  }

  /**
   * Remove a node from the index.
   * @param {number} nodeId
   */
  remove(nodeId) {
    const docLen = this.docLengths.get(nodeId);
    if (docLen === undefined) return;

    this.docLengths.delete(nodeId);
    this.docCount--;
    this.totalLength -= docLen;

    // Remove from inverted index
    for (const [term, postings] of this.index) {
      const filtered = postings.filter(p => p.nodeId !== nodeId);
      if (filtered.length === 0) {
        this.index.delete(term);
      } else {
        this.index.set(term, filtered);
      }
    }
  }

  /**
   * Search for the most relevant nodes given a query.
   * Extracts keywords from query (stopwords stripped), matches against indexed keywords.
   * @param {string} query
   * @param {number} topK - max results to return
   * @returns {{ nodeId: number, score: number }[]}
   */
  search(query, topK = 10) {
    const queryTerms = extractQueryKeywords(query);
    if (queryTerms.length === 0) return [];

    const avgdl = this.docCount > 0 ? this.totalLength / this.docCount : 1;
    const scores = new Map();

    for (const term of queryTerms) {
      const postings = this.index.get(term);
      if (!postings) continue;

      const df = postings.length;
      const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));

      for (const { nodeId, freq } of postings) {
        const dl = this.docLengths.get(nodeId) || 1;
        const numerator = freq * (this.k1 + 1);
        const denominator = freq + this.k1 * (1 - this.b + this.b * (dl / avgdl));
        const termScore = idf * (numerator / denominator);

        scores.set(nodeId, (scores.get(nodeId) || 0) + termScore);
      }
    }

    // Sort by score descending, return top K
    return Array.from(scores.entries())
      .map(([nodeId, score]) => ({ nodeId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Get the best score for a query (used to decide if archive retrieval is needed).
   * @param {string} query
   * @returns {number} best score, or 0 if no matches
   */
  bestScore(query) {
    const results = this.search(query, 1);
    return results.length > 0 ? results[0].score : 0;
  }

  /**
   * Rebuild the entire index from an array of nodes.
   * @param {object[]} nodes
   */
  rebuild(nodes) {
    this.index.clear();
    this.docLengths.clear();
    this.docCount = 0;
    this.totalLength = 0;
    for (const node of nodes) {
      if (node.role !== "compaction") {
        this.add(node);
      }
    }
  }

  /**
   * Export index state.
   */
  export() {
    return {
      index: Array.from(this.index.entries()),
      docLengths: Array.from(this.docLengths.entries()),
      docCount: this.docCount,
      totalLength: this.totalLength
    };
  }

  /**
   * Import index state.
   */
  import(data) {
    this.index = new Map(data.index);
    this.docLengths = new Map(data.docLengths);
    this.docCount = data.docCount;
    this.totalLength = data.totalLength;
  }
}

/**
 * Tokenize text into lowercase terms, stripping punctuation.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 0);
}

const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','might','shall','can','may','must','need','this','that','these','those','which','what','who','whom','where','when','why','how','not','no','nor','but','and','or','if','then','else','than','too','very','just','about','all','also','any','because','before','between','both','by','each','few','for','from','further','here','in','into','its','more','most','of','on','once','only','other','out','over','own','same','so','some','such','their','them','there','through','to','under','until','up','us','we','with','you','your','our','it','they','he','she','him','her','his','my','me','i','am','at','as','please','tell','explain','can','want','know','like','think','get','make','use','let','say','see']);

/**
 * Extract keywords from a query string — same filtering as node keyword extraction.
 * Stopwords removed, 3+ char terms only.
 * @param {string} query
 * @returns {string[]}
 */
function extractQueryKeywords(query) {
  if (!query) return [];
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Count term frequencies in a token array.
 * @param {string[]} terms
 * @returns {Map<string, number>}
 */
function countTerms(terms) {
  const counts = new Map();
  for (const term of terms) {
    counts.set(term, (counts.get(term) || 0) + 1);
  }
  return counts;
}
