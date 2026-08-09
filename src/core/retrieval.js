/**
 * Retrieval Engine — orchestrates the search pipeline.
 * 1. BM25 on active window
 * 2. If low confidence → bloom filter gate → TF-IDF rank → decompress → BM25 inner
 * 3. Returns relevant historical nodes for injection into the prompt
 */
import { stem } from "../search/stem.js";

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
   *
   * Order of operations:
   * 1. Active-memory recall — BM25 search over everything still in RAM (not archived),
   *    excluding whatever's already in the sliding window. If graph edges exist on the
   *    matched nodes, follow them outward up to `linkDistance` hops to pull in related
   *    nodes a plain keyword match would've missed. If a `currentNodeId` is provided,
   *    directional edges are created from that node to whatever gets recalled — this is
   *    how the graph grows through use instead of being pre-built.
   * 2. Only if active memory has nothing useful does this fall back to archives — bloom
   *    filter gate, TF-IDF block ranking, decompress, search within.
   *
   * @param {string} query - the user's message
   * @param {object[]} windowNodes - current sliding window nodes
   * @param {number} [currentNodeId] - id of the node this turn should link FROM, if any
   * @returns {{ nodes: object[], deepResponse: string|null }}
   */
  async retrieve(query, windowNodes, currentNodeId = null) {
    const { retrievalThreshold, maxRetrievedNodes, linkDistance } = this.config;
    const windowIds = new Set(windowNodes.map(n => n.id));

    // Step 1: Active-memory recall (live BM25 + graph link expansion).
    // One BM25 pass gives BOTH the top seed matches AND a relevance score for every
    // node that shares any query term — the score map is reused below to rank the
    // graph-expanded candidates, so we keep the *best*-matching nodes, not just the
    // first ones the graph walk happened to reach.
    const scored = this.bm25.search(query, Number.MAX_SAFE_INTEGER);
    const scoreById = new Map(scored.map(r => [r.nodeId, r.score]));

    let recallNodeIds = scored
      .filter(r => !windowIds.has(r.nodeId))
      .slice(0, maxRetrievedNodes)
      .map(r => r.nodeId);

    if ((linkDistance || 0) > 0 && recallNodeIds.length > 0) {
      recallNodeIds = this._expandAndRank(recallNodeIds, windowIds, linkDistance, maxRetrievedNodes, scoreById);
    }

    const activeNodes = recallNodeIds.map(id => this.chain.get(id)).filter(Boolean);

    if (activeNodes.length > 0) {
      if (currentNodeId != null) {
        for (const node of activeNodes) {
          this.chain.link(currentNodeId, node.id);
        }
      }
      return { nodes: activeNodes, deepResponse: null };
    }

    // Step 2: Nothing relevant in active memory — check confidence before digging into archives
    const windowScore = this.bm25.bestScore(query);
    if (windowScore >= retrievalThreshold) {
      return { nodes: [], deepResponse: null };
    }

    // Step 3: Check if any archived blocks might contain relevant terms
    if (!this.bloom.testQuery(query)) {
      // Bloom filter says definitely not in any archive
      return { nodes: [], deepResponse: null };
    }

    // Step 4: Rank archive blocks by TF-IDF cosine similarity
    const blockVectors = this.compaction.getBlockVectors();
    if (blockVectors.length === 0) return { nodes: [], deepResponse: null };

    const ranked = this.tfidf.rankBlocks(query, blockVectors);
    if (ranked.length === 0 || ranked[0].score === 0) {
      return { nodes: [], deepResponse: null };
    }

    // Filter to blocks with non-zero scores
    const relevantBlocks = ranked.filter(r => r.score > 0);

    // Step 5: Simple retrieval — decompress top candidates and search within
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
   * Follow graph edges outward from the BM25-matched seed nodes (up to `linkDistance`
   * hops), then rank the ENTIRE candidate set — seeds plus everything the walk pulled
   * in — by BM25 relevance to the query, and keep the best `maxRetrievedNodes * 2`.
   *
   * Why the ranking matters: graph-expanded nodes arrive unscored — they were pulled in
   * for being *connected*, not for matching the query. Without ranking, trimming to the
   * cap just keeps whatever the walk reached first (seeds, then nearest neighbors),
   * silently dropping genuinely better matches sitting deeper in the set. Scoring every
   * candidate against the query and keeping the top N means the kept set is the best
   * matches; hop distance (closer first) is the tie-breaker for candidates that share
   * no query terms and would otherwise all score 0.
   *
   * @param {number[]} seedIds - initial BM25 match IDs (already the top matches)
   * @param {Set<number>} windowIds - ids already in the sliding window (skip these)
   * @param {number} linkDistance - how many hops to follow
   * @param {number} maxRetrievedNodes - kept set is capped at 2x this
   * @param {Map<number, number>} scoreById - BM25 score per node id, from the query pass
   * @returns {number[]} candidate ids ranked best-first, capped
   */
  _expandAndRank(seedIds, windowIds, linkDistance, maxRetrievedNodes, scoreById) {
    // BFS outward, recording each candidate's hop distance from the seeds (seeds = 0).
    const hopById = new Map(seedIds.map(id => [id, 0]));
    let frontier = seedIds.slice();

    for (let hop = 1; hop <= linkDistance; hop++) {
      const nextFrontier = [];
      for (const id of frontier) {
        const node = this.chain.get(id);
        if (!node || !node.graph) continue;
        const allEdges = (node.graph.edges_to || []).concat(node.graph.edges_from || []);
        for (const linkedId of allEdges) {
          if (!hopById.has(linkedId) && !windowIds.has(linkedId)) {
            hopById.set(linkedId, hop);
            nextFrontier.push(linkedId);
          }
        }
      }
      frontier = nextFrontier;
    }

    // Rank the whole candidate set by query relevance; tie-break by proximity (hop).
    const ranked = Array.from(hopById.keys())
      .sort((a, b) => {
        const scoreDiff = (scoreById.get(b) || 0) - (scoreById.get(a) || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return hopById.get(a) - hopById.get(b);
      })
      .slice(0, maxRetrievedNodes * 2);

    return ranked;
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
    .filter(t => t.length > 0)
    .map(stem); // match the stemming used at index time
}
