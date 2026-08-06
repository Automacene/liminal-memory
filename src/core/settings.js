/**
 * Settings — runtime configuration manager with schema, validation, and server detection.
 * Provides a typed schema so UIs can dynamically build settings panels.
 * Supports hot-reloading of config values without restarting.
 */

/**
 * Schema definition for all configurable settings.
 * Each entry: { type, label, group, min?, max?, step?, options?, description? }
 * 
 * NOTE: Sampling params are NOT defined here — they're detected dynamically
 * from the running server (llama.cpp /props or Ollama /api/show).
 */
const SCHEMA = {
  // === Connection ===
  endpoint:       { type: 'string', label: 'Server URL', group: 'connection', description: 'LLM server address' },
  apiFormat:      { type: 'select', label: 'API Format', group: 'connection', options: ['openai', 'ollama', 'custom'], description: 'Server protocol' },
  completionPath: { type: 'string', label: 'Completion Path', group: 'connection', description: 'API endpoint path' },
  model:          { type: 'string', label: 'Model', group: 'connection', description: 'Model name sent in requests' },
  thinking:       { type: 'boolean', label: 'Thinking Mode', group: 'connection', description: 'Enable reasoning/chain-of-thought' },
  systemPrompt:   { type: 'textarea', label: 'System Prompt', group: 'connection', description: 'Instruction the model always sees at the top of every prompt' },

  // === Context Window ===
  windowSize:      { type: 'number', label: 'Window Size', group: 'context', min: 1, max: 200, step: 1, description: 'Max conversation turns in prompt' },
  maxTokenBudget:  { type: 'number', label: 'Token Budget', group: 'context', min: 1024, max: 262144, step: 1024, description: 'Max tokens per prompt' },
  reservedTokens:  { type: 'number', label: 'Reserved Tokens', group: 'context', min: 256, max: 16384, step: 256, description: 'Tokens reserved for model reply' },

  // === Recall ===
  recallBufferRatio:  { type: 'number', label: 'Recall Budget Ratio', group: 'recall', min: 0, max: 1, step: 0.05, description: 'Fraction of budget for historical recall' },
  maxRetrievedNodes:  { type: 'number', label: 'Max Retrieved Nodes', group: 'recall', min: 0, max: 20, step: 1, description: 'Max historical nodes injected' },
  retrievalThreshold: { type: 'number', label: 'Retrieval Threshold', group: 'recall', min: 0, max: 1, step: 0.05, description: 'BM25 score below which archives are searched' },

  // === Memory ===
  memoryLimitMB:   { type: 'number', label: 'Memory Limit (MB)', group: 'memory', min: 64, max: 16384, step: 64, description: 'Max RAM for conversation storage' },
  warnThreshold:   { type: 'number', label: 'Warn Threshold', group: 'memory', min: 0.5, max: 1, step: 0.05, description: 'Fraction of limit that triggers warning' },
  archiveBlockSize: { type: 'number', label: 'Archive Block Size', group: 'memory', min: 100, max: 10000, step: 100, description: 'Nodes per archive block' },

  // === Tools ===
  toolMatchThreshold: { type: 'number', label: 'Tool Match Threshold', group: 'tools', min: 0, max: 1, step: 0.05, description: 'BM25 score required to trigger a tool' }
};

/** Group metadata for UI rendering */
const GROUPS = {
  connection: { label: 'Connection', order: 0 },
  context:    { label: 'Context Window', order: 1 },
  recall:     { label: 'Recall & Retrieval', order: 2 },
  memory:     { label: 'Memory & Storage', order: 3 },
  tools:      { label: 'Tools', order: 4 },
  sampling:   { label: 'Sampling Parameters', order: 5 }
};

export class Settings {
  /**
   * @param {object} config - the live config object (mutated in place)
   * @param {import('../transport/llm.js').LLMTransport} transport
   */
  constructor(config, transport) {
    this.config = config;
    this.transport = transport;
    this._listeners = [];
    this._serverDefaults = null;
    this._samplingSchema = null; // populated by detectServerParams
    this._backends = null;       // populated by detectBackends
  }

  /**
   * Get the full schema definition for building UI.
   * Includes dynamically detected sampling params if available.
   * @returns {{ schema: object, groups: object, samplingSchema: object|null }}
   */
  getSchema() {
    return {
      schema: SCHEMA,
      groups: GROUPS,
      samplingSchema: this._samplingSchema
    };
  }

