import { describe, it } from "node:test";
import assert from "node:assert";
import { BM25 } from "../src/search/bm25.js";
import { BloomFilter } from "../src/search/bloom.js";
import { TfIdf } from "../src/search/tfidf.js";
import { Chain } from "../src/core/chain.js";
import { Retrieval } from "../src/core/retrieval.js";

describe("Retrieval Pipeline (unit)", () => {
  it("BM25 finds relevant nodes from chain", () => {
    const chain = new Chain();
    const bm25 = new BM25({ k1: 1.2, b: 0.4 });

    const n1 = chain.append("user", "How do bloom filters work?");
    const n2 = chain.append("assistant", "Bloom filters are probabilistic data structures for membership testing.");
    const n3 = chain.append("user", "What about BM25 scoring?");
    const n4 = chain.append("assistant", "BM25 is a ranking function used in search engines.");

    [n1, n2, n3, n4].forEach(n => bm25.add(n));

    const results = bm25.search("bloom filter membership");
    assert.ok(results.length > 0);
    // Should rank the bloom filter nodes higher
    assert.ok(results[0].nodeId <= 2);
  });

  it("bloom filter gates archive access", () => {
    const bloom = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });

    // Simulate adding terms from an archived block
    bloom.addText("compression algorithm zstandard decompression");

    // Query about compression should hit
    assert.strictEqual(bloom.testQuery("zstandard compression"), true);

    // Query about unrelated topic should miss
    assert.strictEqual(bloom.testQuery("basketball sports"), false);
  });

  it("TF-IDF ranks archive blocks by similarity", () => {
    const tfidf = new TfIdf();

    // Register two blocks
    const text1 = "bloom filters probabilistic data structures membership testing hash functions";
    const text2 = "database optimization query planning index strategies performance tuning";

    tfidf.registerBlock(text1);
    tfidf.registerBlock(text2);

    const vec1 = tfidf.computeVector(text1);
    const vec2 = tfidf.computeVector(text2);

    const blocks = [
      { key: "archive_1", vector: vec1 },
      { key: "archive_2", vector: vec2 }
    ];

    // Query about bloom filters should rank block 1 higher
    const ranked = tfidf.rankBlocks("bloom filter hash", blocks);
    assert.strictEqual(ranked[0].key, "archive_1");
    assert.ok(ranked[0].score > ranked[1].score);
  });

  it("TF-IDF cosine similarity returns 0 for no overlap", () => {
    const tfidf = new TfIdf();
    const vec1 = new Map([["hello", 0.5], ["world", 0.3]]);
    const vec2 = new Map([["foo", 0.5], ["bar", 0.3]]);

    const sim = tfidf.cosineSimilarity(vec1, vec2);
    assert.strictEqual(sim, 0);
  });

  it("TF-IDF vector serialization round-trips", () => {
    const tfidf = new TfIdf();
    tfidf.registerBlock("hello world test");
    const vec = tfidf.computeVector("hello world test");

    const serialized = TfIdf.serializeVector(vec);
    const deserialized = TfIdf.deserializeVector(serialized);

    assert.strictEqual(deserialized.size, vec.size);
    for (const [key, val] of vec) {
      assert.strictEqual(deserialized.get(key), val);
    }
  });
});

