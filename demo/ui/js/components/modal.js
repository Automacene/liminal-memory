/**
 * Modal Component — generic open/close controller for all modals.
 */
var Modal = (function () {
  var modalNames = ['confirm', 'search', 'inspect', 'status'];

  function init() {
    modalNames.forEach(function (name) {
      var closeBtn = document.getElementById('modal-' + name + '-close');
      var backdrop = document.getElementById('modal-' + name + '-backdrop');
      if (closeBtn) closeBtn.addEventListener('click', function () { close(name); });
      if (backdrop) backdrop.addEventListener('click', function () { close(name); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll();
    });
  }

  function open(name) {
    var backdrop = document.getElementById('modal-' + name + '-backdrop');
    var modal = document.getElementById('modal-' + name);
    if (backdrop) backdrop.classList.add('open');
    if (modal) modal.classList.add('open');
  }

  function close(name) {
    var backdrop = document.getElementById('modal-' + name + '-backdrop');
    var modal = document.getElementById('modal-' + name);
    if (backdrop) backdrop.classList.remove('open');
    if (modal) modal.classList.remove('open');
  }

  function closeAll() {
    modalNames.forEach(function (name) { close(name); });
  }

  return { init, open, close, closeAll };
})();
