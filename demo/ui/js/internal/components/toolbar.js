/**
 * Toolbar Component — wires memory control buttons to actions.
 */
var Toolbar = (function () {

  function init(actions) {
    document.getElementById('btn-trim').addEventListener('click', actions.onTrim);
    document.getElementById('btn-branch').addEventListener('click', actions.onBranch);
    document.getElementById('btn-search').addEventListener('click', actions.onSearch);
    document.getElementById('btn-inspect').addEventListener('click', actions.onInspect);
    document.getElementById('btn-status').addEventListener('click', actions.onStatus);
  }

  return { init };
})();
