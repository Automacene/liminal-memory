/**
 * Topbar Component — manages status display and stats in the header.
 */
const Topbar = (function () {
  let dotEl, labelEl, nodesEl, windowEl, memoryEl;

  function init() {
    dotEl = document.getElementById('status-dot');
    labelEl = document.getElementById('status-label');
    nodesEl = document.getElementById('stat-nodes');
    windowEl = document.getElementById('stat-window');
    memoryEl = document.getElementById('stat-memory');
  }

  function setStatus(state, label) {
    if (!dotEl) return;
    dotEl.className = state === 'active' ? 'topbar__dot' : 'topbar__dot topbar__dot--idle';
    labelEl.textContent = label;
  }

  function updateStats(nodes, windowCount, memoryMB) {
    if (nodesEl) nodesEl.textContent = nodes;
    if (windowEl) windowEl.textContent = windowCount;
    if (memoryEl) memoryEl.textContent = memoryMB + ' MB';
  }

  return { init, setStatus, updateStats };
})();
