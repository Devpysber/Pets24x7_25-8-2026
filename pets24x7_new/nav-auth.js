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
    if (cls) a.className = cls;
    a.style.fontWeight = '600';
    a.style.fontSize = '14px';
    a.style.padding = '6px 10px';
    a.style.whiteSpace = 'nowrap';
    return a;
  }

  function applySignedIn(role) {
    var dash = DASH[role] || '/';
    var existing = loginLinks();

    if (existing.length) {
      existing.forEach(function (a) {
        a.textContent = LABEL[role] || 'My Dashboard';
        a.setAttribute('href', dash);
        a.removeAttribute('target');
        if (a.parentNode && !a.parentNode.querySelector('[data-nav-signout]')) {
          var out = mkLink('Sign out', '#', a.className);
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

  fetch(BASE + '/api/me', { credentials: 'include', headers: { 'Accept': 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (m) { if (m && m.role) applySignedIn(m.role); })
    .catch(function () { /* offline / not signed in — leave as-is */ });
})();
