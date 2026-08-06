/**
 * Inspect Modal Component — displays memory state visualization.
 */
var InspectModal = (function () {
  var outputEl, memoryRef;

  function init(memory) {
    memoryRef = memory;
    outputEl = document.getElementById('inspect-output');
  }

  function open() {
    Modal.open('inspect');
    render();
  }

  function render() {
    if (!memoryRef || !outputEl) return;

    var chain = memoryRef.chain.all();
    var windowNodes = memoryRef.getWindow();
    var windowIds = new Set(windowNodes.map(function (n) { return n.id; }));

    var lastTurn = chain.slice().reverse().find(function (n) { return n.role === 'turn' || n.role === 'user'; });
    var query = lastTurn ? (lastTurn.query || lastTurn.content || '') : '';
    var searchResults = query ? memoryRef.bm25.search(query, 10) : [];
    var recallCandidates = searchResults
      .filter(function (r) { return !windowIds.has(r.nodeId); })
      .slice(0, memoryRef.config.maxRetrievedNodes);

    var out = '';

    out += '\u2550\u2550\u2550 WHAT THE AI SEES THIS TURN \u2550\u2550\u2550\n\n';
    out += '\u2500\u2500 SYSTEM PROMPT \u2500\u2500\n  "' + memoryRef.config.systemPrompt + '"\n\n';

    out += '\u2500\u2500 RECALL BUFFER \u2500\u2500 ' + recallCandidates.length + ' nodes\n';
    if (recallCandidates.length === 0) {
      out += '  (empty)\n';
    } else {
      var maxScore = recallCandidates[0].score || 1;
      recallCandidates.forEach(function (r) {
        var node = memoryRef.chain.get(r.nodeId);
        if (!node) return;
        var norm = (r.score / maxScore).toFixed(2);
        var barFull = Math.round(norm * 10);
        var bar = '\u2588'.repeat(barFull) + '\u2591'.repeat(10 - barFull);
        var preview = (node.query || node.content || '').slice(0, 50).replace(/\n/g, ' ');
        out += '  [Node ' + node.id + '] ' + bar + ' ' + norm + ' "' + preview + '"\n';
      });
    }
    out += '\n';

    out += '\u2500\u2500 SLIDING WINDOW \u2500\u2500 ' + windowNodes.length + '/' + memoryRef.config.windowSize + ' nodes\n';
    windowNodes.forEach(function (node) {
      var preview = (node.query || node.content || '').slice(0, 55).replace(/\n/g, ' ');
      out += '  [Node ' + node.id + '] ' + node.role + ': "' + preview + '"\n';
    });
    out += '\n';

    var outsideWindow = chain.filter(function (n) { return !windowIds.has(n.id); });
    out += '\u2500\u2500 OUTSIDE WINDOW \u2500\u2500 ' + outsideWindow.length + ' nodes\n';
    outsideWindow.slice(0, 10).forEach(function (node) {
      var preview = (node.query || node.content || '').slice(0, 55).replace(/\n/g, ' ');
      out += '  [Node ' + node.id + '] ' + node.role + ': "' + preview + '"\n';
    });
    if (outsideWindow.length > 10) out += '  ... and ' + (outsideWindow.length - 10) + ' more\n';
    out += '\n';

    out += '\u2500\u2500 ENGINE STATS \u2500\u2500\n';
    out += '  chain: ' + chain.length + ' nodes\n';
    out += '  window: ' + windowNodes.length + '\n';
    out += '  BM25: ' + memoryRef.bm25.docCount + ' docs, ' + memoryRef.bm25.index.size + ' terms\n';
    out += '  bloom: ' + memoryRef.bloom.itemCount + ' items\n';
    out += '  archives: ' + memoryRef.compaction.markers.length + ' blocks\n';

    outputEl.textContent = out;
  }

  return { init, open };
})();
