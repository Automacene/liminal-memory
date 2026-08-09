/**
 * Compaction Engine — handles trim, branch, and restore operations.
 * Moves nodes from active memory to cold storage (IndexedDB),
 * creates compaction markers, and manages archive lifecycle.
 */
export class Compaction {
  constructor(chain, bm25, bloom, tfidf, archive, config) {
    this.chain = chain;
    this.bm25 = bm25;
    this.bloom = bloom;
    this.tfidf = tfidf;
    this.archive = archive;
    this.config = config;
    this.markers = []; // references to compaction marker metadata
  }

  /**
   * Trim a CONTIGUOUS range of nodes from active memory into cold storage.
   * @param {number} startId - first node to archive
   * @param {number} endId - last node to archive
   * @param {object} summary - { startTopic, keyDecisions, openThreads }
   * @returns {object} the compaction marker node
   */
  async trim(startId, endId, summary) {
    const nodesToArchive = this.chain.range(startId, endId);
    if (nodesToArchive.length === 0) {
      throw new Error(`No nodes found in range ${startId}-${endId}`);
    }
    return this._archiveNodes(nodesToArchive, `archive_${startId}_${endId}`, summary);
  }

  /**
   * Archive an arbitrary, possibly NON-CONTIGUOUS set of node IDs as a single cold-storage
   * block — the sibling of trim() for topic clusters, which rarely occupy a contiguous ID
   * range (a recurring subject can surface at turn 12, 40, and 90). Resolves the ids to nodes
   * (deduped, skipping ids that don't exist and any existing compaction marker), archives the
   * exact set as one block with one summary marker, and works regardless of where those nodes
   * sit chronologically in the chain.
   * @param {number[]} nodeIds - the exact set of node ids to archive, any order
   * @param {object} [summary] - { startTopic, keyDecisions, openThreads }
   * @returns {object} the compaction marker node
   */
  async trimSet(nodeIds, summary) {
    const seen = new Set();
    const nodes = [];
    for (const id of nodeIds || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const node = this.chain.get(id);
      if (node && node.role !== "compaction") nodes.push(node);
    }
    if (nodes.length === 0) {
      throw new Error("No archivable nodes found for the given id set");
    }
    // Sort by id so the archived text, summary, and key are deterministic regardless of the
    // order ids were passed in.
    nodes.sort((a, b) => a.id - b.id);

    const sortedIds = nodes.map(n => n.id);
    // Key is unique by construction (it IS the set), and lets restore() find its block.
    const archiveKey = `archive_set_${sortedIds.join("_")}`;
    return this._archiveNodes(nodes, archiveKey, summary, { nodeIds: sortedIds });
  }

  /**
   * Shared archiving primitive for trim()/trimSet(): index the block (tf-idf + bloom), store it
   * in cold storage, drop the nodes from active memory + the BM25 index, and leave a single
   * compaction marker in the chain. The only things that differ between contiguous and set
   * archiving are *which* nodes and the *archive key* — those are chosen by the caller; this
   * owns everything downstream so the two entry points can't drift.
   * @param {object[]} nodes - the exact nodes to archive
   * @param {string} archiveKey - unique cold-storage key
   * @param {object} summary - { startTopic, keyDecisions, openThreads }
   * @param {object} [extraMeta] - extra marker metadata (e.g. { nodeIds } for a set)
   * @returns {object} the compaction marker node
   */
  async _archiveNodes(nodes, archiveKey, summary, extraMeta = {}) {
    // Concatenate all content for indexing
    const fullText = nodes.map(n => n.content).join(" ");

    // Compute TF-IDF vector + register, add terms to bloom
    const vector = this.tfidf.computeVector(fullText);
    this.tfidf.registerBlock(fullText);
    const bloomTermCount = this.bloom.addText(fullText);

    // Compress and store in cold storage
    await this.archive.store(archiveKey, nodes);

    const ids = nodes.map(n => n.id);
    const startNode = Math.min(...ids);
    const endNode = Math.max(...ids);

    const metadata = {
      type: "compaction",
      startNode,
      endNode,
      nodeCount: nodes.length,
      summary: summary || { startTopic: "", keyDecisions: [], openThreads: [] },
      archiveKey,
      tfidfVector: TfidfSerialize(vector),
      bloomTerms: bloomTermCount,
      ...extraMeta
    };

    // Remove archived nodes from active memory + the BM25 index (per-id, so it works for a
    // non-contiguous set exactly as it does for a range).
    for (const node of nodes) {
      this.chain.removeById(node.id);
      this.bm25.remove(node.id);
    }

    // Insert the compaction marker into the chain (appended at the tail, real integer id).
    const marker = this.chain.append("compaction", "", metadata);

    // Track the marker for retrieval ranking
    this.markers.push({ archiveKey, startNode, endNode, vector });

    return marker;
  }

