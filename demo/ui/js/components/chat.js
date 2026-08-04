/**
 * Chat Component — renders messages into the chat stream.
 */
const Chat = (function () {
  let streamEl;

  function init() {
    streamEl = document.getElementById('chat-stream');
  }

  function renderMessage(role, content, nodeId, animate) {
    if (!streamEl) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'message message--' + role;
    if (animate === false) wrapper.style.animation = 'none';
    if (nodeId) wrapper.dataset.nodeId = nodeId;

    // Sender label
    const sender = document.createElement('div');
    sender.className = 'message__sender';
    if (role === 'user') sender.textContent = 'YOU';
    else if (role === 'assistant') sender.textContent = '◈ LUMINAL';
    else sender.textContent = 'SYSTEM';

    // Body card
    const body = document.createElement('div');
    body.className = 'message__body';

    // Wireframe header strip
    if (role === 'assistant') {
      const header = document.createElement('div');
      header.className = 'message__header';
      const pill1 = document.createElement('span');
      pill1.className = 'wire-pill wire-pill--accent';
      pill1.textContent = '[ RESPONSE ]';
      const pill2 = document.createElement('span');
      pill2.className = 'wire-pill';
      pill2.textContent = 'NODE ' + (nodeId || '?');
      header.appendChild(pill1);
      header.appendChild(pill2);
      body.appendChild(header);
    } else if (role === 'user') {
      const header = document.createElement('div');
      header.className = 'message__header';
      const pill1 = document.createElement('span');
      pill1.className = 'wire-pill wire-pill--accent';
      pill1.textContent = '[ QUERY ]';
      header.appendChild(pill1);
      body.appendChild(header);
    }

    // Content
    const contentEl = document.createElement('div');
    if (role === 'assistant' && typeof marked !== 'undefined') {
      contentEl.className = 'message__content markdown';
      contentEl.innerHTML = marked.marked(content);
    } else {
      contentEl.className = 'message__content';
      contentEl.textContent = content;
    }
    body.appendChild(contentEl);

    wrapper.appendChild(sender);
    wrapper.appendChild(body);
    streamEl.appendChild(wrapper);
    streamEl.scrollTop = streamEl.scrollHeight;
  }

  function renderSystem(content) {
    if (!streamEl) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'message message--system';
    const body = document.createElement('div');
    body.className = 'message__body';
    body.textContent = content;
    wrapper.appendChild(body);
    streamEl.appendChild(wrapper);
    streamEl.scrollTop = streamEl.scrollHeight;
  }

  function renderRecall(count) {
    if (!streamEl) return;
    const el = document.createElement('div');
    el.className = 'recall-indicator';
    el.textContent = '\u27E1 ' + count + ' node' + (count > 1 ? 's' : '') + ' recalled from history';
    streamEl.appendChild(el);
    streamEl.scrollTop = streamEl.scrollHeight;
  }

  /**
   * Create a streaming message that updates live as tokens arrive.
   * Returns { thinkEl, contentEl, finalize(fullText) }
   */
  function createStreamingMessage(nodeId) {
    if (!streamEl) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'message message--assistant';
    if (nodeId) wrapper.dataset.nodeId = nodeId;

    const sender = document.createElement('div');
    sender.className = 'message__sender';
    sender.textContent = '\u25C8 LUMINAL';

    const body = document.createElement('div');
    body.className = 'message__body';

    // Header
    const header = document.createElement('div');
    header.className = 'message__header';
    const pill1 = document.createElement('span');
    pill1.className = 'wire-pill wire-pill--accent';
    pill1.textContent = '[ RESPONSE ]';
    const pill2 = document.createElement('span');
    pill2.className = 'wire-pill';
    pill2.textContent = 'NODE ' + (nodeId || '?');
    header.appendChild(pill1);
    header.appendChild(pill2);
    body.appendChild(header);

    // Think block (dimmed, shows when tokens arrive)
    const thinkWrapper = document.createElement('div');
    thinkWrapper.className = 'tool-block';
    thinkWrapper.style.marginBottom = '10px';
    thinkWrapper.style.opacity = '0.5';
    const thinkHeader = document.createElement('div');
    thinkHeader.className = 'tool-block__header';
    thinkHeader.innerHTML = '<span>[ THINKING ]</span><span class="tool-block__reward">reasoning</span>';
    const thinkContent = document.createElement('div');
    thinkContent.style.whiteSpace = 'pre-wrap';
    thinkContent.style.maxHeight = '150px';
    thinkContent.style.overflowY = 'auto';
    thinkContent.style.fontSize = '11px';
    thinkContent.textContent = 'waiting for reasoning...';
    thinkWrapper.appendChild(thinkHeader);
    thinkWrapper.appendChild(thinkContent);
    body.appendChild(thinkWrapper);

    // Content area
    const contentEl = document.createElement('div');
    contentEl.className = 'message__content markdown';
    body.appendChild(contentEl);

    wrapper.appendChild(sender);
    wrapper.appendChild(body);
    streamEl.appendChild(wrapper);
    streamEl.scrollTop = streamEl.scrollHeight;

    return {
      thinkEl: thinkContent,
      thinkWrapper: thinkWrapper,
      contentEl: contentEl,
      body: body,
      appendThink: function (token) {
        if (thinkContent.textContent === 'waiting for reasoning...') thinkContent.textContent = '';
        thinkWrapper.style.opacity = '0.7';
        thinkContent.textContent += token;
        streamEl.scrollTop = streamEl.scrollHeight;
        console.log('[Stream:think]', token.slice(0, 50));
      },
      appendContent: function (token) {
        // Accumulate raw text, re-render as markdown periodically
        contentEl._raw = (contentEl._raw || '') + token;
        if (typeof marked !== 'undefined') {
          contentEl.innerHTML = marked.marked(contentEl._raw);
        } else {
          contentEl.textContent = contentEl._raw;
        }
        streamEl.scrollTop = streamEl.scrollHeight;
      },
      finalize: function (fullText) {
        if (typeof marked !== 'undefined') {
          contentEl.innerHTML = marked.marked(fullText);
        } else {
          contentEl.textContent = fullText;
        }
      }
    };
  }

  function renderWindowBoundary() {
    if (!streamEl) return;
    const el = document.createElement('div');
    el.className = 'window-boundary';
    el.innerHTML = '<div class="window-boundary__line"></div>' +
      '<span class="window-boundary__label">end of ai window</span>';
    streamEl.appendChild(el);
  }

  function clear() {
    if (streamEl) streamEl.innerHTML = '';
  }

  /**
   * Remove messages outside a kept range (for trim) or before a node (for branch).
   * @param {object} opts
   * @param {number} [opts.keepStart] - first node ID to keep
   * @param {number} [opts.keepEnd] - last node ID to keep
   * @param {number} [opts.fromNodeId] - keep this node and after (branch)
   */
  function removeArchived(opts) {
    if (!streamEl) return;
    var messages = streamEl.querySelectorAll('.message[data-node-id]');
    var keepStartEl = null;
    var keepEndEl = null;
    var branchFromEl = null;

    messages.forEach(function (el) {
      var id = parseInt(el.dataset.nodeId, 10);
      if (!id && id !== 0) return;

      var shouldRemove = false;
      if (opts.keepStart !== undefined && opts.keepEnd !== undefined) {
        shouldRemove = id < opts.keepStart || id > opts.keepEnd;
        if (id === opts.keepStart) keepStartEl = el;
        if (id === opts.keepEnd) keepEndEl = el;
      } else if (opts.fromNodeId !== undefined) {
        shouldRemove = id < opts.fromNodeId;
        if (id === opts.fromNodeId) branchFromEl = el;
      }

      if (shouldRemove) {
        el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        el.style.opacity = '0';
        el.style.transform = 'translateX(-20px)';
        setTimeout(function () { el.remove(); }, 300);
      }
    });

    // Also remove the window boundary divider if it exists
    var boundary = streamEl.querySelector('.window-boundary');
    if (boundary) {
      setTimeout(function () { boundary.remove(); }, 300);
    }

    // Insert informational markers after animations complete
    setTimeout(function () {
      if (opts.keepStart !== undefined && opts.keepEnd !== undefined) {
        // Trim: marker before the first kept node and after the last
        if (keepStartEl) {
          var startMarker = createInfoMarker('\u25C0 Archived nodes before this point');
          keepStartEl.parentNode.insertBefore(startMarker, keepStartEl);
        }
        if (keepEndEl) {
          var endMarker = createInfoMarker('Archived nodes after this point \u25B6');
          keepEndEl.parentNode.insertBefore(endMarker, keepEndEl.nextSibling);
        }
      } else if (opts.fromNodeId !== undefined) {
        // Branch: marker before the branch point
        if (branchFromEl) {
          var branchMarker = createInfoMarker('\u25C0 Branch point — previous nodes archived');
          branchFromEl.parentNode.insertBefore(branchMarker, branchFromEl);
        }
      }
    }, 350);
  }

  function createInfoMarker(text) {
    var el = document.createElement('div');
    el.className = 'message message--system';
    el.style.animation = 'fadeSlideIn 0.3s ease both';
    var body = document.createElement('div');
    body.className = 'message__body';
    body.style.borderColor = 'var(--color-accent-border)';
    body.style.background = 'var(--color-accent-bg)';
    body.style.color = 'var(--color-accent)';
    body.textContent = text;
    el.appendChild(body);
    return el;
  }

  function renderSources(results) {
    if (!streamEl || !results || results.length === 0) return;
    var el = document.createElement('div');
    el.className = 'message message--system';
    el.style.animation = 'fadeSlideIn 0.3s ease both';
    var body = document.createElement('div');
    body.className = 'message__body sources-list';
    body.style.fontFamily = 'var(--font-mono)';
    body.style.fontSize = '11px';
    body.style.lineHeight = '1.8';

    var html = '<strong style="color:var(--color-accent);">Sources</strong><br>';
    results.forEach(function (r, i) {
      html += '<a href="' + r.url + '" target="_blank" rel="noopener" style="color:var(--color-accent); text-decoration:none; display:block;">';
      html += '<span style="color:var(--color-accent);">[' + (i + 1) + ']</span> ' + r.title;
      html += '</a>';
    });
    body.innerHTML = html;
    el.appendChild(body);
    streamEl.appendChild(el);
    streamEl.scrollTop = streamEl.scrollHeight;
  }

  return { init, renderMessage, renderSystem, renderRecall, createStreamingMessage, renderSources, renderWindowBoundary, removeArchived, clear };
})();
