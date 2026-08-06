/**
 * LUMINAL MEMORY — Demo Application Interface
 * ================================================================
 * Entry point for understanding the entire demo/ folder.
 * AI agents: read this file FIRST when working on anything in demo/.
 *
 * WHAT IS THIS DEMO?
 * ----------------------------------------------------------------
 * A single-page browser app that showcases the Luminal Memory library.
 * It loads a prebuilt conversation fixture, connects to a local LLM
 * (llama.cpp or Ollama), and provides a full chat UI with:
 *   - Real-time BM25 recall from conversation history
 *   - Streaming LLM responses with thinking/reasoning display
 *   - Trim/branch operations for memory management
 *   - Tool execution (web search, datetime, file explorer)
 *   - Settings modal with live backend detection + sampling params
 *   - Pocket notes (correction/annotation queue)
 *
 * FILE STRUCTURE:
 * ----------------------------------------------------------------
 * demo/
 * ├── index.js              ← YOU ARE HERE (demo interface)
 * ├── index.html            — App shell. Loads CSS + library + fixtures + UI scripts.
 * ├── fixtures/
 * │   └── knowledge-base.js — 60-message conversation fixture (ES module export)
 * └── ui/
 *     ├── index.js          — UI layer interface (architecture + inventory)
 *     ├── assets/
 *     │   └── bg.gif        — Animated background for geometric canvas
 *     ├── css/
 *     │   ├── index.css     — Single stylesheet entry point
 *     │   └── internal/     — Atomic design (atoms/molecules/organisms/templates)
 *     └── js/
 *         ├── index.js      — JS module map, load order, helpers
 *         └── internal/     — All JS implementation
 *             ├── app.js        — Main controller (boot, send, trim, branch, stats)
 *             ├── canvas.js     — Animated geometric background
 *             ├── components/   — 11 UI components (modal, chat, settings, etc.)
 *             ├── tools/        — Toolchain multi-step execution
 *             └── vendor/       — Third-party (gifuct GIF decoder)
 *
 * HOW TO READ THIS DEMO:
 * ----------------------------------------------------------------
 * 1. Start here (you're doing it right)
 * 2. For UI specifics → demo/ui/index.js
 * 3. For JS module details → demo/ui/js/index.js
 * 4. For CSS architecture → demo/ui/css/index.css
 * 5. For the actual app logic → demo/ui/js/internal/app.js
 *
 * DATA FLOW (per user message):
 * ----------------------------------------------------------------
 * 1. User types message → Input component captures
 * 2. Message appended to Chain as pending node, indexed in BM25
 * 3. Tool matching (BM25 on tool descriptions) → execute if triggered
 * 4. Recall: BM25 search outside window → inject historical nodes
 * 5. Prompt built: system prompt + recall block + sliding window + tool results
 * 6. Role-fixing: collapse multiple system messages for API compliance
 * 7. Stream to LLM (llama.cpp or Ollama via transport)
 * 8. Response stored as turn node, BM25 re-indexed
 * 9. Stats refreshed (tokens, window count, memory usage)
 *
 * KEY DEPENDENCIES:
 * ----------------------------------------------------------------
 * - dist/luminal-memory.umd.js — The library (loaded as UMD global: window.LuminalMemory)
 * - marked.js (CDN)            — Markdown rendering for assistant messages
 * - gifuct-js (vendored)       — GIF frame extraction for canvas background
 *
 * CONFIGURATION:
 * ----------------------------------------------------------------
 * The demo passes minimal overrides to LuminalMemory constructor:
 *   { endpoint, apiFormat, completionPath, model, thinking, ... }
 * After construction, CONFIG = memory.config (the merged result).
 * All settings are editable live via the Settings modal (gear icon in topbar).
 *
 * SERVING:
 * ----------------------------------------------------------------
 * Run: node serve.js
 * Opens at: http://localhost:3000/demo/
 * The serve.js file is a zero-dependency static file server at the project root.
 * ================================================================
 */
