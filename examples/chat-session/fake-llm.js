/**
 * A stand-in for a language model. Deterministic, offline, and about forty lines.
 *
 * The example needs a model for two jobs, and both are faked here so the whole thing runs in
 * CI with no network and no api key.
 */

/**
 * Job one: decide whether the user wants a tool, and say what it is looking for.
 *
 * This is the part a real model does with function calling. It reads the user's message and
 * emits its own phrasing of the intent, which is what then gets searched against the tool
 * pool. The distinction matters: the search phrase is the model's interpretation, not the raw
 * user text. People ask "what did we blow on servers last month", and the words that actually
 * match a tool description are "total spending over a date range".
 *
 * The keyword matching below is a crude imitation of that step. A real model would be better
 * at it. What the example is showing is where the step sits, not how to do it well.
 *
 * @param {string} userText
 * @returns {string|null} the model's phrasing of what it wants, or null for no tool
 */
export function interpretForTools(userText) {
  const text = userText.toLowerCase();

  if (/(spend|spent|cost|bill|budget|invoice)/.test(text)) {
    return "total spending amount over a date range";
  }
  if (/(meeting|standup|calendar|schedule|booked|retro)/.test(text)) {
    return "find scheduled meetings on the calendar";
  }
  if (/(function|code|implementation|where is|defined)/.test(text)) {
    return "search the source code for a symbol";
  }
  if (/(weather|rain|forecast|temperature)/.test(text)) {
    return "current weather forecast for a city";
  }

  return null;
}

/**
 * Job two: write the reply.
 *
 * A real model would read the whole prompt. This reads just enough of it to prove the prompt
 * carried what it was supposed to carry, which is the only thing the example is testing.
 *
 * @param {object} context
 * @param {string} context.userText
 * @param {object[]} context.recalled  nodes pulled out of the recall pool
 * @param {object[]} context.tools  tool nodes the interpreted intent matched
 * @param {object|null} context.nudge  the one-shot instruction, if one was waiting
 * @param {string|null} [context.scripted]  when replaying a recorded conversation, the reply
 *   that was actually given at the time. Used instead of inventing one, so the transcript that
 *   goes into memory is the real thing rather than this function's output.
 * @returns {string}
 */
export function reply({ userText, recalled, tools, nudge, scripted = null }) {
  const parts = [];

  if (nudge) parts.push(`(following the nudge: ${nudge.content})`);

  if (tools.length > 0) {
    const tool = tools[0].content;
    parts.push(`calling ${tool.name}(${Object.keys(tool.call).join(", ")})`);
  }

  if (scripted) {
    parts.push(scripted);
    return parts.join(" ");
  }

  if (recalled.length > 0) {
    // Quoting the recalled turn back is what makes the demo checkable: if the fact was not in
    // the prompt, it cannot appear here.
    parts.push(`from earlier: "${recalled[0].content.assistant}"`);
  } else {
    parts.push(`nothing on file about "${userText.slice(0, 40)}"`);
  }

  return parts.join(" ");
}
