import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LiminalMemory, Pool } from "../src/index.js";

function testPool(name = "main", options = {}) {
  let t = 0;
  return new Pool(name, { now: () => ++t, ...options });
}

describe("searching a pool", () => {
  test("finds nodes by content without anyone having to index them", async () => {
    const pool = testPool();
    await pool.create({ id: "a", content: "the quarterly report is on the desk" });
    await pool.create({ id: "b", content: "lunch plans for tuesday" });

    const hits = await pool.search("report");

    assert.deepEqual(hits.map(n => n.id), ["a"]);
  });

  test("matches across different word endings", async () => {
    const pool = testPool();
    await pool.create({ id: "a", content: "we spent the morning indexing nodes" });

    const hits = await pool.search("how was the node index built");

    assert.deepEqual(hits.map(n => n.id), ["a"]);
  });

  test("tags are written onto the node as it is created", async () => {
    const pool = testPool();
    const node = await pool.create({ content: "quarterly report" });

    assert.ok(Array.isArray(node.tags.keywords));
    assert.ok(node.tags.keywords.includes("report"));
  });

  test("caller-supplied tags are used as given and never overwritten", async () => {
    const pool = testPool();
    await pool.create({
      id: "a",
      content: "opaque binary blob",
      tags: { keywords: ["invoice", "acme"] }
    });

    assert.deepEqual((await pool.search("invoice")).map(n => n.id), ["a"]);
    assert.deepEqual(await pool.search("opaque"), [], "content was not indexed over the tags");
    assert.deepEqual(pool.get("a").tags.keywords, ["invoice", "acme"]);
  });

  test("returns whole node objects, not ids", async () => {
    const pool = testPool();
    await pool.create({ id: "a", content: { user: "where is the report", assistant: "desk" } });

    const [hit] = await pool.search("report");

    assert.equal(hit.id, "a");
    assert.deepEqual(hit.content, { user: "where is the report", assistant: "desk" });
    assert.equal(hit.pool, "main");
  });

  test("rank keeps the score alongside each node", async () => {
    const pool = testPool();
    await pool.create({ id: "a", content: "the quarterly revenue report" });
    await pool.create({ id: "b", content: "a report" });
    await pool.create({ id: "c", content: "unrelated lunch plans" });

    const ranked = await pool.rank("report revenue");

    assert.deepEqual(ranked.map(r => r.node.id), ["a", "b"]);
    assert.ok(ranked[0].score > ranked[1].score, "matching both terms must outrank matching one");
    assert.ok(ranked.every(r => typeof r.score === "number"));
  });

  test("the default tagger scores on presence, not on repetition", async () => {
    const pool = testPool();
    await pool.create({ id: "once", content: "report" });
    await pool.create({ id: "many", content: "report report report report" });

    const ranked = await pool.rank("report");

    assert.equal(ranked[0].score, ranked[1].score,
      "keywords are deduplicated, so saying a word ten times is the same as saying it once");
  });

  test("limit caps the results", async () => {
    const pool = testPool();
    for (let i = 0; i < 8; i++) await pool.create({ content: `report number ${i}` });

    assert.equal((await pool.search("report", { limit: 3 })).length, 3);
  });

  test("a query matching nothing gives an empty list", async () => {
    const pool = testPool();
    await pool.create({ content: "lunch plans" });

    assert.deepEqual(await pool.search("kubernetes"), []);
    assert.deepEqual(await pool.search(""), []);
  });
});

describe("structural nodes", () => {
  test("null content is never returned by search", async () => {
    const pool = testPool();
    await pool.create({ id: "structural", content: null });
    await pool.create({ id: "real", content: "a real node about reports" });

    assert.deepEqual((await pool.search("report")).map(n => n.id), ["real"]);
    assert.equal(pool.has("structural"), true, "it still exists, it just cannot be searched");
  });

  test("tagging is skipped entirely for null content", async () => {
    const pool = testPool();
    const node = await pool.create({ content: null });

    assert.deepEqual(node.tags, {});
  });
});

describe("the index tracks the pool", () => {
  test("a removed node stops coming back", async () => {
    const pool = testPool();
    await pool.create({ id: "a", content: "the report" });
    await pool.create({ id: "b", content: "another report" });

    pool.remove("a");

    assert.deepEqual((await pool.search("report")).map(n => n.id), ["b"]);
  });

  test("an evicted node stops coming back", async () => {
    const pool = testPool("main", { onEvict: () => {} });
    await pool.create({ id: "a", content: "the report" });
    await pool.evict(["a"]);

    assert.deepEqual(await pool.search("report"), []);
  });

  test("updating content re-tags and re-indexes", async () => {
    const pool = testPool();
    await pool.create({ id: "a", content: "originally about badgers" });

    await pool.update("a", { content: "now about kubernetes" });

    assert.deepEqual(await pool.search("badgers"), []);
    assert.deepEqual((await pool.search("kubernetes")).map(n => n.id), ["a"]);
  });

  test("updating only metadata leaves the tags alone", async () => {
    const pool = testPool();
    const created = await pool.create({ id: "a", content: "about badgers" });

    await pool.update("a", { metadata: { reviewed: true } });

    assert.deepEqual(pool.get("a").tags, created.tags);
    assert.deepEqual((await pool.search("badgers")).map(n => n.id), ["a"]);
  });

  test("clearing empties the index too", async () => {
    const pool = testPool();
    await pool.create({ content: "the report" });

    pool.clear();

    assert.deepEqual(await pool.search("report"), []);
  });
});

