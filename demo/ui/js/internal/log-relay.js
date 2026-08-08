/**
 * Log Relay — mirrors browser console output to the dev server.
 *
 * Why this exists: verification of demo/UI behavior needs someone actually watching
 * the browser, but the person building the code often can't. This wraps console.log/
 * warn/error so every line that already gets logged in the browser (the existing
 * [Graph], [Graph:Expand], [Dedup], [Gate] messages, etc.) also gets POSTed to
 * /api/log on serve.js, which writes it to a file on disk. The browser console still
 * behaves completely normally — this only adds a mirror, it changes nothing else.
 *
 * Must load before any other script (see demo/index.html) so nothing logs before
 * the wrapping is in place.
 */
(function () {
  var original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  function relay(level, args) {
    // Best-effort stringify — never let a logging failure break the app.
    try {
      var text = Array.prototype.map.call(args, function (a) {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(' ');

      fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: level, text: text, timestamp: Date.now() })
      }).catch(function () { /* server not running / offline — ignore, browser console still works */ });
    } catch (e) { /* never let relay logging break the real console call */ }
  }

  console.log = function () {
    relay('log', arguments);
    original.log.apply(console, arguments);
  };
  console.warn = function () {
    relay('warn', arguments);
    original.warn.apply(console, arguments);
  };
  console.error = function () {
    relay('error', arguments);
    original.error.apply(console, arguments);
  };
})();
