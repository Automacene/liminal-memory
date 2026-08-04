/**
 * ConversationManager — responsible for calculating how all the pieces
 * fit together within the model's context window.
 * 
 * It manages:
 * - System prompt budget
 * - Attached context budget (PDFs, code, etc.)
 * - Recall buffer budget (retrieved historical nodes)
 * - Sliding buffer budget (recent conversation)
 * 
 * And ensures the combined total never exceeds the model's context limit.
 * 
 * Budget allocation:
 *   totalBudget = maxTokenBudget - reservedTokens
 *   systemBudget = tokens used by system prompt + attached context
 *   recallBudget = configurable portion of remaining budget
 *   slidingBudget = everything left after system + recall
 */
import { SlidingBuffer, RecallBuffer } from "./buffer.js";

export class ConversationManager {
  constructor(config) {
    this.config = config;
    this.attachedContext = []; // additional context (PDFs, code, etc.)
  }

  /**
   * Calculate the total available token budget after system prompt + attached context.
   * @returns {{ total: number, system: number, available: number }}
   */
  getBudget() {
    const total = this.config.maxTokenBudget - this.config.reservedTokens;
    const systemTokens = this._systemTokens();
    const available = Math.max(0, total - systemTokens);
    return { total, system: systemTokens, available };
  }

  /**
   * Build the full prompt: system + recall + sliding window.
   * Ensures everything fits within budget.
   * 
   * @param {object[]} chainNodes - all nodes in the chain
   * @param {{ node: object, score: number }[]} retrievedNodes - scored recall candidates
   * @returns {{ messages: object[], slidingBuffer: object, recallBuffer: object }}
   */
  buildPrompt(chainNodes, retrievedNodes = []) {
    const { available } = this.getBudget();
    
    // Split available budget between recall and sliding
    // Recall gets up to 30% of available, sliding gets the rest
    const recallRatio = this.config.recallBufferRatio || 0.3;
    const recallBudget = Math.floor(available * recallRatio);
    const slidingBudget = available - recallBudget;

    // Fill recall buffer (best-matching historical nodes, pruned to fit)
    const recallBuffer = new RecallBuffer({ maxTokens: recallBudget });
    if (retrievedNodes.length > 0) {
      recallBuffer.fill(retrievedNodes);
    }

    // Give unused recall budget to sliding
    const actualRecallUsed = recallBuffer.tokenCount;
    const adjustedSlidingBudget = slidingBudget + (recallBudget - actualRecallUsed);

    // Fill sliding buffer (most recent nodes that fit)
    const slidingBuffer = new SlidingBuffer({
      maxTokens: adjustedSlidingBudget,
      maxNodes: this.config.windowSize
    });
    slidingBuffer.fill(chainNodes);

    // Assemble final messages array
    const messages = [];

    // System prompt
    messages.push({ role: "system", content: this.config.systemPrompt });

    // Attached context (if any)
    if (this.attachedContext.length > 0) {
      const ctxBlock = this.attachedContext
        .map(c => `[${c.type}]: ${c.content}`)
        .join("\n\n");
      messages.push({ role: "system", content: ctxBlock });
    }

    // Recall buffer (historical context, injected before sliding window)
    if (!recallBuffer.isEmpty) {
      const recallMessages = recallBuffer.toMessages();
      const recallBlock = recallMessages
        .map(m => `[Recalled - ${m.role}]: ${m.content}`)
        .join("\n\n");
      messages.push({
        role: "system",
        content: `Relevant context from earlier in this conversation:\n\n${recallBlock}`
      });
    }

    // Sliding window (the recent conversation)
    messages.push(...slidingBuffer.toMessages());

    return {
      messages,
      slidingBuffer: slidingBuffer.status(),
      recallBuffer: recallBuffer.status()
    };
  }

  /**
   * Attach additional context (PDF content, code, etc.) that should be included in every prompt.
   * @param {string} type - label for the context ("pdf", "code", "page", etc.)
   * @param {string} content - the text content
   */
  attachContext(type, content) {
    this.attachedContext.push({ type, content });
  }

  /**
   * Remove all attached context.
   */
  clearContext() {
    this.attachedContext = [];
  }

  /**
   * Check if any context is attached.
   * @returns {boolean}
   */
  hasContext() {
    return this.attachedContext.length > 0;
  }

  /**
   * Estimate tokens used by system prompt + attached context.
   * @returns {number}
   */
  _systemTokens() {
    let tokens = Math.ceil((this.config.systemPrompt || "").length / 4);
    for (const ctx of this.attachedContext) {
      tokens += Math.ceil(ctx.content.length / 4);
    }
    return tokens;
  }
}
