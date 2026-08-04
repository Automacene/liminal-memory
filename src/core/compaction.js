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
   * Trim a range of nodes from active memory into cold storage.
   * @param {number} startId - first node to archive
   * @param {number} endId - last node to archive
   * @param {object} summary - { startTopic, keyDecisions, openThreads }
   * @returns {object} the compaction marker node
   */
  async trim(startId, endId, summary) {
    // Extract nodes to archive
    const nodesToArchive = this.chain.range(startId, endId);
    if (nodesToArchive.length === 0) {
      throw new Error(`No nodes found in range ${startId}-${endId}`);
    }

    // Concatenate all content for indexing
    const fullText = nodesToArchive.map(n => n.content).join(" ");

    // Compute TF-IDF vector for this block
    const vector = this.tfidf.computeVector(fullText);
    this.tfidf.registerBlock(fullText);

    // Add terms to bloom filter
    const bloomTermCount = this.bloom.addText(fullText);

    // Compress and store in cold storage
    const archiveKey = `archive_${startId}_${endId}`;
    await this.archive.store(archiveKey, nodesToArchive);

    // Create compaction marker
    const marker = {
      id: endId + 0.5, // will be positioned after endId in the chain
      parentId: startId > 1 ? startId - 1 : 0,
      role: "compaction",
      content: "",
      timestamp: Date.now(),
      tokenCount: 0,
      metadata: {
        type: "compaction",
        startNode: startId,
        endNode: endId,
        nodeCount: nodesToArchive.length,
        summary: summary || { startTopic: "", keyDecisions: [], openThreads: [] },
        archiveKey,
        tfidfVector: TfidfSerialize(vector),
        bloomTerms: bloomTermCount
      }
    };

    // Assign a real integer ID for the marker
    marker.id = this.chain.nextId;

    // Remove archived nodes from memory
    const removed = this.chain.remove(startId, endId);

    // Remove from BM25 index
    for (const node of removed) {
      this.bm25.remove(node.id);
    }

    // Insert compaction marker into chain
    this.chain.append("compaction", "", marker.metadata);

    // Track the marker
    this.markers.push({
      archiveKey,
      startNode: startId,
      endNode: endId,
      vector
    });

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
