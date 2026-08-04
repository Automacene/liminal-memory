/**
 * Status Modal Component — displays system metrics.
 */
var StatusModal = (function () {
  var bodyEl, memoryRef;

  function init(memory) {
    memoryRef = memory;
    bodyEl = document.getElementById('status-body');
  }

  function open() {
    Modal.open('status');
    render();
  }

  function render() {
    if (!memoryRef || !bodyEl) return;
    var s = memoryRef.status();

    bodyEl.innerHTML =
      '<div class="metric-card" style="margin-bottom:12px">' +
        '<div class="metric-card__label">Nodes <span class="metric-card__value">' + s.totalNodes + '</span></div>' +
      '</div>' +
      '<div class="metric-card" style="margin-bottom:12px">' +
        '<div class="metric-card__label">Memory <span class="metric-card__value">' + s.memoryUsageMB + ' MB / ' + s.limitMB + ' MB</span></div>' +
        '<div class="progress-bar"><div class="progress-bar__fill" style="width:' + Math.max(s.utilizationPercent, 0.5) + '%"></div></div>' +
      '</div>' +
      '<div class="metric-card" style="margin-bottom:12px">' +
        '<div class="metric-card__label">Utilization <span class="metric-card__value">' + s.utilizationPercent + '%</span></div>' +
      '</div>' +
      '<div class="metric-card" style="margin-bottom:12px">' +
        '<div class="metric-card__label">Archives <span class="metric-card__value">' + s.archiveBlocks + '</span></div>' +
      '</div>' +
      '<div class="metric-card" style="margin-bottom:12px">' +
        '<div class="metric-card__label">Window <span class="metric-card__value">' + memoryRef.getWindow().length + ' / ' + memoryRef.config.windowSize + '</span></div>' +
      '</div>' +
      '<div class="metric-card" style="margin-bottom:12px">' +
        '<div class="metric-card__label">BM25 Index <span class="metric-card__value">' + memoryRef.bm25.docCount + ' docs / ' + memoryRef.bm25.index.size + ' terms</span></div>' +
      '</div>' +
      '<div class="metric-card">' +
        '<div class="metric-card__label">Bloom Filter <span class="metric-card__value">' + memoryRef.bloom.itemCount + ' items</span></div>' +
      '</div>';
  }

  return { init, open };
})();
