import { describe, it } from "node:test";
import assert from "node:assert";
import { Chain } from "../src/core/chain.js";

describe("Chain", () => {
  it("appends turn nodes with sequential IDs", () => {
    const chain = new Chain();
    const n1 = chain.appendTurn("hello", "hi there");
    const n2 = chain.appendTurn("how are you", "doing great");

    assert.strictEqual(n1.id, 1);
    assert.strictEqual(n2.id, 2);
    assert.strictEqual(n2.parentId, 1);
    assert.strictEqual(chain.length, 2);
    assert.strictEqual(n1.role, "turn");
    assert.strictEqual(n1.query, "hello");
    assert.strictEqual(n1.response, "hi there");
  });

  it("turn node content combines query and response", () => {
    const chain = new Chain();
    const node = chain.appendTurn("what is BM25", "its a ranking function");
    assert.ok(node.content.includes("[user]: what is BM25"));
    assert.ok(node.content.includes("[assistant]: its a ranking function"));
  });

  it("returns tail nodes for sliding window", () => {
    const chain = new Chain();
    for (let i = 0; i < 30; i++) {
      chain.appendTurn(`question ${i}`, `answer ${i}`);
    }

    const window = chain.tail(10);
    assert.strictEqual(window.length, 10);
    assert.strictEqual(window[0].id, 21);
    assert.strictEqual(window[9].id, 30);
  });

  it("gets nodes by range", () => {
    const chain = new Chain();
    for (let i = 0; i < 10; i++) {
      chain.appendTurn(`q${i}`, `a${i}`);
    }

    const range = chain.range(3, 7);
    assert.strictEqual(range.length, 5);
    assert.strictEqual(range[0].id, 3);
    assert.strictEqual(range[4].id, 7);
  });

  it("removes nodes by range", () => {
    const chain = new Chain();
    for (let i = 0; i < 10; i++) {
      chain.appendTurn(`q${i}`, `a${i}`);
    }

    const removed = chain.remove(3, 7);
    assert.strictEqual(removed.length, 5);
    assert.strictEqual(chain.length, 5);
  });

  it("still supports single-role append for backwards compat", () => {
    const chain = new Chain();
    const node = chain.append("user", "standalone message");
    assert.strictEqual(node.role, "user");
    assert.strictEqual(node.content, "standalone message");
  });

  it("estimates token count", () => {
    const chain = new Chain();
    const node = chain.appendTurn("hello world this is a test", "yes it is a test indeed");
    assert.ok(node.tokenCount > 0);
    assert.ok(node.tokenCount < 50);
  });

  it("exports and imports state", () => {
    const chain = new Chain();
    chain.appendTurn("hello", "hi");
    chain.appendTurn("bye", "see ya");

    const exported = chain.export();
    const chain2 = new Chain();
    chain2.import(exported);

    assert.strictEqual(chain2.length, 2);
    assert.strictEqual(chain2.all()[0].query, "hello");
    assert.strictEqual(chain2.all()[1].response, "see ya");
  });
});
