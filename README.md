# Luminal Memory

[![stars](https://img.shields.io/github/stars/automacene/luminal-memory?style=flat&color=gold)](https://github.com/automacene/luminal-memory/stargazers)
[![forks](https://img.shields.io/github/forks/automacene/luminal-memory?style=flat&color=blue)](https://github.com/automacene/luminal-memory/network/members)
[![license](https://img.shields.io/badge/license-Apache%202.0-green)](./LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)]()
[![platform](https://img.shields.io/badge/platform-browser%20%7C%20node.js-blue)]()
[![model-free](https://img.shields.io/badge/retrieval-no%20extra%20models-orange)]()

Zero-dependency infinite context memory for any LLM. Runs in browser and Node.js.

Give any local model — even a small one — persistent conversation memory without adding extra models or burning extra GPU. The LLM is stateless. Luminal Memory *is* the memory.

## What It Does

Every LLM has a fixed context window. Once a conversation exceeds it, the model forgets. Luminal Memory solves this by:

- Storing every conversation turn in RAM as a linear chain of nodes
- Rebuilding the LLM's context from scratch each turn using a sliding window of recent messages
- Retrieving relevant historical context using pure-math algorithms (BM25, Bloom filters, TF-IDF) when you reference something outside the window — no embedding models, no vector databases, no extra inference

The retrieval pipeline runs in sub-millisecond time on tens of thousands of nodes. The only model inference is the one you're already paying for.

## Installation

```bash
npm install @automacene/luminal-memory
```

Or load directly in the browser via CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/@automacene/luminal-memory@latest/dist/luminal-memory.min.js"></script>
```

## Quick Start

```javascript
import { LuminalMemory } from '@automacene/luminal-memory';

const memory = new LuminalMemory({
  endpoint: "http://127.0.0.1:8081",
  windowSize: 20
});

await memory.init();

// Chat handles the full cycle:
// append → retrieve → build prompt → call LLM → store response
const response = await memory.chat("How do bloom filters work?");
console.log(response);

// Context is managed automatically across unlimited turns
const response2 = await memory.chat("Can you explain the math behind that?");
```

## Configuration

```javascript
const memory = new LuminalMemory({
  // LLM Connection
  endpoint: "http://127.0.0.1:8081",     // your local model server
  apiFormat: "openai",                     // "openai" | "ollama" | "custom"
  completionPath: "/v1/chat/completions",  // API path on your server
  model: "local",                          // model name sent in requests

  // System Prompt
  systemPrompt: "You are a helpful assistant.",

  // Sliding Window
  windowSize: 20,            // recent nodes included per prompt
  maxTokenBudget: 32768,     // max tokens to send to the model
  reservedTokens: 2048,      // headroom for the model's reply

  // Memory Limits
  memoryLimitMB: 2048,       // RAM ceiling (plain text is tiny — 2GB holds millions of messages)
  warnThreshold: 0.8,        // emit warning at 80% utilization

  // Compaction
  archiveBlockSize: 1000,    // nodes per archive block
  summaryFormat: "json",     // "json" | "text"

  // Search Tuning
  bm25: { k1: 1.2, b: 0.4 },
  bloom: { expectedItems: 100000, falsePositiveRate: 0.01 },

  // Retrieval
  retrievalThreshold: 0.3,   // BM25 confidence below this triggers archive search
  maxRetrievedNodes: 3,      // max historical nodes injected per turn

  // Deep Retrieval (hierarchical branching for complex multi-hop questions)
  deepRetrievalEnabled: true,
  deepRetrievalThreshold: 2, // number of relevant blocks that triggers branching
  maxBranches: 7,            // max parallel branch calls
  branchSummaryMaxTokens: 150,

  // Buffer Budgeting
  recallBufferRatio: 0.3     // recall gets up to 30% of available tokens; rest goes to sliding window
});
```

## API Reference

### Core

```javascript
// Full chat cycle — append, retrieve, prompt, call LLM, store
const response = await memory.chat("your message");

// Manual node management (for importing existing conversations)
memory.append("user", "message");
memory.append("assistant", "response");

// Search all in-memory history
const results = memory.search("bloom filters", 10);
// [{ nodeId, score, node }]

// Get the current sliding window
const window = memory.getWindow();

// Attach additional context (PDFs, code, etc.) to every prompt
memory.attachContext("pdf", pdfText);
memory.clearContext();

// System status
const status = memory.status();
// { totalNodes, memoryUsageMB, utilizationPercent, limitMB, archiveBlocks, warning }
```

### Memory Management

```javascript
// Trim a specific range to cold storage (IndexedDB / in-memory fallback)
await memory.trim({ from: 100, to: 500 });

// Trim everything before the current sliding window
await memory.trimFromHere();

// Branch to a new session — archives everything, starts fresh
const archiveKey = await memory.branch();

// Restore an archived block back into active memory
await memory.restore("archive_100_500");
```

### Events

```javascript
memory.on("memory-warning", ({ usageMB, utilization, limitMB, blocked }) => {
  console.log(`Memory at ${Math.round(utilization * 100)}% — consider trimming`);
});
```

### Export / Import

```javascript
// Save full state (chain, indexes, archives)
const snapshot = await memory.export();
localStorage.setItem("luminal-state", JSON.stringify(snapshot));

// Restore from snapshot
const saved = JSON.parse(localStorage.getItem("luminal-state"));
await memory.import(saved);
```

### Custom LLM Format

```javascript
const memory = new LuminalMemory({
  apiFormat: "custom",
  formatRequest: (messages, config) => ({
    url: "http://localhost:5000/generate",
    headers: { "X-Api-Key": "..." },
    body: { prompt: messages.map(m => m.content).join("\n") }
  }),
  parseResponse: (json) => json.text
});
```

## Model Compatibility

Works with any LLM that exposes an HTTP API:

| Server | `apiFormat` |
|--------|------------|
| llama.cpp (llama-server) | `"openai"` |
| Ollama | `"ollama"` |
| LM Studio | `"openai"` |
| vLLM | `"openai"` |
| OpenAI API | `"openai"` |
| Custom | `"custom"` + `formatRequest` / `parseResponse` |

## How It Works

### Every Turn

1. User message is appended to the chain as a new node
2. LLM context is cleared (fresh slate — the model is stateless)
3. Sliding window selects the last N nodes that fit the token budget
4. Retrieval checks if the user is referencing something outside the window
5. Prompt is assembled: system prompt → attached context → recalled history → sliding window
6. HTTP POST to the model → response appended as a new node

### Retrieval Pipeline (Pure Math, Sub-Millisecond)

```
User Query
    │
    ▼
BM25 on active window → high confidence? → skip archive search
    │
    (low confidence)
    ▼
Bloom filter gate → definitely not in any archive? → skip
    │
    (maybe-hit)
    ▼
TF-IDF cosine similarity → rank candidate archive blocks
    │
    ▼
Decompress top 1–2 blocks from cold storage
    │
    ▼
BM25 within decompressed block → exact node retrieval
    │
    ▼
Inject into prompt alongside sliding window
```

### Deep Retrieval (Complex Questions)

When a question needs information from multiple distant archive blocks:

1. Each relevant block gets its own focused LLM call to extract pertinent info
2. All branch summaries are consolidated with the sliding window into a final synthesis call
3. Branches are ephemeral — they don't persist in the chain
4. Cost: N+1 LLM calls (only for complex multi-hop questions; simple questions remain 1 call)

### Trim / Compaction

When you trim, old nodes are:
- Compressed (gzip via CompressionStream where available)
- Stored in cold storage (IndexedDB in browser, in-memory Map in Node.js)
- Replaced by a compaction marker containing a structured summary, a TF-IDF vector, and bloom filter entries
- Fully restorable at any time via `memory.restore(key)`

## Architecture

```
src/
├── core/
│   ├── node.js               # Single conversation unit with cached metrics
│   ├── chain.js              # Linear node chain (append, slice, remove)
│   ├── window.js             # Sliding window selection + message building
│   ├── buffer.js             # Token-budgeted containers (Sliding, Recall)
│   ├── conversation-manager.js  # Budget allocation across prompt sections
│   ├── compaction.js         # Trim, branch, restore operations
│   ├── retrieval.js          # Search pipeline orchestration
│   └── deep-retrieval.js     # Hierarchical branching for multi-hop questions
├── search/
│   ├── bm25.js              # BM25 scoring engine (inverted index)
│   ├── bloom.js             # d-Left Counting Bloom Filter (FNV-1a)
│   └── tfidf.js             # TF-IDF vectors + cosine similarity
├── storage/
│   ├── memory.js            # RAM usage tracking + warning events
│   └── archive.js           # IndexedDB cold storage (gzip compressed)
├── transport/
│   └── llm.js              # Model-agnostic HTTP client
├── config.js               # Defaults + user config merge
└── index.js                # Main entrypoint + public API
```

### Key Design Decisions

- **LLM is stateless** — context is rebuilt from scratch every turn
- **Linear chain only** — simple, predictable, no branching complexity
- **Retrieval is pure math** — BM25, Bloom filters, TF-IDF. No neural inference for search.
- **Deep retrieval uses the LLM** — only for complex multi-hop questions spanning multiple archive blocks
- **Budget-first prompt building** — nothing ever exceeds the model's context limit
- **Explicit compaction** — you decide when to trim; no automatic data loss
- **Zero dependencies** — pure ES modules, ships as a single bundled file

### Known Tradeoffs

- **No synonym matching.** Without embeddings, "automobile" won't find "car." Acceptable because users tend to reuse their own vocabulary in persistent conversations.
- **Multi-hop reasoning.** Small models can still struggle to synthesize across injected nodes. This is a model-weight limitation, not an architecture limitation.

## Browser Compatibility

| Feature | Support |
|---------|---------|
| Core (Maps, Arrays, fetch) | All modern browsers |
| IndexedDB (cold storage) | All modern browsers |
| CompressionStream (gzip) | Chrome 80+, Firefox 113+, Safari 16.4+ |

Browsers without CompressionStream fall back to storing uncompressed data in IndexedDB.

## Development

```bash
npm install
npm run build        # Bundle to dist/ (ESM)
npm run build:umd    # Bundle to dist/ (UMD, for <script> tags)
npm test             # Run test suite
npm run dev          # Watch mode (rebuilds on change)
```

### Running the Demo

```bash
node serve.js
# → http://localhost:3000/demo/
```

Make sure your LLM server is running with CORS enabled (e.g., `llama-server --cors`).

## License

Apache 2.0 © Automacene
