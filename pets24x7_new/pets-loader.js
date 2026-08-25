/**
 * Pets24x7.com — Optional live Google Sheets refresh layer.
 *
 * The site is fully functional with the bundled pets-data.js snapshot.
 * If you publish a Google Sheet with the same columns as pets.csv, paste
 * its published-CSV URL into CSV_URL below and the site will:
 *   1. Render instantly from the bundled snapshot (no waiting).
 *   2. Silently re-fetch the latest CSV in the background and re-render
 *      the home page + city pages when fresh data arrives.
 *
 * Setup:
 *   1. Upload pets.csv to a new Google Sheet (File > Import > Upload).
 *   2. File > Share > Publish to web > Entire document, CSV > Publish.
 *   3. Copy the published CSV URL and paste it into CSV_URL below.
 *
 * If CSV_URL is left blank, this loader does nothing — the bundled
 * pets-data.js snapshot is the source of truth.
 */
(function () {
  // Read from /config.js (single source of truth for all sheet integrations).
  var CSV_URL = (window.PETS_CONFIG && window.PETS_CONFIG.CSV_URL) || '';

  var CACHE_KEY = 'pets24x7_csv_v1';
  var CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  if (!CSV_URL) {
    // Silent bail — the bundled snapshot is fine.
    return;
  }

  // 1. Hydrate from cache instantly if fresh.
  try {
    var cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached && cached.t && (Date.now() - cached.t) < CACHE_TTL_MS && Array.isArray(cached.d) && cached.d.length > 5) {
      mergeIntoIndex(cached.d);
      dispatchUpdate();
    }
  } catch (e) {}

  // 2. Always refresh in background (cache-busted).
  var url = CSV_URL + (CSV_URL.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now();
  fetch(url, { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then(function (csv) {
      var rows = parseCSV(csv);
      if (rows.length < 5) throw new Error('CSV parse returned too few rows');
      rows = rows.filter(function (r) {
        var a = (r.active || '').toString().trim().toLowerCase();
        return !a || a === 'yes' || a === 'true' || a === '1' || a === 'y';
      });
      rows.forEach(function (r) {
        r.rating = parseFloat(r.rating) || 4.4;
        r.review_count = parseInt(r.review_count, 10) || 0;
        if (!r.city_slug && r.city) {
          r.city_slug = String(r.city).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        }
        if (!r.category_slug && r.category) {
          r.category_slug = String(r.category).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        }
        if (r.google_cid && !r.gmb_link) {
          r.gmb_link = 'https://www.google.com/maps?cid=' + r.google_cid;
        }
      });
      mergeIntoIndex(rows);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), d: rows })); } catch (e) {}
      dispatchUpdate();
      console.info('[Pets24x7] Live CSV loaded: ' + rows.length + ' rows.');
    })
    .catch(function (err) {
      console.warn('[Pets24x7] Live CSV fetch failed; keeping bundled snapshot.', err);
    });

  function mergeIntoIndex(rows) {
    // Recompute PETS_INDEX (city + count + top categories) from the live rows.
    var byCity = {};
    rows.forEach(function (r) {
      if (!r.country || !r.city_slug) return;
      var key = r.country + '|' + r.city_slug;
      if (!byCity[key]) {
        byCity[key] = { country: r.country, city: r.city, city_slug: r.city_slug, count: 0, top_rating: 0, _cats: {} };
      }
      byCity[key].count++;
      byCity[key].top_rating = Math.max(byCity[key].top_rating, r.rating || 0);
      var cs = r.category_slug || 'other';
      byCity[key]._cats[cs] = (byCity[key]._cats[cs] || 0) + 1;
    });
    var index = Object.keys(byCity).map(function (k) {
      var c = byCity[k];
      var top = Object.keys(c._cats).sort(function (a, b) { return c._cats[b] - c._cats[a]; }).slice(0, 4);
      delete c._cats;
      c.top_categories = top;
      return c;
    }).filter(function (c) { return c.count >= 5; })
      .sort(function (a, b) { return (a.country === b.country) ? b.count - a.count : a.country.localeCompare(b.country); });
    window.PETS_INDEX = index;

    // Featured: top 24 by rating with 25+ reviews
    var feat = rows.slice().filter(function (r) { return (r.review_count || 0) >= 25; })
      .sort(function (a, b) { return (b.rating || 0) - (a.rating || 0) || (b.review_count || 0) - (a.review_count || 0); })
      .slice(0, 24);
    window.PETS_FEATURED = feat;

    // City pages still load their per-city JSON file directly from /data/.
    // Stash the live row set so a page can opt to use it as an override.
    window.PETS_LIVE_ROWS = rows;
  }

  function dispatchUpdate() {
    try { window.dispatchEvent(new CustomEvent('petsUpdated')); }
    catch (e) {
      var ev = document.createEvent('Event');
      ev.initEvent('petsUpdated', true, true);
      window.dispatchEvent(ev);
    }
  }

  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    var rows = [];
    var i = 0, len = text.length, field = '', row = [], inQuotes = false;
    while (i < len) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); field = ''; row = []; i++; continue; }
      field += ch; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (rows.length < 2) return [];
    var headers = rows[0].map(function (h) { return h.trim(); });
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var rr = rows[r];
      if (rr.length === 1 && rr[0].trim() === '') continue;
      var obj = {};
      for (var c = 0; c < headers.length; c++) obj[headers[c]] = (rr[c] || '').trim();
      if (obj.id || obj.name) out.push(obj);
    }
    return out;
  }
})();
