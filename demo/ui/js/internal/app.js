/**
 * Luminal Memory — Main App Controller
 * Initializes the engine, loads fixtures, wires UI components.
 * Delegates heavy logic to: sovereign-loop.js, mock-responses.js
 *
 * No ES modules — loads as a regular script after component scripts.
 */
(function () {
  'use strict';

  // === Config ===
  var CONFIG = {
    endpoint: 'http://127.0.0.1:11434',
    apiFormat: 'ollama',
    completionPath: '/v1/chat/completions',
    model: 'gemma4-e4b:gpu',
    thinking: false,
    maxRetrievedNodes: 6,
    recallBufferRatio: 0.2,
    retrievalThreshold: 0.2,
    toolMatchThreshold: 0.5,
    webSearchEnabled: false,
    // DOGFOOD: we (the demo) plug our own NLP namer into the library's node-naming socket,
    // exactly like an outside developer would. The library keeps its instant keyword names;
    // this upgrades them to nice topic labels off the hot path (via enrichCategoryNames below).
    nodeNamer: nlpNameCluster
  };

  /**
   * NLP cluster namer plugged into the library's nodeNamer socket. Given the member nodes of a
   * freshly-split category, ask the local model for a short topic label. Runs OFF the hot path
   * (the library only calls this from enrichCategoryNames, never during a split). Returns
   * { label } or null to leave the instant keyword name in place.
   */
  async function nlpNameCluster(memberNodes) {
    try {
      var snippets = memberNodes
        .map(function (n) { return (n.content || '').replace(/\s+/g, ' ').slice(0, 200); })
        .filter(Boolean).join('\n---\n');
      if (!snippets) return null;
      // Reuse the library's own transport, so the namer speaks whatever backend the demo is
      // configured for (ollama/openai/custom) without duplicating any of that logic.
      var out = await memory.transport.complete([
        { role: 'system', content: 'You name topic clusters. Given a few related snippets, reply with ONLY a short 1-3 word topic label. No punctuation, no quotes, no explanation.' },
        { role: 'user', content: snippets }
      ]);
      var label = ((out && out.text) || '').split('\n')[0].replace(/["'.:]/g, '').trim().slice(0, 40);
      if (!label) return null;
      console.log('[NodeNamer] NLP named a ' + memberNodes.length + '-node cluster: "' + label + '"');
      return { label: label };
    } catch (e) {
      console.warn('[NodeNamer] NLP naming failed:', e.message);
      return null;
    }
  }

  // === State ===
  var memory = new LuminalMemory.LuminalMemory(CONFIG);
  CONFIG = memory.config;
  window._luminalMemory = memory;
  var ready = false;
  var llmAvailable = false;
  var _pendingRemotePrompt = null; // holds a control-channel prompt that arrived pre-init

  // Stream state (shared with SovereignLoop)
  var streamState = {
    currentAbort: null,
    lastMessages: null,
    lastPartialResponse: '',
    lastStreamMsg: null
  };

  // === Auto-Save / Restore ===
  var SAVE_KEY = 'luminal-memory-state';

  async function autoSave() {
    try {
      var state = await memory.export();
      // Save to server (JSON file on disk)
      await fetch('/api/state/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state, null, 2)
      });
      console.log('[AutoSave] Saved (' + memory.chain.length + ' nodes)');
    } catch (e) {
      console.warn('[AutoSave] Failed:', e.message);
    }
  }

  async function tryRestore() {
    try {
      var res = await fetch('/api/state/load');
      if (!res.ok) return false;
      var state = await res.json();
      if (!state || !state.chain || !state.chain.nodes || state.chain.nodes.length === 0) return false;
      // Import chain data only — don't overwrite current config
      delete state.config;
      await memory.import(state);
      console.log('[Restore] Restored ' + memory.chain.length + ' nodes from server');

      // Rebuild BM25 index if it wasn't in the saved state (e.g. DocGen ingest profiles)
      if (!state.bm25 || !state.bm25.documents || Object.keys(state.bm25.documents).length === 0) {
        console.log('[Restore] BM25 index empty — rebuilding from chain...');
        var allNodes = memory.chain.all();
        for (var ri = 0; ri < allNodes.length; ri++) {
          memory.bm25.add(allNodes[ri]);
        }
        console.log('[Restore] BM25 rebuilt: ' + allNodes.length + ' nodes indexed');
      }

      return true;
    } catch (e) {
      console.warn('[Restore] Failed:', e.message);
      return false;
    }
  }

  // === Pocket Queue Display ===
  function updatePocketQueueDisplay() {
    var queueEl = document.getElementById('pocket-queue');
    if (!queueEl) return;
    var items = queueEl.querySelectorAll('.pocket-queue__item');
    items.forEach(function (el) { el.remove(); });

    var pending = memory.pocket.queue;
    if (pending.length === 0) {
      queueEl.classList.remove('pocket-queue--active');
      return;
    }

    queueEl.classList.add('pocket-queue--active');
    pending.forEach(function (n) {
      var item = document.createElement('div');
      item.className = 'pocket-queue__item';
      item.textContent = '#' + n.id + ' ' + n.content.slice(0, 50) + (n.content.length > 50 ? '...' : '');
      queueEl.appendChild(item);
    });
  }

  // === Fixture loading ===
  var conversation = null;
  window.addEventListener('fixture-ready', function () {
    conversation = window.conversation35;
    init();
  });

  // === Initialize ===
  async function init() {
    Topbar.init();
    Topbar.setConfig(CONFIG);
    Chat.init();
    Modal.init();

    await memory.init();

    // Restore saved settings (persistent across restarts)
    try {
      var settingsRes = await fetch('/api/settings/load');
      if (settingsRes.ok) {
        var savedSettings = await settingsRes.json();
        if (savedSettings && typeof savedSettings === 'object') {
          Object.keys(savedSettings).forEach(function (group) {
            if (typeof savedSettings[group] === 'object') {
              Object.keys(savedSettings[group]).forEach(function (key) {
                memory.settings.set(key, savedSettings[group][key]);
              });
            }
          });
          CONFIG = memory.config;
          console.log('[Init] Restored saved settings');
        }
      }
    } catch (e) { /* no saved settings, use defaults */ }

    // Try restoring saved state — skip fixture if we have saved data
    var restored = await tryRestore();

    if (!restored) {
      // Load fixture into chain (fresh start)
      for (var i = 0; i < conversation.length - 1; i += 2) {
        var user = conversation[i];
        var assistant = conversation[i + 1];
        if (user && assistant) {
          memory.chain.appendTurn(user.content, assistant.content);
          var node = memory.chain.all()[memory.chain.length - 1];
          memory.bm25.add(node);
        }
      }
    }

    // Render preloaded messages (from fixture or restored chain)
    var allNodes = memory.chain.all();
    if (!restored) {
      var windowStart = conversation.length - (CONFIG.windowSize * 2);
      for (var j = 0; j < conversation.length; j++) {
        if (j === windowStart) Chat.renderWindowBoundary();
        Chat.renderMessage(conversation[j].role, conversation[j].content, Math.ceil((j + 1) / 2), false);
      }
    } else {
      // Render ALL nodes from restored chain (full scrollable history)
      var allRestoredNodes = memory.chain.all();
      var windowStart = Math.max(0, allRestoredNodes.length - CONFIG.windowSize);
      for (var k = 0; k < allRestoredNodes.length; k++) {
        if (k === windowStart) Chat.renderWindowBoundary();
        var wn = allRestoredNodes[k];
        if (wn.role === 'turn') {
          Chat.renderMessage('user', wn.query || '', wn.id, false);
          Chat.renderMessage('assistant', wn.response || '', wn.id, false);
        } else if (wn.role === 'user' || wn.role === 'assistant') {
          Chat.renderMessage(wn.role, wn.content || '', wn.id, false);
        } else if (wn.role === 'system' && wn.content) {
          var displayContent = wn.content.length > 400 ? wn.content.slice(0, 400) : wn.content;
          Chat.renderSystem(displayContent, { truncated: wn.content.length > 400, nodeId: wn.id });
        }
      }
      Chat.renderSystem('\u2713 Restored ' + allRestoredNodes.length + ' nodes from saved state');
    }

    // Check LLM availability
    try {
      var res = await fetch(CONFIG.endpoint + '/v1/models', { signal: AbortSignal.timeout(2000) });
      llmAvailable = res.ok;
    } catch (e) {
      llmAvailable = false;
    }

    // Detect thinking support
    if (llmAvailable) {
      try {
        var propsRes = await fetch(CONFIG.endpoint + '/props', { signal: AbortSignal.timeout(2000) });
        if (propsRes.ok) {
          var props = await propsRes.json();
          var template = props.default_generation_settings?.chat_template || props.chat_template || '';

          if (template.includes('<think>') || template.includes('<|think|>') || (props.thinking === 1)) {
            CONFIG.thinking = true;
            CONFIG.thinkOpen = template.includes('<|think|>') ? '<|think|>' : '<think>';
            CONFIG.thinkClose = template.includes('<|/think|>') ? '<|/think|>' : '</think>';
            console.log('[Init] Thinking detected: ' + CONFIG.thinkOpen);
          } else if (template.includes('<|channel>') || template.includes('thought<channel|>')) {
            CONFIG.thinking = true;
            CONFIG.thinkOpen = '<|channel>thought<channel|>';
            CONFIG.thinkClose = '<|channel>response<channel|>';
            console.log('[Init] Thinking detected (channel format)');
          } else {
            CONFIG.thinking = false;
          }

          if (template.includes('tool_call') || template.includes('<|tool_response>')) {
            CONFIG.toolCallFormat = 'native';
          }

          console.log('[Init] Model: ' + (props.model || props.default_generation_settings?.model || 'unknown'));
        }
      } catch (e) {
        console.log('[Init] Could not fetch /props');
      }
    }

    // Init components
    SelectionMode.init();
    RecallFX.init();
    SearchModal.init(memory);
    InspectModal.init(memory);
    StatusModal.init(memory);
    SettingsModal.init(memory);
    IngestModal.init();
    DocGen.init();
    DocGenIngest.init();
    Input.init(handleSend);

    // Dev control channel (control-client.js → serve.js): allow remote prompt injection.
    // If a prompt lands before init finishes, hold the latest and fire it once ready.
    window.addEventListener('luminal:remote-prompt', function (e) {
      var text = e && e.detail && e.detail.text;
      if (!text) return;
      if (ready) {
        handleSend(text);
      } else {
        _pendingRemotePrompt = text;
        console.warn('[Control] Prompt queued — app not ready yet');
      }
    });

    Toolbar.init({
      onTrim: handleTrim,
      onBranch: handleBranch,
      onSearch: function () { SearchModal.open(); },
      onInspect: function () { InspectModal.open(); },
      onStatus: function () { StatusModal.open(); }
    });

    // Register Ephemeral Mind tool
    var ephemeralMind = LuminalMemory.createEphemeralMindTool({
      transport: memory.transport,
      memoryConfig: CONFIG
    });
    memory.registerTool(ephemeralMind);

    // Register Web Search tool
    var webSearch = LuminalMemory.createWebSearchTool({ maxResults: 3, memoryConfig: CONFIG });
    memory.registerTool(webSearch);

    console.log('[Init] Tools registered: ephemeral_mind (llm), web_search (bm25)');

    // Pocket note mode
    initPocketMode();

    // Memory warning
    memory.on('memory-warning', function (data) {
      Chat.renderSystem('\u26A0\uFE0F Memory at ' + Math.round(data.utilization * 100) + '% (' + data.usageMB.toFixed(1) + ' MB). Consider trimming.');
    });

    ready = true;
    Topbar.setStatus('active', llmAvailable ? 'READY' : 'MOCK LLM');
    refreshStats();

    // Flush any control-channel prompt that arrived while we were still initializing.
    if (_pendingRemotePrompt) {
      var _queued = _pendingRemotePrompt;
      _pendingRemotePrompt = null;
      console.log('[Control] Flushing queued prompt now that app is ready');
      handleSend(_queued);
    }

    // Settings change listener
    var _recheckTimer = null;
    var _settingsSaveTimer = null;
    memory.settings.onChange(function (key) {
      refreshStats();
      if (key === 'endpoint' || key === 'apiFormat' || key === 'model') {
        clearTimeout(_recheckTimer);
        _recheckTimer = setTimeout(recheckLLM, 150);
      }
      // Persist settings to disk (debounced)
      clearTimeout(_settingsSaveTimer);
      _settingsSaveTimer = setTimeout(function () {
        var allSettings = memory.settings.getAll();
        fetch('/api/settings/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(allSettings, null, 2)
        }).catch(function () {});
      }, 500);
    });

    if (!llmAvailable) {
      Chat.renderSystem('\u26A1 No LLM server at ' + CONFIG.endpoint + ' \u2014 using mock responses. Memory/search/retrieval are all real.');
    }

    console.log('[Init] Chain: ' + memory.chain.length + ' nodes | Window: ' + memory.getWindow().length + '/' + CONFIG.windowSize + ' | LLM: ' + llmAvailable);
  }

  // === Pocket Note Mode ===
  function initPocketMode() {
    var pocketMode = false;
    var inputBox = document.querySelector('.input-box');

    function activate() {
      pocketMode = true;
      inputBox.classList.add('input-box--pocket-mode');
      var input = document.getElementById('user-input');
      input.placeholder = 'Queue a pocket note (Enter to add, Esc to exit)...';
      input.value = '';
      input.focus();
      Topbar.setStatus('active', 'POCKET (' + memory.pocket.pending + ' queued)');
    }

    function deactivate() {
      pocketMode = false;
      inputBox.classList.remove('input-box--pocket-mode');
      var input = document.getElementById('user-input');
      input.placeholder = 'Type a message...';
      Topbar.setStatus('active', memory.pocket.pending > 0 ? 'READY (' + memory.pocket.pending + ' notes)' : 'READY');
    }

    function queue() {
      var input = document.getElementById('user-input');
      var note = input.value.trim();
      if (!note) return;
      var noteObj = memory.pocket.add(note);
      input.value = '';

      var staging = document.getElementById('pocket-staging');
      var noteEl = document.createElement('div');
      noteEl.className = 'pocket-staging__note';
      noteEl.id = 'pocket-staged-' + noteObj.id;
      noteEl.innerHTML = '<div class="pocket-staging__label">\u270E queued #' + noteObj.id + '</div>' + note;
      staging.appendChild(noteEl);
      updatePocketQueueDisplay();
      Topbar.setStatus('active', 'POCKET (' + memory.pocket.pending + ' queued)');
    }

    document.getElementById('pocket-note-btn').addEventListener('click', function () {
      if (pocketMode) deactivate(); else activate();
    });

    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.key === 'q') { e.preventDefault(); if (pocketMode) deactivate(); else activate(); }
      if (e.key === 'Escape' && pocketMode) deactivate();
    });

    document.getElementById('user-input').addEventListener('keydown', function (e) {
      if (pocketMode && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        queue();
      }
    });
  }

  // === Send Handler ===
  async function handleSend(msg) {
    if (!ready) return;

    Input.disable();
    Topbar.setStatus('active', 'SOVEREIGN MIND');
    Chat.renderMessage('user', msg, memory.chain.length + 1, true);

    try {
      var pendingNode = memory.chain.append('user', msg);
      memory.bm25.add(pendingNode);

      // BM25-discovered tools
      var toolResults = [];
      var chainMatch = ToolChain.match(msg);

      if (chainMatch) {
        Topbar.setStatus('active', 'CHAIN: ' + chainMatch.recipe.name.toUpperCase());
        Chat.renderSystem('\u2692 Running chain: ' + chainMatch.recipe.name);
        var chainResult = await ToolChain.execute(chainMatch.recipe, msg);
        if (chainResult && chainResult.formatted) {
          toolResults.push({ name: chainMatch.recipe.name, result: { formatted: chainResult.formatted } });
          Chat.renderSystem('\u2713 Chain complete: ' + chainResult.steps.length + ' steps');
        }
      } else {
        var matchedTools = memory.toolRegistry.retrieve(msg);
        if (matchedTools.length > 0 && matchedTools[0].score > 0.5) {
          var topTool = matchedTools[0].tool;
          Topbar.setStatus('active', 'TOOL: ' + topTool.name.toUpperCase());
          Chat.renderSystem('\u2692 Using tool: ' + topTool.name);
          var toolResult = await memory.toolRegistry.execute(topTool.name, { query: msg }, { query: msg, chain: memory.chain, config: memory.config });
          if (toolResult.success) {
            toolResults.push({ name: topTool.name, result: toolResult.result });
            Chat.renderSystem('\u2713 ' + topTool.name + ' (' + toolResult.elapsed + 'ms)');

            // Store web search results as research nodes (BM25 indexed, persistent)
            if (topTool.name === 'web_search' && toolResult.result.results) {
              toolResult.result.results.forEach(function (r) {
                if (r.content && r.content.length > 30) {
                  var researchNode = memory.chain.append('system', '[Research: ' + (r.title || 'Web') + '] ' + r.content.slice(0, 800));
                  memory.bm25.add(researchNode);
                }
              });
              console.log('[WebSearch] Stored ' + toolResult.result.results.length + ' research nodes');
            }
          } else {
            Chat.renderSystem('\u2717 Tool failed: ' + toolResult.error);
          }
        }
      }

      // Recall — delegated to the library's retrieval engine (src/core/retrieval.js),
      // the SAME path LuminalMemory.chat() uses: BM25 recall + N-hop graph expansion +
      // relevance ranking + edge creation from this turn to whatever it recalls. The demo
      // used to re-implement all of this inline; it now calls the library so it exercises
      // the real code on every turn and can't silently drift from it (ROADMAP.md Phase 1.5).
      // The [Graph:Expand] / [Graph] trace lines now originate in the library itself.
      var windowNodes = memory.getWindow();
      var recall = await memory.retrieval.retrieve(msg, windowNodes, pendingNode.id);
      var recallNodes = recall.nodes;

      if (recallNodes.length > 0) {
        Chat.renderRecall(recallNodes.length);
        RecallFX.fire(recallNodes);
      }

      // Build prompt
      var messages = memory.window.buildMessages(windowNodes, recallNodes, CONFIG.systemPrompt);

      // Inject BM25 tool results
      if (toolResults.length > 0) {
        var toolContext = toolResults.map(function (t) {
          return t.result && t.result.formatted ? t.result.formatted : JSON.stringify(t.result, null, 2);
        }).join('\n\n');
        messages.splice(messages.length - 1, 0, {
          role: 'system',
          content: 'Tool output:\n' + toolContext
        });
      }

      // Inject LLM-discovery tool schemas (not needed — critique loop is system-driven)
      // Sovereign just answers. System handles the ephemeral critique automatically.

      var response;
      if (llmAvailable) {
        // Pocket note checkpoint
        if (memory.pocket.hasPending) {
          var pocketNote = memory.pocket.consume();
          messages.splice(messages.length - 1, 0, { role: 'system', content: '[Pocket Note #' + pocketNote.id + ']: ' + pocketNote.content });
          Chat.renderSystem('\u2713 Pocket note #' + pocketNote.id + ' applied');
          updatePocketQueueDisplay();
        }

        messages = SovereignLoop.fixRoles(messages);

        // Run the Sovereign ↔ Ephemeral loop
        response = await SovereignLoop.run({
          messages: messages,
          memory: memory,
          config: CONFIG,
          userMsg: msg,
          streamState: streamState
        });
      } else {
        await new Promise(function (r) { setTimeout(r, 400 + Math.random() * 600); });
        response = MockLLM.getResponse(msg);
        Chat.renderMessage('assistant', response, memory.chain.length + 1, true);
      }

      // Store turn
      memory.chain.removeById(pendingNode.id);
      memory.bm25.remove(pendingNode.id);
      var cleanResponse = (response || '').replace(/<\|channel>\w+\s*<channel\|>/g, '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      var turnNode = memory.chain.appendTurn(msg, cleanResponse);
      memory.bm25.add(turnNode);

      Topbar.setStatus('active', llmAvailable ? 'READY' : 'MOCK LLM');

      // Post-response pocket checkpoint
      if (memory.pocket.hasPending) {
        var postNote = memory.pocket.consume();
        var stagedEl = document.getElementById('pocket-staged-' + postNote.id);
        if (stagedEl) stagedEl.remove();
        var chatStream = document.getElementById('chat-stream');
        var notePanel = document.createElement('div');
        notePanel.className = 'pocket-note-panel';
        notePanel.innerHTML = '<div class="pocket-note-panel__label">\u270E Note #' + postNote.id + ' \u2014 applied</div>' + postNote.content;
        chatStream.appendChild(notePanel);
        chatStream.scrollTop = chatStream.scrollHeight;
        updatePocketQueueDisplay();
        await new Promise(function (r) { setTimeout(r, 200); });
        await handleSend(postNote.content);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('[Stream] Aborted');
      } else {
        Chat.renderSystem('\u274C Error: ' + err.message);
        Topbar.setStatus('idle', 'ERROR');
        console.error(err);
      }
    }

    Input.enable();
    refreshStats();
    autoSave();

    // DOGFOOD: after the turn (off the hot path), let our plugged-in NLP namer upgrade the names
    // of any category nodes the splits created this turn. Fire-and-forget — never blocks the UI.
    memory.enrichCategoryNames().then(function (n) {
      if (n > 0) {
        console.log('[NodeNamer] upgraded ' + n + ' category node name(s) via the NLP plug');
        refreshStats();
      }
    }).catch(function (e) { console.warn('[NodeNamer] enrich failed:', e.message); });
  }

  // === Trim ===
  function handleTrim() {
    if (!ready) return;
    if (SelectionMode.isActive()) { SelectionMode.cancel(); return; }
    SelectionMode.startTrim(async function (data) {
      try {
        var result = await memory.trimKeepRange({ keepStart: data.keepStartId, keepEnd: data.keepEndId });
        var archived = 0;
        if (result.before) archived += result.before.metadata.nodeCount;
        if (result.after) archived += result.after.metadata.nodeCount;
        Chat.removeArchived({ keepStart: data.keepStartId, keepEnd: data.keepEndId });
        Chat.renderSystem('\u2702\uFE0F Trimmed ' + archived + ' nodes to archive.');
      } catch (err) {
        Chat.renderSystem('\u274C Trim failed: ' + err.message);
      }
      refreshStats();
    });
  }

  // === Branch ===
  function handleBranch() {
    if (!ready) return;
    if (SelectionMode.isActive()) { SelectionMode.cancel(); return; }
    SelectionMode.startBranch(async function (data) {
      try {
        var result = await memory.branchFrom(data.fromNodeId);
        if (result) {
          Chat.removeArchived({ fromNodeId: data.fromNodeId });
          Chat.renderSystem('\u2325 Branched from Node ' + data.fromNodeId + '. ' + result.metadata.nodeCount + ' nodes archived.');
        } else {
          Chat.renderSystem('Nothing to archive before Node ' + data.fromNodeId + '.');
        }
      } catch (err) {
        Chat.renderSystem('\u274C Branch failed: ' + err.message);
      }
      refreshStats();
    });
  }

  // === Stats ===
  function refreshStats() {
    var s = memory.status();
    Topbar.updateStats(s.totalNodes, memory.getWindow().length, s.memoryUsageMB, s.totalTokens);
    var sideArchives = document.getElementById('side-archives');
    if (sideArchives) sideArchives.textContent = s.archiveBlocks;
  }
  window._refreshStats = refreshStats;

  // === Recheck LLM ===
  var _recheckAbort = null;
  async function recheckLLM() {
    if (_recheckAbort) _recheckAbort.abort();
    _recheckAbort = new AbortController();
    var endpoint = memory.config.endpoint;
    var apiFormat = memory.config.apiFormat;
    try {
      var checkUrl = apiFormat === 'ollama' ? endpoint + '/api/tags' : endpoint + '/v1/models';
      var res = await fetch(checkUrl, { signal: _recheckAbort.signal });
      llmAvailable = res.ok;
    } catch (e) {
      if (e.name === 'AbortError') return;
      llmAvailable = false;
    }
    _recheckAbort = null;
    Topbar.setStatus('active', llmAvailable ? 'READY' : 'MOCK LLM');
    if (llmAvailable) {
      Chat.renderSystem('\u2713 Connected to ' + apiFormat + ' at ' + endpoint + (memory.config.model ? ' (' + memory.config.model + ')' : ''));
    }
  }

})();
