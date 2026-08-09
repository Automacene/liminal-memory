/**
 * A chat session built on four pools. This is the part worth copying.
 *
 * In your own project the import is the package name:
 *   import { LiminalMemory } from "@automacene/liminal-memory";
 */
import { LiminalMemory } from "../../src/index.js";
import { interpretForTools, reply as fakeReply } from "./fake-llm.js";

/**
 * The four pools and why they are separate:
 *
 * `active`  the last N turns. Always sent to the model in full, and never searched, because
 *           searching what you are already sending is wasted work.
 * `recall`  every turn that has aged out of active. Turns are not copied here on creation,
 *           they are moved here when they slide out, so there is exactly one copy of each turn
 *           and the two pools can never return the same thing twice.
 * `nudge`   capped at one. A one-shot instruction that rides along with the next prompt and is
 *           thrown away immediately after.
 * `tools`   filled once at session start. Short descriptions that would rank strangely if they
 *           shared an index with long conversation turns.
 */
export class ChatSession {
  /**
   * @param {object} [options]
   * @param {number} [options.windowSize]  how many turns stay in the active pool
   * @param {() => number} [options.now]  clock, for reproducible timestamps
   */
  constructor({ windowSize = 60, now = Date.now } = {}) {
    this.windowSize = windowSize;

    this.memory = new LiminalMemory({ defaultPool: "active", now });

    // Aging out of active is what fills recall. The hook receives the nodes on their way out,
    // and putting them straight into another pool is all "long term memory" means here.
    this.memory.pool("active", {
      onEvict: async nodes => {
        for (const node of nodes) {
          await this.memory.pool("recall").create({
            id: node.id,
            content: node.content,
            metadata: node.metadata
          });
        }
      }
    });

    this.memory.pool("recall");
    this.memory.pool("tools");

    // Consumed nudges are kept only so the example can show they fired exactly once.
    this.consumedNudges = [];
    this.memory.pool("nudge", {
      onEvict: nodes => this.consumedNudges.push(...nodes)
    });
  }

  /**
   * Stand up the tool pool. Called once, at session start.
   * @param {object[]} definitions
   */
  async registerTools(definitions) {
    for (const definition of definitions) {
      await this.memory.pool("tools").create({
        id: `tool-${definition.name}`,
        content: definition
      });
    }
  }

  /**
   * Queue a one-shot instruction for the next turn. The pool holds one, so a second nudge
   * pushes the first out rather than stacking up.
   * @param {string} text
   */
  async nudge(text) {
    const pool = this.memory.pool("nudge");
    if (pool.size > 0) await pool.evictOldest(pool.size);

    return pool.create({ content: text });
  }

  /**
   * One full turn.
   *
   * @param {string} userText
   * @param {object} [options]
   * @param {string} [options.scripted]  replaying a recorded conversation: use this as the
   *   assistant's reply rather than generating one, so what lands in memory is the real
   *   transcript. Leave it off and the model answers for itself.
   * @returns {Promise<{reply: string, prompt: string, recalled: object[], ranked: {node: object, score: number}[], tools: object[], nudge: object|null}>}
   */
  async send(userText, { scripted = null } = {}) {
    const active = this.memory.pool("active");

    // The turn node exists before anything is searched, because it is the node doing the
    // asking. Recall links what it finds back to this node, and leaves it out of its own
    // results.
    const turn = await active.create({ content: { user: userText, assistant: null } });

    // rank rather than search, because the scores are worth seeing. BM25 on short conversational
    // turns will sometimes rank an incidental one-word overlap above a genuinely relevant turn,
    // and a threshold does not fix that: the incidental match is often the higher score. Showing
    // the number is more honest than pretending a cutoff sorts it out.
    const ranked = await this.memory.pool("recall").rank(userText, { from: turn, limit: 3 });
    const recalled = ranked.map(hit => hit.node);

    // The model decides whether it wants a tool and says what it is after. Its phrasing is
    // what searches the tool pool, not the user's raw words.
    const intent = interpretForTools(userText);
    const toolHits = intent
      ? await this.memory.pool("tools").rank(intent, { limit: 2 })
      : [];
    const tools = toolHits.map(hit => hit.node);

    const nudge = this.memory.pool("nudge").list()[0] ?? null;

    const prompt = this.buildPrompt({ userText, recalled, tools, nudge });
    const reply = fakeReply({ userText, recalled, tools, nudge, scripted });

    await active.update(turn.id, { content: { user: userText, assistant: reply } });

    // The nudge fired, so it goes. One turn is its whole life.
    if (nudge) await this.memory.pool("nudge").evictOldest(1);

    await this.trimWindow();

    return { reply, prompt, recalled, ranked, tools, toolHits, intent, nudge, turn: this.memory.get(turn.id) };
  }

  /**
   * Assemble what would be sent to the model.
   *
   * Note what this library did not do for you: there is no token counting anywhere. The active
   * window is capped by turn count because that is easy to read in an example. Budgeting by
   * tokens is the caller's job, and this is the function where you would do it.
   */
  buildPrompt({ userText, recalled, tools, nudge }) {
    const sections = ["[system] You are a helpful assistant."];

    if (tools.length > 0) {
      const lines = tools.map(node => {
        const tool = node.content;
        return `- ${tool.name}(${JSON.stringify(tool.call)}) -> ${JSON.stringify(tool.returns)}\n  ${tool.description}`;
      });
      sections.push(`[tools available]\n${lines.join("\n")}`);
    }

    const window = this.memory.pool("active").list()
      .filter(node => node.content.assistant !== null)
      .map(node => `user: ${node.content.user}\nassistant: ${node.content.assistant}`);

    sections.push(`[conversation]\n${window.join("\n")}`);

    // Recalled turns sit below the recent conversation rather than above it, so the model reads
    // them as older material being brought back rather than as the start of the thread.
    if (recalled.length > 0) {
      const lines = recalled.map(node =>
        `- ${node.content.user}\n  ${node.content.assistant}`
      );
      sections.push(`[recalled memories]\n${lines.join("\n")}`);
    }

    if (nudge) sections.push(`[nudge] ${nudge.content}`);

    sections.push(`[user] ${userText}`);

    return sections.join("\n\n");
  }

  /**
   * Push anything past the window into recall, via the eviction hook.
   */
  async trimWindow() {
    const active = this.memory.pool("active");
    const over = active.size - this.windowSize;
    if (over > 0) await active.evictOldest(over);
  }

  /**
   * What a plain sliding window would have sent, with no recall at all. Used by the demo to
   * show the difference rather than assert it in a comment.
   */
  windowOnlyPrompt(userText) {
    return this.buildPrompt({ userText, recalled: [], tools: [], nudge: null });
  }

  stats() {
    return {
      active: this.memory.pool("active").size,
      recall: this.memory.pool("recall").size,
      nudge: this.memory.pool("nudge").size,
      tools: this.memory.pool("tools").size,
      total: this.memory.size
    };
  }
}
