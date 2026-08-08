/**
 * Settings Modal — two-panel layout with left nav + right content.
 * Static groups (connection, context, etc.) built from library schema.
 * Sampling tab is empty until "Detect from Server" pulls live params.
 */
var SettingsModal = (function () {
  var memoryRef, bodyEl, navEl;
  var activeGroup = 'connection';

  var GROUP_ICONS = {
    connection: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>',
    context: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
    recall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
    memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12H2M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>',
    tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>',
    sampling: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10M18 20V4M6 20v-4"/></svg>',
    profiles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
  };

  var GROUP_DESCRIPTIONS = {
    connection: 'Detected backends and model selection.',
    context: 'Control how much conversation the model sees each turn.',
    recall: 'Tune how aggressively historical context is retrieved.',
    memory: 'Set storage limits and archival behavior.',
    tools: 'Configure automatic tool discovery and matching.',
    sampling: 'Generation parameters pulled from your running server.',
    profiles: 'Switch between memory profiles or create new ones.'
  };

  function init(memory) {
    memoryRef = memory;
    bodyEl = document.getElementById('settings-body');
    navEl = document.getElementById('settings-nav');
    document.getElementById('btn-settings').addEventListener('click', open);
  }

  function open() {
    Modal.open('settings');
    render();
  }

  function render() {
    if (!memoryRef || !bodyEl || !navEl) return;

    var schemaData = memoryRef.settings.getSchema();
    var groups = schemaData.groups;
    var fields = schemaData.schema;
    var samplingSchema = schemaData.samplingSchema;
    var values = memoryRef.settings.getAll();

    // Build left nav
    var sortedGroups = Object.entries(groups).sort(function (a, b) { return a[1].order - b[1].order; });
    // Add profiles tab (demo-only, not from library schema)
    sortedGroups.push(['profiles', { label: 'Profiles', order: 99 }]);
    var navHtml = '';
    sortedGroups.forEach(function (entry) {
      var key = entry[0], meta = entry[1];
      var cls = key === activeGroup ? 'settings-nav__item settings-nav__item--active' : 'settings-nav__item';
      var icon = GROUP_ICONS[key] || '';
      navHtml += '<div class="' + cls + '" data-group="' + key + '">';
      navHtml += '<span class="settings-nav__icon">' + icon + '</span>';
      navHtml += '<span>' + meta.label + '</span>';
      navHtml += '</div>';
    });
    navEl.innerHTML = navHtml;

    navEl.querySelectorAll('.settings-nav__item').forEach(function (item) {
      item.addEventListener('click', function () {
        activeGroup = item.getAttribute('data-group');
        render();
      });
    });

    // Build right content
    var groupMeta = groups[activeGroup] || { label: activeGroup.charAt(0).toUpperCase() + activeGroup.slice(1) };
    var html = '';

    // Section header
    html += '<div class="settings-content__header">';
    html += '<div class="settings-content__title">' + groupMeta.label + '</div>';
    html += '<div class="settings-content__desc">' + (GROUP_DESCRIPTIONS[activeGroup] || '') + '</div>';
    html += '</div>';

    if (activeGroup === 'sampling') {
      html += renderSamplingTab(samplingSchema, values.sampling);
    } else if (activeGroup === 'connection') {
      html += renderConnectionTab(fields, values.connection || {});
    } else if (activeGroup === 'profiles') {
      html += renderProfilesTab();
    } else {
      html += renderStaticFields(fields, values[activeGroup] || {});
    }

    bodyEl.innerHTML = html;
    if (activeGroup !== 'profiles') {
      wireHandlers(activeGroup === 'sampling' ? samplingSchema : fields);
    }
  }

  function renderStaticFields(fields, groupValues) {
    var html = '';
    Object.entries(fields).forEach(function (entry) {
      var key = entry[0], meta = entry[1];
      if (meta.group !== activeGroup) return;
      html += renderField(key, meta, groupValues[key]);
    });
    return html;
  }

  function renderConnectionTab(fields, groupValues) {
    var html = '';
    var backends = memoryRef.settings.getBackends();

    // Detect button
    html += '<div class="settings-detect-bar">';
    html += '<button class="btn-control" id="settings-detect-backends">\u27F3 Scan for Backends</button>';
    html += '<span class="settings-detect-bar__status" id="settings-backends-status">';
    if (backends) {
      var found = [];
      if (backends.llamacpp) found.push('llama.cpp');
      if (backends.ollama) found.push('Ollama (' + backends.ollama.models.length + ' models)');
      html += found.length ? '\u2713 Found: ' + found.join(', ') : '\u2717 No backends found';
    } else {
      html += 'Scan for llama.cpp and Ollama servers';
    }
    html += '</span>';
    html += '</div>';

    // Show detected backends as cards
    if (backends) {
      // llama.cpp card
      if (backends.llamacpp) {
        var isActive = memoryRef.settings.get('apiFormat') === 'openai';
        html += '<div class="settings-backend-card' + (isActive ? ' settings-backend-card--active' : '') + '">';
        html += '<div class="settings-backend-card__header">';
        html += '<strong>llama.cpp</strong>';
        html += '<span class="settings-backend-card__badge">' + backends.llamacpp.endpoint + '</span>';
        html += '</div>';
        if (backends.llamacpp.models.length > 0) {
          html += '<div class="settings-backend-card__model">' + backends.llamacpp.models[0] + '</div>';
        }
        if (!isActive) {
          html += '<button class="btn-control settings-backend-card__btn" data-backend="llamacpp">Use this</button>';
        } else {
          html += '<span class="settings-backend-card__active">\u2713 Active</span>';
        }
        html += '</div>';
      }

      // Ollama card with model list
      if (backends.ollama) {
        var isOllama = memoryRef.settings.get('apiFormat') === 'ollama';
        html += '<div class="settings-backend-card' + (isOllama ? ' settings-backend-card--active' : '') + '">';
        html += '<div class="settings-backend-card__header">';
        html += '<strong>Ollama</strong>';
        html += '<span class="settings-backend-card__badge">' + backends.ollama.endpoint + '</span>';
        html += '</div>';

        if (backends.ollama.models.length > 0) {
          html += '<div class="settings-backend-card__models">';
          backends.ollama.models.forEach(function (m) {
            var currentModel = memoryRef.settings.get('model');
            var isCurrent = isOllama && currentModel === m.name;
            html += '<div class="settings-model-row' + (isCurrent ? ' settings-model-row--active' : '') + '" data-model="' + m.name + '">';
            html += '<span class="settings-model-row__name">' + m.name + '</span>';
            html += '<span class="settings-model-row__meta">';
            if (m.paramSize) html += m.paramSize + ' ';
            if (m.quantization) html += m.quantization;
            html += '</span>';
            if (isCurrent) {
              html += '<span class="settings-model-row__badge">\u2713</span>';
            }
            html += '</div>';
          });
          html += '</div>';
        } else {
          html += '<div style="color:var(--color-text-muted);font-size:var(--text-sm);padding:var(--space-8) 0;">No models installed. Run: ollama pull &lt;model&gt;</div>';
        }
        html += '</div>';
      }
    }

    // Manual config fields below
    html += '<div style="margin-top:var(--space-20); padding-top:var(--space-16); border-top:1px solid var(--color-border);">';
    html += '<div style="font-size:var(--text-sm);font-weight:var(--weight-semibold);color:var(--color-text-secondary);margin-bottom:var(--space-12);">Manual Configuration</div>';
    Object.entries(fields).forEach(function (entry) {
      var key = entry[0], meta = entry[1];
      if (meta.group !== 'connection') return;
      html += renderField(key, meta, groupValues[key]);
    });
    html += '</div>';

    return html;
  }

  function renderSamplingTab(samplingSchema, samplingValues) {
    var html = '';

    // Always show detect button
    html += '<div class="settings-detect-bar">';
    html += '<button class="btn-control" id="settings-detect">\u27F3 Detect from Server</button>';
    html += '<span class="settings-detect-bar__status" id="settings-detect-status">';
    if (samplingSchema) {
      html += '\u2713 ' + Object.keys(samplingSchema).length + ' parameters loaded';
    } else {
      html += 'Click to pull parameters from your running model';
    }
    html += '</span>';
    html += '</div>';

    // If no schema detected yet, show empty state
    if (!samplingSchema) {
      html += '<div style="text-align:center; padding:var(--space-32) 0; color:var(--color-text-muted);">';
      html += '<div style="font-size:var(--text-lg); margin-bottom:var(--space-8);">\u2699</div>';
      html += '<div>No sampling parameters detected yet.</div>';
      html += '<div style="font-size:var(--text-sm); margin-top:var(--space-4);">Hit detect to query your llama.cpp or Ollama server.</div>';
      html += '</div>';
      return html;
    }

    // Render detected params as fields
    Object.entries(samplingSchema).forEach(function (entry) {
      var key = entry[0], meta = entry[1];
      var value = samplingValues ? samplingValues[key] : meta.default;
      html += renderField(key, meta, value);
    });

    return html;
  }

  function renderProfilesTab() {
    var html = '';
    html += '<div class="settings-field" id="profiles-container">';
    html += '<div style="margin-bottom:16px;"><button class="btn-action" id="profiles-refresh" style="margin-right:8px;">↻ Refresh</button>';
    html += '<button class="btn-action" id="profiles-create" style="color:#87ceeb;border-color:#87ceeb;">+ New Profile</button></div>';
    html += '<div id="profiles-list" style="font-size:0.9rem;color:#aaa;">Loading...</div>';
    html += '</div>';

    // Wire up after render
    setTimeout(function () {
      loadProfilesList();
      var refreshBtn = document.getElementById('profiles-refresh');
      if (refreshBtn) refreshBtn.addEventListener('click', loadProfilesList);
      var createBtn = document.getElementById('profiles-create');
      if (createBtn) createBtn.addEventListener('click', createNewProfile);
    }, 50);

    return html;
  }

  async function loadProfilesList() {
    var listEl = document.getElementById('profiles-list');
    if (!listEl) return;
    listEl.textContent = 'Loading...';

    try {
      var res = await fetch('/api/profiles');
      var data = await res.json();
      var html = '';

      data.profiles.forEach(function (p) {
        var isActive = p.name === data.active;
        var sizeKB = (p.size / 1024).toFixed(1);
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;margin-bottom:6px;background:' + (isActive ? '#1a2a3a' : '#111') + ';border:1px solid ' + (isActive ? '#87ceeb' : '#333') + ';border-radius:6px;">';
        html += '<div>';
        html += '<strong style="color:' + (isActive ? '#87ceeb' : '#eee') + ';">' + p.name + '</strong>';
        if (isActive) html += ' <span style="color:#87ceeb;font-size:0.75rem;">(active)</span>';
        html += '<div style="font-size:0.8rem;color:#666;">' + p.nodeCount + ' nodes · ' + sizeKB + ' KB</div>';
        html += '</div>';
        html += '<div style="display:flex;gap:6px;">';
        if (!isActive) {
          html += '<button class="btn-action profiles-switch-btn" data-name="' + p.name + '" style="font-size:0.8rem;padding:4px 8px;">Switch</button>';
          if (p.name !== 'state') {
            html += '<button class="btn-action profiles-delete-btn" data-name="' + p.name + '" style="font-size:0.8rem;padding:4px 8px;color:#ff6b6b;border-color:#ff6b6b;">✕</button>';
          }
        }
        html += '</div>';
        html += '</div>';
      });

      listEl.innerHTML = html;

      // Wire switch buttons
      listEl.querySelectorAll('.profiles-switch-btn').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var name = btn.getAttribute('data-name');
          if (!confirm('Switch to profile "' + name + '"? The page will reload.')) return;
          await fetch('/api/profiles/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name })
          });
          window.location.reload();
        });
      });

      // Wire delete buttons
      listEl.querySelectorAll('.profiles-delete-btn').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var name = btn.getAttribute('data-name');
          if (!confirm('Delete profile "' + name + '"? This cannot be undone.')) return;
          await fetch('/api/profiles/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name })
          });
          loadProfilesList();
        });
      });
    } catch (err) {
      listEl.textContent = 'Error loading profiles: ' + err.message;
    }
  }

  async function createNewProfile() {
    var name = prompt('New profile name:\n(lowercase, alphanumeric, dashes only)');
    if (!name) return;
    name = name.toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/^-|-$/g, '');
    if (!name) return;

    var res = await fetch('/api/profiles/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    });
    var data = await res.json();
    if (data.success) {
      Chat.renderSystem('✓ Created profile: "' + name + '"');
      loadProfilesList();
    } else {
      alert('Failed: ' + data.error);
    }
  }

  function renderField(key, meta, value) {
    var html = '';
    html += '<div class="settings-field">';
    html += '<label class="settings-field__label" for="setting-' + key + '">' + (meta.label || key) + '</label>';

    if (meta.type === 'number') {
      var displayVal = value !== undefined && value !== null ? value : (meta.default || 0);
      html += '<div class="settings-field__row">';
      html += '<input type="range" class="settings-range" id="setting-' + key + '-range"'
        + ' min="' + (meta.min !== undefined ? meta.min : 0) + '"'
        + ' max="' + (meta.max !== undefined ? meta.max : 100) + '"'
        + ' step="' + (meta.step || 1) + '"'
        + ' value="' + displayVal + '">';
      html += '<input type="number" class="settings-input settings-input--num" id="setting-' + key + '"'
        + ' min="' + (meta.min !== undefined ? meta.min : 0) + '"'
        + ' max="' + (meta.max !== undefined ? meta.max : 100) + '"'
        + ' step="' + (meta.step || 1) + '"'
        + ' value="' + displayVal + '">';
      html += '</div>';
    } else if (meta.type === 'boolean') {
      html += '<label class="settings-toggle">';
      html += '<input type="checkbox" id="setting-' + key + '"' + (value ? ' checked' : '') + '>';
      html += '<span class="settings-toggle__slider"></span>';
      html += '</label>';
    } else if (meta.type === 'select') {
      html += '<select class="settings-input" id="setting-' + key + '">';
      (meta.options || []).forEach(function (opt) {
        html += '<option value="' + opt + '"' + (opt === value ? ' selected' : '') + '>' + opt + '</option>';
      });
      html += '</select>';
    } else if (meta.type === 'textarea') {
      html += '<textarea class="settings-input settings-input--textarea" id="setting-' + key + '" rows="4">' + (value || '') + '</textarea>';
    } else {
      html += '<input type="text" class="settings-input" id="setting-' + key + '" value="' + (value || '') + '">';
    }

    if (meta.description) {
      html += '<span class="settings-field__hint">' + meta.description + '</span>';
    }
    html += '</div>';
    return html;
  }

  function wireHandlers(fieldsOrSampling) {
    // Determine which keys to wire
    var keys = [];
    if (activeGroup === 'sampling') {
      if (fieldsOrSampling) keys = Object.keys(fieldsOrSampling);
    } else {
      Object.entries(fieldsOrSampling).forEach(function (entry) {
        if (entry[1].group === activeGroup) keys.push(entry[0]);
      });
    }

    keys.forEach(function (key) {
      var el = document.getElementById('setting-' + key);
      if (!el) return;

      var meta = (activeGroup === 'sampling' && fieldsOrSampling)
        ? fieldsOrSampling[key]
        : fieldsOrSampling[key];

      if (meta && meta.type === 'number') {
        var rangeEl = document.getElementById('setting-' + key + '-range');
        el.addEventListener('input', function () {
          memoryRef.settings.set(key, el.value);
          if (rangeEl) rangeEl.value = el.value;
        });
        if (rangeEl) {
          rangeEl.addEventListener('input', function () {
            el.value = rangeEl.value;
            memoryRef.settings.set(key, rangeEl.value);
          });
        }
      } else if (meta && meta.type === 'boolean') {
        el.addEventListener('change', function () {
          memoryRef.settings.set(key, el.checked);
        });
      } else if (meta && meta.type === 'textarea') {
        el.addEventListener('input', function () {
          memoryRef.settings.set(key, el.value);
        });
      } else {
        el.addEventListener('change', function () {
          memoryRef.settings.set(key, el.value);
        });
      }
    });

    // Wire detect button (sampling tab)
    var detectBtn = document.getElementById('settings-detect');
    if (detectBtn) {
      detectBtn.addEventListener('click', async function () {
        detectBtn.disabled = true;
        var statusEl = document.getElementById('settings-detect-status');
        if (statusEl) statusEl.textContent = 'detecting...';

        var result = await memoryRef.settings.detectServerParams();
        if (result) {
          if (statusEl) statusEl.textContent = '\u2713 Loaded ' + Object.keys(memoryRef.settings.getSchema().samplingSchema || {}).length + ' parameters';
          render();
        } else {
          if (statusEl) statusEl.textContent = '\u2717 Could not reach server';
          detectBtn.disabled = false;
        }
      });
    }

    // Wire backend scan button (connection tab)
    var detectBackendsBtn = document.getElementById('settings-detect-backends');
    if (detectBackendsBtn) {
      detectBackendsBtn.addEventListener('click', async function () {
        detectBackendsBtn.disabled = true;
        var statusEl = document.getElementById('settings-backends-status');
        if (statusEl) statusEl.textContent = 'scanning...';
        await memoryRef.settings.detectBackends();
        render();
      });
    }

    // Wire "Use this" button for llama.cpp
    var llamaBtn = document.querySelector('[data-backend="llamacpp"]');
    if (llamaBtn) {
      llamaBtn.addEventListener('click', function () {
        var backends = memoryRef.settings.getBackends();
        if (backends && backends.llamacpp) {
          memoryRef.settings.selectLlamaCpp(backends.llamacpp.endpoint, backends.llamacpp.models[0] || '');
          render();
        }
      });
    }

    // Wire Ollama model rows
    document.querySelectorAll('.settings-model-row').forEach(function (row) {
      row.addEventListener('click', function () {
        var modelName = row.getAttribute('data-model');
        memoryRef.settings.selectOllamaModel(modelName);
        render();
      });
    });
  }

  return { init, open };
})();
