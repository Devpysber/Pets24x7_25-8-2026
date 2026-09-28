/* Show / hide password: adds an eye button inside every password field,
   including fields added later (dialogs, tabs). Self-contained, no deps. */
(function () {
  'use strict';
  var EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-6.4 0-10-7-10-7a18.5 18.5 0 0 1 5.1-5.9M9.9 5.2A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a18.6 18.6 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/></svg>';

  var css = document.createElement('style');
  css.textContent =
    '.pw-wrap{position:relative;display:block;width:100%}' +
    '.pw-wrap>input{width:100%;padding-right:46px!important;box-sizing:border-box}' +
    '.pw-eye{position:absolute;top:50%;right:6px;transform:translateY(-50%);width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;' +
    'border:0;background:transparent;color:#6B7280;border-radius:8px;cursor:pointer;padding:0;margin:0;min-height:0;box-shadow:none}' +
    '.pw-eye:hover{color:#111827;background:rgba(0,0,0,.05)}' +
    '.pw-eye:focus-visible{outline:2px solid #F97316;outline-offset:1px}' +
    '.pw-eye[aria-pressed="true"]{color:#EA580C}';
  (document.head || document.documentElement).appendChild(css);

  function enhance(input) {
    if (input.dataset.pwEye) return;
    input.dataset.pwEye = '1';
    var wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    // keep the field's own spacing on the wrapper so layout doesn't shift
    var cs = window.getComputedStyle(input);
    wrap.style.marginTop = cs.marginTop; wrap.style.marginBottom = cs.marginBottom;
    input.style.marginTop = '0'; input.style.marginBottom = '0';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Show password');
    btn.title = 'Show password';
    btn.innerHTML = EYE;
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep caret in the field
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.title = show ? 'Hide password' : 'Show password';
      btn.innerHTML = show ? EYE_OFF : EYE;
    });
    wrap.appendChild(btn);
  }

  function scan(root) {
    (root.querySelectorAll ? root : document).querySelectorAll('input[type="password"]').forEach(enhance);
  }

  // hide again before the form goes, so the browser still offers to save it
  document.addEventListener('submit', function (e) {
    e.target.querySelectorAll && e.target.querySelectorAll('.pw-eye[aria-pressed="true"]').forEach(function (b) { b.click(); });
  }, true);

  function start() {
    scan(document);
    if (window.MutationObserver) {
      new MutationObserver(function (list) {
        list.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType !== 1) return;
            if (n.matches && n.matches('input[type="password"]')) enhance(n); else scan(n);
          });
        });
      }).observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
