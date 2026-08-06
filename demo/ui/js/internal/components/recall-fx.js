/**
 * Recall FX Component — visual effects when memory recall fires.
 * 
 * Shows ghost node fragments in the right whitespace with a sci-fi flicker,
 * and triggers the canvas pulse.
 */
var RecallFX = (function () {
  var containerEl = null;

  function init() {
    // Create a fixed container in the right whitespace for ghost nodes
    containerEl = document.createElement('div');
    containerEl.id = 'recall-fx';
    containerEl.style.cssText =
      'position:fixed; right:6%; top:35%; z-index:3; ' +
      'display:flex; flex-direction:column; gap:6px; ' +
      'max-width:180px; pointer-events:none;';
    document.body.appendChild(containerEl);
  }

  /**
   * Fire the recall effect.
   * @param {object[]} nodes - the recalled nodes (from memory.chain.get())
   */
  function fire(nodes) {
    if (!containerEl) return;

    // Trigger canvas pulse
    if (typeof Canvas !== 'undefined' && Canvas.pulse) {
      Canvas.pulse();
    }

    // Show ghost node fragments
    for (var i = 0; i < Math.min(nodes.length, 4); i++) {
      showGhostNode(nodes[i], i * 120);
    }
  }

  function showGhostNode(node, delay) {
    setTimeout(function () {
      var el = document.createElement('div');
      el.style.cssText =
        'font-family: "SF Mono", Consolas, monospace; font-size: 9px; ' +
        'color: rgba(255, 69, 0, 0.7); line-height: 1.4; ' +
        'padding: 6px 8px; border-left: 2px solid rgba(255, 69, 0, 0.4); ' +
        'opacity: 0; animation: ghostFlicker 2.5s ease-out forwards;';

      var preview = (node.query || node.content || '').slice(0, 60).replace(/\n/g, ' ');
      el.textContent = '[' + node.id + '] ' + preview;

      containerEl.appendChild(el);

      // Remove after animation completes
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 2800);
    }, delay);
  }

  return { init: init, fire: fire };
})();
