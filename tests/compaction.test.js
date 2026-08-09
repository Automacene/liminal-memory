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

  it("trimSet archives a non-contiguous set of node ids as one block", async () => {
    const { chain, bm25, compaction } = setup();
    const initialLength = chain.length;

    // Nodes 2, 5, 9, 14 — scattered, not a contiguous range.
    const marker = await compaction.trimSet([2, 5, 9, 14], {
      startTopic: "scattered topic", keyDecisions: [], openThreads: []
    });

    // 4 nodes removed, 1 compaction marker added.
    assert.strictEqual(chain.length, initialLength - 4 + 1);
    // The marker records the exact set (sorted), plus min/max bounds.
    assert.deepStrictEqual(marker.metadata.nodeIds, [2, 5, 9, 14]);
    assert.strictEqual(marker.metadata.startNode, 2);
    assert.strictEqual(marker.metadata.endNode, 14);
    assert.strictEqual(marker.metadata.nodeCount, 4);
    // Those exact nodes are gone from active memory + BM25; untouched ones remain.
    for (const id of [2, 5, 9, 14]) assert.strictEqual(chain.get(id), undefined, `node ${id} archived`);
    assert.ok(chain.get(3), "an unarchived node in between stays");
    assert.strictEqual(bm25.search("message number 5", 5).some(r => r.nodeId === 5), false);

    // Block vector is tracked under the set key.
    const vectors = compaction.getBlockVectors();
    assert.strictEqual(vectors.length, 1);
    assert.strictEqual(vectors[0].key, "archive_set_2_5_9_14");
  });

  it("trimSet round-trips through restore", async () => {
    const { chain, compaction } = setup();
    await compaction.trimSet([2, 5, 9, 14], { startTopic: "t", keyDecisions: [], openThreads: [] });
    const afterTrim = chain.length;

    await compaction.restore("archive_set_2_5_9_14");

    // The 4 nodes come back (net +4, minus the removed marker = +3 over afterTrim).
    assert.ok(chain.length > afterTrim);
    for (const id of [2, 5, 9, 14]) assert.ok(chain.get(id), `node ${id} restored`);
  });

  it("trimSet dedupes, skips missing ids and compaction markers, and orders by id", async () => {
    const { chain, compaction } = setup();
    const initialLength = chain.length;

    // Pass duplicates, out-of-order ids, and a non-existent id (999).
    const marker = await compaction.trimSet([9, 2, 9, 999, 5]);

    assert.deepStrictEqual(marker.metadata.nodeIds, [2, 5, 9], "deduped, sorted, missing dropped");
    assert.strictEqual(chain.length, initialLength - 3 + 1);

    // A prior marker must never be re-archived by a later set.
    const preMarkerLen = chain.length;
    await assert.rejects(() => compaction.trimSet([marker.id]), /No archivable nodes/);
    assert.strictEqual(chain.length, preMarkerLen, "no-op when the set resolves to nothing archivable");
  });

  it("trimSet throws on an empty or fully-missing set", async () => {
    const { compaction } = setup();
    await assert.rejects(() => compaction.trimSet([]), /No archivable nodes/);
    await assert.rejects(() => compaction.trimSet([9999, 8888]), /No archivable nodes/);
  });

  it("exports and imports state", async () => {
    const { compaction } = setup();

    await compaction.trim(1, 5, { startTopic: "test", keyDecisions: [], openThreads: [] });

    const exported = compaction.export();
    assert.strictEqual(exported.markers.length, 1);
    assert.strictEqual(exported.markers[0].archiveKey, "archive_1_5");
  });
});
