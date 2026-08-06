/**
 * Luminal Memory — Main App Controller
 * Initializes the real LuminalMemory engine, loads test data,
 * and wires all UI components together.
 * 
 * No ES modules — loads as a regular script after component scripts.
 */
(function () {
  'use strict';

  // === Config ===
  // Demo-specific overrides. Everything else comes from the library's defaultConfig.
  var CONFIG = {
    endpoint: 'http://127.0.0.1:8081',
    apiFormat: 'openai',
    completionPath: '/v1/chat/completions',
    model: 'gemma-4-26B-A4B-it',
    thinking: false,
    maxRetrievedNodes: 6,
    recallBufferRatio: 0.2,
    retrievalThreshold: 0.2,
    toolMatchThreshold: 0.5
  };

  // === State ===
  var memory = new LuminalMemory.LuminalMemory(CONFIG);
  // CONFIG is now the merged config from the library (has all defaults filled in)
  CONFIG = memory.config;
  window._luminalMemory = memory; // expose for pocket notes
  var ready = false;
  var llmAvailable = false;

  // Stream abort + regeneration state
  var currentAbort = null;      // AbortController for active stream
  var lastMessages = null;      // last prompt messages (for regeneration)
  var lastPendingNode = null;   // pending node being processed
  var lastPartialResponse = ''; // what the LLM wrote before abort
  var lastStreamMsg = null;     // streaming UI element

  // Pocket queue display (top-level so both init and handleSend can access)
  function updatePocketQueueDisplay() {
    var queueEl = document.getElementById('pocket-queue');
    if (!queueEl) return;
    var items = queueEl.querySelectorAll('.pocket-queue__item');
    items.forEach(function (el) { el.remove(); });

    // Only show PENDING notes — consumed ones disappear entirely
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

  // === Test conversation fixture — loaded via module script into window.conversation35 ===
  var conversation = null;

  // === Boot — always wait for fixture-ready event ===
  window.addEventListener('fixture-ready', function () {
    conversation = window.conversation35;
    init();
  });

  // === Mock LLM responses ===
  var mockResponses = [
    'Based on the retrieval pipeline, I found relevant context from earlier in our conversation to answer that.',
    'The BM25 search identified matching nodes in the chain. Here is what I found from the recalled context.',
    'Interesting question. Let me pull from the memory graph to give you a useful answer.',
    'I found relevant nodes outside the current window. The recall buffer has been populated with historical context.',
    'The bloom filter confirmed potential matches in the active chain. BM25 scored and ranked the results.',
    'Searching the sliding window and recall buffer for relevant context to synthesize a response.'
  ];
  var mockIdx = 0;

  function getMockResponse(query) {
    var q = query.toLowerCase();
    if (q.indexOf('pineapple') !== -1 || q.indexOf('code word') !== -1 || q.indexOf('secret') !== -1) {
      return 'The secret code word is pineapple \u2014 you set it up back in turn 4 during the BM25 Python session. Retrieved from node 4 via BM25 recall.';
    }
    if (q.indexOf('dog') !== -1 || q.indexOf('corgi') !== -1 || q.indexOf('biscuit') !== -1 || q.indexOf('mochi') !== -1) {
      return "From memory chain: your friend has a corgi named Biscuit who herds cats. You're getting your own corgi named Mochi. Vet is Dr. Nakamura, Hillside Animal Clinic, 4th street.";
    }
    if (q.indexOf('bm25') !== -1 || q.indexOf('python') !== -1 || q.indexOf('k1') !== -1) {
      return 'Retrieved from chain: Python 3.11.4, project at C:\\Users\\dev\\projects\\memory-engine. BM25 settings for conversational text: k1=1.2, b=0.4.';
    }
    if (q.indexOf('tokyo') !== -1 || q.indexOf('japan') !== -1 || q.indexOf('cherry') !== -1 || q.indexOf('flight') !== -1) {
      return 'From recalled nodes: Tokyo trip March 28 - April 8, ANA flight NH109. Airalo eSIM, Suica card, budget ~\u00A510,000-15,000/day. Vegetarian: try shojin ryori.';
    }
    if (q.indexOf('music') !== -1 || q.indexOf('beat') !== -1 || q.indexOf('fl studio') !== -1) {
      return "From memory: FL Studio on Windows, lo-fi at 80 BPM, trap at 140 BPM. Splice username: beatmaker_mochi. Focusrite Scarlett 2i2 interface.";
    }
    if (q.indexOf('pc') !== -1 || q.indexOf('cpu') !== -1 || q.indexOf('build') !== -1 || q.indexOf('ryzen') !== -1) {
      return 'From chain: Ryzen 7 7800X3D, MSI MAG B650 TOMAHAWK, 32GB DDR5-6000, RTX 4060 Ti, Fractal Meshify 2, Corsair RM750x. Microcenter Tustin.';
    }
    var resp = mockResponses[mockIdx % mockResponses.length];
    mockIdx++;
    return resp;
  }

  // === Initialize ===
  async function init() {
    // Init all components
    Topbar.init();
    Topbar.setConfig(CONFIG);
    Chat.init();
    Modal.init();

    // Init memory engine
    await memory.init();

    // Load test conversation into the real chain
    for (var i = 0; i < conversation.length - 1; i += 2) {
      var user = conversation[i];
      var assistant = conversation[i + 1];
      if (user && assistant) {
        memory.chain.appendTurn(user.content, assistant.content);
        var node = memory.chain.all()[memory.chain.length - 1];
        memory.bm25.add(node);
      }
    }

    // Render preloaded messages with window boundary
    var windowStart = conversation.length - (CONFIG.windowSize * 2); // windowSize turns = 2x messages
    for (var j = 0; j < conversation.length; j++) {
      if (j === windowStart) {
        Chat.renderWindowBoundary();
      }
      Chat.renderMessage(conversation[j].role, conversation[j].content, Math.ceil((j + 1) / 2), false);
    }

    // Check if LLM is reachable + detect model capabilities
    try {
      var res = await fetch(CONFIG.endpoint + '/v1/models', { signal: AbortSignal.timeout(2000) });
      llmAvailable = res.ok;
    } catch (e) {
      llmAvailable = false;
    }

    // Auto-detect thinking support from server props
    if (llmAvailable) {
      try {
        var propsRes = await fetch(CONFIG.endpoint + '/props', { signal: AbortSignal.timeout(2000) });
        if (propsRes.ok) {
          var props = await propsRes.json();
          var template = props.default_generation_settings?.chat_template || props.chat_template || '';
          
          // Detect thinking channel
          if (template.includes('<think>') || template.includes('<|think|>') || (props.thinking === 1)) {
            CONFIG.thinking = true;
            CONFIG.thinkOpen = template.includes('<|think|>') ? '<|think|>' : '<think>';
            CONFIG.thinkClose = template.includes('<|/think|>') ? '<|/think|>' : '</think>';
            console.log('[Init] Thinking detected: ' + CONFIG.thinkOpen);
          } else if (template.includes('<|channel>') || template.includes('thought<channel|>')) {
            CONFIG.thinking = true;
            CONFIG.thinkOpen = '<|channel>thought<channel|>';
            CONFIG.thinkClose = '<|channel>response<channel|>';
            console.log('[Init] Thinking detected (channel format): ' + CONFIG.thinkOpen);
          } else {
            CONFIG.thinking = false;
            console.log('[Init] No thinking support detected in model template');
          }

          // Detect tool call format
          if (template.includes('tool_call') || template.includes('<|tool_response>')) {
            CONFIG.toolCallFormat = 'native';
            console.log('[Init] Native tool calling detected in template');
          }

          // Log model info
          var modelName = props.model || props.default_generation_settings?.model || 'unknown';
          console.log('[Init] Model: ' + modelName);
        }
      } catch (e) {
        console.log('[Init] Could not fetch /props — using defaults');
      }
    }

    // Init components that need memory ref
    SelectionMode.init();
    RecallFX.init();
    SearchModal.init(memory);
    InspectModal.init(memory);
    StatusModal.init(memory);
    SettingsModal.init(memory);
    Input.init(handleSend);
    Toolbar.init({
      onTrim: handleTrim,
      onBranch: handleBranch,
      onSearch: function () { SearchModal.open(); },
      onInspect: function () { InspectModal.open(); },
      onStatus: function () { StatusModal.open(); }
    });

    // Register tools
    var webSearch = LuminalMemory.createWebSearchTool({ limit: 3 });
    memory.registerTool(webSearch);
    var dateTime = LuminalMemory.createDateTimeTool();
    memory.registerTool(dateTime);
    var grep = LuminalMemory.createExplorerTool({ serverUrl: '' });
    memory.registerTool(grep);
    console.log('[Init] Tools registered: web_search, datetime, project_explorer');

    // Pocket note — queue-based. Notes accumulate and get consumed at checkpoints.
    var pocketMode = false;
    var inputBox = document.querySelector('.input-box');

    function activatePocketMode() {
      pocketMode = true;
      inputBox.classList.add('input-box--pocket-mode');
      var input = document.getElementById('user-input');
      input.placeholder = 'Queue a pocket note (Enter to add, Esc to exit)...';
      input.value = '';
      input.focus();
      Topbar.setStatus('active', 'POCKET (' + memory.pocket.pending + ' queued)');
    }

    function exitPocketMode() {
      pocketMode = false;
      inputBox.classList.remove('input-box--pocket-mode');
      var input = document.getElementById('user-input');
      input.placeholder = 'Type a message...';
      Topbar.setStatus('active', memory.pocket.pending > 0 ? 'READY (' + memory.pocket.pending + ' notes)' : 'READY');
    }

    function queuePocketNote() {
      var input = document.getElementById('user-input');
      var note = input.value.trim();
      if (!note) return;

      var noteObj = memory.pocket.add(note);
      input.value = '';

      // Add to staging area (pinned to bottom of chat)
      var staging = document.getElementById('pocket-staging');
      var noteEl = document.createElement('div');
      noteEl.className = 'pocket-staging__note';
      noteEl.id = 'pocket-staged-' + noteObj.id;
      noteEl.innerHTML = '<div class="pocket-staging__label">\u270E queued #' + noteObj.id + '</div>' + note;
      staging.appendChild(noteEl);

      // Update right-side queue display
      updatePocketQueueDisplay();

      Topbar.setStatus('active', 'POCKET (' + memory.pocket.pending + ' queued)');
      console.log('[Pocket] Queued: "' + note + '" (' + memory.pocket.pending + ' pending)');
    }


    // Button click toggles pocket mode
    document.getElementById('pocket-note-btn').addEventListener('click', function () {
      if (pocketMode) exitPocketMode();
      else activatePocketMode();
    });

    // Ctrl+Q shortcut
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.key === 'q') {
        e.preventDefault();
        if (pocketMode) exitPocketMode();
        else activatePocketMode();
      }
      // Esc exits pocket mode
      if (e.key === 'Escape' && pocketMode) {
        exitPocketMode();
      }
    });

    // Enter in pocket mode queues the note (doesn't send as chat)
    document.getElementById('user-input').addEventListener('keydown', function (e) {
      if (pocketMode && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        queuePocketNote();
      }
    });

    // Memory warning listener
    memory.on('memory-warning', function (data) {
      Chat.renderSystem('\u26A0\uFE0F Memory at ' + Math.round(data.utilization * 100) + '% (' + data.usageMB.toFixed(1) + ' MB). Consider trimming.');
    });

    ready = true;
    Topbar.setStatus('active', llmAvailable ? 'READY' : 'MOCK LLM');
    refreshStats();

    // Live-update sidebar when settings change, and re-check LLM connectivity on backend switch
    var _recheckTimer = null;
    memory.settings.onChange(function (key) {
      refreshStats();
      if (key === 'endpoint' || key === 'apiFormat' || key === 'model') {
        // Debounce — wait for all 3 fields to settle before checking
        clearTimeout(_recheckTimer);
        _recheckTimer = setTimeout(recheckLLM, 150);
      }
    });

    if (!llmAvailable) {
      Chat.renderSystem('\u26A1 No LLM server at ' + CONFIG.endpoint + ' \u2014 using mock responses. Memory/search/retrieval are all real.');
    }

    console.log('[Init] Chain: ' + memory.chain.length + ' nodes | Window: ' + memory.getWindow().length + '/' + CONFIG.windowSize + ' | LLM: ' + llmAvailable);
  }

  // === Send handler ===
  async function handleSend(msg) {
    if (!ready) return;

    Input.disable();
    Topbar.setStatus('active', 'THINKING');
    Chat.renderMessage('user', msg, memory.chain.length + 1, true);

    try {
      // Real: append to chain + BM25 index
      var pendingNode = memory.chain.append('user', msg);
      memory.bm25.add(pendingNode);

      // Tool chain — multi-step deterministic tool execution
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
        // Single tool — keyword pre-filter then BM25
        var toolTriggers = ['what time', 'what day', 'whats the date', 'whats the time', 'show me the code', 'read file', 'read the file', 'grep', 'search the code', 'show source', 'open file'];
        var msgLower = msg.toLowerCase();
        var hasTrigger = toolTriggers.some(function (t) { return msgLower.includes(t); });

        if (hasTrigger) {
          var matchedTools = memory.toolRegistry.retrieve(msg);
          if (matchedTools.length > 0 && matchedTools[0].score > 0.5) {
        var topTool = matchedTools[0].tool;
        var toolParams = { query: msg };

        // Infer params by tool type
        if (topTool.name === 'project_explorer') {
          toolParams = { action: 'search', target: msg };
        } else if (topTool.name === 'datetime') {
          toolParams = { type: 'full' };
        } else if (topTool.name === 'web_search') {
          toolParams = { query: msg.replace(/^(can you |please |search for |look up |find |google )/i, '').slice(0, 100) };
        }

        Topbar.setStatus('active', 'TOOL: ' + topTool.name.toUpperCase());
        Chat.renderSystem('\u2692 Using tool: ' + topTool.name);
        console.log('[Tool] Executing: ' + topTool.name, toolParams);

        var toolResult = await memory.toolRegistry.execute(topTool.name, toolParams, {
          query: msg, chain: memory.chain, config: memory.config
        });

        if (toolResult.success) {
          toolResults.push({ name: topTool.name, result: toolResult.result });
          var resultCount = toolResult.result.results ? toolResult.result.results.length : 0;
          Chat.renderSystem('\u2713 ' + topTool.name + ' returned ' + resultCount + ' results (' + toolResult.elapsed + 'ms)');
          console.log('[Tool] Success:', toolResult.result);
        } else {
          Chat.renderSystem('\u2717 Tool failed: ' + toolResult.error);
          console.warn('[Tool] Failed:', toolResult.error);
        }
        }
        }
      }

      // Real: get window and find recall candidates
      var windowNodes = memory.getWindow();
      var windowIds = new Set(windowNodes.map(function (n) { return n.id; }));

      var searchResults = memory.bm25.search(msg, 10);
      var recallNodes = searchResults
        .filter(function (r) { return !windowIds.has(r.nodeId); })
        .slice(0, memory.config.maxRetrievedNodes)
        .map(function (r) { return memory.chain.get(r.nodeId); })
        .filter(Boolean);

      if (recallNodes.length > 0) {
        Chat.renderRecall(recallNodes.length);
        RecallFX.fire(recallNodes);
        console.log('[Recall] ' + recallNodes.length + ' nodes from outside window');
      }

      // Build real prompt
      var messages = memory.window.buildMessages(windowNodes, recallNodes, CONFIG.systemPrompt);
      console.log('[Prompt] System prompt (' + (CONFIG.systemPrompt || '').length + ' chars): ' + (CONFIG.systemPrompt || '').slice(0, 80) + '...');

      // Inject tool results into prompt if any
      if (toolResults.length > 0) {
        var toolContext = toolResults.map(function (t) {
          if (t.result && t.result.formatted) {
            return t.result.formatted;
          }
          return typeof t.result === 'string' ? t.result : JSON.stringify(t.result, null, 2);
        }).join('\n\n');

        // Build recalled context summary
        var recallContext = '';
        if (recallNodes.length > 0) {
          recallContext = recallNodes.map(function (n) {
            return '[Node ' + n.id + '] ' + (n.content || '').slice(0, 300);
          }).join('\n');
        }

        // Build a structured synthesis template
        var lastIdx = messages.length - 1;
        messages.splice(lastIdx, 0, {
          role: 'system',
          content: 'Answer the user\'s question by filling in ALL applicable sections below. Use specifics from each source — do not give generic answers.\n\n'
            + '─── FROM CONVERSATION HISTORY (what was discussed previously) ───\n'
            + (recallContext || '(no recalled history for this query)')
            + '\n\n─── FROM TOOL OUTPUT (data just retrieved) ───\n'
            + toolContext
            + '\n\n─── INSTRUCTIONS ───\n'
            + 'Synthesize a complete answer using BOTH the conversation history above AND the tool output. Reference specific details from each. If conversation history explains what this project is, use that. If the tool shows file structure, connect the two.'
        });
      }

      var response;
      if (llmAvailable) {
        // CHECKPOINT: consume ONE pending pocket note and inject into prompt
        if (memory.pocket.hasPending) {
          var pocketNote = memory.pocket.consume();
          // Inject before the last message
          var insertIdx = messages.length - 1;
          messages.splice(insertIdx, 0, {
            role: 'system',
            content: '[Pocket Note #' + pocketNote.id + ']: ' + pocketNote.content
          });
          Chat.renderSystem('\u2713 Pocket note #' + pocketNote.id + ' applied');
          updatePocketQueueDisplay();
          console.log('[Pocket] Consumed note #' + pocketNote.id + ' at pre-LLM checkpoint');
        }

        // Fix role alternation: convert system→user (except first), then merge consecutive same-role
        var fixedMessages = [];
        messages.forEach(function (m, i) {
          var role = m.role;
          if (role === 'system' && i > 0) role = 'user';
          var last = fixedMessages[fixedMessages.length - 1];
          if (last && last.role === role) {
            last.content += '\n\n' + m.content;
          } else {
            fixedMessages.push({ role: role, content: m.content });
          }
        });
        messages = fixedMessages;

        // Show estimated tokens immediately (will be overwritten with real count after stream)
        var sentTokens = 0;
        messages.forEach(function (m) {
          sentTokens += Math.ceil((m.content || '').length / 4);
        });
        var sideSent = document.getElementById('side-sent');
        if (sideSent) sideSent.textContent = '~' + sentTokens.toLocaleString();
        console.log('[Prompt] Estimated ~' + sentTokens + ' tokens (' + messages.length + ' messages), awaiting real count from server...');

        // Stream response with live thinking + token display
        var streamMsg = Chat.createStreamingMessage(memory.chain.length + 1);
        lastStreamMsg = streamMsg;
        lastPartialResponse = '';
        if (!CONFIG.thinking && streamMsg && streamMsg.thinkWrapper) {
          streamMsg.thinkWrapper.querySelector('div').textContent = 'thinking disabled \u2014 model does not support reasoning or it is turned off';
          streamMsg.thinkWrapper.style.opacity = '0.35';
          streamMsg.thinkWrapper.open = false;
        }

        // Store for potential pocket note regeneration
        lastMessages = messages;
        currentAbort = new AbortController();

        var streamResult = await memory.transport.stream(messages, {
          onThink: function (token) { if (streamMsg) streamMsg.appendThink(token); },
          onToken: function (token) {
            var clean = token.replace(/<\|channel>\w+\s*<channel\|>/g, '');
            if (clean) {
              lastPartialResponse += clean;
              if (streamMsg) streamMsg.appendContent(clean);
            }
          },
          onDone: function (full, think) {
            if (think) console.log('[LLM:think] ' + think.slice(0, 200));
            var cleaned = full
              .replace(/<\|channel>\w+\s*<channel\|>/g, '')
              .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
              .trim();
            if (streamMsg) streamMsg.finalize(cleaned);
          }
        }, currentAbort.signal);
        response = streamResult.text;
        currentAbort = null;

        // Display real token usage from server if available
        if (streamResult.usage) {
          var sideSent = document.getElementById('side-sent');
          if (sideSent) sideSent.textContent = streamResult.usage.promptTokens.toLocaleString();
          console.log('[Prompt] Real usage from server: prompt=' + streamResult.usage.promptTokens + ' completion=' + streamResult.usage.completionTokens + ' total=' + streamResult.usage.totalTokens);
        }
      } else {
        await new Promise(function (r) { setTimeout(r, 400 + Math.random() * 600); });
        response = getMockResponse(msg);
        Chat.renderMessage('assistant', response, memory.chain.length + 1, true);
      }

      // Replace pending with turn node
      memory.chain.removeById(pendingNode.id);
      memory.bm25.remove(pendingNode.id);
      // Clean any leaked channel/think tags from stored response
      var cleanResponse = (response || '').replace(/<\|channel>\w+\s*<channel\|>/g, '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      var turnNode = memory.chain.appendTurn(msg, cleanResponse);
      memory.bm25.add(turnNode);

      // Source links for web search      // Append clickable source references only for web search results
      if (toolResults.length > 0 && toolResults[0].name === 'web_search' && toolResults[0].result && toolResults[0].result.results && toolResults[0].result.results.length > 0) {
        Chat.renderSources(toolResults[0].result.results);
      }

      Topbar.setStatus('active', llmAvailable ? 'READY' : 'MOCK LLM');

      console.log('[Node ' + turnNode.id + '] appended | chain: ' + memory.chain.length + ' | window: ' + memory.getWindow().length);

      // POST-RESPONSE CHECKPOINT: consume ONE note, move from staging to chat, re-run
      if (memory.pocket.hasPending) {
        var postNote = memory.pocket.consume();

        // Move from staging into the chat flow
        var stagedEl = document.getElementById('pocket-staged-' + postNote.id);
        if (stagedEl) {
          stagedEl.remove();
        }
        var chatStream = document.getElementById('chat-stream');
        var notePanel = document.createElement('div');
        notePanel.className = 'pocket-note-panel';
        notePanel.innerHTML = '<div class="pocket-note-panel__label">\u270E Note #' + postNote.id + ' \u2014 applied</div>' + postNote.content;
        chatStream.appendChild(notePanel);
        chatStream.scrollTop = chatStream.scrollHeight;

        updatePocketQueueDisplay();

        // Wait for current response to settle, then process next note
        await new Promise(function (r) { setTimeout(r, 200); });
        await handleSend(postNote.content);
      }
    } catch (err) {
      // AbortError is expected when pocket note interrupts — don't show as error
      if (err.name === 'AbortError') {
        console.log('[Stream] Aborted (pocket note or user cancel)');
      } else {
        Chat.renderSystem('\u274C Error: ' + err.message);
        Topbar.setStatus('idle', 'ERROR');
        console.error(err);
      }
    }

    Input.enable();
    refreshStats();
  }

  // === Confirm modal helper ===
  function confirm(title, message, onProceed) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    Modal.open('confirm');

    var proceedBtn = document.getElementById('confirm-proceed');
    var cancelBtn = document.getElementById('confirm-cancel');

    function cleanup() {
      proceedBtn.removeEventListener('click', onYes);
      cancelBtn.removeEventListener('click', onNo);
    }
    function onYes() { cleanup(); Modal.close('confirm'); onProceed(); }
    function onNo() { cleanup(); Modal.close('confirm'); }

    proceedBtn.addEventListener('click', onYes);
    cancelBtn.addEventListener('click', onNo);
  }

  // === Trim — enters selection mode ===
  function handleTrim() {
    if (!ready) return;
    if (SelectionMode.isActive()) { SelectionMode.cancel(); return; }

    SelectionMode.startTrim(async function (data) {
      try {
        var result = await memory.trimKeepRange({
          keepStart: data.keepStartId,
          keepEnd: data.keepEndId
        });
        var archived = 0;
        if (result.before) archived += result.before.metadata.nodeCount;
        if (result.after) archived += result.after.metadata.nodeCount;
        Chat.removeArchived({ keepStart: data.keepStartId, keepEnd: data.keepEndId });
        Chat.renderSystem('\u2702\uFE0F Trimmed ' + archived + ' nodes to archive. Keeping nodes ' + data.keepStartId + '\u2013' + data.keepEndId + '.');
      } catch (err) {
        Chat.renderSystem('\u274C Trim failed: ' + err.message);
      }
      refreshStats();
    });
  }

  // === Branch — enters selection mode ===
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

  // === Refresh stats in topbar + sidebar ===
  function refreshStats() {
    var s = memory.status();
    Topbar.updateStats(s.totalNodes, memory.getWindow().length, s.memoryUsageMB, s.totalTokens);
    var sideArchives = document.getElementById('side-archives');
    if (sideArchives) sideArchives.textContent = s.archiveBlocks;
  }

  // === Re-check LLM availability after backend/model change ===
  var _recheckAbort = null;
  async function recheckLLM() {
    // Abort any in-flight check
    if (_recheckAbort) _recheckAbort.abort();
    _recheckAbort = new AbortController();

    var endpoint = memory.config.endpoint;
    var apiFormat = memory.config.apiFormat;

    try {
      var checkUrl;
      if (apiFormat === 'ollama') {
        checkUrl = endpoint + '/api/tags';
      } else {
        checkUrl = endpoint + '/v1/models';
      }
      var res = await fetch(checkUrl, { signal: _recheckAbort.signal });
      llmAvailable = res.ok;
    } catch (e) {
      if (e.name === 'AbortError') return; // superseded by newer check
      llmAvailable = false;
    }

    _recheckAbort = null;
    Topbar.setStatus('active', llmAvailable ? 'READY' : 'MOCK LLM');
    if (llmAvailable) {
      Chat.renderSystem('\u2713 Connected to ' + apiFormat + ' at ' + endpoint + (memory.config.model ? ' (' + memory.config.model + ')' : ''));
    }
    console.log('[Settings] Backend changed: ' + apiFormat + ' @ ' + endpoint + ' | available: ' + llmAvailable);
  }

  // Boot is triggered by fixture-ready event above
})();
