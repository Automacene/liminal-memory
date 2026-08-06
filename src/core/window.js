/**
 * Sliding Window — selects which nodes get fed to the LLM each turn.
 * Every turn the LLM context is cleared and rebuilt from this window.
 */
export class Window {
  constructor(config) {
    this.config = config;
  }

  /**
   * Get the nodes that should be included in the next LLM prompt.
   * Respects both windowSize and maxTokenBudget.
   * @param {import('./chain.js').Chain} chain
   * @returns {object[]} nodes for the prompt
   */
  select(chain) {
    const { windowSize, maxTokenBudget, reservedTokens } = this.config;
    const availableTokens = maxTokenBudget - reservedTokens;
    const candidates = chain.tail(windowSize);

    if (candidates.length === 0) return [];

    // Walk backwards from most recent, accumulating tokens
    let tokenSum = 0;
    let startIdx = candidates.length;

    for (let i = candidates.length - 1; i >= 0; i--) {
      const nodeTokens = candidates[i].tokenCount || 0;
      if (tokenSum + nodeTokens > availableTokens) break;
      tokenSum += nodeTokens;
      startIdx = i;
    }

    return candidates.slice(startIdx);
  }

  /**
   * Build the messages array for the LLM from window nodes + optional retrieved nodes.
   * @param {object[]} windowNodes - nodes from the sliding window
   * @param {object[]} retrievedNodes - historical nodes from retrieval (injected before window)
   * @param {string} systemPrompt - system message
   * @returns {object[]} messages array for the API
   */
  buildMessages(windowNodes, retrievedNodes = [], systemPrompt = "") {
    const messages = [];

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    // Inject retrieved historical context before the window
    if (retrievedNodes.length > 0) {
      const contextBlock = retrievedNodes
        .map(n => `[Recalled — Node ${n.id}] ${n.content}`)
        .join("\n\n");
      messages.push({
        role: "system",
        content: `The following was retrieved from earlier in this conversation because it is relevant to the current question. Use this information directly in your response:\n\n${contextBlock}`
      });
    }

    // Add the sliding window nodes as the conversation
    for (const node of windowNodes) {
      if (node.role === "compaction") {
        const summary = node.metadata?.summary;
        if (summary) {
          messages.push({
            role: "system",
            content: `[Archived conversation summary - Nodes ${node.metadata.startNode}-${node.metadata.endNode}]: ${JSON.stringify(summary)}`
          });
        }
      } else if (node.role === "turn") {
        // Turn nodes contain both query and response — split back into messages
        if (node.query) messages.push({ role: "user", content: node.query });
        let responseContent = node.response || '';
        // Append pocket notes inline with the response
        if (node.pocketNotes && node.pocketNotes.length > 0) {
          const notes = node.pocketNotes.map(n => `[Correction]: ${n.content}`).join('\n');
          responseContent += '\n' + notes;
        }
        if (responseContent) messages.push({ role: "assistant", content: responseContent });
      } else {
        let content = node.content;
        if (node.pocketNotes && node.pocketNotes.length > 0) {
          const notes = node.pocketNotes.map(n => `[Correction]: ${n.content}`).join('\n');
          content += '\n' + notes;
        }
        messages.push({
          role: node.role,
          content: content
        });
      }
    }

    return messages;
  }
}
