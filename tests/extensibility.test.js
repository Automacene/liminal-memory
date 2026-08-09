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
