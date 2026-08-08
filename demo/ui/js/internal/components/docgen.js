/**
 * DocGen UI Component — Thin trigger for documentation generation with live progress.
 * All logic lives in src/extensions/docgen.js. This handles button + live SSE updates.
 */
var DocGen = (function () {

  function init() {
    document.getElementById('btn-docgen').addEventListener('click', startDocGen);
  }

  async function startDocGen() {
    var folderPath = prompt('Enter the folder path to document:\n(relative to project root, e.g. "demo" or "src/core")');
    if (!folderPath) return;

    Chat.renderSystem('📝 DocGen starting: "' + folderPath + '"');
    Topbar.setStatus('active', 'DOCGEN');

    try {
      // Use fetch with streaming to read SSE events
      var response = await fetch('/api/docgen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootDir: folderPath })
      });

      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });

        // Process complete SSE events
        var lines = buffer.split('\n\n');
        buffer = lines.pop(); // Keep incomplete event in buffer

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line.startsWith('data: ')) continue;

          try {
            var event = JSON.parse(line.slice(6));

            if (event.type === 'progress') {
              Topbar.setStatus('active', 'DOCGEN: ' + event.data);
            } else if (event.type === 'done') {
              Chat.renderSystem('✓ DocGen complete: ' + event.data.filesDocumented + ' files, ' + event.data.totalFunctions + ' functions → DOCUMENTATION.md');
            } else if (event.type === 'error') {
              Chat.renderSystem('✗ DocGen error: ' + event.data);
            }
          } catch (e) { /* skip malformed events */ }
        }
      }
    } catch (err) {
      Chat.renderSystem('✗ DocGen failed: ' + err.message);
    }

    Topbar.setStatus('idle', 'IDLE');
  }

  return { init: init };
})();
