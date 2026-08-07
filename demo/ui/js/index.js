/**
 * LUMINAL MEMORY — Demo UI JavaScript Interface
 * ================================================================
 * Single entry point for all demo UI scripts.
 * AI agents: read this file to understand the full UI module map.
 *
 * ARCHITECTURE:
 *   All implementation lives in ./internal/
 *   This file is the manifest — it describes what exists and load order.
 *
 * LOAD ORDER (matters — scripts are non-module globals):
 *   1. vendor/     — third-party (gifuct for GIF canvas)
 *   2. canvas.js   — background animated geometric canvas
 *   3. components/ — UI components (modals, chat, input, toolbar, etc.)
 *   4. tools/      — tool chain logic (multi-step tool execution)
 *   5. app.js      — main controller (boots everything, wires events)
 *
 * MODULE MAP:
 * ----------------------------------------------------------------
 * internal/vendor/gifuct.js       — GIF decoder for animated background
 * internal/canvas.js              — WebGL/Canvas2D geometric animation layer
 *
 * internal/components/modal.js          — Generic modal open/close controller
 * internal/components/topbar.js         — Header status bar + stats display
 * internal/components/chat.js           — Chat message rendering + streaming
 * internal/components/input.js          — Textarea input + send button
 * internal/components/toolbar.js        — Trim/Branch/Search/Inspect/Status buttons
 * internal/components/search-modal.js   — BM25 search across conversation history
 * internal/components/inspect-modal.js  — Memory node inspector
 * internal/components/status-modal.js   — System metrics display
 * internal/components/settings-modal.js — Settings panel (config + sampling + backends)
 * internal/components/selection-mode.js — Node range selection for trim/branch
 * internal/components/recall-fx.js      — Visual recall animation effect
 * internal/components/ingest-modal.js   — Document/repo ingestion panel
 *
 * internal/tools/toolchain.js     — Multi-step deterministic tool execution
 *
 * internal/app.js                 — Main app controller:
 *   - Initializes LuminalMemory engine with config
 *   - Loads conversation fixtures
 *   - Detects LLM server + thinking support
 *   - Wires send handler (retrieval → prompt build → stream → store)
 *   - Manages pocket notes, tool routing, abort/regen
 *   - Refreshes sidebar stats on config changes
 *
 * GLOBALS EXPOSED (for cross-component communication):
 *   Modal, Topbar, Chat, Input, Toolbar, SearchModal, InspectModal,
 *   StatusModal, SettingsModal, SelectionMode, RecallFX, IngestModal, ToolChain
 *
 * HELPERS:
 * ----------------------------------------------------------------
 * getScriptBasePath()  — Returns the base path for internal scripts
 * getLoadOrder()       — Returns ordered array of script paths
 * ================================================================
 */

// --- Helpers ---

/**
 * Get the base path for all internal JS files.
 * @returns {string}
 */
function getScriptBasePath() {
  return 'ui/js/internal';
}

/**
 * Get the correct load order for all UI scripts.
 * Use this if dynamically loading scripts.
 * @returns {string[]}
 */
function getLoadOrder() {
  var base = getScriptBasePath();
  return [
    base + '/vendor/gifuct.js',
    base + '/canvas.js',
    base + '/components/modal.js',
    base + '/components/topbar.js',
    base + '/components/chat.js',
    base + '/components/input.js',
    base + '/components/toolbar.js',
    base + '/components/search-modal.js',
    base + '/components/inspect-modal.js',
    base + '/components/status-modal.js',
    base + '/components/settings-modal.js',
    base + '/components/selection-mode.js',
    base + '/components/recall-fx.js',
    base + '/components/ingest-modal.js',
    base + '/tools/toolchain.js',
    base + '/mock-responses.js',
    base + '/sovereign-loop.js',
    base + '/app.js'
  ];
}
