/**
 * Pets24x7 — toasts and modal dialogs.
 *
 * Replaces the browser's alert() and confirm(), which are jarring, unstyled,
 * block the page, and on mobile look like the browser is warning about the
 * site rather than the site talking to you.
 *
 *   toast('Saved')                      → a self-dismissing slip, bottom right
 *   toast('Could not save', 'error')    → same, red
 *   uiConfirm({ title, body, danger })  → Promise<boolean>
 *   uiAlert({ title, body })            → Promise<void>, for anything that
 *                                         needs acknowledging rather than noting
 *
 * Include with:  <script src="/ui-dialogs.js"></script>
 * Everything is namespaced on window so inline handlers can reach it.
 */
(function () {
  if (window.toast) return; // already loaded

  var STYLE = [
    '.p24-toast-wrap{position:fixed;right:18px;bottom:18px;z-index:9999;display:flex;flex-direction:column;gap:10px;max-width:min(380px,calc(100vw - 36px))}',
    '.p24-toast{display:flex;align-items:flex-start;gap:10px;background:#0F172A;color:#fff;border-radius:12px;padding:13px 15px;font:600 13.5px/1.45 Inter,system-ui,sans-serif;box-shadow:0 14px 34px rgba(2,6,23,.32);opacity:0;transform:translateY(10px);transition:opacity .22s ease,transform .22s ease}',
    '.p24-toast.in{opacity:1;transform:none}',
    '.p24-toast .ic{flex-shrink:0;font-size:15px;line-height:1.3}',
    '.p24-toast.ok{background:#065F46}',
    '.p24-toast.error{background:#991B1B}',
    '.p24-toast.warn{background:#92400E}',
    '.p24-dlg-back{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(2px);z-index:10000;display:flex;align-items:center;justify-content:center;padding:18px;opacity:0;transition:opacity .18s ease}',
    '.p24-dlg-back.in{opacity:1}',
    '.p24-dlg{background:#fff;border-radius:18px;max-width:440px;width:100%;padding:26px 24px 20px;box-shadow:0 30px 70px rgba(2,6,23,.4);font-family:Inter,system-ui,sans-serif;transform:translateY(10px) scale(.98);transition:transform .18s ease}',
    '.p24-dlg-back.in .p24-dlg{transform:none}',
    '.p24-dlg h3{font-size:18px;font-weight:800;color:#0F172A;margin:0 0 8px;letter-spacing:-.3px}',
    '.p24-dlg p{font-size:14px;line-height:1.55;color:#475569;margin:0 0 18px;white-space:pre-wrap}',
    '.p24-dlg-row{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}',
    '.p24-btn{border:none;border-radius:10px;padding:10px 18px;font:700 13.5px Inter,system-ui,sans-serif;cursor:pointer}',
    '.p24-btn-ghost{background:#fff;border:1px solid #E2E8F0;color:#334155}',
    '.p24-btn-primary{background:#2563EB;color:#fff}',
    '.p24-btn-danger{background:#DC2626;color:#fff}',
    '@media(max-width:480px){.p24-toast-wrap{right:12px;left:12px;bottom:12px}.p24-dlg-row{flex-direction:column-reverse}.p24-btn{width:100%}}'
  ].join('');

  var styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  var wrap;
  function toastWrap() {
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'p24-toast-wrap';
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  var ICONS = { ok: '✓', error: '!', warn: '!', info: 'i' };

  /** A short message that does not need acknowledging. */
  window.toast = function (message, type, ms) {
    var kind = type || 'info';
    var el = document.createElement('div');
    el.className = 'p24-toast ' + kind;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    var ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = ICONS[kind] || 'i';
    var txt = document.createElement('span');
    txt.textContent = String(message == null ? '' : message);
    el.appendChild(ic);
    el.appendChild(txt);
    toastWrap().appendChild(el);
    requestAnimationFrame(function () { el.classList.add('in'); });

    // Errors stay longer: they usually carry something worth reading.
    var life = ms || (kind === 'error' ? 6500 : 3800);
    setTimeout(function () {
      el.classList.remove('in');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, life);
    return el;
  };

  function dialog(opts) {
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'p24-dlg-back';
      var confirmLabel = opts.confirmLabel || 'Confirm';
      var cancelLabel = opts.cancelLabel || 'Cancel';

      var dlg = document.createElement('div');
      dlg.className = 'p24-dlg';
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-modal', 'true');

      var h = document.createElement('h3');
      h.textContent = opts.title || 'Are you sure?';
      var p = document.createElement('p');
      p.textContent = opts.body || '';
      var row = document.createElement('div');
      row.className = 'p24-dlg-row';

      function close(result) {
        back.classList.remove('in');
        document.removeEventListener('keydown', onKey);
        setTimeout(function () { if (back.parentNode) back.parentNode.removeChild(back); }, 200);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Enter' && opts.mode !== 'confirm') close(true);
      }

      if (opts.mode === 'confirm') {
        var cancel = document.createElement('button');
        cancel.className = 'p24-btn p24-btn-ghost';
        cancel.textContent = cancelLabel;
        cancel.onclick = function () { close(false); };
        row.appendChild(cancel);
      }
      var ok = document.createElement('button');
      ok.className = 'p24-btn ' + (opts.danger ? 'p24-btn-danger' : 'p24-btn-primary');
      ok.textContent = opts.mode === 'confirm' ? confirmLabel : (opts.confirmLabel || 'OK');
      ok.onclick = function () { close(true); };
      row.appendChild(ok);

      dlg.appendChild(h);
      if (opts.body) dlg.appendChild(p);
      dlg.appendChild(row);
      back.appendChild(dlg);
      back.addEventListener('click', function (e) { if (e.target === back) close(false); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(back);
      requestAnimationFrame(function () { back.classList.add('in'); ok.focus(); });
    });
  }

  /** Resolves true when the person confirms. Never blocks the page. */
  window.uiConfirm = function (opts) {
    return dialog(Object.assign({ mode: 'confirm' }, typeof opts === 'string' ? { body: opts } : opts));
  };

  /** For something that must be read, not merely noticed. */
  window.uiAlert = function (opts) {
    return dialog(Object.assign({ mode: 'alert', title: 'Heads up' }, typeof opts === 'string' ? { body: opts } : opts));
  };
})();
