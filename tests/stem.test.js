import { describe, it } from "node:test";
import assert from "node:assert";
import { stem } from "../src/search/stem.js";
import { BM25 } from "../src/search/bm25.js";
import { Chain } from "../src/core/chain.js";

describe("stem — conservative stemmer", () => {
  it("collapses common inflections to a shared stem", () => {
    for (const w of ["index", "indexing", "indexed"]) assert.strictEqual(stem(w), "index", w);
    for (const w of ["split", "splits", "splitting"]) assert.strictEqual(stem(w), "split", w);
    for (const w of ["match", "matches", "matching"]) assert.strictEqual(stem(w), "match", w);
    for (const w of ["map", "maps", "mapped", "mapping"]) assert.strictEqual(stem(w), "map", w);
    for (const w of ["category", "categories"]) assert.strictEqual(stem(w), "category", w);
    for (const w of ["query", "queries"]) assert.strictEqual(stem(w), "query", w);
  });

  it("is idempotent — stemming an already-stemmed term is a no-op", () => {
    for (const w of ["indexing", "matches", "categories", "running"]) {
      assert.strictEqual(stem(stem(w)), stem(w), w);
    }
  });

  it("does NOT over-stem — unrelated words stay distinct (the whole point of going gentle)", () => {
    // The classic false-merge an aggressive stemmer makes; we must NOT make it.
    assert.notStrictEqual(stem("universe"), stem("university"));
    // Words ending in 'ss' are left intact (not treated as a plural).
    assert.strictEqual(stem("class"), "class");
    assert.strictEqual(stem("process"), "process");
    assert.strictEqual(stem("access"), "access");
    // Short tokens are never touched (idf, api, sql, bm25…).
    for (const w of ["idf", "api", "sql", "bm25"]) assert.strictEqual(stem(w), w, w);
  });
});

describe("stem — end-to-end matching", () => {
  it("BM25 recalls a node written with a different word ending than the query", () => {
    const bm25 = new BM25();
    // Node only ever says "indexed"; nothing says "indexing".
    bm25.add({ id: 1, content: "the storage layer indexed every archived block" });
    bm25.add({ id: 2, content: "completely unrelated content about weather and cooking" });

    // Query uses "indexing" — pre-stemming this would miss node 1 entirely.
    const results = bm25.search("how does indexing work", 5);
    assert.ok(results.some(r => r.nodeId === 1), "query 'indexing' should recall the 'indexed' node");
    assert.ok(!results.some(r => r.nodeId === 2), "unrelated node should not match");
  });

  it("Chain stores stemmed keywords so variant phrasings converge", () => {
    const chain = new Chain();
    const a = chain.append("user", "we are indexing the documents");
    const b = chain.append("assistant", "the documents were indexed");
    // Both nodes should carry the stem "index" even though they used different endings.
    assert.ok(a.keywords.includes("index"), "indexing → index");
    assert.ok(b.keywords.includes("index"), "indexed → index");
    // And "documents" collapses to the same stem in both.
    assert.strictEqual(stem("documents"), stem("document"));
  });
});
