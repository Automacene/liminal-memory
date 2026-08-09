import { describe, it } from "node:test";
import assert from "node:assert";
import { LuminalMemory } from "../src/index.js";
import { Archive } from "../src/storage/archive.js";
import { LLMTransport } from "../src/transport/llm.js";

describe("Extensibility — pluggable connection points", () => {
  describe("storage adapter", () => {
    it("defaults to the built-in Archive when none is supplied", () => {
      const mem = new LuminalMemory();
      assert.ok(mem.archive instanceof Archive, "falls back to the built-in Archive");
    });

    it("uses a supplied storageAdapter, and the archiving path actually calls it", async () => {
      // A minimal outside-developer storage backend — just a Map behind the contract.
      const stored = new Map();
      const calls = [];
      const fakeAdapter = {
        async init() { calls.push("init"); },
        async store(key, nodes) { calls.push("store"); stored.set(key, nodes); },
        async retrieve(key) { calls.push("retrieve"); return stored.get(key); },
        async delete(key) { calls.push("delete"); stored.delete(key); }
      };

      const mem = new LuminalMemory({ storageAdapter: fakeAdapter });
      assert.strictEqual(mem.archive, fakeAdapter, "the supplied adapter is wired in");

      // Drive a real archive through the real compaction path — it must hit OUR adapter.
      mem.chain.append("user", "first message about apples");
      mem.chain.append("assistant", "second message about oranges");
      await mem.compaction.trim(1, 2, { startTopic: "fruit", keyDecisions: [], openThreads: [] });

      assert.ok(stored.has("archive_1_2"), "the injected adapter received the archived block");
      assert.ok(calls.includes("store"), "store() was called on the injected adapter");

      // And restore round-trips through the injected adapter too.
      await mem.compaction.restore("archive_1_2");
      assert.ok(calls.includes("retrieve"), "retrieve() was called on the injected adapter");
    });
  });

  describe("node namer (hot-path safe)", () => {
    // Two clear clusters so the hub splits into two category nodes.
    function triggerSplit(mem) {
      const hub = mem.chain.append("system", "hub central node");
      const kids = [
        mem.chain.append("system", "cats dogs pets animals furry companions"),
        mem.chain.append("system", "dogs animals veterinary care pets"),
        mem.chain.append("system", "pets animals cats grooming furry"),
        mem.chain.append("system", "database sql queries indexing storage"),
        mem.chain.append("system", "sql database transactions rollback"),
        mem.chain.append("system", "indexing database performance sql tuning")
      ];
      kids.forEach(k => mem.chain.link(hub.id, k.id));
    }

    it("default: no namer — instant keyword names, nothing queued, enrich is a no-op", async () => {
      const mem = new LuminalMemory();
      assert.strictEqual(mem.chain.recordCategoryNaming, false);
      triggerSplit(mem);

      const cats = mem.chain.all().filter(n => n.role === "category");
      assert.ok(cats.length >= 2, "the hub split into category nodes");
      assert.ok(cats.every(c => c.content && c.content.length > 0), "each has an instant keyword name");
      assert.strictEqual(mem.chain.pendingCategoryNaming.length, 0, "nothing queued without a namer");
      assert.strictEqual(await mem.enrichCategoryNames(), 0, "enrich is a no-op with no namer");
    });

    it("with a namer: split never calls it (stays fast); enrichCategoryNames upgrades off-path", async () => {
      let totalCalls = 0;
      const namer = async (memberNodes) => { totalCalls++; return { label: "NICE:" + memberNodes.length }; };

      const mem = new LuminalMemory({ nodeNamer: namer });
      assert.strictEqual(mem.chain.recordCategoryNaming, true, "recording turns on when a namer is supplied");

      triggerSplit(mem);

      // The hot-path proof: the namer was NOT called during the split itself.
      assert.strictEqual(totalCalls, 0, "namer must not run inline on the split hot path");
      assert.ok(mem.chain.pendingCategoryNaming.length >= 2, "category nodes were queued for later naming");

      // Off the hot path, the namer runs and upgrades the names.
      const renamed = await mem.enrichCategoryNames();
      assert.ok(renamed >= 2, "enrichCategoryNames renamed the queued category nodes");
      assert.strictEqual(totalCalls, renamed, "namer called exactly once per queued category");
      const cats = mem.chain.all().filter(n => n.role === "category");
      assert.ok(cats.some(c => c.content.startsWith("NICE:")), "a category node got the plugged-in name");
      assert.strictEqual(mem.chain.pendingCategoryNaming.length, 0, "queue drained after enrich");
    });
  });

  describe("summarizer", () => {
    it("defaults to the transport when none is supplied", () => {
      const mem = new LuminalMemory();
      assert.strictEqual(mem.summarizer, mem.transport, "summaries ride on the transport by default");
    });

    it("uses a supplied summarizer to write archive summaries", async () => {
      let called = false;
      const mem = new LuminalMemory({
        storageAdapter: { async init() {}, async store() {}, async retrieve() { return []; }, async delete() {} },
        summarizer: {
          async generateSummary(nodes) {
            called = true;
            return { startTopic: "custom summary", keyDecisions: [], openThreads: [] };
          }
        }
      });

      mem.chain.append("user", "alpha");
      mem.chain.append("assistant", "beta");
      // Public trim with no summary → the library must auto-generate via OUR summarizer.
      const marker = await mem.trim({ from: 1, to: 2 });

      assert.ok(called, "injected summarizer was called");
      assert.strictEqual(marker.metadata.summary.startTopic, "custom summary", "its summary was used");
    });
  });

  describe("model transport", () => {
    it("defaults to the built-in LLMTransport when none is supplied", () => {
      const mem = new LuminalMemory();
      assert.ok(mem.transport instanceof LLMTransport, "falls back to the built-in transport");
    });

    it("uses a supplied transport, and the library talks to it instead of the network", async () => {
      const seen = [];
      const fakeTransport = {
        async complete(messages) { seen.push(messages); return { text: "canned reply", usage: null }; },
        async generateSummary(nodes) { return { startTopic: "canned", keyDecisions: [], openThreads: [] }; }
      };

      const mem = new LuminalMemory({ transport: fakeTransport });
      assert.strictEqual(mem.transport, fakeTransport, "the supplied transport is wired in");

      const out = await mem.transport.complete([{ role: "user", content: "hi" }]);
      assert.strictEqual(out.text, "canned reply", "the library uses the injected transport");
    });
  });
});
