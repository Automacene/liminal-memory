/**
 * Dev Control Client — lets serve.js drive this demo tab during development.
 *
 * Opens an SSE connection to /api/control/stream and reacts to two pushed events:
 *   - "refresh": reloads the page (used right after a library rebuild)
 *   - "prompt":  injects a prompt into the Sovereign chat, exactly as if typed
 *
 * This is a local dev aid only (see serve.js). It changes nothing for a normal user —
 * if the control channel isn't there, EventSource just retries quietly and nothing
 * happens. Prompt injection is dispatched as a DOM CustomEvent that app.js listens
 * for, so this file stays fully decoupled from app internals.
 */
(function () {
  if (typeof EventSource === 'undefined') return;

  var es = new EventSource('/api/control/stream');

  es.addEventListener('refresh', function () {
    console.log('[Control] Refresh requested — reloading UI');
    // Small delay so this log line flushes to /api/log before the page tears down.
    setTimeout(function () { location.reload(); }, 150);
  });

  es.addEventListener('prompt', function (e) {
    var text = '';
    try { text = JSON.parse(e.data).text || ''; } catch (err) { /* ignore malformed */ }
    if (!text) return;
    console.log('[Control] Prompt received → dispatching to Sovereign: "' + text + '"');
    window.dispatchEvent(new CustomEvent('luminal:remote-prompt', { detail: { text: text } }));
  });

  // EventSource auto-reconnects (including after location.reload); nothing to handle.
  es.onerror = function () {};
})();
