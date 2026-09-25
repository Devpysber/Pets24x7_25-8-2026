/**
 * Shared navbar auth state for every public page.
 *  - If a "Sign in" link exists, it becomes "My Dashboard" (+ a "Sign out" link).
 *  - If the page has no sign-in link, "My Dashboard" + "Sign out" are injected
 *    into the header so the signed-in state shows on every page.
 *
 * Include:  <script src="/nav-auth.js" defer></script>
 * Works with serve.py's same-origin API proxy locally and api.pets24x7.com in prod.
 */
(function () {
  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
  var BASE = ((window.PETS_CONFIG && window.PETS_CONFIG.API_BASE) ||
    (isLocal ? '' : 'https://api.pets24x7.com')).replace(/\/+$/, '');

  var DASH = { pet_parent: '/dashboard/parent/', vendor: '/dashboard/vendor/', admin: '/dashboard/admin/' };
  var LABEL = { pet_parent: 'My Dashboard', vendor: 'My Dashboard', admin: 'Admin' };

  function signOut(e) {
    if (e) e.preventDefault();
    fetch(BASE + '/api/me/logout', { method: 'POST', credentials: 'include' })
      .catch(function () {})
      .then(function () { location.reload(); });
  }

  function loginLinks() {
    var out = [];
    var links = document.querySelectorAll('header a[href], .header a[href], nav a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var href = a.getAttribute('href') || '';
      var txt = (a.textContent || '').trim().toLowerCase();
      if (/\/(login|parent-login|vendor-login)\/?(#.*)?$/.test(href) || txt === 'sign in' || txt === 'log in' || txt === 'login') {
        out.push(a);
      }
    }
    return out;
  }

  function anchorNode() {
    // Prefer to sit next to a "For Businesses" style link.
    var links = document.querySelectorAll('header a[href], .header a[href], nav a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i], href = a.getAttribute('href') || '', txt = (a.textContent || '').trim().toLowerCase();
      if (/marketing\.html/.test(href) || txt.indexOf('for businesses') === 0 || txt.indexOf('for pet businesses') === 0) return a;
    }
    return null;
  }

  function mkLink(text, href, cls) {
    var a = document.createElement('a');
    a.textContent = text;
    a.href = href;
    // A link that borrows a page class (nav-link, …) takes that class's look,
    // so it matches its neighbours in the header and in the opened phone menu.
    if (cls) { a.className = cls; return a; }
    a.style.fontWeight = '600';
    a.style.fontSize = '14px';
    a.style.padding = '6px 10px';
    a.style.whiteSpace = 'nowrap';
    return a;
  }

  // Injected links get a 44px tap height. Zero specificity (:where) so any
  // page rule, e.g. one hiding header links on phones until the menu opens,
  // still wins; inline styles would override those.
  function addTapStyle() {
    if (document.getElementById('navAuthTapStyle')) return;
    var st = document.createElement('style');
    st.id = 'navAuthTapStyle';
    st.textContent = ':where([data-nav-dash],[data-nav-signout]){display:inline-flex;align-items:center;min-height:44px}';
    document.head.insertBefore(st, document.head.firstChild);
  }

  function applySignedIn(role) {
    addTapStyle();
    var dash = DASH[role] || '/';
    var existing = loginLinks();

    if (existing.length) {
      existing.forEach(function (a) {
        a.textContent = LABEL[role] || 'My Dashboard';
        a.setAttribute('href', dash);
        a.removeAttribute('target');
        if (a.parentNode && !a.parentNode.querySelector('[data-nav-signout]')) {
          // Not a "keep visible on phones" link: on a narrow header only the
          // dashboard link stays out; Sign out lives in the opened menu.
          var out = mkLink('Sign out', '#', (a.className || '').replace(/\b(nav-keep|essential)\b/g, '').trim());
          out.setAttribute('data-nav-signout', '1');
          out.addEventListener('click', signOut);
          a.parentNode.insertBefore(out, a.nextSibling);
        }
      });
      return;
    }

    // No sign-in link on this page — inject the signed-in controls.
    if (document.querySelector('[data-nav-dash]')) return;
    var ref = anchorNode();
    var container = ref ? ref.parentNode
      : (document.querySelector('.header-nav') || document.querySelector('.header-right') ||
         document.querySelector('.header .container') || document.querySelector('header .container') ||
         document.querySelector('header'));
    if (!container) return;
    var cls = ref ? ref.className : '';
    var d = mkLink(LABEL[role] || 'My Dashboard', dash, cls);
    d.setAttribute('data-nav-dash', '1');
    d.style.color = '#2563EB';
    var o = mkLink('Sign out', '#', cls);
    o.setAttribute('data-nav-signout', '1');
    o.style.color = '#6B7280';
    o.addEventListener('click', signOut);
    if (ref) { container.insertBefore(d, ref); container.insertBefore(o, ref); }
    else { container.appendChild(d); container.appendChild(o); }
  }

  // ---- Mobile menu ----
  // Every public header's hamburger (.nav-toggle) opens the nav it names in
  // aria-controls (or the header's own nav). One implementation, so each page
  // gets the same keyboard behaviour: Escape closes and returns focus, a tap
  // outside or on a link closes, and widening past the breakpoint resets it.
  function wireNavToggles() {
    var toggles = document.querySelectorAll('.nav-toggle');
    Array.prototype.forEach.call(toggles, function (btn) {
      if (btn.getAttribute('data-nav-wired')) return;
      btn.setAttribute('data-nav-wired', '1');
      var id = btn.getAttribute('aria-controls');
      var header = btn.closest('header') || document;
      var nav = (id && document.getElementById(id)) ||
        header.querySelector('.hdr-nav, .header-nav, .nav-links, nav');
      if (!nav) return;
      if (!nav.id) nav.id = 'siteNav' + Math.random().toString(36).slice(2, 7);
      btn.setAttribute('aria-controls', nav.id);

      function setOpen(open, focusBack) {
        nav.classList.toggle('nav-open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        if (!open && focusBack) btn.focus();
      }
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = !nav.classList.contains('nav-open');
        setOpen(open);
        if (open) {
          var first = nav.querySelector('a[href], button');
          if (first && e.detail === 0) first.focus(); // keyboard activation
        }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && nav.classList.contains('nav-open')) setOpen(false, true);
      });
      document.addEventListener('click', function (e) {
        if (!nav.classList.contains('nav-open')) return;
        // Any activated link or button inside closes the menu (so e.g. a
        // "Talk to Expert" button opening a modal does not leave it open),
        // except toggles that expand a sub-menu.
        var hit = e.target.closest && e.target.closest('a[href],button:not(.dropdown-toggle):not([aria-haspopup])');
        if (nav.contains(e.target) && !hit) return;
        setOpen(false);
      });
      // Tabbing out of the open menu closes it, so it does not stay over the page.
      // The toggle sits after the menu in some headers, so watch both.
      function onFocusOut(e) {
        if (!nav.classList.contains('nav-open')) return;
        var to = e.relatedTarget;
        if (!to || nav.contains(to) || to === btn) return;
        setOpen(false);
      }
      nav.addEventListener('focusout', onFocusOut);
      btn.addEventListener('focusout', onFocusOut);
      window.addEventListener('resize', function () {
        if (nav.classList.contains('nav-open') && getComputedStyle(btn).display === 'none') setOpen(false);
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireNavToggles);
  else wireNavToggles();

  fetch(BASE + '/api/me', { credentials: 'include', headers: { 'Accept': 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (m) { if (m && m.role) applySignedIn(m.role); })
    .catch(function () { /* offline / not signed in — leave as-is */ });
})();
