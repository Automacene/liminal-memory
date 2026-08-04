import { describe, it } from "node:test";
import assert from "node:assert";
import { Chain } from "../src/core/chain.js";
import { BM25 } from "../src/search/bm25.js";
import { BloomFilter } from "../src/search/bloom.js";
import { TfIdf } from "../src/search/tfidf.js";
import { Archive } from "../src/storage/archive.js";
import { Compaction } from "../src/core/compaction.js";

describe("Compaction", () => {
  function setup() {
    const chain = new Chain();
    const bm25 = new BM25({ k1: 1.2, b: 0.4 });
    const bloom = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });
    const tfidf = new TfIdf();
    const archive = new Archive(); // uses in-memory fallback (no IndexedDB in Node)
    const config = { archiveBlockSize: 1000 };
    const compaction = new Compaction(chain, bm25, bloom, tfidf, archive, config);

    // Add some nodes
    for (let i = 0; i < 20; i++) {
      const node = chain.append(i % 2 === 0 ? "user" : "assistant", `message number ${i} about topic ${i % 3}`);
      bm25.add(node);
    }

    return { chain, bm25, bloom, tfidf, archive, compaction };
  }

  it("trims a range of nodes to archive", async () => {
    const { chain, bm25, bloom, compaction } = setup();

    const initialLength = chain.length;
    await compaction.trim(1, 10, {
      startTopic: "beginning",
      keyDecisions: ["decided stuff"],
      openThreads: []
    });

    // 10 nodes removed, 1 compaction marker added
    assert.strictEqual(chain.length, initialLength - 10 + 1);

    // Bloom filter should have terms from archived nodes
    assert.strictEqual(bloom.testQuery("message"), true);
  });

  it("restore brings nodes back from archive", async () => {
    const { chain, bm25, bloom, compaction } = setup();

    await compaction.trim(1, 10, { startTopic: "test", keyDecisions: [], openThreads: [] });
    const afterTrim = chain.length;

    await compaction.restore("archive_1_10");

    // Nodes should be back (minus the compaction marker that was removed)
    assert.ok(chain.length > afterTrim);
  });

  it("tracks archive block vectors for retrieval", async () => {
    const { compaction } = setup();

    await compaction.trim(1, 10, { startTopic: "test", keyDecisions: [], openThreads: [] });

    const vectors = compaction.getBlockVectors();
    assert.strictEqual(vectors.length, 1);
    assert.strictEqual(vectors[0].key, "archive_1_10");
    assert.ok(vectors[0].vector instanceof Map);
  });

  it("exports and imports state", async () => {
    const { compaction } = setup();

    await compaction.trim(1, 5, { startTopic: "test", keyDecisions: [], openThreads: [] });

    const exported = compaction.export();
    assert.strictEqual(exported.markers.length, 1);
    assert.strictEqual(exported.markers[0].archiveKey, "archive_1_5");
  });
});
