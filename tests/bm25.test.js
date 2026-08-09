import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BM25 } from "../src/search/bm25.js";

describe("indexing", () => {
  test("ranks documents that share query terms, best first", () => {
    const index = new BM25();
    index.add("a", ["report", "desk", "report"]);
    index.add("b", ["report", "kitchen"]);
    index.add("c", ["banana"]);

    const hits = index.search(["report"]);

    assert.deepEqual(hits.map(h => h.id), ["a", "b"]);
    assert.ok(hits[0].score > hits[1].score, "two mentions should outrank one");
  });

  test("re-adding an id replaces the old terms rather than stacking them", () => {
    const index = new BM25();
    index.add("a", ["alpha"]);
    index.add("a", ["beta"]);

    assert.equal(index.size, 1);
    assert.deepEqual(index.search(["alpha"]), []);
    assert.deepEqual(index.search(["beta"]).map(h => h.id), ["a"]);
  });

  test("removal takes the document out of every posting list it was in", () => {
    const index = new BM25();
    index.add("a", ["alpha", "beta"]);
    index.add("b", ["alpha"]);

    assert.equal(index.remove("a"), true);
    assert.equal(index.remove("a"), false, "removing twice is not an error");
    assert.deepEqual(index.search(["alpha"]).map(h => h.id), ["b"]);
    assert.deepEqual(index.search(["beta"]), []);
  });

  test("removal restores the index to exactly its earlier state", () => {
    const index = new BM25();
    index.add("a", ["alpha", "beta"]);
    const before = index.search(["alpha"]);

    index.add("temp", ["alpha", "gamma"]);
    index.remove("temp");

    assert.deepEqual(index.search(["alpha"]), before,
      "scores must not drift after a node comes and goes");
  });

  test("empty terms index nothing and match nothing", () => {
    const index = new BM25();
    index.add("a", []);
    index.add("b", null);

    assert.equal(index.size, 0);
    assert.deepEqual(index.search(["anything"]), []);
  });

  test("searching an empty index is not an error", () => {
    assert.deepEqual(new BM25().search(["alpha"]), []);
  });
});

describe("determinism", () => {
  test("equal scores break on id, not on insertion order", () => {
    const forwards = new BM25();
    forwards.add("zebra", ["alpha"]);
    forwards.add("apple", ["alpha"]);

    const backwards = new BM25();
    backwards.add("apple", ["alpha"]);
    backwards.add("zebra", ["alpha"]);

    assert.deepEqual(forwards.search(["alpha"]).map(h => h.id), ["apple", "zebra"]);
    assert.deepEqual(backwards.search(["alpha"]).map(h => h.id), ["apple", "zebra"]);
  });

  test("the same terms give the same ranking every time", () => {
    const index = new BM25();
    for (let i = 0; i < 50; i++) index.add(`n${i}`, ["shared", `unique${i % 7}`]);

    const first = index.search(["shared", "unique3"], 10);
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(index.search(["shared", "unique3"], 10), first);
    }
  });

  test("a node removed and re-added ranks exactly where it did before", () => {
    const index = new BM25();
    index.add("a", ["shared"]);
    index.add("b", ["shared"]);
    index.add("c", ["shared"]);
    const before = index.search(["shared"]);

    index.remove("b");
    index.add("b", ["shared"]);

    assert.deepEqual(index.search(["shared"]), before);
  });
});

describe("scoring", () => {
  test("rarer terms count for more than common ones", () => {
    const index = new BM25();
    index.add("a", ["common", "rare"]);
    for (let i = 0; i < 20; i++) index.add(`filler${i}`, ["common"]);

    const rare = index.search(["rare"])[0].score;
    const common = index.search(["common"])[0].score;

    assert.ok(rare > common, "a term in one document must outweigh one in twenty-one");
  });

  test("limit caps the results", () => {
    const index = new BM25();
    for (let i = 0; i < 10; i++) index.add(`n${i}`, ["shared"]);

    assert.equal(index.search(["shared"], 3).length, 3);
  });

  test("length tracking survives add, replace, and remove", () => {
    const index = new BM25();
    index.add("a", ["one", "two", "three"]);
    assert.equal(index.length("a"), 3);

    index.add("a", ["one"]);
    assert.equal(index.length("a"), 1);

    index.remove("a");
    assert.equal(index.length("a"), 0);
  });
});
