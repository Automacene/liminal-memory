/**
 * Ephemeral Mind — Internal reasoning scratchpad for the Sovereign Mind.
 *
 * NOT a separate agent. This is the Sovereign thinking at a different speed —
 * raw, adversarial, without thinking tags. It forces self-criticism by requiring
 * a structured payload that identifies unresolved tensions.
 *
 * The structured output drives the continue/end loop:
 * - thought_block: raw analysis (gets stored as chain node)
 * - resolved_nodes: what's been figured out (compressed summary)
 * - unresolved_tension: what's still broken/incomplete (drives next iteration)
 * - requires_further_recursion: boolean gate
 */
import { Tool } from "../tools/base.js";

/**
 * Few-shot template injected into the ephemeral system prompt.
 * Shows the model exactly what output structure we expect.
 */
const EPHEMERAL_FEW_SHOT = `
INPUT: "What are the tradeoffs between approach A and B for handling X?"

OUTPUT:
\`\`\`json
{
  "thought_block": "Approach A offers lower latency due to direct memory access, but sacrifices consistency under concurrent writes. Approach B guarantees consistency via locks but introduces 3-5ms overhead per operation. For read-heavy workloads (>80% reads), A dominates. For write-heavy, B is necessary despite the cost.",
  "resolved_nodes": ["A: latency advantage quantified", "B: consistency guarantee confirmed", "workload threshold identified at 80/20 split"],
  "unresolved_tension": "What happens in mixed workloads (50/50 read/write)? Neither approach clearly wins and a hybrid strategy hasn't been evaluated.",
  "requires_further_recursion": true
}
\`\`\`

INPUT: "Verify whether the hybrid approach resolves the 50/50 workload tension."

OUTPUT:
\`\`\`json
{
  "thought_block": "A hybrid using A for reads and B for writes with a queue boundary achieves 2ms average latency while maintaining consistency. The queue adds 0.5ms but eliminates lock contention. This resolves the mixed workload gap.",
  "resolved_nodes": ["hybrid approach validated", "queue boundary latency measured at 0.5ms", "lock contention eliminated"],
  "unresolved_tension": "",
  "requires_further_recursion": false
}
\`\`\`
`;

const EPHEMERAL_SYSTEM_PROMPT = `You are the Ephemeral Mind — the raw analytical scratchpad of a larger reasoning system. Your job is NOT to be agreeable. You are a skeptical auditor.

RULES:
1. Look for edge cases, missing logic, hidden contradictions, and structural flaws in the directive you receive.
2. Work through the problem step by step with concrete specifics — no vague generalities.
3. You MUST output a strict JSON payload. Nothing else — no commentary before or after the JSON.
4. If something is genuinely unresolved, you MUST state it clearly in unresolved_tension and set requires_further_recursion to true.
5. If you have fully resolved the directive with no remaining gaps, set unresolved_tension to "" and requires_further_recursion to false.
6. Do NOT be lazy. Do NOT fake a tension just to loop. Do NOT say "everything looks good" if it doesn't.

OUTPUT FORMAT (strict JSON, no markdown fences around it):
${EPHEMERAL_FEW_SHOT}

Now process the following directive and output ONLY the JSON payload:`;

/**
 * Parse the ephemeral response into a structured payload.
 * Handles: valid JSON, malformed JSON (repair), and pure text fallback.
 * @param {string} rawOutput
 * @returns {{ thought_block: string, resolved_nodes: string[], unresolved_tension: string, requires_further_recursion: boolean }}
 */