  /**
   * Get all current config values grouped by category.
   * @returns {object} - { group: { key: value, ... }, ... }
   */
  getAll() {
    const result = {};
    for (const [key, meta] of Object.entries(SCHEMA)) {
      if (!result[meta.group]) result[meta.group] = {};
      result[meta.group][key] = this.config[key] !== undefined ? this.config[key] : null;
    }
    // Include sampling values from config (dynamically detected keys)
    if (this._samplingSchema) {
      result.sampling = {};
      for (const key of Object.keys(this._samplingSchema)) {
        result.sampling[key] = this.config[key] !== undefined ? this.config[key] : this._samplingSchema[key].default;
      }
    }
    return result;
  }

  /**
   * Get a single setting value.
   * @param {string} key
   * @returns {*}
   */
  get(key) {
    return this.config[key];
  }

  /**
   * Set a single config value. Validates against schema (static + dynamic sampling).
   * @param {string} key
   * @param {*} value
   * @returns {boolean} true if set, false if invalid
   */
  set(key, value) {
    const meta = SCHEMA[key] || (this._samplingSchema && this._samplingSchema[key]);
    if (!meta) return false;

    // Type coercion and validation
    if (meta.type === 'number') {
      value = Number(value);
      if (isNaN(value)) return false;
      if (meta.min !== undefined && value < meta.min) value = meta.min;
      if (meta.max !== undefined && value > meta.max) value = meta.max;
    } else if (meta.type === 'boolean') {
      value = Boolean(value);
    } else if (meta.type === 'select') {
      if (meta.options && !meta.options.includes(value)) return false;
    }
    // string and textarea: accept as-is

    const oldValue = this.config[key];
    this.config[key] = value;

    // Notify listeners
    if (oldValue !== value) {
      this._emit(key, value, oldValue);
    }
    return true;
  }

  /**
   * Set multiple values at once.
   * @param {object} values - { key: value, ... }
   * @returns {string[]} keys that failed validation
   */
  setMany(values) {
    const failed = [];
    for (const [key, val] of Object.entries(values)) {
      if (!this.set(key, val)) failed.push(key);
    }
    return failed;
  }

  /**
   * Register a change listener.
   * @param {function} fn - called with (key, newValue, oldValue)
   */
  onChange(fn) {
    this._listeners.push(fn);
  }

  /**
   * Detect available backends and list models.
   * Checks both llama.cpp (OpenAI-compatible) and Ollama.
   * @returns {{ llamacpp: object|null, ollama: object|null }}
   */
  async detectBackends() {
    const results = { llamacpp: null, ollama: null };

    // Check llama.cpp on configured endpoint
    try {
      const endpoint = this.config.endpoint || 'http://127.0.0.1:8081';
      const res = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        const models = (data.data || []).map(m => m.id);
        results.llamacpp = { endpoint, models, type: 'openai' };
      }
    } catch { /* not running */ }

