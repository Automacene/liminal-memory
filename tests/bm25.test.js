import { describe, it } from "node:test";
import assert from "node:assert";
import { BM25, tokenize } from "../src/search/bm25.js";

describe("BM25", () => {
  it("tokenizes to lowercase, punctuation-stripped, stemmed terms", () => {
    // tokenize now also stems, so the index matches queries (which are stemmed too).
    const tokens = tokenize("Running Indexes, Quickly!");
    assert.deepStrictEqual(tokens, ["run", "index", "quickly"]);
  });

  it("indexes and searches nodes", () => {
    const bm25 = new BM25({ k1: 1.2, b: 0.4 });

    bm25.add({ id: 1, content: "bloom filters are probabilistic data structures" });
    bm25.add({ id: 2, content: "BM25 is a ranking function for text retrieval" });
    bm25.add({ id: 3, content: "the quick brown fox jumps over the lazy dog" });

    const results = bm25.search("bloom filter");
    assert.strictEqual(results[0].nodeId, 1);
    assert.ok(results[0].score > 0);
  });

  it("returns empty results for no matches", () => {
    const bm25 = new BM25();
    bm25.add({ id: 1, content: "hello world" });

    const results = bm25.search("nonexistent term xyz");
    assert.strictEqual(results.length, 0);
  });

  it("removes nodes from index", () => {
    const bm25 = new BM25();
    bm25.add({ id: 1, content: "bloom filters work well" });
    bm25.add({ id: 2, content: "other stuff entirely" });

    bm25.remove(1);

    const results = bm25.search("bloom filters");
    assert.strictEqual(results.length, 0);
  });

  it("returns best score", () => {
    const bm25 = new BM25();
    bm25.add({ id: 1, content: "javascript programming language" });
    bm25.add({ id: 2, content: "python programming language" });

    const score = bm25.bestScore("javascript");
    assert.ok(score > 0);
  });

  it("rebuilds index from node array", () => {
    const bm25 = new BM25();
    const nodes = [
      { id: 1, role: "user", content: "hello world" },
      { id: 2, role: "assistant", content: "hi there" },
      { id: 3, role: "compaction", content: "" } // should be skipped
    ];

    bm25.rebuild(nodes);
    assert.strictEqual(bm25.docCount, 2);
  });

  it("exports and imports state", () => {
    const bm25 = new BM25();
    bm25.add({ id: 1, content: "test content here" });

    const exported = bm25.export();
    const bm25b = new BM25();
    bm25b.import(exported);

    const results = bm25b.search("test");
    assert.strictEqual(results[0].nodeId, 1);
  });
});
