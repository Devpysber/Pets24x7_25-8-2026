/* Recommendation impression/click beacon — shared by every page that renders
   reco cards (index.html, city.html, listing.html, search/index.html,
   dashboard/parent/index.html). Cards carry data-rid/data-lid/data-pos/
   data-reason/data-sp/data-surface attributes; see each page's inline reco
   script for the contract this file implements: window.recoTrack.observe(box,
   surface) wires impression tracking for a freshly-filled card container,
   window.recoTrack.click(el) reports a click. Batches events and flushes via
   sendBeacon (falls back to fetch keepalive) so a click that navigates away
   still gets delivered. */
(function () {
  var RBASE = (window.PETS_CONFIG && window.PETS_CONFIG.API_BASE) ||
    ((location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '') ? '' : 'https://api.pets24x7.com');
  var ENDPOINT = RBASE + '/api/reco/events';

  var queue = [];
  var seenImpressions = Object.create(null);
  var flushTimer = null;

  // The API rejects a non-integer pos (NaN serialises as null), which used to
  // drop the whole event as malformed.
  function posOf(v) {
    var n = Number(v);
    return (isFinite(n) && n >= 0 && n <= 100 && Math.floor(n) === n) ? n : undefined;
  }

  function eventFromEl(el, type) {
    var d = el.dataset || {};
    return {
      rid: d.rid,
      type: type,
      listingId: d.lid,
      pos: d.pos ? posOf(d.pos) : undefined,
      reason: d.reason || undefined,
      sponsored: d.sp === '1',
      surface: d.surface || undefined,
    };
  }

  function send(events) {
    if (!events.length) return;
    var payload = JSON.stringify({ events: events.slice(0, 50) });
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'text/plain' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch (e) {}
    try {
      fetch(ENDPOINT, {
        method: 'POST', credentials: 'include', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: payload,
      }).catch(function () {});
    } catch (e) {}
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      var batch = queue;
      queue = [];
      send(batch);
    }, 1200);
  }

  function queueEvent(ev) {
    if (!ev.rid || !ev.listingId) return;
    queue.push(ev);
    if (queue.length >= 20) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      var batch = queue;
      queue = [];
      send(batch);
    } else {
      scheduleFlush();
    }
  }

  var observer = (typeof IntersectionObserver !== 'undefined')
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          var d = el.dataset || {};
          var key = d.rid + ':' + d.lid;
          if (seenImpressions[key]) { observer.unobserve(el); return; }
          seenImpressions[key] = true;
          observer.unobserve(el);
          queueEvent(eventFromEl(el, 'impression'));
        });
      }, { threshold: 0.5 })
    : null;

  window.recoTrack = {
    // Wires impression tracking for every [data-lid] card inside `box`
    // (called once per freshly-rendered reco section).
    observe: function (box, surface) {
      if (!box) return;
      var cards = box.querySelectorAll('[data-lid]');
      for (var i = 0; i < cards.length; i++) {
        if (observer) {
          observer.observe(cards[i]);
        } else {
          // No IntersectionObserver support: fire on render, best-effort.
          queueEvent(eventFromEl(cards[i], 'impression'));
        }
      }
    },
    click: function (el) {
      if (!el) return;
      queueEvent(eventFromEl(el, 'click'));
      // Clicks often navigate away immediately — flush now instead of waiting.
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      var batch = queue;
      queue = [];
      send(batch);
    },
  };

  function flushNow() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!queue.length) return;
    var batch = queue;
    queue = [];
    send(batch);
  }
  // pagehide alone misses mobile tab switches; the queue is cleared so a page
  // restored from the back/forward cache does not resend the same batch.
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushNow();
  });

  // Landing attribution for links that carry their rid in the URL — the email
  // digest ("…/in/<city>/<id>/?src=reco_email_digest&rid=<rid>"), opened days
  // later in a fresh tab with no sessionStorage. Without this every digest
  // click went unrecorded. Once per rid+listing per tab; the server dedupes too.
  (function landing() {
    try {
      var q = new URLSearchParams(location.search);
      var rid = q.get('rid') || '';
      var src = q.get('src') || '';
      if (!/^[a-f0-9]{16}$/.test(rid) || !/^reco_[a-z_]{1,35}$/.test(src)) return;
      var m = /^\/(?:in|us)\/[^\/]+\/([^\/]+)\/?$/i.exec(location.pathname);
      var lid = m ? decodeURIComponent(m[1]) : (q.get('id') || '');
      if (!lid) return;
      var key = 'reco:landed:' + rid + ':' + lid;
      try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) {}
      queueEvent({ rid: rid, type: 'click', listingId: lid, surface: src.slice(5) });
      flushNow();
    } catch (e) {}
  })();
})();
