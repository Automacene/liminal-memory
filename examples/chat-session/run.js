/**
 * Watch a 99-turn conversation go by, then watch recall pull back something that scrolled off
 * the top 40 turns ago.
 *
 *   npm run example                 default pace
 *   npm run example -- --fast       no delay, straight to the end
 *   npm run example -- --slow       readable pace
 *   npm run example -- --delay=200  whatever you like, in milliseconds
 *
 * Every claim printed at the end is measured during the run, not decided in advance.
 */
import { ChatSession } from "./session.js";
import { buildTranscript, TOOLS, PLANTED, FINAL_QUESTION } from "./fixtures.js";

const WINDOW = 60;
const TURNS = 99;
const NUDGE_AT = 40;
const NUDGE_TEXT = "Keep answers to one sentence.";

const delay = parseDelay(process.argv.slice(2));
const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

function parseDelay(args) {
  if (args.includes("--fast")) return 0;
  if (args.includes("--slow")) return 220;

  const explicit = args.find(a => a.startsWith("--delay="));
  if (explicit) return Math.max(0, Number(explicit.split("=")[1]) || 0);

  return 45;
}

function rule(char = "-") {
  console.log(char.repeat(78));
}

function heading(text) {
  console.log(`\n${"=".repeat(78)}\n  ${text}\n${"=".repeat(78)}\n`);
}

/** Wrap long text under a fixed left gutter so the transcript stays readable. */
function wrap(text, gutter, width = 78) {
  const room = width - gutter.length;
  const lines = [];
  let line = "";

  for (const word of String(text).split(" ")) {
    if (line.length + word.length + 1 > room && line) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);

  return lines.map((l, i) => (i === 0 ? gutter : " ".repeat(gutter.length)) + l).join("\n");
}

function printPrompt(prompt) {
  const sections = prompt.split("\n\n").map(section => {
    if (!section.startsWith("[conversation]")) return section;
    const lines = section.split("\n");
    return [...lines.slice(0, 5), `... ${lines.length - 5} more lines of recent chatter`].join("\n");
  });

  console.log(sections.join("\n\n").split("\n").map(l => `  ${l}`).join("\n"));
}

const clock = { t: 1_700_000_000_000 };
const session = new ChatSession({ windowSize: WINDOW, now: () => (clock.t += 1000) });
await session.registerTools(TOOLS);

// Filled in while the conversation runs. The summary at the end reports these rather than
// recomputing something that might not match what went past on screen.
const plantedAt = new Set(PLANTED.map(turn => turn.at));
const plantedUsers = new Set(PLANTED.map(turn => turn.user));

const seen = {
  maxActive: 0,
  evictedAt: null,
  evictedCount: 0,
  toolTurns: [],
  nudgeTurns: []
};

heading("A conversation, one turn at a time");
console.log(`  window ${WINDOW} turns   replaying ${TURNS} turns   ${delay}ms per turn`);
console.log(`  every turn shows what each pool returned for it, with scores.`);
console.log();

const transcript = buildTranscript(TURNS);

/**
 * One turn, laid out the way the prompt is laid out. Every section below the exchange is the
 * result of searching a pool, so each one shows its hits with scores, or None.
 */
function printTurn(index, turn, result, evicted) {
  const stats = session.stats();

  console.log(`turn ${index + 1}/${TURNS}`);
  console.log(`[pools]    active ${stats.active}   recall ${stats.recall}   ` +
    `nudge ${stats.nudge}   tools ${stats.tools}`);

  console.log(wrap(turn.user, "> ") + (plantedAt.has(index) ? "   <-- remember this one" : ""));
  console.log(wrap(result.reply, "< "));
  console.log();

  printHits("[recalled]", result.ranked, hit => hit.node.content.user);
  printHits("[tools]", result.toolHits, hit => hit.node.content.name);

  console.log(`[nudges]   ${result.nudge ? `"${result.nudge.content}"  (consumed)` : "None"}`);

  for (const node of evicted) {
    const note = plantedUsers.has(node.content.user) ? "   <-- there it goes" : "";
    console.log(`[dropped]  "${node.content.user.slice(0, 44)}"${note}`);
  }
}

/** A pool's search results: None on one line, or the header then a scored line each. */
function printHits(header, hits, describe) {
  if (hits.length === 0) {
    console.log(`${header.padEnd(10)} None`);
    return;
  }

  console.log(header);
  for (const hit of hits) {
    console.log(`${hit.score.toFixed(2).padStart(6)}  "${describe(hit).slice(0, 58)}"`);
  }
}

