/**
 * Selection Mode Component — handles trim/branch node selection UI.
 * 
 * When activated, chat panels become clickable. Clicking a panel selects it
 * (orange outline + marker). Right-side context info guides the user.
 * After selection is complete, opens a confirmation modal.
 */
var SelectionMode = (function () {
  var mode = null;         // 'trim' | 'branch' | null
  var selections = [];     // array of { nodeId, element }
  var maxSelections = 0;   // 1 for branch, 2 for trim
  var onComplete = null;   // callback when selection is done
  var streamEl = null;

  // Context info elements
  var contextEl, modeEl, messageEl, selectionEl;

  function init() {
    streamEl = document.getElementById('chat-stream');
    contextEl = document.getElementById('context-info');
    modeEl = document.getElementById('context-mode');
    messageEl = document.getElementById('context-message');
    selectionEl = document.getElementById('context-selection');
  }

  /**
   * Enter trim selection mode.
   * @param {function} callback - called with { keepStartId, keepEndId } when confirmed
   */
  function startTrim(callback) {
    mode = 'trim';
    maxSelections = 2;
    selections = [];
    onComplete = callback;
    activate();
    showContext('TRIM MODE', 'Click two nodes to define the range you want to keep. Everything outside will be archived.');
  }

  /**
   * Enter branch selection mode.
   * @param {function} callback - called with { fromNodeId } when confirmed
   */
  function startBranch(callback) {
    mode = 'branch';
    maxSelections = 1;
    selections = [];
    onComplete = callback;
    activate();
    showContext('BRANCH MODE', 'Click a node to branch from. Everything before it will be archived.');
  }

  /**
   * Cancel and exit selection mode.
   */
  function cancel() {
    deactivate();
  }

  /**
   * Check if currently in selection mode.
   */
  function isActive() {
    return mode !== null;
  }

  // --- Internal ---

  function activate() {
    streamEl.classList.add('chat-stream--selecting');
    streamEl.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleEscape);
  }

  function deactivate() {
    mode = null;
    onComplete = null;

    streamEl.classList.remove('chat-stream--selecting');
    streamEl.removeEventListener('click', handleClick);
    document.removeEventListener('keydown', handleEscape);

    // Remove all selection visuals
    for (var i = 0; i < selections.length; i++) {
      var el = selections[i].element;
      el.classList.remove('message--selected');
      var marker = el.querySelector('.selection-marker');
      if (marker) marker.remove();
    }
    selections = [];

    // Hide context info
    hideContext();
  }

  function handleEscape(e) {
    if (e.key === 'Escape') {
      deactivate();
    }
  }

  function handleClick(e) {
    // Find the closest .message element
    var msgEl = e.target.closest('.message');
    if (!msgEl) return;

    // Get the node ID from the data attribute
    var nodeId = parseInt(msgEl.dataset.nodeId, 10);
    if (!nodeId && nodeId !== 0) return;

    // Don't allow selecting the same node twice
    for (var i = 0; i < selections.length; i++) {
      if (selections[i].nodeId === nodeId) return;
    }

    // Don't exceed max selections
    if (selections.length >= maxSelections) return;

    // Mark as selected
    msgEl.classList.add('message--selected');

    // Add marker button with icon + text
    var marker = document.createElement('div');
    marker.className = 'selection-marker';

    var icon = document.createElement('span');
    icon.className = 'selection-marker__icon';

    var label = document.createElement('span');

    if (mode === 'trim') {
      icon.textContent = '\u2702';  // ✂ scissors
      label.textContent = selections.length === 0 ? 'START' : 'END';
    } else {
      icon.textContent = '\u2387';  // ⎇ branch/fork
      label.textContent = 'FROM';
    }

    marker.appendChild(icon);
    marker.appendChild(label);

    // Position relative to message body
    var body = msgEl.querySelector('.message__body');
    if (body) {
      body.style.position = 'relative';
      body.appendChild(marker);
    }

    selections.push({ nodeId: nodeId, element: msgEl });

    // Update context info
    if (mode === 'trim') {
      if (selections.length === 1) {
        showContext('TRIM MODE', 'Start point selected. Click another node for the end point.', 'Keep from: Node ' + nodeId);
      } else if (selections.length === 2) {
        var startId = Math.min(selections[0].nodeId, selections[1].nodeId);
        var endId = Math.max(selections[0].nodeId, selections[1].nodeId);
        completeSelection({ keepStartId: startId, keepEndId: endId });
      }
    } else if (mode === 'branch') {
      completeSelection({ fromNodeId: nodeId });
    }
  }

  function completeSelection(data) {
    // Build confirmation info
    var title, message;

    if (mode === 'trim') {
      title = 'Trim — Keep Range';
      message = 'You selected Node ' + data.keepStartId + ' through Node ' + data.keepEndId + '. ' +
        'Everything before Node ' + data.keepStartId + ' and after Node ' + data.keepEndId + ' will be archived to cold storage. ' +
        'The selected range stays as your active session. Proceed?';
    } else {
      title = 'Branch From Here';
      message = 'You selected Node ' + data.fromNodeId + '. ' +
        'Everything before this node will be archived to cold storage. ' +
        'Node ' + data.fromNodeId + ' onward stays as your active session. Proceed?';
    }

    // Show confirm modal
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    Modal.open('confirm');

    var proceedBtn = document.getElementById('confirm-proceed');
    var cancelBtn = document.getElementById('confirm-cancel');

    function cleanup() {
      proceedBtn.removeEventListener('click', onYes);
      cancelBtn.removeEventListener('click', onNo);
    }

    function onYes() {
      cleanup();
      Modal.close('confirm');
      var cb = onComplete;
      deactivate();
      if (cb) cb(data);
    }

    function onNo() {
      cleanup();
      Modal.close('confirm');
      deactivate();
    }

    proceedBtn.addEventListener('click', onYes);
    cancelBtn.addEventListener('click', onNo);
  }

  function showContext(modeText, messageText, selectionText) {
    contextEl.classList.add('context-info--active');
    modeEl.textContent = modeText;
    messageEl.textContent = messageText;
    if (selectionText) {
      selectionEl.textContent = selectionText;
      selectionEl.style.display = 'block';
    } else {
      selectionEl.style.display = 'none';
    }
  }

  function hideContext() {
    contextEl.classList.remove('context-info--active');
    modeEl.textContent = '';
    messageEl.textContent = '';
    selectionEl.style.display = 'none';
  }

  return { init, startTrim, startBranch, cancel, isActive };
})();
