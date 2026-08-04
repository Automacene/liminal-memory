/**
 * LLM Transport — model-agnostic HTTP client.
 * Talks to any OpenAI-compatible endpoint (llama.cpp, Ollama, LM Studio, OpenAI, etc.)
 * Supports custom formatters for non-standard APIs.
 */
export class LLMTransport {
  constructor(config) {
    this.config = config;
  }

  /**
   * Send a completion request to the LLM.
   * @param {object[]} messages - array of { role, content } message objects
   * @returns {string} the assistant's response text
   */
  async complete(messages) {
    const { apiFormat } = this.config;

    if (apiFormat === "custom" && this.config.formatRequest) {
      return this._customComplete(messages);
    }

    if (apiFormat === "ollama") {
      return this._ollamaComplete(messages);
    }

    // Default: OpenAI-compatible
    return this._openaiComplete(messages);
  }

  /**
   * OpenAI-compatible completion (llama.cpp, LM Studio, vLLM, OpenAI, etc.)
   */
  async _openaiComplete(messages) {
    const url = `${this.config.endpoint}${this.config.completionPath}`;
    const body = {
      model: this.config.model,
      messages,
      stream: false
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }

  /**
   * Ollama-format completion.
   */
  async _ollamaComplete(messages) {
    const url = `${this.config.endpoint}/api/chat`;
    const body = {
      model: this.config.model,
      messages,
      stream: false
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.message?.content || "";
  }

  /**
   * Custom format using user-provided formatter/parser.
   */
  async _customComplete(messages) {
    const { url, headers, body } = this.config.formatRequest(messages, this.config);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Custom LLM request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return this.config.parseResponse(data);
  }

  /**
   * Request a compaction summary from the LLM.
   * @param {object[]} nodes - nodes being compacted
   * @returns {object} structured summary { startTopic, keyDecisions, openThreads }
   */
  async generateSummary(nodes) {
    const conversationText = nodes
      .map(n => `[${n.role}]: ${n.content}`)
      .join("\n");

    const messages = [
      {
        role: "system",
        content: `You are summarizing a conversation section for future reference. 
Output ONLY valid JSON with this exact structure:
{
  "startTopic": "what was being discussed at the start",
  "keyDecisions": ["decision 1", "decision 2"],
  "openThreads": ["unresolved topic 1"]
}
Be concise. Max 2 sentences per field. Max 5 items per array.`
      },
      {
        role: "user",
        content: `Summarize this conversation section:\n\n${conversationText}`
      }
    ];

    const response = await this.complete(messages);

    try {
      return JSON.parse(response);
    } catch {
      // Fallback if LLM doesn't return valid JSON
      return {
        startTopic: response.slice(0, 100),
        keyDecisions: [],
        openThreads: []
      };
    }
  }
}