describe("Retrieval — active memory recall + graph linking (Phase 1, library-level)", () => {
  it("recalls active nodes outside the window and links the current turn to them", async () => {
    const chain = new Chain();
    const bm25 = new BM25({ k1: 1.2, b: 0.4 });
    const config = { retrievalThreshold: 0.5, maxRetrievedNodes: 5, linkDistance: 0 };
    const retrieval = new Retrieval(chain, bm25, null, null, null, null, null, config);

    const n1 = chain.append("user", "How do bloom filters work?");
    bm25.add(n1);
    const n2 = chain.append("assistant", "Bloom filters are probabilistic membership structures.");
    bm25.add(n2);

    const currentTurn = chain.append("user", "remind me about bloom filters");
    bm25.add(currentTurn);

    const { nodes } = await retrieval.retrieve("bloom filters", [currentTurn], currentTurn.id);

    assert.ok(nodes.length > 0, "should recall at least one active node");
    assert.ok(nodes.some(n => n.id === n1.id || n.id === n2.id));

    // The current turn should now have directional edges pointing at whatever was recalled
    assert.ok(currentTurn.graph.edges_to.length > 0);
    for (const n of nodes) {
      assert.ok(n.graph.edges_from.includes(currentTurn.id));
    }
  });

  it("expands recall via existing graph edges, pulling in nodes BM25 alone would miss", async () => {
    const chain = new Chain();
    const bm25 = new BM25({ k1: 1.2, b: 0.4 });
    const config = { retrievalThreshold: 0.5, maxRetrievedNodes: 5, linkDistance: 1 };
    const retrieval = new Retrieval(chain, bm25, null, null, null, null, null, config);

    const a = chain.append("user", "tell me about rate limiters");
    bm25.add(a);
    const b = chain.append("system", "unrelated content about weather patterns");
    bm25.add(b);
    chain.link(a.id, b.id); // pre-existing edge — no shared keywords with the query below

    const currentTurn = chain.append("user", "rate limiters again please");
    bm25.add(currentTurn);

    const { nodes } = await retrieval.retrieve("rate limiters", [currentTurn], currentTurn.id);
    const ids = nodes.map(n => n.id);

    assert.ok(ids.includes(a.id), "direct BM25 match should be recalled");
    assert.ok(ids.includes(b.id), "graph-linked node should be pulled in even without keyword overlap");
  });

  it("does not create a self-edge when the current node also matches its own query", async () => {
    const chain = new Chain();
    const bm25 = new BM25({ k1: 1.2, b: 0.4 });
    const config = { retrievalThreshold: 0.5, maxRetrievedNodes: 5, linkDistance: 0 };
    const retrieval = new Retrieval(chain, bm25, null, null, null, null, null, config);

    const currentTurn = chain.append("user", "bloom filters bloom filters bloom filters");
    bm25.add(currentTurn);

    await retrieval.retrieve("bloom filters", [], currentTurn.id);
    assert.ok(!currentTurn.graph.edges_to.includes(currentTurn.id));
    assert.ok(!currentTurn.graph.edges_from.includes(currentTurn.id));
  });

  it("ranks the full candidate set by relevance — keeps the best matches, not the first the graph walk found", async () => {
    const chain = new Chain();
    const bm25 = new BM25({ k1: 1.2, b: 0.4 });
    // maxRetrievedNodes 1 → the post-expansion cap is 2, so after the seed only ONE slot
    // remains for expanded candidates — it must go to the most relevant, not the first found.
    const config = { retrievalThreshold: 0.5, maxRetrievedNodes: 1, linkDistance: 1 };
    const retrieval = new Retrieval(chain, bm25, null, null, null, null, null, config);

    // Sole strong direct match (short doc → highest BM25) — becomes the single seed.
    const seed = chain.append("user", "rate limiters");
    bm25.add(seed);

    // Two irrelevant neighbors, linked FIRST so the graph walk reaches them first.
    const early1 = chain.append("system", "weather patterns and cloud formations");
    bm25.add(early1);
    const early2 = chain.append("system", "cooking recipes for fresh pasta");
    bm25.add(early2);

    // A relevant neighbor (shares query terms, but longer doc → lower score than the seed),
    // linked LAST so the old first-found logic would have discarded it before reaching it.
    const lateRelevant = chain.append(
      "assistant",
      "rate limiters are commonly implemented with a sliding window algorithm in distributed systems"
    );
    bm25.add(lateRelevant);

    chain.link(seed.id, early1.id);
    chain.link(seed.id, early2.id);
    chain.link(seed.id, lateRelevant.id);

    const currentTurn = chain.append("user", "tell me about rate limiters");
    bm25.add(currentTurn);

    const { nodes } = await retrieval.retrieve("rate limiters", [currentTurn], currentTurn.id);
    const ids = nodes.map(n => n.id);

    assert.ok(ids.includes(lateRelevant.id), "relevant node must be kept even though the graph reached it last");
    assert.ok(
      !ids.includes(early1.id) && !ids.includes(early2.id),
      "irrelevant neighbors reached first must be dropped by relevance ranking"
    );
  });
});
