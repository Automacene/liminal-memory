/**
 * Retrieval Engine — orchestrates the search pipeline.
 * 1. BM25 on active window
 * 2. If low confidence → bloom filter gate → TF-IDF rank → decompress → BM25 inner
 * 3. Returns relevant historical nodes for injection into the prompt
 */
export class Retrieval {
  constructor(chain, bm25, bloom, tfidf, compaction, archive, transport, config) {
    this.chain = chain;
    this.bm25 = bm25;
    this.bloom = bloom;
    this.tfidf = tfidf;
    this.compaction = compaction;
    this.archive = archive;
    this.transport = transport;
    this.config = config;
  }

  /**
   * Full retrieval pipeline. Returns historical nodes to inject into the prompt.
   * For simple queries: returns nodes for injection.
   * For complex queries: returns null (deep retrieval handles the full response).
   * 
   * @param {string} query - the user's message
   * @param {object[]} windowNodes - current sliding window nodes
   * @returns {{ nodes: object[], deepResponse: string|null }}
   */
  async retrieve(query, windowNodes) {
    const { retrievalThreshold, maxRetrievedNodes } = this.config;

    // Step 1: Check BM25 confidence on active window
    const windowScore = this.bm25.bestScore(query);

    // If active window has a strong match, no need to dig into archives
    if (windowScore >= retrievalThreshold) {
      return { nodes: [], deepResponse: null };
    }

    // Step 2: Check if any archived blocks might contain relevant terms
    if (!this.bloom.testQuery(query)) {
      // Bloom filter says definitely not in any archive
      return { nodes: [], deepResponse: null };
    }

    // Step 3: Rank archive blocks by TF-IDF cosine similarity
    const blockVectors = this.compaction.getBlockVectors();
    if (blockVectors.length === 0) return { nodes: [], deepResponse: null };

    const ranked = this.tfidf.rankBlocks(query, blockVectors);
    if (ranked.length === 0 || ranked[0].score === 0) {
      return { nodes: [], deepResponse: null };
    }

    // Filter to blocks with non-zero scores
    const relevantBlocks = ranked.filter(r => r.score > 0);

    // Step 4: Simple retrieval — decompress top candidates and search within
    const results = [];
    const maxBlocks = Math.min(2, relevantBlocks.length);

    for (let i = 0; i < maxBlocks; i++) {
      const archiveKey = relevantBlocks[i].key;
      const nodes = await this.archive.retrieve(archiveKey);
      if (!nodes || nodes.length === 0) continue;

      const innerResults = this._searchWithinBlock(query, nodes);
      results.push(...innerResults);

      if (results.length >= maxRetrievedNodes) break;
    }

    return { nodes: results.slice(0, maxRetrievedNodes), deepResponse: null };
  }

  /**
   * Run BM25 on a temporary set of nodes (decompressed archive block).
   * @param {string} query
   * @param {object[]} nodes
   * @returns {object[]} matching nodes sorted by relevance
   */
  _searchWithinBlock(query, nodes) {
    const queryTerms = tokenizeLocal(query);
    if (queryTerms.length === 0) return [];

    const avgdl = nodes.reduce((sum, n) => sum + (n.content || "").split(/\s+/).length, 0) / nodes.length;
    const scored = [];

    for (const node of nodes) {
      if (node.role === "compaction") continue;
      const terms = tokenizeLocal(node.content);
      const termFreqs = new Map();
      for (const t of terms) {
        termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
      }

      let score = 0;
      for (const qt of queryTerms) {
        const freq = termFreqs.get(qt) || 0;
        if (freq === 0) continue;

        const df = nodes.filter(n => n.content && n.content.toLowerCase().includes(qt)).length;
        const idf = Math.log(1 + (nodes.length - df + 0.5) / (df + 0.5));
        const dl = terms.length;
        const numerator = freq * (this.config.bm25.k1 + 1);
        const denominator = freq + this.config.bm25.k1 * (1 - this.config.bm25.b + this.config.bm25.b * (dl / avgdl));
        score += idf * (numerator / denominator);
      }

      if (score > 0) {
        scored.push({ node, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .map(s => s.node);
  }
}

/**
 * Local tokenizer.
 */
function tokenizeLocal(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 0);
}
