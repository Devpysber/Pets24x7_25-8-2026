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

  // v2: v1 caches hold rows with the old invented 4.4 default rating.
  var CACHE_KEY = 'pets24x7_csv_v2';
  var BAD_KEY = 'pets24x7_csv_bad';
  var CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  var BAD_TTL_MS = 24 * 60 * 60 * 1000;
  // The columns this loader reads (same as pets.csv from build_data.py).
  var REQUIRED = ['id', 'name', 'city', 'country'];

  if (!CSV_URL) {
    // Silent bail — the bundled snapshot is fine.
    return;
  }

  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // A sheet with other columns (a different export was pasted in) parses to
  // nothing, and it used to be downloaded in full — several MB, uncached — on
  // every page view anyway. Remember it for a day so a visitor pays once.
  var bad = lsGet(BAD_KEY);
  if (bad && bad.u === CSV_URL && (Date.now() - bad.t) < BAD_TTL_MS) return;

  // 1. Hydrate from cache instantly if fresh. A fresh cache is the data, so
  //    there is no second download of the same sheet on every page.
  var cached = lsGet(CACHE_KEY);
  if (cached && cached.u === CSV_URL && cached.t && (Date.now() - cached.t) < CACHE_TTL_MS &&
      Array.isArray(cached.d) && cached.d.length > 5) {
    mergeIntoIndex(cached.d);
    dispatchUpdate();
    return;
  }

  function hasRequired(headerLine) {
    var cols = headerLine.replace(/^\uFEFF/, '').split(',').map(function (h) {
      return h.replace(/^"|"$/g, '').trim().toLowerCase();
    });
    return REQUIRED.every(function (c) { return cols.indexOf(c) !== -1; });
  }
  function markBad() {
    lsSet(BAD_KEY, { u: CSV_URL, t: Date.now() });
    console.warn('[Pets24x7] CSV_URL in /config.js does not have the pets.csv columns (' +
      REQUIRED.join(', ') + '); keeping the bundled snapshot.');
  }

  // Read the header row off the stream first and stop there when the columns
  // are wrong, rather than pulling the whole file to find out.
  function readCsv(r) {
    if (!r.body || !r.body.getReader || !window.TextDecoder) return r.text();
    var reader = r.body.getReader(), dec = new TextDecoder(), text = '', checked = false;
    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) { text += dec.decode(); return text; }
        text += dec.decode(chunk.value, { stream: true });
        if (!checked) {
          var nl = text.indexOf('\n');
          if (nl !== -1 || text.length > 65536) {
            checked = true;
            if (!hasRequired(nl === -1 ? text : text.slice(0, nl))) {
              try { reader.cancel(); } catch (e) {}
              throw new Error('schema');
            }
          }
        }
        return pump();
      });
    }
    return pump();
  }

  // 2. Refresh in the background.
  var url = CSV_URL + (CSV_URL.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now();
  fetch(url, { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return readCsv(r); })
    .then(function (csv) {
      var nl = csv.indexOf('\n');
      if (!hasRequired(nl === -1 ? csv : csv.slice(0, nl))) throw new Error('schema');
      var rows = parseCSV(csv);
      if (rows.length < 5) throw new Error('CSV parse returned too few rows');
      rows = rows.filter(function (r) {
        var a = (r.active || '').toString().trim().toLowerCase();
        return !a || a === 'yes' || a === 'true' || a === '1' || a === 'y';
      });
      var seenCid = {};
      rows = rows.filter(function (r) {
        // Same guards as build_pages.py: a CID mangled by a spreadsheet
        // ("6.47E+18") is a dead Maps link, and one business is listed once.
        // The invented count check (below) needs the CID as the sheet had it:
        // old builds summed the digits of a mangled one too.
        r._synthetic = !!r.google_cid && (parseInt(r.review_count, 10) || 0) === syntheticCount(r.google_cid);
        if (r.google_cid && !/^\d+$/.test(r.google_cid)) { r.google_cid = ''; r.gmb_link = ''; }
        if (r.google_cid) {
          if (seenCid[r.google_cid]) return false;
          seenCid[r.google_cid] = 1;
        }
        return true;
      });
      rows.forEach(function (r) {
        // Unknown stays unknown (rating null, count 0), as in build_data.py.
        // A sheet imported from an older pets.csv still carries the invented
        // count that build derived from the CID (and the 4.4 it paired with
        // it); recognise that exact value and drop it, like
        // scripts/strip_synthetic_ratings.py does for data/*.json.
        r.rating = parseFloat(r.rating) || null;
        r.review_count = parseInt(r.review_count, 10) || 0;
        if (r._synthetic) {
          r.review_count = 0;
          if (r.rating === 4.4) r.rating = null;
        }
        delete r._synthetic;
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
      lsSet(CACHE_KEY, { u: CSV_URL, t: Date.now(), d: rows });
      dispatchUpdate();
      console.info('[Pets24x7] Live CSV loaded: ' + rows.length + ' rows.');
    })
    .catch(function (err) {
      if (err && err.message === 'schema') return markBad();
      console.warn('[Pets24x7] Live CSV fetch failed; keeping bundled snapshot.', err);
    });

  function syntheticCount(cid) {
    var seed = 0;
    String(cid).replace(/\d/g, function (d) { seed += +d; return d; });
    return 18 + ((seed || 31) * 7919) % 462;
  }

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
      // Small cities stay in (search links to them); they are flagged thin, as
      // build_data.py does, and the count sort keeps them off the home page.
      c.thin = c.count < 5;
      return c;
    }).sort(function (a, b) { return (a.country === b.country) ? b.count - a.count : a.country.localeCompare(b.country); });
    window.PETS_INDEX = index;

    // Featured: top 24 by rating, 25+ reviews first (same order as
    // build_data.py; with no counts in the sheet the source score orders them).
    var many = function (r) { return (r.review_count || 0) >= 25 ? 1 : 0; };
    var feat = rows.slice().filter(function (r) { return r.rating; })
      .sort(function (a, b) { return many(b) - many(a) || (b.rating || 0) - (a.rating || 0) || (b.review_count || 0) - (a.review_count || 0); })
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