  /**
   * Trim keeping only a specified range. Archives everything OUTSIDE the range.
   * Nodes before keepStart get archived as one block, nodes after keepEnd as another.
   * 
   * @param {number} keepStartId - first node to KEEP (everything before this is archived)
   * @param {number} keepEndId - last node to KEEP (everything after this is archived)
   * @param {object} [beforeSummary] - summary for the before-block
   * @param {object} [afterSummary] - summary for the after-block
   * @returns {{ before: object|null, after: object|null }} compaction markers created
   */
  async trimKeepRange(keepStartId, keepEndId, beforeSummary = null, afterSummary = null) {
    const allNodes = this.chain.all();
    if (allNodes.length === 0) return { before: null, after: null };

    const firstId = allNodes[0].id;
    const lastId = allNodes[allNodes.length - 1].id;

    let beforeMarker = null;
    let afterMarker = null;

    // Archive everything BEFORE the keep range
    if (keepStartId > firstId) {
      const beforeNodes = this.chain.range(firstId, keepStartId - 1);
      if (beforeNodes.length > 0) {
        const summary = beforeSummary || {
          startTopic: (beforeNodes[0].query || beforeNodes[0].content || "").slice(0, 80),
          keyDecisions: [],
          openThreads: []
        };
        beforeMarker = await this.trim(firstId, beforeNodes[beforeNodes.length - 1].id, summary);
      }
    }

    // Archive everything AFTER the keep range
    // Re-fetch allNodes since trim modified the chain
    const remainingNodes = this.chain.all();
    const nodesAfter = remainingNodes.filter(n => n.id > keepEndId && n.role !== "compaction");
    if (nodesAfter.length > 0) {
      const afterStartId = nodesAfter[0].id;
      const afterEndId = nodesAfter[nodesAfter.length - 1].id;
      const summary = afterSummary || {
        startTopic: (nodesAfter[0].query || nodesAfter[0].content || "").slice(0, 80),
        keyDecisions: [],
        openThreads: []
      };
      afterMarker = await this.trim(afterStartId, afterEndId, summary);
    }

    return { before: beforeMarker, after: afterMarker };
  }

  /**
   * Branch from a specific node. Archives everything BEFORE that node.
   * The selected node and everything after it remains as the active session.
   * 
   * @param {number} fromNodeId - the node to branch from (this node stays)
   * @param {object} [summary] - summary for the archived block
   * @returns {object|null} compaction marker, or null if nothing to archive
   */
  async branchFrom(fromNodeId, summary = null) {
    const allNodes = this.chain.all();
    if (allNodes.length === 0) return null;

    const firstId = allNodes[0].id;

    // Nothing to archive if we're branching from the first node
    if (fromNodeId <= firstId) return null;

    const beforeNodes = this.chain.range(firstId, fromNodeId - 1);
    if (beforeNodes.length === 0) return null;

    const archiveSummary = summary || {
      startTopic: (beforeNodes[0].query || beforeNodes[0].content || "").slice(0, 80),
      keyDecisions: [],
      openThreads: []
    };

    return this.trim(firstId, beforeNodes[beforeNodes.length - 1].id, archiveSummary);
  }

  /**
   * Trim everything before the current sliding window.
   * @param {number} windowSize
   * @param {object} summary
   * @returns {object|null} compaction marker, or null if nothing to trim
   */
  async trimBeforeWindow(windowSize, summary) {
    const totalNodes = this.chain.length;
    if (totalNodes <= windowSize) return null;

    const allNodes = this.chain.all();
    const cutoffIdx = totalNodes - windowSize;
    const startId = allNodes[0].id;
    const endId = allNodes[cutoffIdx - 1].id;

    return this.trim(startId, endId, summary);
  }

  /**
   * Branch to a new session. Archives everything and starts fresh.
   * @param {object} summary
   * @returns {string} archive key of the branched session
   */
  async branch(summary) {
    const allNodes = this.chain.all();
    if (allNodes.length === 0) return null;

    const startId = allNodes[0].id;
    const endId = allNodes[allNodes.length - 1].id;

    await this.trim(startId, endId, summary);
    return `archive_${startId}_${endId}`;
  }

  /**
   * Restore an archived block back into active memory.
   * @param {string} archiveKey
   */
  async restore(archiveKey) {
    // Fetch from cold storage
    const nodes = await this.archive.retrieve(archiveKey);
    if (!nodes || nodes.length === 0) {
      throw new Error(`Archive not found: ${archiveKey}`);
    }

    // Find and remove the compaction marker referencing this key
    const markerNode = this.chain.all().find(
      n => n.role === "compaction" && n.metadata?.archiveKey === archiveKey
    );
    if (markerNode) {
      this.chain.removeById(markerNode.id);
    }

    // Re-insert nodes into chain
    this.chain.insertMany(nodes);

    // Re-add to BM25 index
    for (const node of nodes) {
      if (node.role !== "compaction") {
        this.bm25.add(node);
      }
    }

    // Decrement bloom filter
    const fullText = nodes.map(n => n.content).join(" ");
    this.bloom.removeText(fullText);

    // Unregister from TF-IDF
    this.tfidf.unregisterBlock(fullText);

    // Remove from markers list
    this.markers = this.markers.filter(m => m.archiveKey !== archiveKey);

    // Delete from cold storage
    await this.archive.delete(archiveKey);
  }

  /**
   * Get all tracked archive block metadata (for retrieval ranking).
   * @returns {{ key: string, vector: Map<string, number> }[]}
   */
  getBlockVectors() {
    return this.markers.map(m => ({
      key: m.archiveKey,
      vector: m.vector
    }));
  }

  /**
   * Export compaction state.
   */
  export() {
    return {
      markers: this.markers.map(m => ({
        ...m,
        vector: Object.fromEntries(m.vector)
      }))
    };
  }

  /**
   * Import compaction state.
   */
  import(data) {
    this.markers = (data.markers || []).map(m => ({
      ...m,
      vector: new Map(Object.entries(m.vector))
    }));
  }
}

/**
 * Helper to serialize TF-IDF vector for storage in node metadata.
 */
function TfidfSerialize(vector) {
  return Object.fromEntries(vector);
}
