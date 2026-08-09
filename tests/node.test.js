import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createNode, patchNode } from "../src/node.js";

describe("node specification", () => {
  test("fills the three open buckets so callers never have to guard", () => {
    const node = createNode({ id: "n1", pool: "main", content: "hello", at: 1000 });

    assert.deepEqual(node.tags, {});
    assert.deepEqual(node.graph, {});
    assert.equal(node.content, "hello");
    assert.equal(node.pool, "main");
  });

  test("content can be any type, including null", () => {
    const asObject = createNode({
      id: "n1", pool: "main", at: 1, content: { user: "hi", assistant: "hey" }
    });
    assert.deepEqual(asObject.content, { user: "hi", assistant: "hey" });

    const asNull = createNode({ id: "n2", pool: "main", content: null, at: 1 });
    assert.equal(asNull.content, null);
  });

  test("missing content throws, because an absent bucket is a mistake and an empty one is not", () => {
    assert.throws(
      () => createNode({ id: "n1", pool: "main", at: 1 }),
      /content is required/
    );
  });

  test("timestamps come from the caller's clock, not the wall clock", () => {
    const node = createNode({ id: "n1", pool: "main", content: "x", at: 42 });
    assert.equal(node.metadata.createdAt, 42);
    assert.equal(node.metadata.updatedAt, 42);
  });

  test("caller metadata sits alongside ours", () => {
    const node = createNode({
      id: "n1", pool: "main", content: "x", at: 1, metadata: { source: "pdf", page: 3 }
    });
    assert.equal(node.metadata.source, "pdf");
    assert.equal(node.metadata.page, 3);
    assert.equal(node.metadata.createdAt, 1);
  });

  test("both open buckets stay empty, so no algorithm's layout is stamped on every node", () => {
    const node = createNode({ id: "n1", pool: "main", content: "x", at: 1 });
    assert.deepEqual(node.tags, {});
    assert.deepEqual(node.graph, {});
  });

  test("a caller-supplied graph layout is kept as given", () => {
    const node = createNode({
      id: "n1", pool: "main", content: "x", at: 1, graph: { adjacency: { a: 0.5 } }
    });
    assert.deepEqual(node.graph, { adjacency: { a: 0.5 } });
  });
});

describe("patching a node", () => {
  const base = () => createNode({
    id: "n1", pool: "main", content: "first", at: 100,
    tags: { keywords: ["alpha", "beta"] },
    metadata: { source: "chat" }
  });

  test("named buckets are replaced wholesale, not merged", () => {
    const next = patchNode(base(), { tags: { keywords: ["gamma"] } }, 200);
    assert.deepEqual(next.tags, { keywords: ["gamma"] });
  });

  test("metadata merges, so createdAt and caller fields survive", () => {
    const next = patchNode(base(), { metadata: { page: 7 } }, 200);

    assert.equal(next.metadata.createdAt, 100);
    assert.equal(next.metadata.source, "chat");
    assert.equal(next.metadata.page, 7);
    assert.equal(next.metadata.updatedAt, 200);
  });

  test("untouched buckets are left exactly as they were", () => {
    const next = patchNode(base(), { content: "second" }, 200);
    assert.equal(next.content, "second");
    assert.deepEqual(next.tags, { keywords: ["alpha", "beta"] });
  });

  test("identity is fixed for a node's lifetime", () => {
    const next = patchNode(base(), { id: "other", pool: "elsewhere" }, 200);
    assert.equal(next.id, "n1");
    assert.equal(next.pool, "main");
  });

  test("the original node is not mutated", () => {
    const original = base();
    patchNode(original, { content: "second" }, 200);
    assert.equal(original.content, "first");
    assert.equal(original.metadata.updatedAt, 100);
  });
});
