/**
 * Default configuration for Luminal Memory.
 * Tuned for Gemma 4 26B MoE on llama.cpp with 262144 ctx.
 */
export const defaultConfig = {
  // ===== WHERE IS YOUR MODEL RUNNING? =====
  
  // The URL where your llama-server (or any LLM server) is running.
  // If you started llama-server with --port 8081, this is correct as-is.
  endpoint: "http://127.0.0.1:8081",

  // What format does your model server speak?
  // "openai" works for: llama.cpp, LM Studio, vLLM, OpenAI API
  // "ollama" works for: Ollama
  // "custom" works for: anything else (you provide your own formatter)
  apiFormat: "openai",

  // The URL path that handles chat requests on your server.
  // For llama.cpp and OpenAI-compatible servers, this is always /v1/chat/completions.
  completionPath: "/v1/chat/completions",

  // The model name sent in API requests. Some servers need this, some ignore it.
  // For local llama.cpp it doesn't matter much — the server only has one model loaded.
  model: "gemma-4-26B-A4B-it",

  // The instruction the model always sees at the top of every prompt.
  // This is your "personality" or "role" instruction for the AI.
  systemPrompt: "You are a helpful assistant.",

  // ===== HOW MUCH CONVERSATION DOES THE MODEL SEE? =====

  // How many recent messages (nodes) to include in each prompt.
  // 20 means the model sees the last 20 back-and-forth messages.
  // Higher = more context but slower. Lower = faster but forgets sooner.
  windowSize: 20,

  // Maximum tokens (roughly: 1 token ≈ 4 characters of English text) to send per prompt.
  // Your model supports 262144 tokens, but keeping this lower means faster responses.
  // 32768 (32k) is plenty for 20 messages and leaves the model fast.
  maxTokenBudget: 32768,

  // Tokens held back from the budget so the model has room to write its reply.
  // Think of it as: "don't fill the prompt all the way — leave 2048 tokens of breathing room."
  // If you send 32768 tokens and reserve 2048, that means 30720 tokens are available for your messages.
  reservedTokens: 2048,

  // ===== MEMORY LIMITS =====

  // Maximum RAM (in megabytes) that Luminal Memory is allowed to use for storing conversation.
  // 2048 MB = 2 GB. Plain text is tiny — 2GB holds millions of messages.
  // You'll likely never hit this unless you run for months straight.
  memoryLimitMB: 2048,

  // When memory usage reaches this percentage of the limit, you'll get a warning.
  // 0.8 = warn at 80%. Gives you time to trim before hitting the wall.
  warnThreshold: 0.8,

  // ===== TRIM / COMPACTION =====

  // When you trim (archive old messages), how many messages go into one archive file.
  // 1000 nodes per archive block keeps things manageable and searchable.
  archiveBlockSize: 1000,

  // Format for the summary that gets saved when you trim.
  // "json" = structured (startTopic, keyDecisions, openThreads)
  // "text" = plain text paragraph
  summaryFormat: "json",

  // ===== SEARCH TUNING (you probably don't need to touch these) =====

  // BM25 is the search algorithm that finds relevant past messages.
  // k1: how much repeated words matter (1.2 = moderate, higher = more weight on repetition)
  // b: how much message length matters (0.4 = gentle, higher = penalizes long messages more)
  bm25: {
    k1: 1.2,
    b: 0.4
  },

  // Bloom filter: the fast pre-check that skips archives that definitely don't have what you're looking for.
  // expectedItems: how many unique words you expect across all archived messages (100k is very generous)
  // falsePositiveRate: chance of a false "maybe it's here" (0.01 = 1% — very low)
  bloom: {
    expectedItems: 100000,
    falsePositiveRate: 0.01
  },

  // ===== RETRIEVAL (when the system searches old history) =====

  // If the best search score on your current window is below this number,
  // the system will dig into archived history to find relevant old messages.
  // Lower = less aggressive searching. Higher = searches archives more often.
  retrievalThreshold: 0.3,

  // Maximum number of old messages to pull from archives and inject into the prompt.
  // 3 means at most 3 historical messages get added alongside your sliding window.
  maxRetrievedNodes: 3,

  // ===== DEEP RETRIEVAL (hierarchical branching for complex questions) =====

  // When the system finds this many or more relevant archive blocks,
  // it "drops down" into parallel branches instead of cramming everything into one prompt.
  // Each branch gets its own focused LLM call to extract what's relevant.
  deepRetrievalThreshold: 2,

  // Maximum number of branches to process. More branches = more thorough but slower.
  // Each branch is one LLM call, so 7 branches = 7 calls + 1 final synthesis = 8 total.
  maxBranches: 7,

  // Max tokens each branch summary can be. Keeps the final synthesis prompt manageable.
  branchSummaryMaxTokens: 150,

  // Master switch to enable/disable deep retrieval entirely.
  // When off, the system uses simple single-pass injection even for complex questions.
  deepRetrievalEnabled: true,

  // ===== BUFFER BUDGETING =====

  // How to split available token budget between recall (historical) and sliding (recent).
  // 0.3 means recall gets up to 30% of available tokens, sliding gets the rest.
  // If recall doesn't use its full budget, the leftover goes to sliding automatically.
  recallBufferRatio: 0.3
};

/**
 * Merge user config with defaults.
 */
export function createConfig(userConfig = {}) {
  return {
    ...defaultConfig,
    ...userConfig,
    bm25: { ...defaultConfig.bm25, ...(userConfig.bm25 || {}) },
    bloom: { ...defaultConfig.bloom, ...(userConfig.bloom || {}) }
  };
}
