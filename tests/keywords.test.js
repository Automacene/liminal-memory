import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractKeywords, flattenToText, keywordTagger } from "../src/tag/keywords.js";

describe("flattening content to text", () => {
  test("passes strings through", () => {
    assert.equal(flattenToText("hello world"), "hello world");
  });

  test("reads object values but never keys, so structure isn't indexed", () => {
    const text = flattenToText({ user: "where is the report", assistant: "on the desk" });

    assert.ok(text.includes("where is the report"));
    assert.ok(text.includes("on the desk"));
    assert.ok(!text.includes("user"), "the key 'user' must not become a searchable term");
    assert.ok(!text.includes("assistant"));
  });

  test("walks arrays and nesting", () => {
    assert.equal(flattenToText(["a", ["b", { c: "d" }]]), "a b d");
  });

  test("null and undefined flatten to nothing", () => {
    assert.equal(flattenToText(null), "");
    assert.equal(flattenToText(undefined), "");
  });
});

describe("extracting keywords", () => {
  test("lowercases, strips punctuation, and drops stopwords", () => {
    const terms = extractKeywords("The Report, which is on the desk!");

    assert.ok(terms.includes("report"));
    assert.ok(terms.includes("desk"));
    assert.ok(!terms.includes("the"));
    assert.ok(!terms.includes("which"));
  });

  test("drops tokens below the minimum length", () => {
    const terms = extractKeywords("a go sql api");

    assert.deepEqual(terms, ["sql", "api"]);
  });

  test("stems, so inflected forms collapse together", () => {
    assert.deepEqual(extractKeywords("indexing"), extractKeywords("indexed"));
  });

  test("deduplicates while keeping first-seen order", () => {
    assert.deepEqual(extractKeywords("report report desk report"), ["report", "desk"]);
  });

  test("empty input gives an empty list rather than throwing", () => {
    assert.deepEqual(extractKeywords(""), []);
    assert.deepEqual(extractKeywords(null), []);
  });

  test("options override the defaults", () => {
    const terms = extractKeywords("the cat sat", { stopwords: new Set(), minLength: 1 });
    assert.deepEqual(terms, ["the", "cat", "sat"]);
  });
});

describe("the default tagger", () => {
  test("node terms and query terms run through the same pipeline", () => {
    const tagger = keywordTagger();
    const tags = tagger.forNode({ content: "Indexing the conversation nodes" });

    assert.deepEqual(tagger.forQuery("indexed conversations"), ["index", "conversation"]);
    assert.ok(tags.keywords.includes("index"));
    assert.ok(tags.keywords.includes("conversation"),
      "a query term must be able to match the node term it was written differently from");
  });

  test("termsOf reads back what forNode wrote", () => {
    const tagger = keywordTagger();
    const tags = tagger.forNode({ content: "alpha beta" });

    assert.deepEqual(tagger.termsOf(tags), tags.keywords);
  });

  test("termsOf tolerates a tags bucket it did not write", () => {
    const tagger = keywordTagger();

    assert.deepEqual(tagger.termsOf({}), []);
    assert.deepEqual(tagger.termsOf(undefined), []);
  });
});
