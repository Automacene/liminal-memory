/**
 * Sovereign Loop — Self-critique reasoning loop.
 *
 * Context Management Strategy:
 * - Base messages (original prompt) are preserved and never modified
 * - Each Sovereign response is committed to the chain immediately (BM25 indexed)
 * - Old DOM elements are removed after commit (DOM stays lean)
 * - Each iteration rebuilds context from: base + resolvedSummary + last response + critique
 * - The messages array never grows unboundedly
 *
 * Depends on globals: Chat, Topbar
 */
var SovereignLoop = (function () {

  /**
   * Fix role alternation for strict user/assistant APIs.
   */
  function fixRoles(msgs) {
    var fixed = [];
    msgs.forEach(function (m, i) {
      var role = m.role;
      if (role === 'system' && i > 0) role = 'user';
      var last = fixed[fixed.length - 1];
      if (last && last.role === role) {
        last.content += '\n\n' + m.content;
      } else {
        fixed.push({ role: role, content: m.content });
      }
    });
    return fixed;
  }

  /**
   * Parse ephemeral structured payload from raw text.
   */
  function parseEphemeralPayload(rawOutput) {
    var fallback = {
      thought_block: rawOutput || '',
      resolved_nodes: [],
      unresolved_tension: '',
      requires_further_recursion: false
    };

    if (!rawOutput || rawOutput.trim().length === 0) return fallback;

    var cleaned = rawOutput
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    var openIdx = cleaned.indexOf('{');
    if (openIdx === -1) return fallback;

    var depth = 0;
    var closeIdx = -1;
    for (var i = openIdx; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++;
      else if (cleaned[i] === '}') { depth--; if (depth === 0) { closeIdx = i + 1; break; } }
    }
    if (closeIdx <= openIdx) return fallback;

    var jsonStr = cleaned.slice(openIdx, closeIdx);

    try {
      var parsed = JSON.parse(jsonStr);
      return {
        thought_block: parsed.thought_block || parsed.analysis || parsed.thought || rawOutput,
        resolved_nodes: Array.isArray(parsed.resolved_nodes) ? parsed.resolved_nodes : [],
        unresolved_tension: parsed.unresolved_tension || parsed.tension || '',
        requires_further_recursion: Boolean(parsed.requires_further_recursion)
      };
    } catch (e) {
      var thoughtMatch = jsonStr.match(/"thought_block"\s*:\s*"([\s\S]*?)(?:"|$)/);
      var tensionMatch = jsonStr.match(/"unresolved_tension"\s*:\s*"([\s\S]*?)(?:"|$)/);
      var recursionMatch = jsonStr.match(/"requires_further_recursion"\s*:\s*(true|false)/);

      if (thoughtMatch) {
        return {
          thought_block: thoughtMatch[1],
          resolved_nodes: [],
          unresolved_tension: tensionMatch ? tensionMatch[1] : '',
          requires_further_recursion: recursionMatch ? recursionMatch[1] === 'true' : false
        };
      }
      return fallback;
    }
  }

  /**
   * Validate tension is real — has domain overlap with original query and sufficient length.
   */
  function validateTension(tension, originalQuery) {
    if (!tension || tension.length < 15) return false;
    var queryWords = {};
    originalQuery.toLowerCase().split(/\W+/).forEach(function (w) {
      if (w.length >= 4) queryWords[w] = true;
    });
    var tensionWords = tension.toLowerCase().split(/\W+/).filter(function (w) { return w.length >= 4; });
    var overlap = tensionWords.filter(function (w) { return queryWords[w]; });
    return overlap.length >= 1;
  }

  /**
   * Stream a Sovereign response and return the text + DOM reference.
   */
  async function streamSovereign(messages, memory, config, opts) {
    var streamMsg = Chat.createStreamingMessage(memory.chain.length + 1);
    opts.streamState.lastStreamMsg = streamMsg;
    opts.streamState.lastPartialResponse = '';

    if (!config.thinking && streamMsg && streamMsg.thinkWrapper) {
      streamMsg.thinkWrapper.querySelector('div').textContent = 'thinking disabled';
      streamMsg.thinkWrapper.style.opacity = '0.35';
      streamMsg.thinkWrapper.open = false;
    }

    opts.streamState.lastMessages = messages;
    opts.streamState.currentAbort = new AbortController();

    var streamResult = await memory.transport.stream(messages, {
      onThink: function (token) { if (streamMsg) streamMsg.appendThink(token); },
      onToken: function (token) {
        var clean = token.replace(/<\|channel>\w+\s*<channel\|>/g, '');
        if (clean) {
          opts.streamState.lastPartialResponse += clean;
          if (streamMsg) streamMsg.appendContent(clean);
        }
      },
      onDone: function (full, think) {
        var cleaned = full
          .replace(/<\|channel>\w+\s*<channel\|>/g, '')
          .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
          .trim();
        if (streamMsg) streamMsg.finalize(cleaned);
      }
    }, opts.streamState.currentAbort.signal);

    opts.streamState.currentAbort = null;

    if (streamResult.usage) {
      var sideSentEl = document.getElementById('side-sent');
      if (sideSentEl) sideSentEl.textContent = streamResult.usage.promptTokens.toLocaleString();
    }

    return { text: streamResult.text, domElement: streamMsg };
  }

  /**
   * Stream an Ephemeral response and return the parsed payload.
   */
  async function streamEphemeral(ephPrompt, memory, config) {
    var wasThinking = config.thinking;
    config.thinking = false;

    var ephMessages = [
      { role: 'system', content: 'You are the Ephemeral Mind \u2014 the internal critique layer. Your job is NOT to be agreeable. Look for edge cases, missing logic, hidden contradictions, and structural flaws in the answer you receive.\n\nYou MUST output ONLY a JSON payload with this exact structure:\n{"thought_block": "your detailed critique and analysis...", "resolved_nodes": ["what was done well or correctly"], "unresolved_tension": "what is flawed, missing, or contradictory", "requires_further_recursion": true/false}\n\nIf the answer is genuinely complete and correct, set unresolved_tension to "" and requires_further_recursion to false.\nDo NOT fake tensions. Do NOT be lazy. Be specific.' },
      { role: 'user', content: ephPrompt }
    ];

    var indicator = document.createElement('div');
    indicator.className = 'ephemeral-indicator';
    indicator.innerHTML = '<span class="ephemeral-indicator__pulse"></span> <span class="ephemeral-indicator__text">Ephemeral Mind critiquing\u2026</span>';
    document.getElementById('chat-stream').appendChild(indicator);
    document.getElementById('chat-stream').scrollTop = document.getElementById('chat-stream').scrollHeight;

    await new Promise(function (r) { setTimeout(r, 100); });
    if (indicator.parentElement) indicator.remove();

    var ephStreamMsg = Chat.createEphemeralStreamingMessage();
    var ephFullText = '';

    await memory.transport.stream(ephMessages, {
      onThink: function () {},
      onToken: function (token) {
        var clean = token.replace(/<\|channel>\w+\s*<channel\|>/g, '');
        if (clean) {
          ephFullText += clean;
          if (ephStreamMsg) ephStreamMsg.appendContent(clean);
        }
      },
      onDone: function (full) {
        var cleaned = full
          .replace(/<\|channel>\w+\s*<channel\|>/g, '')
          .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
          .trim();
        ephFullText = cleaned;
      }
    });

    config.thinking = wasThinking;

    var payload = parseEphemeralPayload(ephFullText);
    if (ephStreamMsg && payload.thought_block) {
      ephStreamMsg.finalize(payload.thought_block);
    }

    return { payload: payload, domElement: ephStreamMsg };
  }

  /**
   * Build a lean context for the Sovereign on refinement passes.
   * Instead of accumulating all prior messages, rebuild from scratch each time.
   */
  function buildRefinementContext(baseMessages, userMsg, resolvedSummary, lastResponse, tension) {
    // Start with the original base (system prompt + window + recall + user query)
    var msgs = baseMessages.slice();

    // Add context about what's been resolved so far (capped)
    if (resolvedSummary) {
      msgs.push({
        role: 'system',
        content: '[Resolved so far]: ' + resolvedSummary
      });
    }

    // Add the Sovereign's last response
    msgs.push({ role: 'assistant', content: lastResponse });

    // Add the critique feedback with the original query reminder
    msgs.push({
      role: 'user',
      content: '[ORIGINAL QUESTION]: ' + userMsg + '\n\n[Your internal critique found a flaw in your answer]\nFlaw: "' + tension + '"\n\nRefine your answer to address this issue while staying focused on the original question above. Write your complete, updated response.'
    });

    return fixRoles(msgs);
  }

  /**
   * Build context for the final synthesis pass.
   */
  function buildSynthesisContext(baseMessages, userMsg, resolvedSummary, lastResponse) {
    var msgs = baseMessages.slice();

    msgs.push({ role: 'assistant', content: lastResponse });
    msgs.push({
      role: 'user',
      content: '[ORIGINAL QUESTION]: ' + userMsg + '\n\n[Self-critique complete \u2014 all tensions resolved]\nResolved insights: ' + (resolvedSummary || 'N/A') + '\n\nNow write your FINAL answer to the original question above. This should be a clean, unified response that synthesizes everything you worked out. Address the user directly \u2014 do not reference the critique process. Just deliver the best possible answer.'
    });

    return fixRoles(msgs);
  }

  /**
   * Run the Sovereign \u2194 Ephemeral self-critique loop.
   */
  async function run(opts) {
    var baseMessages = opts.messages.slice(); // Snapshot of original context (never modified)
    var memory = opts.memory;
    var config = opts.config;
    var userMsg = opts.userMsg;
    var MAX_LOOPS = 100;
    var MAX_RESOLVED_CHARS = 500;
    var loopCount = 0;
    var resolvedSummary = '';
    var finalResponse = '';
    var prevDomElements = []; // Track DOM elements for cleanup

    // Abort flag
    var aborted = false;
    function onAbort(e) { if (e.key === 'Escape') aborted = true; }
    document.addEventListener('keydown', onAbort);

    // === PASS 1: Sovereign writes full answer ===
    Topbar.setStatus('active', 'SOVEREIGN MIND');
    console.log('[Sovereign] Pass 1 \u2014 initial response');

    var result = await streamSovereign(baseMessages, memory, config, opts);
    var response = result.text;
    prevDomElements.push(result.domElement);

    // Commit initial response to chain immediately
    var sovNode = memory.chain.append('assistant', '[Sovereign Pass 1] ' + (response || '').slice(0, 1000));
    memory.bm25.add(sovNode);

    // === CRITIQUE LOOP ===
    while (loopCount < MAX_LOOPS) {
      if (aborted) {
        console.log('[Sovereign] Aborted by user (Escape)');
        Chat.renderSystem('\u23F9 Loop stopped by user after ' + loopCount + ' passes');
        break;
      }

      // Check pocket queue — let user inject notes mid-loop
      if (memory.pocket && memory.pocket.hasPending) {
        var pocketNote = memory.pocket.consume();
        Chat.renderSystem('\u2713 Pocket note #' + pocketNote.id + ' applied mid-loop');
        // Inject into the next Sovereign pass by appending to resolvedSummary context
        resolvedSummary += (resolvedSummary ? '; ' : '') + '[User note: ' + pocketNote.content + ']';
        console.log('[Pocket] Consumed mid-loop: #' + pocketNote.id);
      }

      loopCount++;
      Topbar.setStatus('active', 'EPHEMERAL MIND (critique ' + loopCount + ')');
      console.log('[Critique] Pass ' + loopCount);

      // Send Sovereign's response to Ephemeral for critique
      var critiquePrompt = 'Critique the following answer for flaws, missing logic, edge cases, or contradictions:\n\n' + response;
      if (resolvedSummary) {
        critiquePrompt += '\n\n[Previously resolved: ' + resolvedSummary + ']';
      }

      var ephResult = await streamEphemeral(critiquePrompt, memory, config);
      var payload = ephResult.payload;
      prevDomElements.push(ephResult.domElement);

      console.log('[Ephemeral] Payload:', {
        resolved: payload.resolved_nodes.length,
        tension: (payload.unresolved_tension || '').slice(0, 80),
        recurse: payload.requires_further_recursion
      });

      // Store thought_block as chain node (BM25 indexed for recall + dedup)
      var thoughtNode = null;
      if (payload.thought_block && payload.thought_block.length > 20) {
        thoughtNode = memory.chain.append('system', '[Critique ' + loopCount + '] ' + payload.thought_block.slice(0, 500));
        memory.bm25.add(thoughtNode);
      }

      // Update resolved summary (capped)
      if (payload.resolved_nodes.length > 0) {
        var newResolved = payload.resolved_nodes.join('; ');
        resolvedSummary += (resolvedSummary ? '; ' : '') + newResolved;
        if (resolvedSummary.length > MAX_RESOLVED_CHARS) {
          resolvedSummary = resolvedSummary.slice(-MAX_RESOLVED_CHARS);
        }
      }

      // === ENRICHED RECALL: Use user query + sovereign response for deeper BM25 ===
      // Ephemeral has both sides now — search with combined terms to find missed nodes
      var enrichedQuery = (userMsg + ' ' + (response || '').slice(0, 300)).slice(0, 500);
      var enrichedResults = memory.bm25.search(enrichedQuery, 6);
      var currentNodeId = memory.chain.all()[memory.chain.length - 1]?.id;
      if (currentNodeId && enrichedResults.length > 0) {
        for (var ei = 0; ei < enrichedResults.length; ei++) {
          memory.chain.link(currentNodeId, enrichedResults[ei].nodeId);
        }
        // Also link enriched results to each other (co-retrieval = association)
        for (var ea = 0; ea < enrichedResults.length; ea++) {
          for (var eb = ea + 1; eb < enrichedResults.length; eb++) {
            memory.chain.link(enrichedResults[ea].nodeId, enrichedResults[eb].nodeId);
          }
        }
        console.log('[Graph:Enriched] Linked ' + enrichedResults.length + ' nodes from enriched recall (query: "' + enrichedQuery.slice(0, 60) + '...")');
      }

      // === AUTO-SEARCH: Fill knowledge gaps mid-loop ===
      if (payload.unresolved_tension && payload.unresolved_tension.length > 20 && payload.requires_further_recursion) {
        // Kill switch — skip if web search is disabled
        if (config.webSearchEnabled === false) {
          console.log('[AutoSearch] Skipped — webSearchEnabled is false');
        } else {
        var tensionText = payload.unresolved_tension;
        // Check if we already have RESEARCH nodes about this tension
        var searchResults = memory.bm25.search(tensionText, 3);
        var hasResearch = false;
        for (var ri = 0; ri < searchResults.length; ri++) {
          var resNode = memory.chain.get(searchResults[ri].nodeId);
          if (resNode && resNode.content && resNode.content.indexOf('[Research:') === 0 && searchResults[ri].score > 2.0) {
            hasResearch = true;
            break;
          }
        }

        if (!hasResearch) {
          var searchTool = memory.toolRegistry.get('web_search');
          if (searchTool) {
            try {
              // Ask the LLM to generate a proper search query from the tension
              var queryMessages = [
                { role: 'system', content: 'Convert the following into a short Google search query. Output ONLY the query — 3 to 6 words, like a human would type into a search bar. No sentences. No quotes. Just keywords.' },
                { role: 'user', content: tensionText.slice(0, 200) }
              ];
              var queryResult = await memory.transport.stream(queryMessages, {
                onThink: function () {},
                onToken: function () {},
                onDone: function () {}
              });
              var searchQuery = (queryResult.text || '')
                .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
                .replace(/^["']|["']$/g, '')
                .replace(/\n.*/g, '')
                .trim()
                .slice(0, 80);

              if (searchQuery.length >= 3) {
                console.log('[AutoSearch] Tension: "' + tensionText.slice(0, 50) + '..." → Query: "' + searchQuery + '"');
                Chat.renderSystem('\u2692 Searching: ' + searchQuery);
                var searchResult = await searchTool.run({ query: searchQuery }, { query: userMsg, chain: memory.chain, config: config });
                if (searchResult.success && searchResult.result.results && searchResult.result.results.length > 0) {
                  searchResult.result.results.forEach(function (r) {
                    if (r.content && r.content.length > 30) {
                      var researchNode = memory.chain.append('system', '[Research: ' + (r.title || 'Web') + '] ' + r.content.slice(0, 800));
                      memory.bm25.add(researchNode);
                    }
                  });
                  Chat.renderSystem('\u2713 Found ' + searchResult.result.results.length + ' sources — stored as research nodes');
                  console.log('[AutoSearch] Stored ' + searchResult.result.results.length + ' research nodes');
                }
              } else {
                console.log('[AutoSearch] LLM returned empty query, skipping search');
              }
            } catch (e) {
              console.log('[AutoSearch] Failed: ' + e.message);
            }
          }
        } else {
          console.log('[AutoSearch] Research already exists for this tension — skipping');
        }
        } // end webSearchEnabled gate
      }

      // === DEDUPLICATION GATE ===
      // Two-layer check: critique-specific AND global pattern matching
      var isDuplicate = false;
      if (payload.unresolved_tension && payload.unresolved_tension.length > 15) {
        var dupResults = memory.bm25.search(payload.unresolved_tension, 5);

        // Layer 1: Check against prior critique nodes (excluding current pass's node)
        var currentCritiqueId = thoughtNode ? thoughtNode.id : -1;
        for (var di = 0; di < dupResults.length; di++) {
          var dupNode = memory.chain.get(dupResults[di].nodeId);
          if (dupNode && dupNode.id !== currentCritiqueId && dupNode.content && dupNode.content.indexOf('[Critique') === 0) {
            if (dupResults[di].score > 2.5) {
              isDuplicate = true;
              console.log('[Dedup:critique] Tension matches prior critique (score: ' + dupResults[di].score.toFixed(2) + '): "' + payload.unresolved_tension.slice(0, 60) + '"');
              break;
            }
          }
        }

        // Layer 2: Check against prior reasoning nodes only (not all chain content)
        // Only compares against [Critique] and [Sovereign Pass] nodes — prevents false positives
        // when the topic already exists in conversation history
        if (!isDuplicate && dupResults.length > 0) {
          for (var gi = 0; gi < dupResults.length; gi++) {
            var globalNode = memory.chain.get(dupResults[gi].nodeId);
            if (globalNode && globalNode.content && (globalNode.content.indexOf('[Critique') === 0 || globalNode.content.indexOf('[Sovereign Pass') === 0)) {
              if (dupResults[gi].score > 4.0) {
                isDuplicate = true;
                console.log('[Dedup:reasoning] Tension matches prior reasoning node (score: ' + dupResults[gi].score.toFixed(2) + '): "' + payload.unresolved_tension.slice(0, 60) + '"');
                break;
              }
            }
          }
        }
      }

      // Also check: is the Sovereign repeating itself?
      if (!isDuplicate && loopCount >= 3) {
        var recentSovNodes = memory.bm25.search(response.slice(0, 300), 5);
        var selfRepeatCount = 0;
        for (var si = 0; si < recentSovNodes.length; si++) {
          var sovCheck = memory.chain.get(recentSovNodes[si].nodeId);
          if (sovCheck && sovCheck.content && sovCheck.content.indexOf('[Sovereign Pass') === 0) {
            if (recentSovNodes[si].score > 3.0) selfRepeatCount++;
          }
        }
        if (selfRepeatCount >= 2) {
          isDuplicate = true;
          console.log('[Dedup:self] Sovereign repeating itself (' + selfRepeatCount + ' high-similarity prior responses)');
        }
      }

      // === EVALUATION GATE ===
      var tensionValid = validateTension(payload.unresolved_tension, userMsg);

      // Additional check: is the tension actually about what the Sovereign said?
      // Prevents ephemeral from manufacturing tangential critiques
      var tensionRelevantToResponse = false;
      if (tensionValid && response) {
        var responseWords = {};
        response.toLowerCase().split(/\W+/).forEach(function (w) {
          if (w.length >= 4) responseWords[w] = true;
        });
        var tensionWords = (payload.unresolved_tension || '').toLowerCase().split(/\W+/).filter(function (w) { return w.length >= 4; });
        var responseOverlap = tensionWords.filter(function (w) { return responseWords[w]; });
        tensionRelevantToResponse = responseOverlap.length >= 1;

        if (!tensionRelevantToResponse) {
          console.log('[Gate] Tension not relevant to Sovereign response — topic drift detected');
        }
      }

      // Anti-continuation bias: reject vague/generic tensions that aren't specific flaws
      var isGenericTension = false;
      if (tensionValid && payload.unresolved_tension) {
        var genericPhrases = ['needs more', 'could be expanded', 'requires further', 'not fully addressed', 'more detail needed', 'lacks depth', 'insufficient', 'too brief', 'not comprehensive'];
        var tensionLower = payload.unresolved_tension.toLowerCase();
        var genericHits = genericPhrases.filter(function (p) { return tensionLower.indexOf(p) !== -1; });
        // If the tension is ONLY generic (no specific technical terms beyond the generic phrase)
        if (genericHits.length > 0 && payload.unresolved_tension.length < 80) {
          isGenericTension = true;
          console.log('[Gate] Generic tension detected ("' + genericHits[0] + '") — not a specific flaw');
        }
      }

      var shouldContinue = payload.requires_further_recursion && tensionValid && tensionRelevantToResponse && !isDuplicate && !isGenericTension;

      if (!shouldContinue) {
        // Converged — run final synthesis
        console.log('[Gate] END \u2014 converged after ' + loopCount + ' passes. Running final synthesis.');
        Chat.renderSystem('\u25C7 Converged after ' + loopCount + ' critique passes');
        Topbar.setStatus('active', 'SOVEREIGN MIND (final)');

        var synthContext = buildSynthesisContext(baseMessages, userMsg, resolvedSummary, response);
        var synthResult = await streamSovereign(synthContext, memory, config, opts);
        finalResponse = synthResult.text;
        break;
      }

      // === CONTINUE: Rebuild lean context and get refined response ===
      console.log('[Gate] CONTINUE \u2014 tension: "' + payload.unresolved_tension.slice(0, 60) + '"');
      Topbar.setStatus('active', 'SOVEREIGN MIND (pass ' + (loopCount + 1) + ')');

      // Remove old DOM elements to keep DOM lean (keep last 3 pairs visible)
      while (prevDomElements.length > 6) {
        var old = prevDomElements.shift();
        if (old && old.body && old.body.parentElement) {
          old.body.parentElement.style.opacity = '0';
          old.body.parentElement.style.height = '0';
          old.body.parentElement.style.overflow = 'hidden';
          old.body.parentElement.style.margin = '0';
          old.body.parentElement.style.padding = '0';
          setTimeout(function (el) { if (el.parentElement) el.parentElement.removeChild(el); }, 300, old.body.parentElement);
        }
      }

      // Build lean context (NOT accumulating all prior messages)
      var refinementContext = buildRefinementContext(baseMessages, userMsg, resolvedSummary, response, payload.unresolved_tension);

      // Stream refined Sovereign response
      var refinedResult = await streamSovereign(refinementContext, memory, config, opts);
      response = refinedResult.text;
      prevDomElements.push(refinedResult.domElement);

      // Commit this response to chain immediately
      var refinedNode = memory.chain.append('assistant', '[Sovereign Pass ' + (loopCount + 1) + '] ' + (response || '').slice(0, 1000));
      memory.bm25.add(refinedNode);

      // Save after every pass (persists mid-loop progress)
      try {
        fetch('/api/state/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(await memory.export(), null, 2)
        });
      } catch (e) { /* non-critical */ }
    }

    if (!finalResponse) {
      // Hit max loops or aborted — still run final synthesis
      console.log('[Sovereign] Max loops or abort \u2014 running final synthesis');
      Chat.renderSystem('\u25C7 ' + (aborted ? 'Stopped' : 'Max passes reached') + ' after ' + loopCount + ' passes');
      Topbar.setStatus('active', 'SOVEREIGN MIND (final)');

      var synthContext = buildSynthesisContext(baseMessages, userMsg, resolvedSummary, response);
      var synthResult = await streamSovereign(synthContext, memory, config, opts);
      finalResponse = synthResult.text;
    }

    document.removeEventListener('keydown', onAbort);
    return finalResponse;
  }

  return { run: run, fixRoles: fixRoles };
})();
