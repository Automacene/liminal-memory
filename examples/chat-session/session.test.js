/**
 * The example doubles as the integration test. Everything asserted here is something the demo
 * output claims, so the two cannot drift apart.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { ChatSession } from "./session.js";
import { buildTranscript, TOOLS, PLANTED, PLANTED_TURN, FINAL_QUESTION } from "./fixtures.js";

const WINDOW = 60;
const TURNS = 99;
const NUDGE_AT = 40;
const NUDGE_TEXT = "Keep answers to one sentence.";

/** One session, replayed once, shared by every test below. */
let session;
let transcript;
let turnResults;

before(async () => {
  const clock = { t: 1_700_000_000_000 };
  session = new ChatSession({ windowSize: WINDOW, now: () => (clock.t += 1000) });

  await session.registerTools(TOOLS);

  transcript = buildTranscript(TURNS);
  turnResults = [];

  for (const [index, turn] of transcript.entries()) {
    if (index === NUDGE_AT) await session.nudge(NUDGE_TEXT);
    turnResults.push(await session.send(turn.user, { scripted: turn.assistant }));
  }
});

describe("the window stays bounded and nothing is lost", () => {
  test("active never grows past the window", () => {
    assert.equal(session.stats().active, WINDOW);
  });

  test("every turn is in exactly one of the two pools", () => {
    const { active, recall } = session.stats();
    assert.equal(active + recall, TURNS, "no turn was dropped and none was duplicated");
  });

  test("a turn that aged out is gone from active and present in recall", () => {
    const planted = session.memory.pool("recall").list()
      .find(node => node.content.user === PLANTED_TURN.user);

    assert.ok(planted, "the planted turn reached recall");
    assert.equal(planted.pool, "recall");

    const stillActive = session.memory.pool("active").list()
      .some(node => node.content.user === PLANTED_TURN.user);
    assert.equal(stillActive, false);
  });
});

describe("recall finds what the window lost", () => {
  test("the planted answer is not in a plain sliding-window prompt", () => {
    const prompt = session.windowOnlyPrompt(FINAL_QUESTION);
    assert.equal(prompt.includes("Apache 2.0"), false);
    assert.equal(prompt.includes("patent grant"), false);
  });

  test("recall returns the whole cluster, not just the closest single turn", async () => {
    const hits = await session.memory.pool("recall").search(FINAL_QUESTION, { link: false });

    assert.equal(hits.length, PLANTED.length, "every planted turn came back");

    const users = hits.map(node => node.content.user).sort();
    assert.deepEqual(users, PLANTED.map(turn => turn.user).sort());
  });

  test("the assembled prompt carries the answer through to the model", async () => {
    const result = await session.send(FINAL_QUESTION);

    assert.match(result.prompt, /Apache 2\.0/);
    assert.match(result.prompt, /\[recalled memories\]/);
    assert.ok(
      result.reply.includes(result.recalled[0].content.assistant),
      "the reply quotes back a recalled turn, so it could only have come from the prompt"
    );
  });

  test("recalled memories sit below the recent conversation", async () => {
    const result = await session.send("what did we decide about the license again");

    assert.ok(
      result.prompt.indexOf("[recalled memories]") > result.prompt.indexOf("[conversation]"),
      "older material is presented as recalled, not as the start of the thread"
    );
  });
});

describe("the tool pool is searched by the model's intent, not the raw query", () => {
  test("a spending question reaches the expense tool", () => {
    const spendTurn = turnResults.find((_, i) =>
      transcript[i].user.includes("spend on cloud")
    );

    assert.ok(spendTurn, "the transcript contains a spending question");
    assert.deepEqual(spendTurn.tools.map(node => node.content.name), ["expense_lookup"]);
  });

  test("the user's own words would not have found the calendar tool", async () => {
    // "are we booked for anything friday" shares no term at all with a description reading
    // "Find scheduled meetings, standups, and events on the team calendar". The model's
    // rephrasing is what bridges the gap, which is the whole reason that step exists.
    const raw = await session.memory.pool("tools")
      .search("are we booked for anything friday", { link: false });
    assert.equal(raw.length, 0, "the raw question matches nothing in the tool pool");

    const viaIntent = await session.memory.pool("tools")
      .search("find scheduled meetings on the calendar", { link: false });
    assert.deepEqual(viaIntent.map(node => node.content.name), ["calendar_search"]);
  });

  test("that calendar turn did reach the tool during the session", () => {
    const turn = turnResults.find((_, i) => transcript[i].user.includes("booked for anything"));
    assert.deepEqual(turn.tools.map(node => node.content.name), ["calendar_search"]);
  });

  test("a question needing no tool gets none", () => {
    const plain = turnResults.find((_, i) => transcript[i].user === "coffee machine is broken again");
    assert.deepEqual(plain.tools, []);
  });

  test("tools stay put for the whole session", () => {
    assert.equal(session.stats().tools, TOOLS.length);
  });
});

