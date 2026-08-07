/**
 * Ingest Modal — handles file upload and git repo ingestion.
 * Server returns chunks, this component stores them as nodes in memory.
 */
var IngestModal = (function () {
  var activeTab = 'file';
  var selectedFile = null;
  var selectedFolder = null;
  var selectedFolderName = '';

  // Valid extensions for folder ingestion
  var validExts = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.rb', '.php', '.md', '.txt', '.yaml', '.yml', '.toml', '.json', '.css', '.html', '.svelte', '.vue', '.astro', '.sh', '.sql'];
  var ignoreNames = ['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.next', '__pycache__', 'coverage', '.cache', '.vscode', '.idea'];

  function init() {
    // Tab switching
    var tabFile = document.getElementById('ingest-tab-file');
    var tabRepo = document.getElementById('ingest-tab-repo');
    var panelFile = document.getElementById('ingest-panel-file');
    var panelRepo = document.getElementById('ingest-panel-repo');

    tabFile.addEventListener('click', function () {
      activeTab = 'file';
      tabFile.classList.add('active');
      tabRepo.classList.remove('active');
      panelFile.style.display = '';
      panelRepo.style.display = 'none';
    });

    tabRepo.addEventListener('click', function () {
      activeTab = 'repo';
      tabRepo.classList.add('active');
      tabFile.classList.remove('active');
      panelFile.style.display = 'none';
      panelRepo.style.display = '';
    });

    // File drop zone
    var dropzone = document.getElementById('ingest-dropzone');
    var fileInput = document.getElementById('ingest-file-input');
    var fileStatus = document.getElementById('ingest-file-status');

    dropzone.addEventListener('click', function () { fileInput.click(); });
    dropzone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dropzone.style.borderColor = '#7fdbca';
    });
    dropzone.addEventListener('dragleave', function () {
      dropzone.style.borderColor = '#333';
    });
    dropzone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropzone.style.borderColor = '#333';
      if (e.dataTransfer.files.length > 0) {
        selectedFile = e.dataTransfer.files[0];
        fileStatus.textContent = '✓ Selected: ' + selectedFile.name + ' (' + formatSize(selectedFile.size) + ')';
      }
    });
    fileInput.addEventListener('change', function () {
      if (fileInput.files.length > 0) {
        selectedFile = fileInput.files[0];
        fileStatus.textContent = '✓ Selected: ' + selectedFile.name + ' (' + formatSize(selectedFile.size) + ')';
      }
    });

    // Ingest button
    document.getElementById('ingest-run-btn').addEventListener('click', runIngest);

    // Folder browse button (File System Access API)
    document.getElementById('ingest-folder-browse').addEventListener('click', async function () {
      try {
        var dirHandle = await window.showDirectoryPicker();
        selectedFolderName = dirHandle.name;
        var files = [];
        await walkDirectory(dirHandle, '', files);
        selectedFolder = files;
        var pathEl = document.getElementById('ingest-folder-path');
        pathEl.textContent = '✓ "' + selectedFolderName + '" — ' + files.length + ' files found';
      } catch (e) {
        if (e.name !== 'AbortError') {
          document.getElementById('ingest-folder-path').textContent = '✗ ' + e.message;
        }
      }
    });

    // Open button
    document.getElementById('btn-ingest').addEventListener('click', function () {
      Modal.open('ingest');
    });
  }

  /**
   * Recursively walk a directory handle, collecting valid files.
   */
  async function walkDirectory(dirHandle, relPath, files) {
    for await (var entry of dirHandle.values()) {
      var name = entry.name;
      if (name.startsWith('.') || ignoreNames.indexOf(name) !== -1) continue;

      if (entry.kind === 'directory') {
        var subPath = relPath ? relPath + '/' + name : name;
        await walkDirectory(entry, subPath, files);
      } else if (entry.kind === 'file') {
        var ext = '.' + name.split('.').pop().toLowerCase();
        if (validExts.indexOf(ext) === -1) continue;
        var file = await entry.getFile();
        file._relPath = relPath ? relPath + '/' + name : name;
        files.push(file);
      }
    }
  }

  async function runIngest() {
    var resultEl = document.getElementById('ingest-result');
    var btn = document.getElementById('ingest-run-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Ingesting...';
    resultEl.textContent = '';

    try {
      if (activeTab === 'file') {
        await ingestFile(resultEl);
      } else {
        await ingestRepo(resultEl);
      }
    } catch (err) {
      resultEl.style.color = '#ff6b6b';
      resultEl.textContent = '✗ Error: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ Ingest';
    }
  }

  async function ingestFile(resultEl) {
    if (!selectedFile) {
      resultEl.style.color = '#ff6b6b';
      resultEl.textContent = 'No file selected.';
      return;
    }

    resultEl.style.color = '#888';
    resultEl.textContent = 'Uploading and parsing...';

    var contentType = selectedFile.type || 'text/plain';
    if (selectedFile.name.endsWith('.pdf')) contentType = 'application/pdf';

    var buffer = await selectedFile.arrayBuffer();

    var res = await fetch('/api/ingest/file?filename=' + encodeURIComponent(selectedFile.name), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: buffer
    });

    var data = await res.json();
    if (data.error) {
      resultEl.style.color = '#ff6b6b';
      resultEl.textContent = '✗ ' + data.error;
      return;
    }

    // Store chunks as nodes in memory
    var memory = window._luminalMemory;
    if (!memory) {
      resultEl.style.color = '#ff6b6b';
      resultEl.textContent = '✗ Memory not initialized.';
      return;
    }

    var count = storeNodes(memory, data.nodes, selectedFile.name);
    resultEl.style.color = '#7fdbca';
    resultEl.textContent = '✓ Ingested ' + count + ' nodes from "' + selectedFile.name + '" (' + data.totalChars.toLocaleString() + ' chars)';

    // Update UI stats
    if (window._refreshStats) window._refreshStats();

    // Show in chat
    if (typeof Chat !== 'undefined' && Chat.renderSystem) {
      Chat.renderSystem('⬆ Ingested ' + count + ' nodes from "' + selectedFile.name + '"');
    }

    // Auto-save
    saveState(memory);
  }

  async function ingestRepo(resultEl) {
    if (!selectedFolder || selectedFolder.length === 0) {
      resultEl.style.color = '#ff6b6b';
      resultEl.textContent = 'No folder selected.';
      return;
    }

    resultEl.style.color = '#888';
    resultEl.textContent = 'Ingesting ' + selectedFolder.length + ' files...';

    // Read all files from the selected folder via File System Access API
    var memory = window._luminalMemory;
    if (!memory) {
      resultEl.style.color = '#ff6b6b';
      resultEl.textContent = '✗ Memory not initialized.';
      return;
    }

    var allChunks = [];
    var filesProcessed = 0;

    for (var i = 0; i < selectedFolder.length; i++) {
      var file = selectedFolder[i];
      try {
        var text = await file.text();
        if (text.length < 30 || text.length > 50000) continue;

        var res = await fetch('/api/ingest/file?filename=' + encodeURIComponent(file._relPath || file.name), {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: text
        });
        var data = await res.json();
        if (data.nodes && data.nodes.length > 0) {
          allChunks.push(...data.nodes);
          filesProcessed++;
        }
      } catch (e) { /* skip unreadable */ }
    }

    if (allChunks.length === 0) {
      resultEl.style.color = '#ff6b6b';
      resultEl.textContent = '✗ No content found in selected folder.';
      return;
    }

    var folderName = selectedFolderName || 'folder';
    var count = storeNodes(memory, allChunks, folderName);
    resultEl.style.color = '#7fdbca';
    resultEl.textContent = '✓ Ingested ' + count + ' nodes from ' + filesProcessed + ' files in "' + folderName + '"';

    // Update UI stats
    if (window._refreshStats) window._refreshStats();

    // Show in chat
    if (typeof Chat !== 'undefined' && Chat.renderSystem) {
      Chat.renderSystem('⬆ Ingested ' + count + ' nodes from folder "' + folderName + '" (' + filesProcessed + ' files)');
    }

    // Auto-save
    saveState(memory);
  }

  /**
   * Store an array of { heading, content } chunks as nodes in memory.
   */
  function storeNodes(memory, nodes, source) {
    var count = 0;
    for (var i = 0; i < nodes.length; i++) {
      var chunk = nodes[i];
      if (!chunk.content || chunk.content.length < 20) continue;
      var nodeContent = '[Ingested: ' + source + '] ' + chunk.heading + '\n' + chunk.content;
      var node = memory.chain.append('system', nodeContent);
      memory.bm25.add(node);
      count++;
    }
    console.log('[Ingest] Stored ' + count + ' nodes from "' + source + '"');
    return count;
  }

  function saveState(memory) {
    try {
      fetch('/api/state/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(memory.export())
      });
    } catch (e) { /* non-critical */ }
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  return { init: init };
})();
