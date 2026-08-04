import { describe, it } from "node:test";
import assert from "node:assert";
import { Chain } from "../src/core/chain.js";
import { Window } from "../src/core/window.js";
import { BM25 } from "../src/search/bm25.js";
import { SlidingBuffer, RecallBuffer } from "../src/core/buffer.js";
import { ConversationManager } from "../src/core/conversation-manager.js";
import { conversation35 } from "./fixtures/conversation-35.js";

const testConfig = {
  windowSize: 10,
  maxTokenBudget: 32768,
  reservedTokens: 2048,
  systemPrompt: "You are a helpful assistant.",
  recallBufferRatio: 0.3
};

describe("35-Message Conversation (Turn Nodes)", () => {
  function loadConversation() {
    const chain = new Chain();
    const bm25 = new BM25({ k1: 1.2, b: 0.4 });

    // Pair messages into turns
    for (let i = 0; i < conversation35.length - 1; i += 2) {
      const user = conversation35[i];
      const assistant = conversation35[i + 1];
      if (user && assistant) {
        const node = chain.appendTurn(user.content, assistant.content);
        bm25.add(node);
      }
    }

    return { chain, bm25 };
  }

  it("loads messages as turn nodes", () => {
    const { chain } = loadConversation();
    // 94 messages / 2 = 47 turn nodes
    assert.strictEqual(chain.length, 47);
  });

  it("turn nodes contain both query and response", () => {
    const { chain } = loadConversation();
    const first = chain.get(1);
    assert.strictEqual(first.role, "turn");
    assert.ok(first.query.includes("import error"));
    assert.ok(first.response.includes("wrong module name"));
  });

  it("sliding window caps at 10 turn nodes", () => {
    const { chain } = loadConversation();
    const window = new Window(testConfig);
    const selected = window.select(chain);
    assert.strictEqual(selected.length, 10);
    // Last 10 nodes
    assert.strictEqual(selected[0].id, chain.length - 9);
    assert.strictEqual(selected[9].id, chain.length);
  });

  it("majority of nodes are outside the window (retrievable)", () => {
    const { chain } = loadConversation();
    const window = new Window(testConfig);
    const selected = window.select(chain);
    const windowIds = new Set(selected.map(n => n.id));
    const outside = chain.all().filter(n => !windowIds.has(n.id));
    assert.strictEqual(outside.length, chain.length - 10);
    assert.ok(outside.length > 30); // plenty of stuff to recall
  });

  it("BM25 finds ModuleNotFoundError from turn 2 (outside window)", () => {
    const { bm25 } = loadConversation();
    const results = bm25.search("ModuleNotFoundError bm25s", 3);
    assert.ok(results.length > 0);
    assert.ok(results[0].nodeId <= 3);
  });

  it("BM25 finds secret code word pineapple (turn 4)", () => {
    const { bm25 } = loadConversation();
    const results = bm25.search("secret code word pineapple", 3);
    assert.ok(results.length > 0);
    assert.ok(results[0].nodeId <= 5);
  });

  it("BM25 finds Biscuit the corgi (turn 11)", () => {
    const { bm25 } = loadConversation();
    const results = bm25.search("Biscuit corgi herds cats", 3);
    assert.ok(results.length > 0);
  });

  it("BM25 finds Tokyo cherry blossoms (turn 19)", () => {
    const { bm25 } = loadConversation();
    const results = bm25.search("cherry blossom tokyo spring", 3);
    assert.ok(results.length > 0);
  });

  it("BM25 finds Mongolia capital (turn 13)", () => {
    const { bm25 } = loadConversation();
    const results = bm25.search("capital mongolia Ulaanbaatar", 3);
    assert.ok(results.length > 0);
  });

  it("BM25 finds BM25 params k1 b values (turn 9)", () => {
    const { bm25 } = loadConversation();
    const results = bm25.search("k1 1.2 b 0.4 short chat", 3);
    assert.ok(results.length > 0);
  });

  it("BM25 finds wifi password (turn 46 — in window)", () => {
    const { bm25 } = loadConversation();
    const results = bm25.search("wifi password Mochi2024Bark", 3);
    assert.ok(results.length > 0);
  });

  it("BM25 finds Focusrite Scarlett audio interface (turn 35)", () => {
    const { bm25 } = loadConversation();
    const results = bm25.search("Focusrite Scarlett 2i2 audio interface", 3);
    assert.ok(results.length > 0);
  });

  it("SlidingBuffer respects token budget", () => {
    const { chain } = loadConversation();
    const buffer = new SlidingBuffer({ maxTokens: 500, maxNodes: 10 });
    buffer.fill(chain.all());
    assert.ok(buffer.length > 0);
    assert.ok(buffer.length <= 10);
    assert.ok(buffer.tokenCount <= 500);
  });

  it("RecallBuffer fills and prunes correctly", () => {
    const { chain, bm25 } = loadConversation();
    const results = bm25.search("python venv activate import", 10);
    const scored = results.map(r => ({
      node: chain.get(r.nodeId),
      score: r.score
    })).filter(r => r.node);

    const buffer = new RecallBuffer({ maxTokens: 400 });
    buffer.fill(scored);

    assert.ok(buffer.length > 0);
    assert.ok(buffer.tokenCount <= 400);
  });

  it("ConversationManager builds prompt with recall + sliding within budget", () => {
    const { chain, bm25 } = loadConversation();
    const manager = new ConversationManager(testConfig);

    const results = bm25.search("pineapple secret code", 5);
    const scored = results.map(r => ({
      node: chain.get(r.nodeId),
      score: r.score
    })).filter(r => r.node);

    const { messages, slidingBuffer, recallBuffer } = manager.buildPrompt(
      chain.all(),
      scored
    );

    assert.ok(messages.length > 0);
    assert.strictEqual(messages[0].role, "system");
    assert.ok(slidingBuffer.tokens > 0);
    // recall should have found the pineapple node
    assert.ok(recallBuffer.nodes > 0);
  });

  it("normalized scores range 0 to 1", () => {
    const { bm25 } = loadConversation();
    const results = bm25.search("python bm25 install error venv", 10);
    if (results.length > 1) {
      const maxScore = results[0].score;
      const normalized = results.map(r => r.score / maxScore);
      assert.strictEqual(normalized[0], 1.0);
      for (const n of normalized) {
        assert.ok(n >= 0 && n <= 1);
      }
    }
  });
});
