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

    // Enable thinking/reasoning if configured
    if (this.config.thinking) {
      body.thinking = true;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content || "";
    let reasoning = data.choices?.[0]?.message?.reasoning_content || "";

    // Log reasoning if present (Gemma 4 format)
    if (reasoning) {
      console.log(`[LLM:think] ${reasoning.slice(0, 300)}`);
    }

    // Strip inline thinking tags if present (other model formats)
    const thinkMatch = content.match(/<\|?think\|?>([\s\S]*?)<\|?\/?think\|?>/);
    if (thinkMatch) {
      console.log(`[LLM:think] ${thinkMatch[1].slice(0, 300)}`);
      content = content.replace(/<\|?think\|?>[\s\S]*?<\|?\/?think\|?>\s*/g, '').trim();
    }

    return content;
  }

  /**
   * OpenAI-compatible streaming completion.
   * Calls onThink(token) during <think> blocks, onToken(token) for the response.
   * Returns the full response text when done.
   * @param {object[]} messages
   * @param {object} callbacks - { onToken, onThink, onDone }
   * @returns {string} full response
   */
  async _openaiStream(messages, callbacks = {}) {
    const url = `${this.config.endpoint}${this.config.completionPath}`;
    const body = {
      model: this.config.model,
      messages,
      stream: true
    };

    if (this.config.thinking) {
      body.thinking = true;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`LLM stream failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let inThink = false;
    let thinkText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta || {};
          const token = delta.content || '';
          const reasoningToken = delta.reasoning_content || '';

          // Handle reasoning_content field (Gemma 4 style)
          if (reasoningToken) {
            fullText += reasoningToken;
            inThink = true;
            thinkText += reasoningToken;
            if (callbacks.onThink) callbacks.onThink(reasoningToken);
            continue;
          }

          // If we were in reasoning and now get content, we've switched
          if (inThink && token) {
            inThink = false;
          }

          if (!token) continue;
          fullText += token;

          // Handle inline <think> / </think> tags (other models)
          if (token.includes('<think>') || token.includes('<|think|>')) {
            inThink = true;
            const afterTag = token.replace(/<\|?think\|?>/g, '');
            if (afterTag && callbacks.onThink) callbacks.onThink(afterTag);
            thinkText += afterTag;
            continue;
          }
          if (inThink && (token.includes('</think>') || token.includes('<|/think|>'))) {
            inThink = false;
            const beforeTag = token.replace(/<\|?\/think\|?>/g, '');
            if (beforeTag && callbacks.onThink) callbacks.onThink(beforeTag);
            thinkText += beforeTag;
            continue;
          }

          if (inThink) {
            thinkText += token;
            if (callbacks.onThink) callbacks.onThink(token);
          } else {
            if (callbacks.onToken) callbacks.onToken(token);
          }
        } catch { /* skip malformed chunks */ }
      }
    }

    if (callbacks.onDone) callbacks.onDone(fullText, thinkText);

    // Return cleaned content (without think tags)
    return fullText.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  }

  /**
   * Stream a completion with callbacks. Falls back to non-streaming if callbacks not provided.
   * @param {object[]} messages
   * @param {object} [callbacks] - { onToken, onThink, onDone }
   * @returns {string}
   */
  async stream(messages, callbacks) {
    const { apiFormat } = this.config;
    if (apiFormat === "openai" || !apiFormat) {
      return this._openaiStream(messages, callbacks);
    }
    // Fallback: non-streaming
    return this.complete(messages);
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