    // Check Ollama on default port
    try {
      const ollamaEndpoint = 'http://127.0.0.1:11434';
      const res = await fetch(`${ollamaEndpoint}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        const models = (data.models || []).map(m => ({
          name: m.name,
          size: m.size,
          paramSize: m.details?.parameter_size || null,
          family: m.details?.family || null,
          quantization: m.details?.quantization_level || null
        }));
        results.ollama = { endpoint: ollamaEndpoint, models, type: 'ollama' };
      }
    } catch { /* not running */ }

    this._backends = results;
    return results;
  }

  /**
   * Select an Ollama model — sets endpoint, apiFormat, and model name.
   * @param {string} modelName - e.g. "llama3:latest"
   */
  selectOllamaModel(modelName) {
    this.set('endpoint', 'http://127.0.0.1:11434');
    this.set('apiFormat', 'ollama');
    this.set('model', modelName);
    // Reset sampling schema since we're switching models
    this._samplingSchema = null;
  }

  /**
   * Select a llama.cpp backend.
   * @param {string} endpoint - e.g. "http://127.0.0.1:8081"
   * @param {string} [modelName]
   */
  selectLlamaCpp(endpoint, modelName) {
    this.set('endpoint', endpoint);
    this.set('apiFormat', 'openai');
    if (modelName) this.set('model', modelName);
    this._samplingSchema = null;
  }

  /**
   * Get cached backend detection results.
   * @returns {{ llamacpp: object|null, ollama: object|null }|null}
   */
  getBackends() {
    return this._backends || null;
  }

  /**
   * Detect server capabilities and build a dynamic sampling schema.
   * Works with both llama.cpp (/props) and Ollama (/api/show).
   * After calling this, getSchema().samplingSchema will be populated.
   * @returns {object|null} detected params with values, or null if unreachable
   */
  async detectServerParams() {
    const { endpoint, apiFormat, model } = this.config;

    try {
      if (apiFormat === 'ollama') {
        return await this._detectOllama(endpoint, model);
      } else {
        return await this._detectLlamaCpp(endpoint);
      }
    } catch (e) {
      console.warn('[Settings] Server detection failed:', e.message);
      return null;
    }
  }

  /**
   * Detect from llama.cpp /props endpoint.
   * Builds sampling schema dynamically from whatever params the server exposes.
   */
  async _detectLlamaCpp(endpoint) {
    const res = await fetch(`${endpoint}/props`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;

    const props = await res.json();
    const dgs = props.default_generation_settings || {};
    const params = dgs.params || dgs;

    // Extract server info
    const serverInfo = {
      model: props.model_alias || null,
      contextLength: dgs.n_ctx || null,
      thinking: !!(props.thinking || (props.chat_template || '').includes('<think>'))
    };

    // Build dynamic schema from params — only include numeric sampling-relevant ones
    const SKIP_KEYS = new Set([
      'stream', 'n_probs', 'n_keep', 'n_discard', 'ignore_eos', 'min_keep',
      'chat_format', 'reasoning_format', 'reasoning_in_content', 'generation_prompt',
      'samplers', 'speculative.types', 'timings_per_token', 'post_sampling_probs',
      'backend_sampling', 'lora'
    ]);

    const samplingSchema = {};
    for (const [key, value] of Object.entries(params)) {
      if (SKIP_KEYS.has(key)) continue;
      if (typeof value !== 'number') continue;

      // Build reasonable ranges based on the param name and value
      const meta = this._inferParamMeta(key, value);
      samplingSchema[key] = meta;

      // Apply current server value to config
      this.config[key] = value;
    }

    this._samplingSchema = samplingSchema;
    this._serverDefaults = { ...serverInfo, params: Object.fromEntries(
      Object.entries(samplingSchema).map(([k]) => [k, this.config[k]])
    )};

    return this._serverDefaults;
  }

  /**
   * Detect from Ollama /api/show endpoint.
   */
  async _detectOllama(endpoint, model) {
    const res = await fetch(`${endpoint}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return null;

    const data = await res.json();
    const rawParams = {};

    // Ollama returns modelfile params as "parameter <name> <value>" lines
    if (data.parameters) {
      const lines = data.parameters.split('\n');
      for (const line of lines) {
        const match = line.match(/^(\w+)\s+(.+)$/);
        if (match) {
          const num = Number(match[2]);
          if (!isNaN(num)) rawParams[match[1]] = num;
        }
      }
    }

    // Also check model_info for context length
    const serverInfo = {
      model: model,
      contextLength: rawParams.num_ctx || null
    };

    // Build dynamic schema
    const SKIP_KEYS = new Set(['num_ctx', 'num_gpu', 'num_thread']);
    const samplingSchema = {};

    for (const [key, value] of Object.entries(rawParams)) {
      if (SKIP_KEYS.has(key)) continue;

      const meta = this._inferParamMeta(key, value);
      samplingSchema[key] = meta;
      this.config[key] = value;
    }

    this._samplingSchema = samplingSchema;
    this._serverDefaults = { ...serverInfo, params: Object.fromEntries(
      Object.entries(samplingSchema).map(([k]) => [k, this.config[k]])
    )};

    return this._serverDefaults;
  }

  /**
   * Infer UI metadata (label, min, max, step) from a param name and its current value.
   * @param {string} key
   * @param {number} value
   * @returns {object}
   */
  _inferParamMeta(key, value) {
    // Known param ranges
    const KNOWN = {
      temperature:        { min: 0, max: 3, step: 0.05, label: 'Temperature', description: 'Randomness. Lower = focused, higher = creative' },
      top_p:              { min: 0, max: 1, step: 0.01, label: 'Top P', description: 'Nucleus sampling — cumulative probability cutoff' },
      top_k:              { min: 0, max: 200, step: 1, label: 'Top K', description: 'Consider only the top K most likely tokens' },
      min_p:              { min: 0, max: 1, step: 0.01, label: 'Min P', description: 'Minimum probability relative to the top token' },
      repeat_penalty:     { min: 0.5, max: 2, step: 0.05, label: 'Repeat Penalty', description: 'Penalize repeated tokens' },
      presence_penalty:   { min: -2, max: 2, step: 0.1, label: 'Presence Penalty', description: 'Penalize tokens already in context' },
      frequency_penalty:  { min: -2, max: 2, step: 0.1, label: 'Frequency Penalty', description: 'Penalize tokens by how often they appear' },
      n_predict:          { min: -1, max: 32768, step: 64, label: 'Max Tokens', description: 'Max tokens to generate. -1 = unlimited' },
      max_tokens:         { min: -1, max: 32768, step: 64, label: 'Max Tokens', description: 'Max tokens to generate. -1 = unlimited' },
      seed:               { min: -1, max: 2147483647, step: 1, label: 'Seed', description: 'Random seed. Large number = random' },
      typical_p:          { min: 0, max: 1, step: 0.01, label: 'Typical P', description: 'Locally typical sampling threshold' },
      repeat_last_n:      { min: 0, max: 2048, step: 1, label: 'Repeat Last N', description: 'How far back to check for repetition' },
      mirostat:           { min: 0, max: 2, step: 1, label: 'Mirostat', description: '0=off, 1=Mirostat, 2=Mirostat 2.0' },
      mirostat_tau:       { min: 0, max: 10, step: 0.1, label: 'Mirostat Tau', description: 'Target entropy for Mirostat' },
      mirostat_eta:       { min: 0, max: 1, step: 0.01, label: 'Mirostat Eta', description: 'Learning rate for Mirostat' },
      dynatemp_range:     { min: 0, max: 3, step: 0.05, label: 'Dynamic Temp Range', description: 'Range for dynamic temperature' },
      dynatemp_exponent:  { min: 0.1, max: 5, step: 0.1, label: 'Dynamic Temp Exponent', description: 'Exponent for dynamic temperature' },
      top_n_sigma:        { min: -1, max: 5, step: 0.1, label: 'Top N Sigma', description: 'Standard deviations for sigma sampling. -1=off' },
      xtc_probability:    { min: 0, max: 1, step: 0.01, label: 'XTC Probability', description: 'Exclude top choices probability' },
      xtc_threshold:      { min: 0, max: 1, step: 0.01, label: 'XTC Threshold', description: 'Exclude top choices threshold' },
      dry_multiplier:     { min: 0, max: 5, step: 0.1, label: 'DRY Multiplier', description: 'Dont Repeat Yourself penalty multiplier' },
      dry_base:           { min: 1, max: 4, step: 0.05, label: 'DRY Base', description: 'DRY penalty base' },
      dry_allowed_length: { min: 0, max: 20, step: 1, label: 'DRY Allowed Length', description: 'Max repetition length before penalty' },
      dry_penalty_last_n: { min: -1, max: 4096, step: 1, label: 'DRY Penalty Last N', description: 'Window for DRY penalty. -1 = ctx size' },
      num_predict:        { min: -1, max: 32768, step: 64, label: 'Max Tokens', description: 'Max tokens to generate. -1 = unlimited' }
    };

    if (KNOWN[key]) {
      return { type: 'number', default: value, ...KNOWN[key] };
    }

    // Unknown param — infer from value
    let min = 0, max = Math.max(value * 4, 10), step = 1;
    if (value > 0 && value <= 1) { min = 0; max = 1; step = 0.01; }
    else if (value > 1 && value <= 10) { min = 0; max = 10; step = 0.1; }

    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return { type: 'number', min, max, step, label, default: value, description: '' };
  }

  /** @private */
  _emit(key, newValue, oldValue) {
    for (const fn of this._listeners) {
      try { fn(key, newValue, oldValue); } catch (e) { /* don't break on listener errors */ }
    }
  }
}
