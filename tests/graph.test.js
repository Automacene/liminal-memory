import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LiminalMemory, Pool, decayGraph } from "../src/index.js";

function testPool(name = "main", options = {}) {
  let t = 0;
  return new Pool(name, { now: () => ++t, ...options });
}

/** A clock the test drives by hand, so decay never depends on how long the test took. */
function clockPool(name = "main", options = {}) {
  const clock = { t: 1000 };
  const pool = new Pool(name, { now: () => clock.t, ...options });
  return { pool, clock };
}

describe("edges", () => {
  test("a link writes both directions", async () => {
    const pool = testPool();
    const a = await pool.create({ id: "a", content: "first" });
    const b = await pool.create({ id: "b", content: "second" });

    pool.link(a, b);

    assert.deepEqual(a.graph.to, [{ id: "b" }]);
    assert.deepEqual(b.graph.from, [{ id: "a" }]);
  });

  test("the graph bucket stays empty until an edge is actually written", async () => {
    const pool = testPool();
    const node = await pool.create({ content: "lonely" });

    assert.deepEqual(node.graph, {});
  });

  test("an edge with no time never decays", async () => {
    const { pool, clock } = clockPool("main", { graph: decayGraph({ decayMs: 10 }) });
    const a = await pool.create({ id: "a", content: "first" });
    const b = await pool.create({ id: "b", content: "second" });

    pool.link(a, b);
    clock.t += 1_000_000;

    assert.deepEqual(pool.neighbors("a").map(e => e.id), ["b"]);
  });

  test("linking the same pair twice refreshes rather than duplicating", async () => {
    const { pool, clock } = clockPool();
    const a = await pool.create({ id: "a", content: "first" });
    const b = await pool.create({ id: "b", content: "second" });

    pool.link(a, b, clock.t);
    clock.t += 50;
    pool.link(a, b, clock.t);

    assert.equal(a.graph.to.length, 1);
    assert.equal(a.graph.to[0].observedAt, clock.t);
  });

  test("reinforcing a permanent edge does not give it an expiry", async () => {
    const pool = testPool();
    const a = await pool.create({ id: "a", content: "first" });
    const b = await pool.create({ id: "b", content: "second" });

    pool.link(a, b);
    pool.link(a, b, 5000);

    assert.deepEqual(a.graph.to, [{ id: "b" }]);
  });

  test("a node cannot link to itself", async () => {
    const pool = testPool();
    const a = await pool.create({ id: "a", content: "first" });

    pool.link(a, a);

    assert.deepEqual(a.graph, {});
  });

  test("linking a missing node reports failure instead of throwing", async () => {
    const pool = testPool();
    await pool.create({ id: "a", content: "first" });

    assert.equal(pool.link("a", "ghost"), false);
    assert.equal(pool.link("ghost", "a"), false);
  });
});

describe("decay", () => {
  test("edges outlive the decay window only if reinforced", async () => {
    const { pool, clock } = clockPool("main", { graph: decayGraph({ decayMs: 100 }) });
    const a = await pool.create({ id: "a", content: "first" });
    const b = await pool.create({ id: "b", content: "second" });

    pool.link(a, b, clock.t);

    clock.t += 50;
    assert.equal(pool.neighbors("a").length, 1, "still inside the window");

    clock.t += 100;
    assert.equal(pool.neighbors("a").length, 0, "past the window with no reinforcement");
  });

  test("decay is off by default, however long you wait", async () => {
    const { pool, clock } = clockPool();
    const a = await pool.create({ id: "a", content: "first" });
    const b = await pool.create({ id: "b", content: "second" });

    pool.link(a, b, clock.t);
    clock.t += 10_000_000;

    assert.equal(pool.neighbors("a").length, 1);
  });

  test("decay reads the injected clock, so the same steps always give the same edges", async () => {
    const build = async () => {
      const { pool, clock } = clockPool("main", { graph: decayGraph({ decayMs: 100 }) });
      const a = await pool.create({ id: "a", content: "first" });
      const b = await pool.create({ id: "b", content: "second" });
      pool.link(a, b, clock.t);
      clock.t += 150;
      return pool.neighbors("a");
    };

    assert.deepEqual(await build(), await build());
  });
});

describe("edges written by search", () => {
  test("recalled nodes are linked back to the node that asked", async () => {
    const pool = testPool();
    const asked = await pool.create({ id: "asker", content: "do you remember the report" });
    await pool.create({ id: "old", content: "the quarterly report was late" });

    const hits = await pool.search("report", { from: asked });

    assert.deepEqual(hits.map(n => n.id), ["old"]);
    assert.deepEqual(asked.graph.to.map(e => e.id), ["old"]);
    assert.deepEqual(pool.get("old").graph.from.map(e => e.id), ["asker"]);
  });

  test("search-written edges carry a time, so they can decay", async () => {
    const { pool, clock } = clockPool();
    const asked = await pool.create({ id: "asker", content: "the report" });
    await pool.create({ id: "old", content: "report details" });

    await pool.search("report", { from: asked });

    assert.equal(asked.graph.to[0].observedAt, clock.t);
  });

  test("no asker means no edges", async () => {
    const pool = testPool();
    await pool.create({ id: "old", content: "the quarterly report" });

    await pool.search("report");

    assert.deepEqual(pool.get("old").graph, {});
  });

  test("linking can be turned off for one call", async () => {
    const pool = testPool();
    const asked = await pool.create({ id: "asker", content: "the report" });
    await pool.create({ id: "old", content: "report details" });

    await pool.search("report", { from: asked, link: false });

    assert.deepEqual(asked.graph, {});
  });

  test("repeated recall keeps an edge alive that would otherwise decay", async () => {
    const { pool, clock } = clockPool("main", { graph: decayGraph({ decayMs: 100 }) });
    const asked = await pool.create({ id: "asker", content: "the report" });
    await pool.create({ id: "old", content: "report details" });

    for (let i = 0; i < 5; i++) {
      await pool.search("report", { from: asked });
      clock.t += 80;
    }

    assert.equal(pool.neighbors("asker").length, 1, "reinforced faster than it decayed");

    clock.t += 500;
    assert.equal(pool.neighbors("asker").length, 0, "and gone once recall stops");
  });

  test("an asker given by id resolves inside the pool", async () => {
    const pool = testPool();
    await pool.create({ id: "asker", content: "the report" });
    await pool.create({ id: "old", content: "report details" });

    await pool.search("report", { from: "asker" });

    assert.deepEqual(pool.get("asker").graph.to.map(e => e.id), ["old"]);
  });
});

