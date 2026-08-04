/**
 * Search Modal Component — handles search input and results display.
 */
var SearchModal = (function () {
  var inputEl, resultsEl, memoryRef;

  function init(memory) {
    memoryRef = memory;
    inputEl = document.getElementById('search-input');
    resultsEl = document.getElementById('search-results');

    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') execute();
    });
  }

  function open() {
    Modal.open('search');
    setTimeout(function () { inputEl.focus(); }, 100);
  }

  function execute() {
    var query = inputEl.value.trim();
    if (!query || !memoryRef) return;

    var results = memoryRef.search(query, 8);

    if (results.length === 0) {
      resultsEl.textContent = 'No results for "' + query + '"';
      return;
    }

    resultsEl.textContent = results.map(function (r) {
      var content = (r.node && (r.node.query || r.node.content)) || '';
      return '[Node ' + r.nodeId + '] score: ' + r.score.toFixed(3) + '\n  ' + content.slice(0, 120).replace(/\n/g, ' ') + '...';
    }).join('\n\n');
  }

  return { init, open };
})();
