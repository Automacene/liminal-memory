import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "../src/pool.js";

/** A pool with a clock that ticks one unit per read, so timestamps are exact and ordered. */
function testPool(name = "main", options = {}) {
  let t = 0;
  return new Pool(name, { now: () => ++t, ...options });
}

describe("creating nodes", () => {
  test("generates a prefixed id and returns the stored node", async () => {
    const pool = testPool("conversation");
    const node = await pool.create({ content: "hello" });

    assert.match(node.id, /^conversation-[0-9a-f-]{36}$/);
    assert.equal(node.pool, "conversation");
    assert.equal(pool.get(node.id), node);
  });

  test("a supplied id is used verbatim, with no pool prefix", async () => {
    const pool = testPool();
    const node = await pool.create({ id: "system-prompt", content: "you are..." });

    assert.equal(node.id, "system-prompt");
    assert.equal(pool.get("system-prompt").content, "you are...");
  });

  test("reusing an id throws rather than overwriting", async () => {
    const pool = testPool();
    await pool.create({ id: "dup", content: "first" });

    await assert.rejects(
      () => pool.create({ id: "dup", content: "second" }),
      /already exists/
    );
    assert.equal(pool.get("dup").content, "first");
  });

  test("ids are unique across many creates", async () => {
    const pool = testPool();
    for (let i = 0; i < 500; i++) await pool.create({ content: i });
    assert.equal(new Set(pool.ids()).size, 500);
  });

  test("a batch either lands completely or not at all", async () => {
    const pool = testPool();
    await pool.create({ id: "taken", content: "original" });

    await assert.rejects(
      () => pool.createMany([{ content: "a" }, { id: "taken", content: "b" }]),
      /already exists/
    );
    assert.equal(pool.size, 1);
  });
});

describe("reading", () => {
  test("list and ids come back oldest first", async () => {
    const pool = testPool();
    await pool.create({ id: "a", content: 1 });
    await pool.create({ id: "b", content: 2 });
    await pool.create({ id: "c", content: 3 });

    assert.deepEqual(pool.ids(), ["a", "b", "c"]);
    assert.deepEqual(pool.list().map(n => n.content), [1, 2, 3]);
  });

  test("missing nodes read as undefined, not an error", () => {
    const pool = testPool();
    assert.equal(pool.get("nope"), undefined);
    assert.equal(pool.has("nope"), false);
  });
});

describe("updating", () => {
  test("stores the patched node and stamps updatedAt from the clock", async () => {
    const pool = testPool();
    const created = await pool.create({ id: "a", content: "first" });
    const updated = await pool.update("a", { content: "second" });

    assert.equal(pool.get("a").content, "second");
    assert.ok(updated.metadata.updatedAt > created.metadata.createdAt);
  });

  test("updating an absent node throws", async () => {
    const pool = testPool();
    await assert.rejects(() => pool.update("ghost", { content: "x" }), /no node "ghost"/);
  });
});

describe("eviction", () => {
  test("hands nodes to the hook before dropping them", async () => {
    const seen = [];
    const pool = testPool("main", { onEvict: nodes => seen.push(...nodes.map(n => n.id)) });

    await pool.create({ id: "a", content: 1 });
    await pool.create({ id: "b", content: 2 });
    const gone = await pool.evict(["a"]);

    assert.deepEqual(seen, ["a"]);
    assert.deepEqual(gone.map(n => n.id), ["a"]);
    assert.equal(pool.has("a"), false);
    assert.equal(pool.has("b"), true);
  });

  test("waits for an async hook to finish before dropping", async () => {
    const persisted = [];
    const pool = testPool("main", {
      onEvict: async nodes => {
        await new Promise(r => setTimeout(r, 5));
        persisted.push(...nodes.map(n => n.id));
      }
    });

    await pool.create({ id: "a", content: 1 });
    await pool.evict(["a"]);

    assert.deepEqual(persisted, ["a"], "hook completed before eviction returned");
    assert.equal(pool.size, 0);
  });

  test("accepts a predicate as well as a list of ids", async () => {
    const pool = testPool();
    await pool.create({ id: "keep", content: "short" });
    await pool.create({ id: "drop", content: "a much longer piece of content" });

    await pool.evict(node => node.content.length > 10);

    assert.deepEqual(pool.ids(), ["keep"]);
  });

  test("evictOldest takes from the front", async () => {
    const pool = testPool();
    for (const id of ["a", "b", "c", "d"]) await pool.create({ id, content: id });

    const gone = await pool.evictOldest(2);

    assert.deepEqual(gone.map(n => n.id), ["a", "b"]);
    assert.deepEqual(pool.ids(), ["c", "d"]);
  });

  test("evicting nothing skips the hook entirely", async () => {
    let called = 0;
    const pool = testPool("main", { onEvict: () => called++ });

    await pool.evict([]);
    await pool.evict(["missing"]);
    await pool.evictOldest(0);

    assert.equal(called, 0);
  });

  test("remove forgets without telling the hook", async () => {
    let called = 0;
    const pool = testPool("main", { onEvict: () => called++ });
    await pool.create({ id: "a", content: 1 });

    assert.equal(pool.remove("a"), true);
    assert.equal(pool.remove("a"), false);
    assert.equal(called, 0);
  });
});

