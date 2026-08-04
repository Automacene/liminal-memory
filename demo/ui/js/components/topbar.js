/**
 * Topbar Component — manages status display and stats in the header.
 */
const Topbar = (function () {
  let dotEl, labelEl;

  function init() {
    dotEl = document.getElementById('status-dot');
    labelEl = document.getElementById('status-label');
  }

  function setStatus(state, label) {
    if (!dotEl) return;
    dotEl.className = state === 'active' ? 'topbar__dot' : 'topbar__dot topbar__dot--idle';
    labelEl.textContent = label;
    // Also update sidebar
    var sideStatus = document.getElementById('side-status');
    if (sideStatus) sideStatus.textContent = label;
  }

  function updateStats(nodes, windowCount, memoryMB, totalTokens) {
    // Update sidebar stats
    var sideNodes = document.getElementById('side-nodes');
    var sideWindow = document.getElementById('side-window');
    var sideMemory = document.getElementById('side-memory');
    var sideTokens = document.getElementById('side-tokens');
    if (sideNodes) sideNodes.textContent = nodes;
    if (sideWindow) sideWindow.textContent = windowCount + '/40';
    if (sideMemory) sideMemory.textContent = memoryMB + ' / 2048 MB';
    if (sideTokens) sideTokens.textContent = totalTokens ? totalTokens.toLocaleString() : '0';
  }

  return { init, setStatus, updateStats };
})();
