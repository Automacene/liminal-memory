import { describe, it } from "node:test";
import assert from "node:assert";
import { Chain } from "../src/core/chain.js";

describe("Phase 3 — deterministic node splitting", () => {
  it("splits a hub that reaches 6 neighbors into two keyword-grouped category nodes", () => {
    const chain = new Chain();
    const hub = chain.append("system", "hub central node");

    // Two clear clusters: 3 animal nodes, 3 database nodes.
    const a1 = chain.append("system", "cats dogs pets animals furry companions");
    const a2 = chain.append("system", "dogs animals veterinary care pets");
    const a3 = chain.append("system", "pets animals cats grooming furry");
    const d1 = chain.append("system", "database sql queries indexing storage");
    const d2 = chain.append("system", "sql database transactions rollback");
    const d3 = chain.append("system", "indexing database performance sql tuning");

    const neighbors = [a1, a2, a3, d1, d2, d3];
    // The 6th link pushes the hub to the split threshold — split fires synchronously here.
    neighbors.forEach(n => chain.link(hub.id, n.id));

    // Hub is demoted from 6 edges down to 2 (one per category).
    const hubNow = chain.get(hub.id);
    assert.strictEqual(chain._neighborCount(hubNow), 2, "hub should drop to 2 edges after split");

    // Exactly two category nodes were created.
    const cats = chain.all().filter(n => n.role === "category");
    assert.strictEqual(cats.length, 2, "two category nodes should exist");

    // The hub points at exactly those two categories.
    const hubNeighbors = chain._neighborIds(hubNow).sort((x, y) => x - y);
    assert.deepStrictEqual(hubNeighbors, cats.map(c => c.id).sort((x, y) => x - y));

    // Every original neighbor is rewired off the hub and onto a category.
    for (const n of neighbors) {
      assert.ok(!chain._neighborIds(chain.get(n.id)).includes(hub.id),
        `neighbor ${n.id} should no longer link to the hub`);
    }

    // Grouping is thematic: the 3 animal nodes share one category, the 3 db nodes the other.
    const catOf = (nid) => cats.find(c => c.graph.edges_to.includes(nid));
    const animalCat = catOf(a1.id);
    assert.ok(animalCat, "a1 should belong to a category");
    assert.strictEqual(catOf(a2.id), animalCat, "a2 with a1");
    assert.strictEqual(catOf(a3.id), animalCat, "a3 with a1");
    const dbCat = catOf(d1.id);
    assert.ok(dbCat && dbCat !== animalCat, "db nodes in the other category");
    assert.strictEqual(catOf(d2.id), dbCat, "d2 with d1");
    assert.strictEqual(catOf(d3.id), dbCat, "d3 with d1");

    // Category nodes have a deterministic fallback name + the autoNamed flag for LLM naming.
    for (const c of cats) {
      assert.ok(c.content && c.content.length > 0, "category has a fallback name");
      assert.strictEqual(c.metadata.autoNamed, true, "flagged for optional LLM naming");
      assert.strictEqual(c.graph.edges_to.length, 3, "each category holds its 3 members");
    }
  });

  it("does not split a node that stays under the threshold", () => {
    const chain = new Chain();
    const hub = chain.append("system", "hub");
    for (let i = 0; i < 5; i++) {
      const n = chain.append("system", "neighbor content number " + i);
      chain.link(hub.id, n.id);
    }
    // 5 neighbors — below the split threshold of 6.
    assert.strictEqual(chain._neighborCount(chain.get(hub.id)), 5);
    assert.strictEqual(chain.all().filter(n => n.role === "category").length, 0, "no split yet");
  });

  it("recurses: a category that later fills to 6 children splits again and keeps its parent", () => {
    const chain = new Chain();
    const hub = chain.append("system", "hub central");
    const mk = (c) => chain.append("system", c);

    // First split → two categories, one holds 3 "alpha" members.
    const members = [
      mk("alpha topic one shared"), mk("alpha topic two shared"), mk("alpha topic three shared"),
      mk("beta subject one shared"), mk("beta subject two shared"), mk("beta subject three shared")
    ];
    members.forEach(m => chain.link(hub.id, m.id));
    let cats = chain.all().filter(n => n.role === "category");
    assert.strictEqual(cats.length, 2, "first split made two categories");

    // Fill one category from 3 → 6 children, which must trigger a recursive split.
    const cat = cats[0];
    assert.strictEqual(cat.graph.edges_to.length, 3);
    [mk("gamma extra alpha"), mk("gamma extra beta"), mk("gamma extra delta")]
      .forEach(x => chain.link(cat.id, x.id));

    const catsAfter = chain.all().filter(n => n.role === "category");
    assert.ok(catsAfter.length >= 4, "the filled category split into two sub-categories");
    assert.strictEqual(chain.get(cat.id).graph.edges_to.length, 2, "filled category demoted to 2 sub-categories");
    assert.ok(chain.get(cat.id).graph.edges_from.includes(hub.id),
      "the category keeps its parent (hub) edge through its own split");
  });
});
