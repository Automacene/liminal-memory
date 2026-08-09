import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LiminalMemory } from "../src/index.js";

describe("pools", () => {
  test("a default pool exists from the start", () => {
    const mem = new LiminalMemory();
    assert.deepEqual(mem.pools(), ["main"]);
  });

  test("naming a pool creates it, and asking again returns the same one", () => {
    const mem = new LiminalMemory();
    const first = mem.pool("docs");
    const second = mem.pool("docs");

    assert.equal(first, second);
    assert.deepEqual(mem.pools().sort(), ["docs", "main"]);
  });

  test("pools inherit the container's clock and eviction hook", async () => {
    const evicted = [];
    const mem = new LiminalMemory({ now: () => 7, onEvict: nodes => evicted.push(...nodes) });

    const node = await mem.pool("docs").create({ content: "x" });
    assert.equal(node.metadata.createdAt, 7);

    await mem.pool("docs").evict([node.id]);
    assert.equal(evicted.length, 1);
  });

  test("the default pool cannot be dropped", () => {
    const mem = new LiminalMemory();
    assert.throws(() => mem.dropPool("main"), /cannot be dropped/);
  });

  test("dropping a pool takes its nodes with it", async () => {
    const mem = new LiminalMemory();
    await mem.pool("scratch").create({ id: "a", content: 1 });

    assert.equal(mem.dropPool("scratch"), true);
    assert.equal(mem.get("a"), undefined);
    assert.equal(mem.hasPool("scratch"), false);
  });
});

describe("one id space across pools", () => {
  test("a node is findable from the container wherever it lives", async () => {
    const mem = new LiminalMemory();
    await mem.pool("docs").create({ id: "doc-1", content: "a document" });
    await mem.pool("chat").create({ id: "turn-1", content: "a turn" });

    assert.equal(mem.get("doc-1").pool, "docs");
    assert.equal(mem.get("turn-1").pool, "chat");
    assert.equal(mem.has("doc-1"), true);
    assert.equal(mem.get("nope"), undefined);
  });

  test("generated ids carry the pool that made them", async () => {
    const mem = new LiminalMemory();
    const doc = await mem.pool("docs").create({ content: "x" });
    const turn = await mem.pool("chat").create({ content: "y" });

    assert.ok(doc.id.startsWith("docs-"));
    assert.ok(turn.id.startsWith("chat-"));
  });

  test("size counts every pool", async () => {
    const mem = new LiminalMemory();
    await mem.pool("docs").create({ content: 1 });
    await mem.pool("chat").createMany([{ content: 2 }, { content: 3 }]);

    assert.equal(mem.size, 3);
  });
});

describe("shorthand", () => {
  test("create and list act on the default pool", async () => {
    const mem = new LiminalMemory();
    const node = await mem.create({ content: "hello" });

    assert.equal(node.pool, "main");
    assert.deepEqual(mem.list(), [node]);
    assert.equal(mem.pool("main").size, 1);
  });

  test("the default pool can be named something else", async () => {
    const mem = new LiminalMemory({ defaultPool: "conversation" });
    const node = await mem.create({ content: "hello" });

    assert.equal(node.pool, "conversation");
    assert.ok(node.id.startsWith("conversation-"));
  });
});

describe("serialization", () => {
  test("a snapshot round-trips every pool unchanged", async () => {
    const mem = new LiminalMemory({ defaultPool: "chat", now: () => 5 });
    await mem.create({ id: "t1", content: { user: "hi", assistant: "hey" } });
    await mem.pool("docs").create({ id: "d1", content: "a doc", tags: { keywords: ["x"] } });

    const snapshot = JSON.parse(JSON.stringify(mem));
    const restored = new LiminalMemory().load(snapshot);

    assert.equal(restored.defaultPoolName, "chat");
    assert.deepEqual(restored.pools().sort(), ["chat", "docs"]);
    assert.deepEqual(restored.get("t1"), mem.get("t1"));
    assert.deepEqual(restored.get("d1"), mem.get("d1"));
  });

  test("loading an empty snapshot still leaves a usable default pool", async () => {
    const mem = new LiminalMemory().load({});
    const node = await mem.create({ content: "x" });
    assert.equal(node.pool, "main");
  });
});
