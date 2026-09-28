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

  // ---- Listing pages: keep the enquiry form clear ----
  // The sidebar (enquiry form + owner card) is sticky on wide screens. When it
  // is taller than the window it sticks by its bottom edge instead of its top
  // (negative top), so the Send button can always be reached. The floating
  // WhatsApp pill and the phone "Enquire" bar hide while they would cover the
  // form, and come back once it scrolls away.
  function wireListingSidebar() {
    var card = document.getElementById('enquiryForm');
    if (!card) return;
    var aside = card.closest('aside');
    var pill = document.querySelector('.float-wa');
    var bar = document.querySelector('.mobile-book-bar');
    var queued = false;
    function update() {
      queued = false;
      var vh = window.innerHeight;
      if (aside) aside.style.setProperty('--aside-top', Math.min(90, vh - aside.offsetHeight - 16) + 'px');
      var r = card.getBoundingClientRect();
      var onScreen = r.top < vh && r.bottom > 0;
      if (bar) bar.classList.toggle('is-covering', onScreen);
      if (pill) {
        // The whole sidebar (form and owner card), not only the form.
        var box = aside ? aside.getBoundingClientRect() : r;
        var f = pill.getBoundingClientRect();
        pill.classList.toggle('is-covering', f.left < box.right && f.right > box.left && f.top < box.bottom && f.bottom > box.top);
      }
    }
    function queue() { if (!queued) { queued = true; requestAnimationFrame(update); } }
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    // The form grows (error / success messages, restored drafts).
    if (window.ResizeObserver && aside) new ResizeObserver(queue).observe(aside);
    update();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireListingSidebar);
  else wireListingSidebar();

  // ---- Contact lock ----
  // Phone numbers and WhatsApp buttons work only for signed-in people. For
  // everyone else, on every page that loads this file:
  //  - tel:, wa.me/<number>, api.whatsapp.com and whatsapp:// links open a
  //    "sign in to contact" box instead (share links, wa.me/?text=, stay open);
  //  - window.open() of such a link does the same (enquiry forms use it);
  //  - the WhatsApp enquiry forms (#bookForm, #leadForm) ask to sign in before
  //    sending, and what was typed is put back after signing in;
  //  - phone numbers written in the page are masked (+91 99300 •••••).
  // Until /api/me answers, the page counts as signed out; a tap made in that
  // moment waits for the answer and then goes through if signed in.
  var authRole = null, authKnown = false, authWaiters = [];
  var DRAFT_KEY = 'p24:gateDraft';
  var GATED_FORMS = { bookForm: 1, leadForm: 1 };

  function track(action, extra) {
    try {
      var body = { action: action, path: location.pathname + location.search };
      var m = /^\/(?:in|us)\/[^\/]+\/([^\/]+)\/?$/i.exec(location.pathname);
      if (m) { try { body.listingId = decodeURIComponent(m[1]); } catch (e) {} }
      if (extra) for (var k in extra) body[k] = extra[k];
      fetch(BASE + '/api/activity/track', {
        method: 'POST', credentials: 'include', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }).catch(function () {});
    } catch (e) {}
  }

  function contactKind(href) {
    href = String(href || '').trim();
    if (/^tel:/i.test(href)) return 'phone';
    if (/^whatsapp:/i.test(href)) return 'whatsapp';
    if (/^(https?:)?\/\/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\//i.test(href)) {
      // wa.me/?text=… (no number) only shares a link — not a contact.
      if (/wa\.me\/\d/i.test(href) || /[?&]phone=\d/i.test(href)) return 'whatsapp';
    }
    return null;
  }

  function whenAuthKnown(fn) { if (authKnown) fn(); else authWaiters.push(fn); }

  // ---- Plan allowance (signed-in pet parents) ----
  // Each membership includes a number of contacts a month (free accounts a
  // few, Gold unlimited); /api/access/contact says how many are left and which
  // listings are already unlocked this month (free to contact again). Other
  // roles are never limited. If the allowance cannot be read the tap goes
  // through: enquiries are still enforced by the API.
  var quota = null, quotaKnown = false, quotaWaiters = [];
  function whenQuotaKnown(fn) { if (quotaKnown) fn(); else quotaWaiters.push(fn); }
  function settleQuota(q) {
    quota = q; quotaKnown = true;
    var ws = quotaWaiters; quotaWaiters = [];
    ws.forEach(function (fn) { try { fn(); } catch (e) {} });
  }
  function loadQuota() {
    fetch(BASE + '/api/access/contact', { credentials: 'include', headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { settleQuota(d && d.quota ? d.quota : null); })
      .catch(function () { settleQuota(null); });
  }
  function contactTarget() {
    var m = /^\/(?:in|us)\/[^\/]+\/([^\/]+)\/?$/i.exec(location.pathname);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) {} }
    return 'site';
  }
  function allowedByPlan() {
    if (!quota || quota.unlimited) return true;
    return quota.unlocked.indexOf(contactTarget()) !== -1 || quota.remaining > 0;
  }
  // 'ok' | 'signin' | 'upgrade', or null while still finding out.
  function syncDecision() {
    if (!authKnown) return null;
    if (!authRole) return 'signin';
    if (authRole !== 'pet_parent') return 'ok';
    if (!quotaKnown) return null;
    return allowedByPlan() ? 'ok' : 'upgrade';
  }
  function asyncDecision(cb) {
    whenAuthKnown(function () {
      if (!authRole) return cb('signin');
      if (authRole !== 'pet_parent') return cb('ok');
      whenQuotaKnown(function () { cb(allowedByPlan() ? 'ok' : 'upgrade'); });
    });
  }
  // Records the unlock (once per listing a month) and says what is left.
  function spendContact(kind) {
    if (authRole !== 'pet_parent' || !quota || quota.unlimited) return;
    var target = contactTarget();
    if (quota.unlocked.indexOf(target) !== -1) return;
    quota.unlocked.push(target);
    quota.used += 1;
    quota.remaining = Math.max(0, quota.remaining - 1);
    try {
      fetch(BASE + '/api/access/contact', {
        method: 'POST', credentials: 'include', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: target, kind: kind === 'form' ? 'enquiry' : kind, path: location.pathname })
      }).catch(function () {});
    } catch (e) {}
    toast(quota.remaining === 0
      ? 'That was your last contact included this month.'
      : quota.remaining + ' of ' + quota.limit + ' contacts left this month on your plan.');
  }
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483001;background:#111827;color:#fff;padding:10px 16px;border-radius:10px;font:500 14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:calc(100% - 32px);text-align:center';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 4000);
  }

  function nextUrl() { return location.pathname + location.search + location.hash; }

  var gateBox = null;
  function showGate(kind, mode) {
    var upgrade = mode === 'upgrade';
    track(upgrade ? 'plan_limit' : 'contact_locked', { target: kind });
    if (!gateBox) {
      var st = document.createElement('style');
      st.textContent =
        '.p24-gate{position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px}' +
        '.p24-gate[hidden]{display:none}' +
        '.p24-gate-card{background:#fff;color:#111827;border-radius:14px;max-width:380px;width:100%;padding:24px 22px 20px;box-shadow:0 20px 50px rgba(0,0,0,.25);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center}' +
        '.p24-gate-card h2{font-size:19px;margin:6px 0 6px;line-height:1.3}' +
        '.p24-gate-card p{margin:0 0 18px;color:#4B5563}' +
        '.p24-gate-card a,.p24-gate-card button{display:flex;align-items:center;justify-content:center;min-height:46px;width:100%;box-sizing:border-box;border-radius:10px;font:600 15px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-decoration:none;cursor:pointer;margin-top:10px}' +
        '.p24-gate-go{background:#2563EB;color:#fff;border:0}' +
        '.p24-gate-biz{background:#fff;color:#1F2937;border:1px solid #D1D5DB}' +
        '.p24-gate-x{background:none;border:0;color:#6B7280;font-weight:500!important}' +
        '.p24-gate-lock{font-size:30px;line-height:1}' +
        '.p24-gate-card [hidden]{display:none}';
      document.head.appendChild(st);
      gateBox = document.createElement('div');
      gateBox.className = 'p24-gate';
      gateBox.setAttribute('role', 'dialog');
      gateBox.setAttribute('aria-modal', 'true');
      gateBox.setAttribute('aria-labelledby', 'p24GateTitle');
      gateBox.innerHTML =
        '<div class="p24-gate-card">' +
          '<div class="p24-gate-lock" aria-hidden="true">🔒</div>' +
          '<h2 id="p24GateTitle">Sign in to contact</h2>' +
          '<p id="p24GateText">Phone numbers and WhatsApp are available to signed-in members. It is free and takes under a minute.</p>' +
          '<a class="p24-gate-go" data-gate-go href="#">Sign in / Create free account</a>' +
          '<a class="p24-gate-biz" data-gate-biz href="#">I run a pet business</a>' +
          '<button type="button" class="p24-gate-x" data-gate-close>Not now</button>' +
        '</div>';
      document.body.appendChild(gateBox);
      gateBox.addEventListener('click', function (e) {
        if (e.target === gateBox || (e.target.closest && e.target.closest('[data-gate-close]'))) hideGate();
      });
      gateBox.querySelector('[data-gate-go]').addEventListener('click', function () { track('gate_sign_in', { target: 'parent' }); });
      gateBox.querySelector('[data-gate-biz]').addEventListener('click', function () { track('gate_sign_in', { target: 'vendor' }); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && gateBox && !gateBox.hidden) hideGate(); });
    }
    var next = encodeURIComponent(nextUrl());
    var go = gateBox.querySelector('[data-gate-go]');
    var biz = gateBox.querySelector('[data-gate-biz]');
    if (upgrade) {
      var plan = quota && quota.tier && quota.tier !== 'FREE'
        ? quota.tier.charAt(0) + quota.tier.slice(1).toLowerCase() + ' membership' : 'free account';
      gateBox.querySelector('#p24GateTitle').textContent = 'This month’s contacts are used up';
      gateBox.querySelector('#p24GateText').textContent =
        'Your ' + plan + ' includes ' + (quota ? quota.limit : '') + ' contacts a month (calls, WhatsApp and enquiries), and you have used them all. ' +
        'Upgrade your membership to keep contacting businesses now, or wait until the 1st.' +
        (kind === 'form' ? ' What you typed is kept.' : '');
      go.textContent = 'See membership plans';
      go.setAttribute('href', '/membership/?next=' + next + '&utm_source=contact_limit');
      biz.hidden = true;
    } else {
      gateBox.querySelector('#p24GateTitle').textContent = 'Sign in to contact';
      gateBox.querySelector('#p24GateText').textContent = kind === 'form'
        ? 'Sign in to send this enquiry on WhatsApp. It is free and takes under a minute — what you typed is kept.'
        : 'Phone numbers and WhatsApp are available to signed-in members. It is free and takes under a minute.';
      go.textContent = 'Sign in / Create free account';
      go.setAttribute('href', '/parent-login/?next=' + next);
      biz.setAttribute('href', '/vendor-login/?next=' + next);
      biz.hidden = false;
    }
    gateBox.hidden = false;
    gateBox.querySelector('[data-gate-go]').focus();
  }
  function hideGate() { if (gateBox) gateBox.hidden = true; }

  function openContact(href, target) {
    if (/^tel:|^whatsapp:/i.test(href) || target !== '_blank') { location.href = href; return; }
    var w = realOpen ? realOpen.call(window, href, '_blank', 'noopener') : null;
    if (!w) location.href = href; // popup blocked after the wait
  }

  // Capture on window: runs before any page's own click handlers, so a
  // blocked tap is not also counted as a phone/WhatsApp tap on the listing.
  window.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var kind = contactKind(href);
    if (!kind) return;
    var d = syncDecision();
    if (d === 'ok') { spendContact(kind); track(kind === 'phone' ? 'phone_click' : 'whatsapp_click'); return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (d) { showGate(kind, d); return; }
    var tgt = a.getAttribute('target');
    asyncDecision(function (r) {
      if (r === 'ok') { spendContact(kind); track(kind === 'phone' ? 'phone_click' : 'whatsapp_click'); openContact(href, tgt); }
      else showGate(kind, r);
    });
  }, true);

  // Inside the Pets24x7 Android app a WebView opens no new windows, so a link
  // meant for a new tab (WhatsApp, a payment page) is followed in place; the
  // app hands WhatsApp / phone / UPI links to their own apps.
  var IN_APP = /Pets24x7App/.test(navigator.userAgent);
  var realOpen = IN_APP
    ? function (u) { if (u) location.href = String(u); return window; }
    : window.open;
  // (window.open itself is wrapped below and falls through to realOpen.)
  window.open = function (url) {
    var kind = contactKind(url);
    if (!kind) return realOpen.apply(window, arguments);
    var d = syncDecision();
    // An enquiry form spends its contact on submit; the WhatsApp it opens next
    // is the same contact, so nothing more is spent.
    if (d === 'ok') { spendContact(kind); return realOpen.apply(window, arguments); }
    if (d) { showGate(kind, d); return null; }
    asyncDecision(function (r) {
      if (r === 'ok') { spendContact(kind); openContact(String(url), '_blank'); }
      else showGate(kind, r);
    });
    return null;
  };

  function saveDraft(form) {
    try {
      var vals = {};
      Array.prototype.forEach.call(form.elements, function (el) {
        var key = el.id || el.name;
        if (!key || el.type === 'password' || el.type === 'file' || el.type === 'submit' || el.type === 'button') return;
        vals[key] = (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? '1' : '') : el.value;
      });
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ path: location.pathname, form: form.id, vals: vals }));
    } catch (e) {}
  }
  function restoreDraft() {
    try {
      var d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
      if (!d || d.path !== location.pathname) return;
      var form = document.getElementById(d.form);
      if (!form) return;
      sessionStorage.removeItem(DRAFT_KEY);
      Array.prototype.forEach.call(form.elements, function (el) {
        var key = el.id || el.name;
        if (!key || !(key in d.vals)) return;
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!d.vals[key];
        else el.value = d.vals[key];
      });
      form.scrollIntoView({ block: 'center' });
    } catch (e) {}
  }

  window.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !GATED_FORMS[form.id]) return;
    // The For Businesses lead form is a business writing to Pets24x7: it needs
    // a sign-in, never a pet parent's contact allowance.
    var biz = form.id === 'leadForm';
    var d = syncDecision();
    if (d === 'ok' || (biz && d === 'upgrade')) {
      if (!biz) spendContact('form');
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    saveDraft(form);
    if (d) { showGate('form', d); return; }
    asyncDecision(function (r) {
      if (r !== 'ok' && !(biz && r === 'upgrade')) { showGate('form', r); return; }
      try { sessionStorage.removeItem(DRAFT_KEY); } catch (err) {}
      if (form.requestSubmit) form.requestSubmit(); else if (form.onsubmit) form.onsubmit();
    });
  }, true);

  // Phone numbers in the page text: 10+ digits, optionally with +, spaces,
  // dashes, dots or brackets. Prices (commas), pincodes (6 digits) and years
  // do not match. The last five digits are masked; originals are kept so
  // signing in (or the answer to /api/me) puts them back.
  var PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
  var masked = [];
  var maskObserver = null;
  // "+91 99300 90487" -> "+91 99300 •••••": the last five digits go.
  function maskPhoneNumber(s) {
    var n = s.replace(/\D/g, '').length, seen = 0;
    return s.replace(/\d/g, function (d) { seen++; return seen > n - 5 ? '•' : d; });
  }
  function maskNode(root) {
    if (!root || authRole) return;
    if (root.nodeType === 3) { maskOne(root); return; }
    if (root.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|SELECT|OPTION|CODE)$/.test(root.nodeName)) return;
    if (root.isContentEditable) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION|CODE)$/.test(p.nodeName)) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('form, [contenteditable], .p24-gate')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var list = [], n;
    while ((n = w.nextNode())) list.push(n);
    list.forEach(maskOne);
  }
  function maskOne(node) {
    var t = node.nodeValue;
    if (!t || t.length < 10 || !/\d{3}/.test(t)) return;
    var changed = false;
    var out = t.replace(PHONE_RE, function (m) {
      var digits = m.replace(/\D/g, '').length;
      if (digits < 10 || digits > 13) return m;
      changed = true;
      return maskPhoneNumber(m);
    });
    if (changed) { masked.push([node, t]); node.nodeValue = out; }
  }
  function startMasking() {
    if (authRole || !document.body) return;
    maskNode(document.body);
    if (window.MutationObserver && !maskObserver) {
      maskObserver = new MutationObserver(function (muts) {
        if (authRole) return;
        muts.forEach(function (mu) {
          if (mu.type === 'characterData') maskOne(mu.target);
          else Array.prototype.forEach.call(mu.addedNodes, maskNode);
        });
      });
      maskObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }
  function unmaskAll() {
    if (maskObserver) { maskObserver.disconnect(); maskObserver = null; }
    masked.forEach(function (p) { if (p[0].isConnected !== false) p[0].nodeValue = p[1]; });
    masked = [];
    // Pages ship our own number pre-masked (<span data-p24-phone="…">), so it
    // never flashes before this script runs.
    revealPhones(document);
    // …including ones a page script renders later (listing.html builds its card after load).
    if (window.MutationObserver && document.body) {
      new MutationObserver(function (muts) {
        muts.forEach(function (mu) {
          Array.prototype.forEach.call(mu.addedNodes, function (n) { if (n.nodeType === 1) revealPhones(n); });
        });
      }).observe(document.body, { childList: true, subtree: true });
    }
  }
  function revealPhones(root) {
    if (root.matches && root.matches('[data-p24-phone]')) root.textContent = root.getAttribute('data-p24-phone');
    Array.prototype.forEach.call(root.querySelectorAll('[data-p24-phone]'), function (el) {
      el.textContent = el.getAttribute('data-p24-phone');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startMasking);
  else startMasking();

  function settleAuth(role) {
    authRole = role || null;
    authKnown = true;
    if (authRole) {
      if (authRole === 'pet_parent') loadQuota(); else settleQuota(null);
      unmaskAll();
      hideGate();
      track('page_view', { title: (document.title || '').slice(0, 200) });
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restoreDraft);
      else restoreDraft();
    }
    var ws = authWaiters; authWaiters = [];
    ws.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  fetch(BASE + '/api/me', { credentials: 'include', headers: { 'Accept': 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (m) {
      settleAuth(m && m.role);
      if (m && m.role) applySignedIn(m.role);
    })
    .catch(function () { settleAuth(null); /* offline / not signed in — stays locked */ });
})();
