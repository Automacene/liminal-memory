/**
 * Deep Retrieval — Hierarchical Branching for complex multi-hop questions.
 * 
 * When a question needs info from multiple archive blocks that won't fit
 * in a single window, the system "drops down" into parallel branches:
 * 1. Each branch gets its own focused LLM call to summarize relevant info
 * 2. All branch summaries are consolidated into one final synthesis prompt
 * 3. Branches are ephemeral — they don't persist in the chain
 */
export class DeepRetrieval {
  constructor(transport, config) {
    this.transport = transport;
    this.config = config;
  }

  /**
   * Determine if deep retrieval should activate.
   * @param {string[]} candidateBlockKeys - archive block keys identified by retrieval
   * @returns {boolean}
   */
  shouldActivate(candidateBlockKeys) {
    if (!this.config.deepRetrievalEnabled) return false;
    return candidateBlockKeys.length >= this.config.deepRetrievalThreshold;
  }

  /**
   * Execute the full deep retrieval flow.
   * @param {string} userQuery - the original user question
   * @param {object[]} windowNodes - current sliding window nodes
   * @param {{ key: string, nodes: object[] }[]} blocks - decompressed archive blocks
   * @param {string} systemPrompt - base system prompt
   * @returns {string} final synthesized response
   */
  async execute(userQuery, windowNodes, blocks, systemPrompt) {
    // Cap branches
    const maxBranches = this.config.maxBranches || 7;
    const activeBlocks = blocks.slice(0, maxBranches);

    // Phase 1: Branch summaries (parallel-ish — sequential for simplicity on local hardware)
    const branchSummaries = [];
    for (const block of activeBlocks) {
      const summary = await this._summarizeBranch(userQuery, block);
      if (summary && summary !== "No relevant information found.") {
        branchSummaries.push({
          key: block.key,
          summary
        });
      }
    }

    // If no branches produced useful info, fall back to simple response
    if (branchSummaries.length === 0) {
      return null; // caller should fall back to normal flow
    }

    // Phase 2: Consolidation — synthesize all branch summaries with the window
    const response = await this._synthesize(userQuery, windowNodes, branchSummaries, systemPrompt);
    return response;
  }

  /**
   * Summarize a single branch (one archive block) relative to the user's question.
   * @param {string} userQuery
   * @param {{ key: string, nodes: object[] }} block
   * @returns {string} condensed summary
   */
  async _summarizeBranch(userQuery, block) {
    const maxTokens = this.config.branchSummaryMaxTokens || 100;

    // Build context from the block's nodes
    const contextText = block.nodes
      .filter(n => n.role !== "compaction")
      .map(n => `[${n.role}]: ${n.content}`)
      .join("\n")
      .slice(0, 8000); // cap raw context to avoid huge prompts

    const messages = [
      {
        role: "system",
        content: `You are extracting relevant information from a historical conversation segment. Answer ONLY the specific sub-question below. Be concise (max ${maxTokens} tokens). If the segment doesn't contain relevant information, respond with exactly: "No relevant information found."`
      },
      {
        role: "user",
        content: `Context from conversation history (archive ${block.key}):\n\n${contextText}\n\nSub-question: Based on this context, what information is relevant to answering: "${userQuery}"?`
      }
    ];

    return await this.transport.complete(messages);
  }

  /**
   * Final synthesis: combine window + branch summaries + question into one response.
   * @param {string} userQuery
   * @param {object[]} windowNodes
   * @param {{ key: string, summary: string }[]} branchSummaries
   * @param {string} systemPrompt
   * @returns {string}
   */
  async _synthesize(userQuery, windowNodes, branchSummaries, systemPrompt) {
    const messages = [];

    // System prompt
    messages.push({
      role: "system",
      content: systemPrompt
    });

    // Inject research findings
    const findings = branchSummaries
      .map((b, i) => `[Research ${i + 1} - ${b.key}]: ${b.summary}`)
      .join("\n\n");

    messages.push({
      role: "system",
      content: `You have retrieved the following information from your conversation history to help answer the user's question. Use these findings alongside the recent conversation:\n\n${findings}`
    });

    // Add sliding window as conversation context
    for (const node of windowNodes) {
      if (node.role === "compaction") {
        const summary = node.metadata?.summary;
        if (summary) {
          messages.push({
            role: "system",
            content: `[Archived summary]: ${JSON.stringify(summary)}`
          });
        }
      } else {
        messages.push({
          role: node.role,
          content: node.content
        });
      }
    }

    return await this.transport.complete(messages);
  }
}
