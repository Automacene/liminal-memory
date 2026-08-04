import { describe, it } from "node:test";
import assert from "node:assert";
import { BM25 } from "../src/search/bm25.js";
import { BloomFilter } from "../src/search/bloom.js";
import { TfIdf } from "../src/search/tfidf.js";
import { Chain } from "../src/core/chain.js";

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
