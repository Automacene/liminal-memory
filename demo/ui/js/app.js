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
  var CONFIG = {
    endpoint: 'http://127.0.0.1:8081',
    apiFormat: 'openai',
    completionPath: '/v1/chat/completions',
    model: 'gemma-4-26B-A4B-it',
    thinking: false,
    systemPrompt: 'You are Liminal, a conversational AI assistant. Chat naturally with the user like a knowledgeable friend. When context from earlier conversation appears in the prompt (labeled Recalled), use that information first. When tool results appear, incorporate them into your answer. Always prioritize information from recalled nodes and tools over your own knowledge. But when no recalled context or tool results are present, just chat — share thoughts, ask questions, discuss ideas, be helpful. Never refuse to answer. Never say you cannot help. If you lack specific information, give your best understanding and say what you are unsure about. Keep responses concise unless the user asks for detail.',
    windowSize: 40,
    maxTokenBudget: 32768,
    reservedTokens: 4096,
    maxRetrievedNodes: 6,
    recallBufferRatio: 0.2,
    retrievalThreshold: 0.2,
    toolMatchThreshold: 0.5,
    memoryLimitMB: 2048
  };

  // === State ===
  var memory = new LuminalMemory.LuminalMemory(CONFIG);
  var ready = false;
  var llmAvailable = false;

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

    // Memory warning listener
    memory.on('memory-warning', function (data) {
      Chat.renderSystem('\u26A0\uFE0F Memory at ' + Math.round(data.utilization * 100) + '% (' + data.usageMB.toFixed(1) + ' MB). Consider trimming.');
    });

    ready = true;
    Topbar.setStatus('active', llmAvailable ? 'READY' : 'MOCK LLM');
    refreshStats();

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

        // Calculate tokens being sent to LLM
        var sentTokens = 0;
        messages.forEach(function (m) {
          sentTokens += Math.ceil((m.content || '').length / 4);
        });
        var sideSent = document.getElementById('side-sent');
        if (sideSent) sideSent.textContent = sentTokens.toLocaleString();
        console.log('[Prompt] Sending ~' + sentTokens + ' tokens to LLM (' + messages.length + ' messages)');

        // Stream response with live thinking + token display
        var streamMsg = Chat.createStreamingMessage(memory.chain.length + 1);
        if (!CONFIG.thinking && streamMsg && streamMsg.thinkWrapper) {
          streamMsg.thinkWrapper.querySelector('div').textContent = 'thinking disabled \u2014 model does not support reasoning or it is turned off';
          streamMsg.thinkWrapper.style.opacity = '0.35';
          streamMsg.thinkWrapper.open = false;
        }
        response = await memory.transport.stream(messages, {
          onThink: function (token) { if (streamMsg) streamMsg.appendThink(token); },
          onToken: function (token) {
            // Strip any channel tags that leak into content
            var clean = token.replace(/<\|channel>\w+\s*<channel\|>/g, '');
            if (clean && streamMsg) streamMsg.appendContent(clean);
          },
          onDone: function (full, think) {
            if (think) console.log('[LLM:think] ' + think.slice(0, 200));
            var cleaned = full
              .replace(/<\|channel>\w+\s*<channel\|>/g, '')
              .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
              .trim();
            if (streamMsg) streamMsg.finalize(cleaned);
          }
        });
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
    } catch (err) {
      Chat.renderSystem('\u274C Error: ' + err.message);
      Topbar.setStatus('idle', 'ERROR');
      console.error(err);
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

  // Boot is triggered by fixture-ready event above
})();
