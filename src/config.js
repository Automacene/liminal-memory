/**
 * Default configuration for Liminal Memory.
 */
export const defaultConfig = {

  // ===== LLM CONNECTION =====

  // URL of your LLM server.
  endpoint: "http://127.0.0.1:8081",

  // API format. Options: "openai" (llama.cpp, LM Studio, vLLM, OpenAI) | "ollama" | "custom"
  apiFormat: "openai",

  // Completion endpoint path. Only used for "openai" format.
  completionPath: "/v1/chat/completions",

  // Model name sent in requests. Ignored by most local servers.
  model: "gemma-4-26B-A4B-it",

  // Enable thinking/reasoning mode if your model supports it (e.g. QwQ, DeepSeek-R1).
  thinking: true,

  // System prompt shown to the model on every request.
  systemPrompt: "You are Liminal, a conversational AI assistant. Chat naturally with the user like a knowledgeable friend. When context from earlier conversation appears in the prompt (labeled Recalled), use that information first. When tool results appear, incorporate them into your answer. Always prioritize information from recalled nodes and tools over your own knowledge. But when no recalled context or tool results are present, just chat — share thoughts, ask questions, discuss ideas, be helpful. Never refuse to answer. Never say you cannot help. If you lack specific information, give your best understanding and say what you are unsure about. Keep responses concise unless the user asks for detail.",


  // ===== CONTEXT WINDOW =====

  // Max conversation turns to include in each prompt.
  windowSize: 20,

  // Total token budget per prompt (prompt + completion combined).
  maxTokenBudget: 128000,

  // Tokens reserved for the model's reply. Kept back from the prompt budget.
  // availableForPrompt = maxTokenBudget - reservedTokens
  reservedTokens: 2048,


  // ===== RECALL (long-term memory injection) =====

  // Fraction of the available prompt budget allocated to recalled historical nodes.
  // Remainder goes to the sliding window. Unused recall budget flows back to sliding.
  // 0.3 = recall gets up to 30%, sliding gets at least 70%.
  recallBufferRatio: 0.3,

  // Max number of historical nodes to inject from retrieval.
  maxRetrievedNodes: 5,

  // BM25 score threshold below which retrieval searches archives.
  // Lower = only searches archives when the window is a poor match.
  // Higher = searches archives more aggressively.
  retrievalThreshold: 0.5,


  // ===== MEMORY LIMITS =====

  // RAM cap for in-memory conversation storage (in MB).
  memoryLimitMB: 2048,

  // Warn when memory usage hits this fraction of the limit. 0.8 = warn at 80%.
  warnThreshold: 0.8,


  // ===== ARCHIVING =====

  // How many nodes are bundled into one archive block when trimming.
  archiveBlockSize: 1000,

  // Format of the compaction summary. "json" (structured) | "text" (plain paragraph).
  summaryFormat: "json",


  // ===== TOOLS =====

  // BM25 match score required before a tool is considered for a query.
  toolMatchThreshold: 0.3,

  // Kill switch for web search. Set to false to disable all web search attempts.
  webSearchEnabled: false,

  // How many hops to follow node links during recall expansion. 0 = no expansion.
  linkDistance: 2,


  // ===== SEARCH TUNING =====

  // BM25 parameters. k1: term frequency weight. b: document length normalization.
  // Defaults are tuned for short conversational messages.
  bm25: {
    k1: 1.2,
    b: 0.4
  },

  // Bloom filter for fast archive pre-screening.
  // expectedItems: estimated unique terms across all archived content.
  // falsePositiveRate: acceptable rate of false "maybe present" answers (1% = 0.01).
  bloom: {
    expectedItems: 100000,
    falsePositiveRate: 0.01
  }
};

/**
 * Merge user config with defaults.
 * Nested objects (bm25, bloom) are merged shallowly.
 * @param {object} userConfig
 * @returns {object}
 */
export function createConfig(userConfig = {}) {
  return {
    ...defaultConfig,
    ...userConfig,
    bm25: { ...defaultConfig.bm25, ...(userConfig.bm25 || {}) },
    bloom: { ...defaultConfig.bloom, ...(userConfig.bloom || {}) }
  };
}