describe("the graph never changes the ranking", () => {
  test("search results are identical with and without edges", async () => {
    const build = async () => {
      const pool = testPool();
      await pool.create({ id: "asker", content: "report" });
      await pool.create({ id: "a", content: "the quarterly report on revenue" });
      await pool.create({ id: "b", content: "a report about lunch" });
      return pool;
    };

    const plain = await build();
    const linked = await build();

    for (let i = 0; i < 3; i++) await linked.search("report", { from: "asker" });

    assert.deepEqual(
      (await plain.search("report revenue")).map(n => n.id),
      (await linked.search("report revenue")).map(n => n.id)
    );
  });

  test("a heavily linked node does not outrank a better text match", async () => {
    const pool = testPool();
    await pool.create({ id: "asker", content: "revenue" });
    await pool.create({ id: "popular", content: "revenue" });
    await pool.create({ id: "better", content: "revenue revenue quarterly revenue report" });

    for (let i = 0; i < 10; i++) await pool.search("revenue", { from: "asker" });

    const ranked = await pool.rank("quarterly revenue report", { link: false });
    assert.equal(ranked[0].node.id, "better");
  });
});

describe("edges across pools", () => {
  test("the container links nodes living in different pools", async () => {
    const mem = new LiminalMemory();
    const turn = await mem.pool("chat").create({ id: "t1", content: "about the report" });
    const doc = await mem.pool("docs").create({ id: "d1", content: "report template" });

    assert.equal(mem.link(turn, doc), true);

    assert.deepEqual(mem.neighbors("t1").map(e => e.id), ["d1"]);
    assert.deepEqual(mem.neighbors("d1").map(e => e.id), ["t1"]);
  });

  test("an asker in one pool can be linked from a search of another", async () => {
    const mem = new LiminalMemory({ defaultPool: "docs" });
    await mem.pool("chat").create({ id: "t1", content: "do you remember the report" });
    await mem.pool("docs").create({ id: "d1", content: "the quarterly report" });

    const hits = await mem.search("report", { from: "t1" });

    assert.deepEqual(hits.map(n => n.id), ["d1"]);
    assert.deepEqual(mem.neighbors("t1").map(e => e.id), ["d1"]);
  });

  test("linking a missing node reports failure", async () => {
    const mem = new LiminalMemory();
    await mem.create({ id: "a", content: "x" });

    assert.equal(mem.link("a", "ghost"), false);
    assert.deepEqual(mem.neighbors("ghost"), []);
  });
});

describe("bringing your own graph", () => {
  test("a custom algorithm replaces edge handling completely", async () => {
    const calls = [];
    const counting = {
      link: (from, to) => { calls.push(`${from.id}->${to.id}`); },
      sweep: () => false,
      neighbors: () => [{ id: "made-up", direction: "to" }]
    };

    const pool = testPool("main", { graph: counting });
    await pool.create({ id: "asker", content: "report" });
    await pool.create({ id: "old", content: "report details" });

    await pool.search("report", { from: "asker" });

    assert.deepEqual(calls, ["asker->old"]);
    assert.deepEqual(pool.neighbors("asker"), [{ id: "made-up", direction: "to" }]);
  });
});

describe("serialization", () => {
  test("edges survive a snapshot round trip", async () => {
    const pool = testPool("docs");
    const a = await pool.create({ id: "a", content: "first" });
    const b = await pool.create({ id: "b", content: "second" });
    pool.link(a, b, 500);

    const restored = new Pool("docs").load(JSON.parse(JSON.stringify(pool)));

    assert.deepEqual(restored.get("a").graph.to, [{ id: "b", observedAt: 500 }]);
    assert.deepEqual(restored.get("b").graph.from, [{ id: "a", observedAt: 500 }]);
  });
});

describe("the asker is not its own memory", () => {
  test("a node asking a question does not recall itself", async () => {
    const pool = testPool();
    await pool.create({ id: "asker", content: "do you remember the quarterly report" });
    await pool.create({ id: "old", content: "the quarterly report was late" });

    const hits = await pool.search("quarterly report", { from: "asker" });

    assert.deepEqual(hits.map(n => n.id), ["old"]);
  });

  test("the limit still returns a full page once the asker is filtered out", async () => {
    const pool = testPool();
    await pool.create({ id: "asker", content: "report" });
    for (let i = 0; i < 5; i++) await pool.create({ id: `n${i}`, content: `report ${i}` });

    assert.equal((await pool.search("report", { from: "asker", limit: 3 })).length, 3);
  });

  test("no self-edge is written even with a graph that has no guard of its own", async () => {
    const links = [];
    const pool = testPool("main", {
      graph: { link: (a, b) => links.push(`${a.id}->${b.id}`), sweep: () => false, neighbors: () => [] }
    });
    await pool.create({ id: "asker", content: "report" });
    await pool.create({ id: "old", content: "report details" });

    await pool.search("report", { from: "asker" });

    assert.deepEqual(links, ["asker->old"]);
  });
});