export function parseEphemeralPayload(rawOutput) {
  const fallback = {
    thought_block: rawOutput || '',
    resolved_nodes: [],
    unresolved_tension: '',
    requires_further_recursion: false
  };

  if (!rawOutput || rawOutput.trim().length === 0) return fallback;

  // Strip markdown fences if present
  let cleaned = rawOutput
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Try to find JSON by brace-depth matching
  const openIdx = cleaned.indexOf('{');
  if (openIdx === -1) return fallback;

  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0) { closeIdx = i + 1; break; }
    }
  }

  if (closeIdx <= openIdx) return fallback;

  const jsonStr = cleaned.slice(openIdx, closeIdx);

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      thought_block: parsed.thought_block || parsed.analysis || parsed.thought || rawOutput,
      resolved_nodes: Array.isArray(parsed.resolved_nodes) ? parsed.resolved_nodes : [],
      unresolved_tension: parsed.unresolved_tension || parsed.tension || '',
      requires_further_recursion: Boolean(parsed.requires_further_recursion)
    };
  } catch (e) {
    // JSON parse failed — attempt basic field extraction via regex
    const thoughtMatch = jsonStr.match(/"thought_block"\s*:\s*"([\s\S]*?)(?:"|$)/);
    const tensionMatch = jsonStr.match(/"unresolved_tension"\s*:\s*"([\s\S]*?)(?:"|$)/);
    const recursionMatch = jsonStr.match(/"requires_further_recursion"\s*:\s*(true|false)/);

    if (thoughtMatch) {
      return {
        thought_block: thoughtMatch[1],
        resolved_nodes: [],
        unresolved_tension: tensionMatch ? tensionMatch[1] : '',
        requires_further_recursion: recursionMatch ? recursionMatch[1] === 'true' : false
      };
    }

    // Total failure — use raw text as thought_block, pull last sentence as tension hint
    const sentences = rawOutput.split(/[.!?]\s+/);
    const lastSentence = sentences.length > 1 ? sentences[sentences.length - 1] : '';
    return {
      thought_block: rawOutput,
      resolved_nodes: [],
      unresolved_tension: lastSentence.length > 15 ? lastSentence : '',
      requires_further_recursion: false
    };
  }
}

/**
 * Validate that an unresolved_tension is real and anchored to the problem domain.
 * Checks: minimum length + entity overlap with the original query.
 * @param {string} tension
 * @param {string} originalQuery
 * @returns {boolean}
 */
export function validateTension(tension, originalQuery) {
  if (!tension || tension.length < 15) return false;

  // Extract meaningful words (4+ chars) from the original query
  const queryWords = new Set(
    originalQuery.toLowerCase().split(/\W+/).filter(w => w.length >= 4)
  );

  // Extract words from the tension
  const tensionWords = tension.toLowerCase().split(/\W+/).filter(w => w.length >= 4);

  // Require at least one domain noun overlap
  const overlap = tensionWords.filter(w => queryWords.has(w));
  return overlap.length >= 1;
}

/**
 * Create the Ephemeral Mind tool.
 * @param {object} config
 * @param {import('../transport/llm.js').LLMTransport} config.transport - LLM transport instance
 * @param {object} config.memoryConfig - the live config object (for toggling thinking)
 * @returns {Tool}
 */
export function createEphemeralMindTool({ transport, memoryConfig }) {
  return new Tool({
    name: "ephemeral_mind",
    discovery: "llm",
    description: "Use this tool when you need to reason through a complex problem, work out logic step-by-step, analyze tradeoffs, deliberate between options, or think deeply before responding. Call it to get a focused analysis back that you can then use in your final answer to the user. You SHOULD use this for any question involving: comparisons, multi-step reasoning, technical analysis, design decisions, debugging logic, or synthesizing multiple pieces of information.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to think about, reason through, or work out internally"
        }
      },
      required: ["query"]
    },
    execute: async function (params, context) {
      const query = params.query;
      if (!query) throw new Error("ephemeral_mind requires a query");

      // Snapshot thinking state, disable for ephemeral
      const wasThinking = memoryConfig.thinking;
      memoryConfig.thinking = false;

      try {
        const messages = [
          { role: "system", content: EPHEMERAL_SYSTEM_PROMPT },
          { role: "user", content: query }
        ];

        const { text } = await transport.complete(messages);
        const payload = parseEphemeralPayload(text);

        return {
          result: payload,
          formatted: payload.thought_block
        };
      } finally {
        memoryConfig.thinking = wasThinking;
      }
    }
  });
}

export { EPHEMERAL_SYSTEM_PROMPT };
