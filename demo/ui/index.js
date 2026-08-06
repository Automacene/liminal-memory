/**
 * LUMINAL MEMORY — Demo UI Interface
 * ================================================================
 * Top-level manifest for the entire demo UI layer.
 * AI agents: read this file to understand the full demo structure.
 *
 * STRUCTURE:
 * ----------------------------------------------------------------
 * demo/ui/
 * ├── index.js          ← YOU ARE HERE (top-level interface)
 * ├── assets/           — Static assets (background GIF)
 * ├── css/
 * │   ├── index.css     — Style entry point (the only CSS door)
 * │   └── internal/     — Atomic design internals
 * │       ├── atoms/        — Design tokens (variables, reset, typography)
 * │       ├── molecules/    — Buttons, cards, modals
 * │       ├── organisms/    — Topbar, chat, input, toolbar, settings, etc.
 * │       └── templates/    — Page layout
 * └── js/
 *     ├── index.js      — JS entry point (module map + helpers)
 *     └── internal/     — All implementation
 *         ├── vendor/       — Third-party libs (gifuct)
 *         ├── canvas.js     — Animated background
 *         ├── components/   — UI components (11 modules)
 *         ├── tools/        — Tool chain execution
 *         └── app.js        — Main controller
 *
 * HOW IT WORKS:
 * ----------------------------------------------------------------
 * 1. index.html loads css/index.css (one stylesheet import)
 * 2. index.html loads the UMD library bundle (dist/luminal-memory.umd.js)
 * 3. index.html loads a fixture module (demo/fixtures/knowledge-base.js)
 * 4. index.html loads all JS scripts from js/internal/ in order
 * 5. app.js boots: creates LuminalMemory instance, loads fixture, wires UI
 *
 * KEY CONCEPTS:
 * ----------------------------------------------------------------
 * - All JS is plain scripts (no ES modules in UI) — globals communicate
 * - The library is an ES module bundled to UMD (window.LuminalMemory)
 * - The demo CONFIG is passed to LuminalMemory, then reassigned to memory.config
 *   so there's one source of truth for all settings
 * - Settings modal dynamically detects backends (llama.cpp + Ollama) and
 *   builds sampling controls from whatever the server reports
 * - The chat flow: user message → BM25 recall → tool routing → prompt build →
 *   stream from LLM → store turn node → refresh stats
 *
 * HELPERS:
 * ----------------------------------------------------------------
 */

/**
 * Get the full file inventory for the demo UI.
 * Useful for build tools or AI agents exploring the codebase.
 * @returns {object}
 */
function getDemoUIInventory() {
  return {
    css: {
      entry: 'css/index.css',
      atoms: ['variables.css', 'reset.css', 'typography.css'],
      molecules: ['buttons.css', 'cards.css', 'modal.css'],
      organisms: ['topbar.css', 'chat.css', 'input.css', 'toolbar.css', 'canvas.css', 'sidebar-stats.css', 'selection-mode.css', 'settings.css'],
      templates: ['layout.css']
    },
    js: {
      entry: 'js/index.js',
      vendor: ['gifuct.js'],
      core: ['canvas.js', 'app.js'],
      components: ['modal.js', 'topbar.js', 'chat.js', 'input.js', 'toolbar.js', 'search-modal.js', 'inspect-modal.js', 'status-modal.js', 'settings-modal.js', 'selection-mode.js', 'recall-fx.js'],
      tools: ['toolchain.js']
    },
    assets: ['bg.gif'],
    fixtures: ['knowledge-base.js']
  };
}
