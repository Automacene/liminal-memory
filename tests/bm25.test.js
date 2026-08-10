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
  test("rarer terms count for more within a query", () => {
    const index = new BM25();
    index.add("hasRare", ["rare", "filler"]);
    index.add("hasCommon", ["common", "filler"]);
    for (let i = 0; i < 20; i++) index.add(`n${i}`, ["common"]);

    const hits = index.search(["rare", "common"]);

    assert.equal(hits[0].id, "hasRare", "matching the rare term carries more of the query");
    assert.ok(hits[0].score > hits[1].score);
  });

  test("a single term query cannot rank by rarity, because idf cancels", () => {
    // Every returned document contains the one term, so its idf is identical for all of them and
    // divides straight back out. What is left is term frequency and length. This is the tradeoff
    // calibration makes: scores become comparable across queries, and stop encoding how rare the
    // query happened to be.
    const index = new BM25();
    index.add("rareDoc", ["rare"]);
    for (let i = 0; i < 20; i++) index.add(`n${i}`, ["common"]);

    const rare = index.search(["rare"])[0].score;
    const common = index.search(["common"])[0].score;

    assert.equal(rare.toFixed(6), common.toFixed(6));
  });

  test("scores stay inside 0 and 1 however lopsided the corpus", () => {
    const index = new BM25();
    index.add("a", Array(500).fill("repeated"));
    index.add("b", ["repeated"]);
    for (let i = 0; i < 200; i++) index.add(`n${i}`, ["other"]);

    for (const hit of index.search(["repeated", "other"], 50)) {
      assert.ok(hit.score > 0 && hit.score < 1, `${hit.id} scored ${hit.score}`);
    }
  });

  test("calibration is monotonic, so it never reorders anything", () => {
    const index = new BM25();
    let previous = -1;

    for (const ratio of [0, 0.1, 0.3, 0.5, 0.8, 1, 1.5, 3]) {
      const score = index.calibrate(ratio);
      assert.ok(score > previous, `${ratio} should score above the ratio below it`);
      assert.ok(score > 0 && score < 1);
      previous = score;
    }
  });

  test("inflection and slope are tunable", () => {
    const lenient = new BM25({ inflection: 0.2 });
    const strict = new BM25({ inflection: 0.8 });

    assert.ok(lenient.calibrate(0.4) > strict.calibrate(0.4), "a lower inflection scores higher");

    const sharp = new BM25({ slope: 20 });
    const soft = new BM25({ slope: 2 });

    assert.ok(sharp.calibrate(0.9) > soft.calibrate(0.9), "a steeper slope is more decisive");
    assert.ok(sharp.calibrate(0.1) < soft.calibrate(0.1));
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

describe("turning calibration off", () => {
  const build = options => {
    const index = new BM25(options);
    index.add("strong", ["quarterly", "revenue", "report"]);
    index.add("weak", ["report", "lunch"]);
    index.add("other", ["nothing", "related"]);
    return index;
  };

  test("score becomes the plain unbounded BM25 figure", () => {
    const hits = build({ calibrated: false }).search(["quarterly", "revenue", "report"]);

    for (const hit of hits) assert.equal(hit.score, hit.raw);
    assert.ok(hits[0].score > 1, "unbounded, so it is free to exceed 1");
  });

  test("the calibrated index reports the same raw numbers underneath", () => {
    const query = ["quarterly", "revenue", "report"];

    const plain = build({ calibrated: false }).search(query);
    const curved = build().search(query);

    assert.deepEqual(curved.map(h => h.raw), plain.map(h => h.raw));
    assert.notEqual(curved[0].score, plain[0].score);
  });

  test("ordering is identical either way, because the curve is monotonic", () => {
    const query = ["quarterly", "revenue", "report", "lunch"];

    assert.deepEqual(
      build().search(query).map(h => h.id),
      build({ calibrated: false }).search(query).map(h => h.id)
    );
  });
});