describe("serialization", () => {
  test("a snapshot round-trips ids, content, and timestamps unchanged", async () => {
    const pool = testPool("docs");
    await pool.create({ id: "a", content: "alpha", tags: { keywords: ["x"] } });
    await pool.create({ id: "b", content: "beta" });

    const snapshot = JSON.parse(JSON.stringify(pool));
    const restored = new Pool("docs").load(snapshot);

    assert.deepEqual(restored.list(), pool.list());
  });
});

describe("scores and thresholds", () => {
  test("scores land between 0 and 1", async () => {
    const pool = testPool();
    await pool.create({ id: "strong", content: "the quarterly revenue report" });
    await pool.create({ id: "weak", content: "the report was fine" });
    await pool.create({ id: "other", content: "lunch with sam" });

    for (const hit of await pool.rank("quarterly revenue report")) {
      assert.ok(hit.score > 0 && hit.score < 1, `${hit.node.id} scored ${hit.score}`);
    }
  });

  test("a closer match scores higher", async () => {
    const pool = testPool();
    await pool.create({ id: "strong", content: "the quarterly revenue report" });
    await pool.create({ id: "weak", content: "a report about lunch" });

    const hits = await pool.rank("quarterly revenue report");

    assert.equal(hits[0].node.id, "strong");
    assert.ok(hits[0].score > hits[1].score);
  });

  test("minScore drops the weak tail", async () => {
    const pool = testPool();
    await pool.create({ id: "strong", content: "the quarterly revenue report" });
    await pool.create({ id: "weak", content: "a report about lunch" });

    const all = await pool.rank("quarterly revenue report");
    assert.equal(all.length, 2, "both match something");

    const cut = (all[0].score + all[1].score) / 2;
    const filtered = await pool.rank("quarterly revenue report", { minScore: cut });

    assert.deepEqual(filtered.map(hit => hit.node.id), ["strong"]);
  });

  test("the raw unbounded score is still available", async () => {
    const pool = testPool();
    await pool.create({ id: "a", content: "the quarterly report" });

    const [hit] = await pool.rank("report");
    assert.equal(typeof hit.raw, "number");
    assert.notEqual(hit.raw, hit.score);
  });

  test("a threshold means the same thing for a short and a long query", async () => {
    // The point of calibrating at all. Both queries fully describe their target, so both should
    // clear the same threshold, even though the raw scores differ by a lot.
    const pool = testPool();
    await pool.create({ id: "a", content: "alpha" });
    await pool.create({ id: "b", content: "beta gamma delta epsilon zeta" });
    await pool.create({ id: "c", content: "nothing in common here" });

    const short = await pool.rank("alpha", { minScore: 0.5 });
    const long = await pool.rank("beta gamma delta epsilon zeta", { minScore: 0.5 });

    assert.deepEqual(short.map(h => h.node.id), ["a"]);
    assert.deepEqual(long.map(h => h.node.id), ["b"]);
    assert.ok(long[0].raw > short[0].raw * 2, "raw scores are on very different scales");
  });
});