describe("loading a snapshot", () => {
  test("a restored pool is searchable with no rebuild step", async () => {
    const original = testPool("docs");
    await original.create({ id: "a", content: "the quarterly report" });
    await original.create({ id: "b", content: "lunch plans" });

    const restored = new Pool("docs").load(JSON.parse(JSON.stringify(original)));

    assert.deepEqual((await restored.search("report")).map(n => n.id), ["a"]);
  });

  test("stored tags are reused rather than recomputed", async () => {
    const snapshot = {
      nodes: [{
        id: "a",
        pool: "docs",
        content: "opaque blob",
        tags: { keywords: ["invoice"] },
        graph: {},
        metadata: { createdAt: 1, updatedAt: 1 }
      }]
    };

    const pool = new Pool("docs").load(snapshot);

    assert.deepEqual((await pool.search("invoice")).map(n => n.id), ["a"]);
    assert.deepEqual(await pool.search("opaque"), []);
  });

  test("searching twice does not double-index", async () => {
    const original = testPool();
    await original.create({ id: "a", content: "the report" });

    const restored = new Pool("main").load(JSON.parse(JSON.stringify(original)));
    const first = await restored.rank("report");
    const second = await restored.rank("report");

    assert.deepEqual(second, first);
    assert.equal(restored.engine.size, 1);
  });
});

describe("determinism", () => {
  test("the same pool and query give the same order every time", async () => {
    const pool = testPool();
    for (let i = 0; i < 30; i++) {
      await pool.create({ content: `report about topic ${i % 5} and detail ${i}` });
    }

    const first = (await pool.search("report topic")).map(n => n.id);
    for (let i = 0; i < 5; i++) {
      assert.deepEqual((await pool.search("report topic")).map(n => n.id), first);
    }
  });

  test("two pools built the same way rank identically", async () => {
    const build = async () => {
      const pool = testPool();
      await pool.create({ id: "a", content: "the quarterly report on revenue" });
      await pool.create({ id: "b", content: "a report about lunch" });
      await pool.create({ id: "c", content: "revenue figures" });
      return pool;
    };

    const one = await build();
    const two = await build();

    assert.deepEqual(
      (await one.search("report revenue")).map(n => n.id),
      (await two.search("report revenue")).map(n => n.id)
    );
  });
});

describe("bringing your own tagger and engine", () => {
  test("a custom tagger decides what gets indexed", async () => {
    const upperTagger = {
      forNode: node => ({ shouty: String(node.content).toUpperCase().split(" ") }),
      termsOf: tags => tags?.shouty ?? [],
      forQuery: query => query.toUpperCase().split(" ")
    };

    const pool = testPool("main", { tagger: upperTagger });
    await pool.create({ id: "a", content: "hello world" });

    assert.deepEqual((await pool.search("WORLD")).map(n => n.id), ["a"]);
    assert.deepEqual(pool.get("a").tags, { shouty: ["HELLO", "WORLD"] });
  });

  test("an async tagger is awaited", async () => {
    const slowTagger = {
      forNode: async node => {
        await new Promise(r => setTimeout(r, 5));
        return { keywords: [String(node.content)] };
      },
      termsOf: tags => tags?.keywords ?? [],
      forQuery: async query => {
        await new Promise(r => setTimeout(r, 5));
        return [query];
      }
    };

    const pool = testPool("main", { tagger: slowTagger });
    await pool.create({ id: "a", content: "delta" });

    assert.deepEqual((await pool.search("delta")).map(n => n.id), ["a"]);
  });

  test("a custom engine receives the terms and returns the order", async () => {
    const calls = [];
    const reverseEngine = {
      _ids: [],
      add(id) { calls.push(["add", id]); this._ids.push(id); },
      remove(id) { this._ids = this._ids.filter(x => x !== id); },
      search() { return this._ids.slice().reverse().map(id => ({ id, score: 1 })); },
      clear() { this._ids = []; }
    };

    const pool = testPool("main", { engine: reverseEngine });
    await pool.create({ id: "a", content: "one" });
    await pool.create({ id: "b", content: "two" });

    assert.deepEqual((await pool.search("anything")).map(n => n.id), ["b", "a"]);
    assert.deepEqual(calls, [["add", "a"], ["add", "b"]]);
  });
});

describe("pools stay separate", () => {
  test("a search only sees its own pool", async () => {
    const mem = new LiminalMemory();
    await mem.pool("chat").create({ id: "c1", content: "the report is ready" });
    await mem.pool("docs").create({ id: "d1", content: "report template v2" });

    assert.deepEqual((await mem.pool("chat").search("report")).map(n => n.id), ["c1"]);
    assert.deepEqual((await mem.pool("docs").search("report")).map(n => n.id), ["d1"]);
  });

  test("each pool gets its own engine instance from a factory", async () => {
    const mem = new LiminalMemory({ engine: () => new (class {
      constructor() { this.ids = []; }
      add(id) { this.ids.push(id); }
      remove() {}
      search() { return this.ids.map(id => ({ id, score: 1 })); }
      clear() { this.ids = []; }
    })() });

    await mem.pool("a").create({ id: "a1", content: "x" });
    await mem.pool("b").create({ id: "b1", content: "y" });

    assert.notEqual(mem.pool("a").engine, mem.pool("b").engine);
    assert.deepEqual((await mem.pool("a").search("q")).map(n => n.id), ["a1"]);
  });

  test("the container shorthand searches the default pool", async () => {
    const mem = new LiminalMemory();
    await mem.create({ id: "a", content: "the report" });
    await mem.pool("other").create({ id: "b", content: "another report" });

    assert.deepEqual((await mem.search("report")).map(n => n.id), ["a"]);
  });
});