describe("the nudge fires once", () => {
  test("it rides along with exactly one prompt", () => {
    const carried = turnResults.filter(result => result.prompt.includes(`[nudge] ${NUDGE_TEXT}`));
    assert.equal(carried.length, 1);
  });

  test("it is the turn right after it was queued", () => {
    const label = `[nudge] ${NUDGE_TEXT}`;
    assert.ok(turnResults[NUDGE_AT].prompt.includes(label));
    assert.equal(turnResults[NUDGE_AT + 1].prompt.includes(label), false);
  });

  test("the pool is empty afterwards and the nudge was handed to the hook", () => {
    assert.equal(session.stats().nudge, 0);
    assert.equal(session.consumedNudges.length, 1);
    assert.equal(session.consumedNudges[0].content, NUDGE_TEXT);
  });

  test("queueing a second nudge replaces the first rather than stacking", async () => {
    const fresh = new ChatSession({ windowSize: 5, now: () => 1 });
    await fresh.nudge("first");
    await fresh.nudge("second");

    assert.equal(fresh.memory.pool("nudge").size, 1);
    assert.equal(fresh.memory.pool("nudge").list()[0].content, "second");
  });
});

describe("edges cross pools", () => {
  test("the asking turn in active links to what it recalled in recall", async () => {
    const result = await session.send("anything else about the sdk licensing decision");

    const edges = session.memory.neighbors(result.turn.id);
    assert.ok(edges.length > 0, "the search wrote an edge");

    const target = session.memory.get(edges[0].id);
    assert.equal(result.turn.pool, "active");
    assert.equal(target.pool, "recall");
    assert.equal(typeof edges[0].observedAt, "number", "search-written edges carry a time");
  });

  test("the asking turn is never returned as its own memory", async () => {
    const result = await session.send(PLANTED_TURN.user);
    assert.equal(result.recalled.some(node => node.id === result.turn.id), false);
  });
});

describe("the same question twice gives the same answer", () => {
  test("results are identical, in the same order", async () => {
    const pool = session.memory.pool("recall");

    const first = await pool.search(FINAL_QUESTION, { link: false });
    const second = await pool.search(FINAL_QUESTION, { link: false });

    assert.deepEqual(first.map(node => node.id), second.map(node => node.id));
  });

  test("a whole replayed session lands in the same state twice", async () => {
    const replay = async () => {
      const clock = { t: 1_700_000_000_000 };
      const s = new ChatSession({ windowSize: WINDOW, now: () => (clock.t += 1000) });
      await s.registerTools(TOOLS);

      for (const turn of buildTranscript(TURNS)) {
        await s.send(turn.user, { scripted: turn.assistant });
      }

      const hits = await s.memory.pool("recall").search(FINAL_QUESTION, { link: false });
      return { stats: s.stats(), hits: hits.map(node => node.content.user) };
    };

    assert.deepEqual(await replay(), await replay());
  });
});

describe("a session survives a snapshot", () => {
  test("recall still answers after being serialized and loaded back", async () => {
    const snapshot = JSON.parse(JSON.stringify(session.memory));

    const restored = new ChatSession({ windowSize: WINDOW });
    restored.memory.load(snapshot);

    const hits = await restored.memory.pool("recall").search(FINAL_QUESTION, { link: false });

    assert.match(hits[0].content.assistant, /Apache 2\.0/, "searchable with no rebuild step");
  });
});
