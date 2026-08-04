# Luminal Memory

Zero-dependency infinite context memory for any LLM. Runs in browser and Node.js.

Give any local model — even a small one — infinite conversation memory without adding extra models or burning extra GPU.

## Quick Start

### Installation

```bash
npm install @automacene/luminal-memory
```

Or load directly in the browser:

```html
<script src="https://cdn.jsdelivr.net/npm/@automacene/luminal-memory@latest/dist/luminal-memory.min.js"></script>
```

### Basic Usage

```javascript
import { LuminalMemory } from '@automacene/luminal-memory';

const memory = new LuminalMemory({
  endpoint: "http://127.0.0.1:8081",
  windowSize: 20
});

await memory.init();

// Chat — handles everything: append, retrieve, prompt, call LLM, store response
const response = await memory.chat("How do bloom filters work?");
console.log(response);

// Keep chatting — context is managed automatically
const response2 = await memory.chat("Can you explain the math behind that?");
```

### Configuration

```javascript
const memory = new LuminalMemory({
  // LLM Connection
  endpoint: "http://127.0.0.1:8081",   // your local model server
  apiFormat: "openai",                   // "openai" | "ollama" | "custom"
  model: "local",

  // Sliding Window
  windowSize: 20,                        // nodes to include per prompt
  maxTokenBudget: 8192,                  // max tokens to send

  // Memory
  memoryLimitMB: 2048,                   // RAM ceiling
  warnThreshold: 0.8,                    // warn at 80%

  // BM25 Tuning
  bm25: { k1: 1.2, b: 0.4 }
});
```

## How It Works

1. **Every turn becomes a node** in a linear chain stored in RAM
2. **Context is cleared every turn** — the LLM is stateless
3. **A sliding window** of the last N nodes gets sent as the full prompt
4. **BM25 + Bloom Filters** search the entire in-memory chain when you reference old context
5. **Trim/Branch** moves data to disk only when you explicitly choose to

The model never accumulates context. Luminal Memory *is* the memory.

## API

### Core

```javascript
// Full chat cycle
const response = await memory.chat("your message");

// Manual node management
memory.append("user", "message");
memory.append("assistant", "response");

// Search all history
const results = memory.search("bloom filters");

// Get current window
const window = memory.getWindow();

// System status
const status = memory.status();
// { totalNodes, memoryUsageMB, utilizationPercent, archiveBlocks }
```

### Memory Management

```javascript
// Trim a range to cold storage
await memory.trim({ from: 100, to: 500 });

// Trim everything before current window
await memory.trimFromHere();

// Branch to new session (archive everything, start fresh)
await memory.branch();

// Restore archived block
await memory.restore("archive_100_500");
```

### Events

```javascript
memory.on("memory-warning", ({ usageMB, utilization, limitMB }) => {
  console.log(`Memory at ${utilization * 100}% — consider trimming`);
});
```

### Export / Import

```javascript
// Save full state
const snapshot = await memory.export();
localStorage.setItem("luminal-state", JSON.stringify(snapshot));

// Restore
const saved = JSON.parse(localStorage.getItem("luminal-state"));
await memory.import(saved);
```

## Model Compatibility

Works with any LLM that exposes an HTTP API:

| Server | apiFormat |
|--------|-----------|
| llama.cpp (llama-server) | `"openai"` |
| Ollama | `"ollama"` |
| LM Studio | `"openai"` |
| vLLM | `"openai"` |
| OpenAI API | `"openai"` |
| Custom | `"custom"` + formatRequest/parseResponse |

### Custom Format Example

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

## Architecture

```
src/
├── core/
│   ├── chain.js          # Linear node chain (append, slice, remove)
│   ├── window.js         # Sliding window selection + prompt building
│   ├── compaction.js     # Trim, branch, restore operations
│   └── retrieval.js      # Search pipeline orchestration
├── search/
│   ├── bm25.js           # BM25 scoring engine
│   ├── bloom.js          # d-Left Counting Bloom Filter
│   └── tfidf.js          # TF-IDF vectors + cosine similarity
├── storage/
│   ├── memory.js         # RAM usage tracking + warnings
│   └── archive.js        # IndexedDB cold storage for trimmed data
├── transport/
│   └── llm.js            # Model-agnostic HTTP client
├── config.js             # Defaults + user config merge
└── index.js              # Main entrypoint + public API
```

## Development

```bash
npm install
npm run build      # Bundle to dist/
npm test           # Run test suite
```

## License

Apache 2.0 © Automacene