for (const [index, turn] of transcript.entries()) {
  if (index === NUDGE_AT) {
    await session.nudge(NUDGE_TEXT);
    console.log(`[queued]   "${NUDGE_TEXT}"\n`);
  }

  const before = session.stats();
  const result = await session.send(turn.user, { scripted: turn.assistant });
  const after = session.stats();

  const moved = after.recall - before.recall;
  const evicted = moved > 0 ? session.memory.pool("recall").list().slice(-moved) : [];

  printTurn(index, turn, result, evicted);

  if (result.tools.length > 0) seen.toolTurns.push({ turn: index + 1 });
  if (result.nudge) seen.nudgeTurns.push(index + 1);

  for (const node of evicted) {
    if (plantedUsers.has(node.content.user)) {
      seen.evictedCount++;
      if (seen.evictedAt === null) seen.evictedAt = index + 1;
    }
  }

  seen.maxActive = Math.max(seen.maxActive, after.active);

  console.log();
  await sleep(delay);
}

heading("Now ask about it");
console.log(`  The first turn you were told to remember fell out of the window at turn`);
console.log(`  ${seen.evictedAt}, and all ${seen.evictedCount} of them are behind us now. A plain sliding window`);
console.log(`  would send this:\n`);
await sleep(delay * 8);

const windowOnlyPrompt = session.windowOnlyPrompt(FINAL_QUESTION);

rule();
printPrompt(windowOnlyPrompt);
rule();

console.log(`\n  The answer is not in there. Same question, with recall:\n`);
await sleep(delay * 8);

const final = await session.send(FINAL_QUESTION);

const finalStats = session.stats();
console.log(`turn ${TURNS + 1}/${TURNS + 1}`);
console.log(`[pools]    active ${finalStats.active}   recall ${finalStats.recall}   ` +
  `nudge ${finalStats.nudge}   tools ${finalStats.tools}`);
console.log(wrap(FINAL_QUESTION, "> "));
console.log();
printHits("[recalled]", final.ranked, hit => hit.node.content.user);
printHits("[tools]", final.toolHits, hit => hit.node.content.name);
console.log(`[nudges]   ${final.nudge ? `"${final.nudge.content}"` : "None"}`);
console.log();
console.log("  which builds this prompt:\n");

rule();
printPrompt(final.prompt);
rule();

console.log();
console.log(wrap(final.reply, "  reply: "));

heading("What you just watched, measured");

const stats = session.stats();
const firstRun = await session.memory.pool("recall").search(FINAL_QUESTION, { link: false });
const secondRun = await session.memory.pool("recall").search(FINAL_QUESTION, { link: false });
const edges = session.memory.neighbors(final.turn.id);
const linkedTo = edges.length > 0 ? session.memory.get(edges[0].id) : null;

const checks = [
  [
    "the window never grew past its cap",
    `high water mark was ${seen.maxActive} of ${WINDOW}`,
    seen.maxActive === WINDOW
  ],
  [
    "nothing was lost or duplicated on the way out",
    `active ${stats.active} plus recall ${stats.recall} is ${stats.active + stats.recall}, and ${TURNS + 1} turns were sent`,
    stats.active + stats.recall === TURNS + 1
  ],
  [
    "the answer really was missing from the sliding window",
    `that prompt was ${windowOnlyPrompt.length} characters and none of them spelled Apache`,
    !windowOnlyPrompt.includes("Apache")
  ],
  [
    "recall brought back the whole cluster, not just one turn",
    `${final.recalled.length} turns came back, from positions ${PLANTED.map(p => p.at + 1).join(", ")}`,
    final.recalled.length === PLANTED.length &&
      final.recalled.every(node => plantedUsers.has(node.content.user))
  ],
  [
    "the reply could only have come from what was recalled",
    `it quotes the top recalled turn back, word for word`,
    final.recalled.length > 0 && final.reply.includes(final.recalled[0].content.assistant)
  ],
  [
    "tools were chosen by the model rather than by matching the user's words",
    seen.toolTurns.length > 0
      ? `${seen.toolTurns.length} turns picked one out of the ${TOOLS.length} on offer, first at turn ${seen.toolTurns[0].turn}`
      : "none were called",
    seen.toolTurns.length > 0
  ],
  [
    "the nudge fired exactly once",
    `carried on turn ${seen.nudgeTurns.join(", ") || "none"}, and the pool now holds ${stats.nudge}`,
    seen.nudgeTurns.length === 1 && stats.nudge === 0
  ],
  [
    "the search wrote an edge from one pool into another",
    linkedTo ? `${final.turn.pool} to ${linkedTo.pool}` : "no edge was written",
    linkedTo?.pool === "recall" && final.turn.pool === "active"
  ],
  [
    "asking the same thing twice gives the same answer",
    `${firstRun.length} back both times, in the same order`,
    JSON.stringify(firstRun.map(n => n.id)) === JSON.stringify(secondRun.map(n => n.id))
  ]
];

let failed = 0;
for (const [claim, detail, ok] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${claim}`);
  console.log(`          ${detail}`);
}

console.log();
console.log(`  ${checks.length - failed} of ${checks.length} confirmed.`);
console.log(`  Run "npm run test:examples" for the same claims as assertions.`);
console.log();

if (failed > 0) process.exitCode = 1;
