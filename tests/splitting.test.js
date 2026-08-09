import { describe, it } from "node:test";
import assert from "node:assert";
import { Chain } from "../src/core/chain.js";
import { differentialKeywords, KEYWORD_FOOTPRINT_CAP } from "../src/core/node-split.js";

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

    // Category nodes carry a deterministic keyword label + the keyword profile the system
    // matches on — no LLM naming, so the split path stays fast and fully deterministic.
    for (const c of cats) {
      assert.ok(c.content && c.content.length > 0, "category has a deterministic keyword label");
      assert.ok(Array.isArray(c.keywords) && c.keywords.length > 0, "category carries a keyword profile");
      assert.ok(Array.isArray(c.metadata.members) && c.metadata.members.length === 3, "category records its 3 members");
      assert.strictEqual(c.graph.edges_to.length, 3, "each category holds its 3 members");
      // Footprint is bounded — no raw-union match-all hub (the hubness fix).
      assert.ok(c.keywords.length <= KEYWORD_FOOTPRINT_CAP,
        `category footprint stays within the cap (${c.keywords.length} <= ${KEYWORD_FOOTPRINT_CAP})`);
    }

    // The footprint is DISTINCTIVE: the animal category carries animal terms and none of the
    // database terms (and vice-versa). A raw union would have swept both sets into both nodes,
    // making each a match-all magnet. (animalCat / dbCat resolved above.)
    for (const dbTerm of ["database", "sql", "indexing"]) {
      assert.ok(!animalCat.keywords.includes(dbTerm),
        `animal category should not carry db term "${dbTerm}"`);
    }
    for (const animalTerm of ["animals", "pets", "cats"]) {
      assert.ok(!dbCat.keywords.includes(animalTerm),
        `db category should not carry animal term "${animalTerm}"`);
    }
  });

  it("differentialKeywords keeps distinctive terms, drops shared ones, and stays bounded", () => {
    const group = [
      { keywords: ["retrieval", "bm25", "index", "shared", "common"] },
      { keywords: ["retrieval", "bloom", "index", "shared", "common"] },
      { keywords: ["retrieval", "tfidf", "shared", "common"] }
    ];
    const sibling = [
      { keywords: ["storage", "archive", "shared", "common"] },
      { keywords: ["storage", "indexeddb", "shared", "common"] },
      { keywords: ["storage", "compression", "shared", "common"] }
    ];
    // With a tight cap, the distinctiveness ranking is what survives: terms unique to this
    // group outrank the 50/50 shared terms, so the cap prunes the shared ones away first.
    const kw = differentialKeywords(group, sibling, 2);
    assert.ok(kw.includes("retrieval"), "keeps the term distinctive to this group");
    assert.ok(kw.includes("index"), "keeps the second group-only term (higher purity than shared)");
    assert.ok(!kw.includes("shared"), "50/50 shared term ranks below distinctive terms → pruned by cap");
    assert.ok(!kw.includes("common"), "the other shared term is likewise pruned");
    assert.ok(!kw.includes("storage"), "never carries a sibling-only term");
    assert.strictEqual(kw.length, 2, "footprint respects the cap");

    // And the default cap is honored too.
    assert.ok(differentialKeywords(group, sibling).length <= KEYWORD_FOOTPRINT_CAP, "default footprint is bounded");
  });

  it("global IDF weighting demotes codebase-wide terms that only look locally distinctive", () => {
    // Both terms are locally distinctive (absent from the sibling, inC=2) → equal local score.
    const group = [{ keywords: ["retrieval", "common"] }, { keywords: ["retrieval", "common"] }];
    const sibling = [{ keywords: ["storage"] }];

    // But across the whole corpus, "common" is everywhere (df 90/100) and "retrieval" is rare
    // (df 3/100). Smoothed IDF (same formula as BM25) crushes the ubiquitous term.
    const N = 100;
    const df = new Map([["retrieval", 3], ["common", 90]]);
    const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));

    // Single slot: the globally-rare distinctive term must win over the global-noise term.
    const kw = differentialKeywords(group, sibling, 1, idf);
    assert.deepStrictEqual(kw, ["retrieval"], "globally-rare term wins; codebase-wide term demoted");

    // Without IDF the two tie (local score only) and "common" is not filtered out.
    assert.ok(differentialKeywords(group, sibling, 2).includes("common"),
      "local-only scoring can't tell the global-noise term apart");
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
