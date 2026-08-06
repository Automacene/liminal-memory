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
   * @returns {{ text: string, usage: { promptTokens: number, completionTokens: number, totalTokens: number }|null }}
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
      stream: false,
      ...this._samplingParams()
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

    // Strip inline thinking tags if present (various model formats)
    content = content.replace(/<\|channel>thought<channel\|>[\s\S]*?<\|channel>response<channel\|>/g, '').trim();
    content = content.replace(/<\|?think\|?>[\s\S]*?<\|?\/?think\|?>/g, '').trim();

    // Extract usage from response
    const usage = data.usage ? {
      promptTokens: data.usage.prompt_tokens || 0,
      completionTokens: data.usage.completion_tokens || 0,
      totalTokens: data.usage.total_tokens || 0
    } : null;

    return { text: content, usage };
  }

  /**
   * OpenAI-compatible streaming completion.
   * Calls onThink(token) during <think> blocks, onToken(token) for the response.
   * Returns the full response text and usage stats when done.
   * @param {object[]} messages
   * @param {object} callbacks - { onToken, onThink, onDone }
   * @returns {{ text: string, usage: { promptTokens: number, completionTokens: number, totalTokens: number }|null }}
   */
  async _openaiStream(messages, callbacks = {}, signal = null) {
    const url = `${this.config.endpoint}${this.config.completionPath}`;
    const body = {
      model: this.config.model,
      messages,
      stream: true,
      ...this._samplingParams()
    };

    if (this.config.thinking) {
      body.thinking = true;
    }

    const fetchOpts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };
    if (signal) fetchOpts.signal = signal;

    const response = await fetch(url, fetchOpts);

    if (!response.ok) {
      throw new Error(`LLM stream failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let thinkText = '';
    let buffer = '';
    let usage = null;
    
    // Accumulate raw text, then split by boundaries at the end of each chunk
    let rawAccum = '';
    let mode = 'pending'; // 'pending' | 'thinking' | 'content'

    // All known boundary markers
    const THINK_START = ['<think>', '<|think|>', '<|channel>thought<channel|>'];
    const THINK_END = ['</think>', '<|/think|>', '<|channel>response<channel|>'];

    function findBoundary(text, markers) {
      for (const m of markers) {
        const idx = text.indexOf(m);
        if (idx !== -1) return { idx, marker: m, len: m.length };
      }
      return null;
    }

    function flushAccumulator() {
      // Process rawAccum: detect boundaries, route sections
      while (rawAccum.length > 0) {
        if (mode === 'pending' || mode === 'content') {
          // Look for think-start
          const start = findBoundary(rawAccum, THINK_START);
          if (start) {
            // Everything before the marker is content
            const before = rawAccum.slice(0, start.idx);
            if (before) {
              fullText += before;
              if (callbacks.onToken) callbacks.onToken(before);
            }
            rawAccum = rawAccum.slice(start.idx + start.len);
            mode = 'thinking';
            continue;
          }
          // No boundary found — flush all as content
          fullText += rawAccum;
          if (callbacks.onToken) callbacks.onToken(rawAccum);
          rawAccum = '';
        } else if (mode === 'thinking') {
          // Look for think-end
          const end = findBoundary(rawAccum, THINK_END);
          if (end) {
            // Everything before the marker is thinking
            const before = rawAccum.slice(0, end.idx);
            if (before) {
              thinkText += before;
              if (callbacks.onThink) callbacks.onThink(before);
            }
            rawAccum = rawAccum.slice(end.idx + end.len);
            mode = 'content';
            continue;
          }
          // No end found yet — flush all as thinking (more coming)
          thinkText += rawAccum;
          if (callbacks.onThink) callbacks.onThink(rawAccum);
          rawAccum = '';
        }
      }
    }

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

          // Capture usage from final chunk (llama.cpp, vLLM, OpenAI all send this)
          if (parsed.usage) {
            usage = {
              promptTokens: parsed.usage.prompt_tokens || 0,
              completionTokens: parsed.usage.completion_tokens || 0,
              totalTokens: parsed.usage.total_tokens || 0
            };
          }

          // Handle separate reasoning_content field
          if (reasoningToken) {
            mode = 'thinking';
            thinkText += reasoningToken;
            if (callbacks.onThink) callbacks.onThink(reasoningToken);
            continue;
          }

          // If we were getting reasoning_content and now get content, switch
          if (mode === 'thinking' && !reasoningToken && token) {
            mode = 'content';
          }

          if (!token) continue;

          // Accumulate and process for inline boundaries
          rawAccum += token;
          flushAccumulator();
        } catch { /* skip malformed chunks */ }
      }
    }

    // Final flush
    if (rawAccum.length > 0) flushAccumulator();

    if (callbacks.onDone) callbacks.onDone(fullText, thinkText);
    return { text: fullText, usage };
  }

  /**
   * Stream a completion with callbacks. Falls back to non-streaming if callbacks not provided.
   * @param {object[]} messages
   * @param {object} [callbacks] - { onToken, onThink, onDone }
   * @returns {{ text: string, usage: { promptTokens: number, completionTokens: number, totalTokens: number }|null }}
   */
  async stream(messages, callbacks, signal) {
    const { apiFormat } = this.config;
    if (apiFormat === "openai" || !apiFormat) {
      return this._openaiStream(messages, callbacks, signal);
    }
    if (apiFormat === "ollama") {
      return this._ollamaStream(messages, callbacks, signal);
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
      stream: false,
      options: this._samplingParamsOllama()
    };

    if (this.config.thinking) {
      body.think = true;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const text = data.message?.content || "";

    // Ollama uses prompt_eval_count / eval_count
    const usage = (data.prompt_eval_count != null || data.eval_count != null) ? {
      promptTokens: data.prompt_eval_count || 0,
      completionTokens: data.eval_count || 0,
      totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
    } : null;

    return { text, usage };
  }

  /**
   * Ollama streaming completion (NDJSON format).
   * The final object with done:true contains prompt_eval_count and eval_count.
   * @param {object[]} messages
   * @param {object} callbacks - { onToken, onThink, onDone }
   * @returns {{ text: string, usage: { promptTokens: number, completionTokens: number, totalTokens: number }|null }}
   */
  async _ollamaStream(messages, callbacks = {}, signal = null) {
    const url = `${this.config.endpoint}/api/chat`;
    const body = {
      model: this.config.model,
      messages,
      stream: true,
      options: this._samplingParamsOllama()
    };

    if (this.config.thinking) {
      body.think = true;
    }

    const fetchOpts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };
    if (signal) fetchOpts.signal = signal;

    const response = await fetch(url, fetchOpts);

    if (!response.ok) {
      throw new Error(`Ollama stream failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);

          // Final message with done:true contains usage stats
          if (parsed.done) {
            usage = {
              promptTokens: parsed.prompt_eval_count || 0,
              completionTokens: parsed.eval_count || 0,
              totalTokens: (parsed.prompt_eval_count || 0) + (parsed.eval_count || 0)
            };
            break;
          }

          // Handle thinking content (Ollama returns message.thinking when think:true)
          const thinking = parsed.message?.thinking || '';
          if (thinking) {
            if (callbacks.onThink) callbacks.onThink(thinking);
            continue;
          }

          const token = parsed.message?.content || '';
          if (token) {
            fullText += token;
            if (callbacks.onToken) callbacks.onToken(token);
          }
        } catch { /* skip malformed lines */ }
      }
    }

    if (callbacks.onDone) callbacks.onDone(fullText, '');
    return { text: fullText, usage };
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
    const text = this.config.parseResponse(data);
    return { text, usage: null };
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

    const { text: response } = await this.complete(messages);

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

  /**
   * Build sampling params for OpenAI-compatible APIs (llama.cpp, vLLM, LM Studio).
   * Only includes params that are explicitly set (not undefined).
   * @returns {object}
   */
  _samplingParams() {
    const params = {};
    const c = this.config;
    if (c.temperature !== undefined) params.temperature = c.temperature;
    if (c.top_p !== undefined) params.top_p = c.top_p;
    if (c.top_k !== undefined) params.top_k = c.top_k;
    if (c.min_p !== undefined) params.min_p = c.min_p;
    if (c.repeat_penalty !== undefined) params.repeat_penalty = c.repeat_penalty;
    if (c.presence_penalty !== undefined) params.presence_penalty = c.presence_penalty;
    if (c.frequency_penalty !== undefined) params.frequency_penalty = c.frequency_penalty;
    if (c.max_tokens !== undefined) params.max_tokens = c.max_tokens;
    if (c.seed !== undefined && c.seed !== -1) params.seed = c.seed;
    return params;
  }

  /**
   * Build sampling params for Ollama's options format.
   * @returns {object}
   */
  _samplingParamsOllama() {
    const opts = {};
    const c = this.config;
    if (c.temperature !== undefined) opts.temperature = c.temperature;
    if (c.top_p !== undefined) opts.top_p = c.top_p;
    if (c.top_k !== undefined) opts.top_k = c.top_k;
    if (c.min_p !== undefined) opts.min_p = c.min_p;
    if (c.repeat_penalty !== undefined) opts.repeat_penalty = c.repeat_penalty;
    if (c.max_tokens !== undefined) opts.num_predict = c.max_tokens;
    if (c.seed !== undefined && c.seed !== -1) opts.seed = c.seed;
    return opts;
  }
}
