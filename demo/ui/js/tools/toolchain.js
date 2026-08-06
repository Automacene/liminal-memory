/**
 * Tool Chain — deterministic multi-step tool execution.
 * System drives every step. LLM only sees the final assembled context.
 * 
 * Each chain is a recipe: trigger keywords → sequential tool steps → assembled result.
 */
var ToolChain = (function () {
  var serverUrl = '';

  // === Chain Recipes ===
  var recipes = [
    {
      name: 'web_search',
      triggers: ['search for', 'search', 'look up', 'lookup', 'google', 'find online', 'look this up'],
      steps: [
        { action: 'websearch', buildParams: function (msg) { return cleanQuery(msg); } },
        { action: 'fetch', buildParams: function (prev) { return prev && prev.results && prev.results[0] ? prev.results[0].url : null; } }
      ]
    },
    {
      name: 'explain_code',
      triggers: ['how does', 'explain', 'what does', 'show me how', 'walk me through'],
      steps: [
        { action: 'grep', buildParams: function (msg) { return extractKeyword(msg); } },
        { action: 'read', buildParams: function (prev) { return prev.results && prev.results[0] ? prev.results[0].file : null; } }
      ]
    },
    {
      name: 'find_code',
      triggers: ['where is', 'find the', 'which file', 'locate'],
      steps: [
        { action: 'grep', buildParams: function (msg) { return extractKeyword(msg); } }
      ]
    },
    {
      name: 'recent_changes',
      triggers: ['what changed', 'recent changes', 'git diff', 'what did we change', 'whats new'],
      steps: [
        { action: 'shell', command: 'git diff --stat HEAD~3' },
        { action: 'shell', command: 'git log --oneline -5' }
      ]
    }
  ];

  /**
   * Check if a message matches any chain recipe.
   * @param {string} msg
   * @returns {{ recipe: object }|null}
   */
  function match(msg) {
    var lower = msg.toLowerCase();
    for (var i = 0; i < recipes.length; i++) {
      var recipe = recipes[i];
      for (var j = 0; j < recipe.triggers.length; j++) {
        if (lower.includes(recipe.triggers[j])) {
          return { recipe: recipe };
        }
      }
    }
    return null;
  }

  /**
   * Execute a chain recipe — run all steps, return assembled context.
   * @param {object} recipe
   * @param {string} msg - original user message
   * @returns {{ formatted: string, steps: object[] }}
   */
  async function execute(recipe, msg) {
    console.log('[ToolChain] Executing recipe: ' + recipe.name);
    var results = [];
    var prevResult = null;

    for (var i = 0; i < recipe.steps.length; i++) {
      var step = recipe.steps[i];
      var result = null;

      if (step.action === 'grep') {
        var keyword = step.buildParams(prevResult || msg);
        if (!keyword) { console.log('[ToolChain] Step ' + i + ': no keyword, skipping'); continue; }
        console.log('[ToolChain] Step ' + i + ': grep "' + keyword + '"');
        result = await apiCall('/api/search?q=' + encodeURIComponent(keyword));
      } else if (step.action === 'read') {
        var filePath = step.buildParams(prevResult);
        if (!filePath) { console.log('[ToolChain] Step ' + i + ': no file path, skipping'); continue; }
        console.log('[ToolChain] Step ' + i + ': read "' + filePath + '"');
        result = await apiCall('/api/read?path=' + encodeURIComponent(filePath));
      } else if (step.action === 'shell') {
        console.log('[ToolChain] Step ' + i + ': shell "' + step.command + '"');
        result = await apiCall('/api/shell?cmd=' + encodeURIComponent(step.command));
      } else if (step.action === 'websearch') {
        var query = step.buildParams(prevResult || msg);
        if (!query) { console.log('[ToolChain] Step ' + i + ': no query, skipping'); continue; }
        console.log('[ToolChain] Step ' + i + ': websearch "' + query + '"');
        result = await apiCall('/api/websearch?q=' + encodeURIComponent(query));
      } else if (step.action === 'fetch') {
        var fetchUrl = step.buildParams(prevResult);
        if (!fetchUrl) { console.log('[ToolChain] Step ' + i + ': no URL, skipping'); continue; }
        console.log('[ToolChain] Step ' + i + ': fetch "' + fetchUrl + '"');
        result = await apiCall('/api/fetch?url=' + encodeURIComponent(fetchUrl));
      }

      if (result) {
        results.push({ step: i, action: step.action, data: result });
        prevResult = result;
      }
    }

    // Assemble all step outputs into one context block
    var formatted = '─── TOOL CHAIN: ' + recipe.name + ' ───\n\n';
    results.forEach(function (r) {
      formatted += r.data.formatted || JSON.stringify(r.data.results || r.data, null, 2);
      formatted += '\n\n';
    });

    console.log('[ToolChain] Complete: ' + results.length + ' steps executed');
    return { formatted: formatted, steps: results };
  }

  async function apiCall(endpoint) {
    try {
      var res = await fetch(serverUrl + endpoint);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.warn('[ToolChain] API call failed:', endpoint, e.message);
      return null;
    }
  }

  /**
   * Clean a user message into a search query — strip filler words.
   */
  function cleanQuery(input) {
    if (typeof input === 'object') return null;
    return input.toLowerCase()
      .replace(/^(can you |please |hey |search for |search |look up |lookup |google |find online |find |look this up )/i, '')
      .replace(/[?!.,]/g, '')
      .trim()
      .slice(0, 100);
  }

  /**
   * Extract the most relevant keyword from a message for grepping.
   * Strips common filler words, returns the meaty content.
   */
  function extractKeyword(input) {
    if (typeof input === 'object' && input !== null) {
      // Previous step result — extract from it if possible
      if (input.results && input.results[0] && input.results[0].file) return input.results[0].file;
      return null;
    }
    // String input — strip filler, get keywords
    var stripped = input.toLowerCase()
      .replace(/^(how does|explain|what does|show me how|walk me through|where is|find the|which file|locate|can you|please|the)\s+/g, '')
      .replace(/\s+(work|works|function|do|does|in this project|in the code|in the codebase)\s*/g, ' ')
      .replace(/[?!.,]/g, '')
      .trim();
    // Take first 2-3 meaningful words
    var words = stripped.split(/\s+/).filter(function (w) { return w.length > 2; });
    return words.slice(0, 3).join(' ') || stripped;
  }

  return { match: match, execute: execute };
})();
