/**
 * TF-IDF Vector Engine
 * Computes sparse TF-IDF vectors at compaction time.
 * Cosine similarity at query time for ranking archive blocks.
 * Pure JavaScript, zero dependencies.
 */
export class TfIdf {
  constructor() {
    // Global document frequency: term -> number of blocks containing it
    this.documentFrequency = new Map();
    // Total number of blocks indexed
    this.blockCount = 0;
  }

  /**
   * Compute a TF-IDF vector for a block of text.
   * Call this at compaction time.
   * @param {string} text - concatenated text of all nodes in the block
   * @returns {Map<string, number>} sparse vector (term -> tfidf score)
   */
  computeVector(text) {
    const terms = tokenize(text);
    if (terms.length === 0) return new Map();

    // Term frequency in this block
    const tf = new Map();
    for (const term of terms) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }

    // Normalize TF by total terms
    const totalTerms = terms.length;
    const vector = new Map();

    for (const [term, count] of tf) {
      const normalizedTf = count / totalTerms;
      const df = this.documentFrequency.get(term) || 0;
      // Use smoothed IDF: ln((blockCount + 1) / (df + 1)) + 1
      const idf = Math.log((this.blockCount + 1) / (df + 1)) + 1;
      vector.set(term, normalizedTf * idf);
    }

    return vector;
  }

  /**
   * Register a block's terms in the global document frequency.
   * Call this after computing the vector.
   * @param {string} text
   */
  registerBlock(text) {
    const uniqueTermsSet = new Set(tokenize(text));
    for (const term of uniqueTermsSet) {
      this.documentFrequency.set(term, (this.documentFrequency.get(term) || 0) + 1);
    }
    this.blockCount++;
  }

  /**
   * Unregister a block's terms (used when restoring an archive).
   * @param {string} text
   */
  unregisterBlock(text) {
    const uniqueTermsSet = new Set(tokenize(text));
    for (const term of uniqueTermsSet) {
      const count = this.documentFrequency.get(term) || 0;
      if (count <= 1) {
        this.documentFrequency.delete(term);
      } else {
        this.documentFrequency.set(term, count - 1);
      }
    }
    this.blockCount = Math.max(0, this.blockCount - 1);
  }

  /**
   * Compute cosine similarity between a query vector and a stored block vector.
   * @param {Map<string, number>} queryVec
   * @param {Map<string, number>} blockVec
   * @returns {number} similarity score (0 to 1)
   */
  cosineSimilarity(queryVec, blockVec) {
    let dotProduct = 0;
    let queryMag = 0;
    let blockMag = 0;

    for (const [term, score] of queryVec) {
      queryMag += score * score;
      if (blockVec.has(term)) {
        dotProduct += score * blockVec.get(term);
      }
    }

    for (const [, score] of blockVec) {
      blockMag += score * score;
    }

    queryMag = Math.sqrt(queryMag);
    blockMag = Math.sqrt(blockMag);

    if (queryMag === 0 || blockMag === 0) return 0;
    return dotProduct / (queryMag * blockMag);
  }

  /**
   * Rank archive blocks by relevance to a query.
   * @param {string} query
   * @param {{ key: string, vector: Map<string, number> }[]} blocks
   * @returns {{ key: string, score: number }[]} ranked results
   */
  rankBlocks(query, blocks) {
    const queryVec = this.computeVector(query);
    if (queryVec.size === 0) return [];

    const ranked = blocks.map(block => ({
      key: block.key,
      score: this.cosineSimilarity(queryVec, block.vector)
    }));

    return ranked.sort((a, b) => b.score - a.score);
  }

  /**
   * Serialize a sparse vector to a plain object for storage.
   * @param {Map<string, number>} vector
   * @returns {object}
   */
  static serializeVector(vector) {
    return Object.fromEntries(vector);
  }

  /**
   * Deserialize a stored vector back to a Map.
   * @param {object} obj
   * @returns {Map<string, number>}
   */
  static deserializeVector(obj) {
    return new Map(Object.entries(obj));
  }

  /**
   * Export engine state.
   */
  export() {
    return {
      documentFrequency: Array.from(this.documentFrequency.entries()),
      blockCount: this.blockCount
    };
  }

  /**
   * Import engine state.
   */
  import(data) {
    this.documentFrequency = new Map(data.documentFrequency);
    this.blockCount = data.blockCount;
  }
}

/**
 * Tokenize text into lowercase terms.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1);
}
