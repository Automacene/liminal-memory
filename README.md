# Liminal Memory
[![GitHub Repo stars](https://img.shields.io/github/stars/Automacene/liminal-memory?style=flat&color=gold)](https://github.com/Automacene/liminal-memory)
[![GitHub forks](https://img.shields.io/github/forks/Automacene/liminal-memory?style=flat&color=blue)](https://github.com/Automacene/liminal-memory)
[![license](https://img.shields.io/badge/license-Apache%202.0-green)](./LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)]()
[![platform](https://img.shields.io/badge/platform-browser%20%7C%20node.js-blue)]()
[![model-free](https://img.shields.io/badge/retrieval-no%20extra%20models-orange)]()

## What is Liminal Memory?

Liminal Memory is a memory layer for AI models. It sits between your application and any LLM, giving the model the ability to remember unlimited conversation history — without adding more models, without embeddings, and without burning extra GPU.

Every AI model has a context window — a hard limit on how much text it can "see" at once. Once a conversation exceeds that limit, the model forgets everything before it. Liminal Memory solves this by managing what the model sees each turn. It stores the entire conversation, selects the most recent and most relevant messages, and rebuilds the prompt from scratch every single turn. The model is stateless. Liminal Memory is the memory.

It also gives models the ability to use tools — web search, date/time, or anything you build — discovered and invoked automatically when the conversation needs them.

Zero dependencies. Runs in any browser or Node.js environment. Works with any model that has an HTTP API.

## How It Works

The core idea is simple: instead of letting the model accumulate context until it overflows, Liminal clears the slate every turn and reconstructs the prompt intelligently.

**The chain** — every message (user and AI) becomes a node in a linear chain stored in memory. Nothing is ever deleted from the chain unless you explicitly tell it to archive.

**The sliding window** — each turn, the last N messages get sent to the model as its "working memory." This is what the AI actually sees.

**Retrieval** — when you reference something outside the window ("what was that code we wrote earlier?"), the system finds it using keyword search algorithms (BM25, Bloom filters, TF-IDF) and injects it back into the prompt. No neural network needed — just math. Sub-millisecond.

**Tools** — capabilities like web search are registered with descriptions. When your query matches a tool's description, it gets activated for that turn. The AI decides whether to use it, calls it, and the results feed into its response.

**Compaction** — when you're ready, you can archive old sections of the conversation to cold storage. They get compressed, summarized, and indexed so retrieval can still find them later.

```javascript
const memory = new LiminalMemory({ endpoint: "http://127.0.0.1:8081" });
await memory.init();

const { response } = await memory.chat("How do bloom filters work?");
// Later...
const { response } = await memory.chat("What did we discuss 200 messages ago?");
// It finds it. Sub-millisecond.
```

## Why Use Liminal Memory?

**No extra models.** Most "memory" solutions require embedding models, vector databases, or secondary neural networks. Liminal uses pure algorithmic search. Your primary LLM is the only model running.

**No extra hardware.** It runs on whatever is already running your model. Consumer laptop, gaming PC, server — doesn't matter. The retrieval pipeline adds microseconds, not seconds.

**Works with any model.** llama.cpp, Ollama, LM Studio, vLLM, OpenAI — anything with an HTTP API. Swap models without changing your memory layer.

**Actually infinite.** Not "large context" — infinite. Conversations can run for months. Old messages get compressed and archived, but they're always retrievable.

**Extensible tools.** Web search, date/time, or anything you build. Tools are discovered automatically — no prompt bloat from capabilities the model doesn't need right now.

**Zero dependencies.** Ships as a single JavaScript file. No Python, no Docker, no infrastructure. Import it and go.

## Use Cases

- **Local AI assistants** that remember everything across sessions
- **Research tools** that accumulate knowledge over long conversations
- **Customer support bots** with persistent context per user
- **Coding assistants** that recall earlier design decisions and code snippets
- **Personal AI** that knows your preferences, history, and ongoing projects
- **Any application** where an LLM needs to reference information beyond its context window

## Get Started

```bash
npm install @automacene/liminal-memory
```

**Requirements:** Node.js 18+ (for native `fetch`) or any modern browser. If using CompressionStream for archive gzip, Chrome 80+, Firefox 113+, Safari 16.4+.

**CORS:** If your model server runs locally (llama.cpp, Ollama, etc.), make sure CORS is enabled. For llama-server: `llama-server --cors`. For Ollama: it's enabled by default. Without this, browser requests to your model will be blocked.

```javascript
import { LiminalMemory, createWebSearchTool } from '@automacene/liminal-memory';

const memory = new LiminalMemory({
  endpoint: "http://127.0.0.1:8081",  // your model server
  windowSize: 20                       // messages the AI sees per turn
});

await memory.init();

// Give it tools (optional — discovered automatically when relevant)
memory.registerTool(createWebSearchTool());

// Chat — everything is handled automatically
const { response, toolsUsed } = await memory.chat("What's new in Rust this week?");
```

Or load directly in the browser:

```html
<script src="https://cdn.jsdelivr.net/npm/@automacene/liminal-memory@latest/dist/liminal-memory.min.js"></script>
```

## Tools

Tools are never pre-loaded into the prompt. They're discovered via keyword matching against their descriptions and only surface when relevant.

```javascript
import { createWebSearchTool, createDateTimeTool, Tool } from '@automacene/liminal-memory';

// Built-in extensions
memory.registerTool(createWebSearchTool());  // Web search via Firecrawl (free, no key)
memory.registerTool(createDateTimeTool());   // Current date/time/timezone

// Build your own
memory.registerTool(new Tool({
  name: "calculator",
  description: "Do math when the user asks to calculate or compute something.",
  parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
  execute: async (params) => ({ result: eval(params.expression), formatted: `= ${eval(params.expression)}` })
}));
```

## Memory Management

Liminal calls this **Trim & Branch** — not compaction in the traditional database sense.

**What it is:** You select a section of conversation to keep as your active session. Everything outside that selection gets archived to cold storage (IndexedDB in browser, compressed on disk in Node). The archived blocks are compressed, indexed (Bloom filter + TF-IDF vector), and a summary marker is left in the chain so the AI has macro-awareness of what was archived.

**Why you'd do it:** Not for performance — for focus. Even with 32GB of RAM, you could store millions of messages without slowdown (4GB ≈ 8 million messages ≈ 300 million tokens). BM25 stays sub-millisecond on inverted indexes of that size. You trim because your retrieval results get noisy when the chain has 10,000 messages spanning 50 different topics. Trimming says "I'm done with this section, archive it, but keep it searchable."

**How it works:**

- **Trim** — you pick two points in the conversation. Everything between them stays active. Everything before and after gets archived. You're saying "this is the relevant section right now."
- **Branch** — you pick one point. Everything before it archives. You're saying "start fresh from here."
- **Archives are searchable** — the Bloom filter knows which terms exist in which archive block. TF-IDF vectors rank which block is most relevant to a query. When retrieval needs old context, it decompresses only the matching block, runs BM25 inside it, and injects the exact nodes.
- **Archives are restorable** — `memory.restore(key)` brings a block back into active memory. Nothing is ever permanently lost.

**When to trim:**
- You finished a project and want to start a new topic without old results polluting retrieval
- You want cleaner search results — fewer irrelevant matches
- You're about to switch contexts entirely (new day, new task, new subject)
- You don't want 6 months of conversation all competing for the 3 recall slots per turn

**When NOT to trim:**
- You're worried about RAM — you're not going to run out
- Performance feels slow — the slowness is your LLM inference, not Liminal's retrieval
- You might reference that section again soon — just leave it, retrieval handles it

```javascript
// Trim: select what to KEEP, everything else archives
await memory.trimKeepRange({ keepStart: 10, keepEnd: 30 });

// Branch: archive everything before a point
await memory.branchFrom(15);

// Restore an archive back into active memory
await memory.restore("archive_1_14");

// Search all history (including active chain)
const results = memory.search("that thing we discussed about authentication");
```

## Model Compatibility

| Server | Config |
|--------|--------|
| llama.cpp | `apiFormat: "openai"` |
| Ollama | `apiFormat: "ollama"` |
| LM Studio | `apiFormat: "openai"` |
| vLLM | `apiFormat: "openai"` |
| OpenAI | `apiFormat: "openai"` |
| Custom | `apiFormat: "custom"` + formatter functions |

## Demo

A full interactive demo is included with the project. It loads a prebuilt conversation, connects to your local model, and lets you test memory retrieval, tool use, trim/branch, and search — all in the browser.

```bash
git clone https://github.com/automacene/liminal-memory.git
cd liminal-memory
npm install
npm run build:umd
node serve.js
```

Then open `http://localhost:3000/demo/` in your browser.

Make sure your LLM server is running with CORS enabled (e.g., `llama-server --port 8081 --cors`). The demo defaults to `http://127.0.0.1:8081` — edit the config at the top of `demo/ui/js/app.js` if your setup is different.

## Development

```bash
npm install
npm run build        # ESM bundle
npm run build:umd    # UMD bundle (browser)
npm test             # 47 tests
node serve.js        # Demo at http://localhost:3000/demo/
```

## License

Apache 2.0 © Automacene

---

<details>
<summary>Full Configuration</summary>

```javascript
const memory = new LiminalMemory({
  endpoint: "http://127.0.0.1:8081",
  apiFormat: "openai",
  completionPath: "/v1/chat/completions",
  model: "local",
  systemPrompt: "You are a helpful assistant.",
  windowSize: 20,
  maxTokenBudget: 32768,
  reservedTokens: 2048,
  memoryLimitMB: 2048,
  warnThreshold: 0.8,
  archiveBlockSize: 1000,
  summaryFormat: "json",
  bm25: { k1: 1.2, b: 0.4 },
  bloom: { expectedItems: 100000, falsePositiveRate: 0.01 },
  retrievalThreshold: 0.3,
  maxRetrievedNodes: 3,
  deepRetrievalEnabled: true,
  deepRetrievalThreshold: 2,
  maxBranches: 7,
  branchSummaryMaxTokens: 150,
  recallBufferRatio: 0.3,
  toolMatchThreshold: 0.1
});
```

</details>

<details>
<summary>Full API Reference</summary>

```javascript
// Chat (full cycle: tools + retrieval + LLM)
const { response, toolsUsed } = await memory.chat(message);

// Manual nodes
memory.append(role, content);

// Search
memory.search(query, topK);

// Window
memory.getWindow();

// Context attachments
memory.attachContext(type, content);
memory.clearContext();

// Tools
memory.registerTool(tool);

// Memory operations
await memory.trim({ from, to });
await memory.trimKeepRange({ keepStart, keepEnd });
await memory.branchFrom(nodeId);
await memory.trimFromHere();
await memory.branch();
await memory.restore(archiveKey);

// Status & events
memory.status();
memory.on("memory-warning", callback);

// Persistence
await memory.export();
await memory.import(data);
```

</details>

<details>
<summary>Architecture</summary>

```
src/
├── core/              # Chain, window, buffers, compaction, retrieval
├── search/            # BM25, Bloom filter, TF-IDF
├── storage/           # RAM tracking, IndexedDB archive
├── transport/         # Model-agnostic HTTP client
├── tools/             # Tool base class + registry
├── extensions/        # Web search, datetime (tool implementations)
├── config.js
└── index.js
```

</details>
