/* A business's live deals on its listing page. The page carries an empty
   <section id="p24deals" hidden> and calls loadListingDeals(listingId); the
   section stays hidden when the business has no live offer. No deps. */
(function () {
  'use strict';

  function esc(x) {
    return (x == null ? '' : String(x)).replace(/[<>&"']/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var css = document.createElement('style');
  css.textContent =
    '#p24deals .dl-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-top:10px}' +
    '#p24deals .dl-card{border:1px dashed #FDBA74;background:#FFFBF5;border-radius:12px;padding:14px 16px}' +
    '#p24deals .dl-badge{display:inline-block;background:#EA580C;color:#fff;font-weight:800;font-size:12px;letter-spacing:.3px;padding:3px 9px;border-radius:6px}' +
    '#p24deals .dl-title{font-weight:700;font-size:15px;margin:8px 0 4px;color:var(--text,#0F172A)}' +
    '#p24deals .dl-desc{font-size:13.5px;line-height:1.5;color:var(--text-muted,#475569);margin:0}' +
    '#p24deals .dl-foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-top:10px;font-size:12px;color:var(--text-muted,#64748B)}' +
    '#p24deals .dl-code{border:1px solid #CBD5E1;background:#fff;border-radius:6px;padding:3px 8px;font-family:ui-monospace,Menlo,monospace;font-weight:700;color:#0F172A;cursor:pointer;font-size:12px}' +
    '#p24deals .dl-code:hover{border-color:#EA580C}';
  (document.head || document.documentElement).appendChild(css);

  function apiBase() {
    return (window.PETS_CONFIG && window.PETS_CONFIG.API_BASE) ||
      ((location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '') ? '' : 'https://api.pets24x7.com');
  }

  function fmt(d) {
    var t = new Date(d);
    return isNaN(t.getTime()) ? '' : t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function render(box, deals) {
    if (!deals.length) { box.hidden = true; return; }
    box.innerHTML = '<h2>Deals &amp; offers</h2>' +
      '<p style="font-size:13px;color:var(--text-muted);margin:2px 0 0;">Mention Pets24x7 when you book or enquire.</p>' +
      '<div class="dl-list">' + deals.map(function (d) {
        return '<div class="dl-card">' +
          '<span class="dl-badge">' + esc(d.offerLabel) + '</span>' +
          '<div class="dl-title">' + esc(d.title) + '</div>' +
          '<p class="dl-desc">' + esc(d.description) + '</p>' +
          '<div class="dl-foot">' +
            '<span>' + (d.endsAt ? 'Valid till ' + esc(fmt(d.endsAt)) : 'Ongoing offer') + '</span>' +
            (d.code ? '<button type="button" class="dl-code" data-code="' + esc(d.code) + '" title="Copy code">' + esc(d.code) + ' ⧉</button>' : '') +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
    box.hidden = false;
    box.querySelectorAll('[data-code]').forEach(function (b) {
      b.addEventListener('click', function () {
        var code = b.getAttribute('data-code');
        var done = function () { b.textContent = 'Copied ✓'; setTimeout(function () { b.textContent = code + ' ⧉'; }, 1500); };
        try { navigator.clipboard.writeText(code).then(done, function () {}); } catch (e) {}
      });
    });
  }

  window.loadListingDeals = function (listingId) {
    var box = document.getElementById('p24deals');
    if (!box || !listingId) return;
    fetch(apiBase() + '/api/deals?listingId=' + encodeURIComponent(listingId) + '&limit=10', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { render(box, (d && d.deals) || []); })
      .catch(function () { box.hidden = true; });
  };
})();
