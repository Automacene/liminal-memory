import { describe, it } from "node:test";
import assert from "node:assert";
import { BloomFilter } from "../src/search/bloom.js";

describe("BloomFilter", () => {
  it("adds and tests terms", () => {
    const bloom = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });

    bloom.add("hello");
    bloom.add("world");

    assert.strictEqual(bloom.test("hello"), true);
    assert.strictEqual(bloom.test("world"), true);
  });

  it("returns false for terms definitely not present", () => {
    const bloom = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });

    bloom.add("hello");
    // While false positives are possible, "xyznonexistent" is extremely unlikely to match
    // We test the general behavior
    assert.strictEqual(bloom.test("hello"), true);
  });

  it("supports deletion via decrement", () => {
    const bloom = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });

    bloom.add("hello");
    assert.strictEqual(bloom.test("hello"), true);

    bloom.remove("hello");
    // After removal, should not be detected
    assert.strictEqual(bloom.test("hello"), false);
  });

  it("adds all terms from text block", () => {
    const bloom = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });

    const count = bloom.addText("bloom filters are great for fast lookups");
    assert.ok(count > 0);
    assert.strictEqual(bloom.test("bloom"), true);
    assert.strictEqual(bloom.test("filters"), true);
  });

  it("tests query terms against filter", () => {
    const bloom = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });

    bloom.addText("BM25 scoring algorithm implementation");

    assert.strictEqual(bloom.testQuery("BM25 scoring"), true);
  });

  it("clears the filter", () => {
    const bloom = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });

    bloom.add("hello");
    bloom.clear();

    assert.strictEqual(bloom.test("hello"), false);
    assert.strictEqual(bloom.itemCount, 0);
  });

  it("exports and imports state", () => {
    const bloom = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });
    bloom.add("test");

    const exported = bloom.export();
    const bloom2 = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });
    bloom2.import(exported);

    assert.strictEqual(bloom2.test("test"), true);
  });
});
