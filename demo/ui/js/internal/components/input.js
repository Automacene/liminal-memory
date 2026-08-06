/**
 * Input Component — manages the text input area and send behavior.
 */
const Input = (function () {
  let textareaEl, sendBtnEl, onSendCallback;

  function init(onSend) {
    textareaEl = document.getElementById('user-input');
    sendBtnEl = document.getElementById('send-btn');
    onSendCallback = onSend;

    sendBtnEl.addEventListener('click', handleSend);
    textareaEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        // Skip if pocket mode is active (handled by pocket note system)
        if (document.querySelector('.input-box--pocket-mode')) return;
        e.preventDefault();
        handleSend();
      }
    });

    // Auto-resize textarea
    textareaEl.addEventListener('input', function () {
      textareaEl.style.height = 'auto';
      textareaEl.style.height = Math.min(textareaEl.scrollHeight, 200) + 'px';
    });
  }

  function handleSend() {
    var msg = textareaEl.value.trim();
    if (!msg) return;
    textareaEl.value = '';
    textareaEl.style.height = 'auto';
    if (onSendCallback) onSendCallback(msg);
  }

  function disable() {
    if (sendBtnEl) sendBtnEl.disabled = true;
  }

  function enable() {
    if (sendBtnEl) sendBtnEl.disabled = false;
    if (textareaEl) textareaEl.focus();
  }

  return { init, disable, enable };
})();
