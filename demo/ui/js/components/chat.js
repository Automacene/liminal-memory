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
    const contentEl = document.createElement('span');
    contentEl.textContent = content;
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

  function clear() {
    if (streamEl) streamEl.innerHTML = '';
  }

  return { init, renderMessage, renderSystem, renderRecall, clear };
})();
