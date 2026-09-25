/**
 * Pets24x7 — Google Analytics 4, plus optional ad pixels.
 *
 * One file so the measurement IDs live in a single place. Loaded by every
 * page after /config.js, which can override or switch on:
 *
 *   window.PETS_CONFIG.GA_ID = 'G-XXXXXXX';
 *   window.PETS_CONFIG.META_PIXEL_ID = '1234567890';          (empty = off)
 *   window.PETS_CONFIG.GOOGLE_ADS_ID = 'AW-123456789';        (empty = off)
 *   window.PETS_CONFIG.GOOGLE_ADS_CONVERSION_LABELS = { purchase: 'abc', generate_lead: 'def' };
 *   window.PETS_CONFIG.LEAD_VALUE = 150;                        (0 = leads carry no value)
 *
 * Pages call one function, trackEvent(name, params), with GA4 event names;
 * it fans out to every tool that is switched on here.
 *
 * Three deliberate decisions:
 *
 *   Local and preview hosts are not tracked. Development traffic in the same
 *   property as real traffic makes every number a guess, and you cannot take
 *   it out again afterwards.
 *
 *   The signed-in dashboards are not tracked. Those are you and your team;
 *   counting staff clicks as engagement inflates exactly the figures you would
 *   use to make a decision.
 *
 *   Review links carry a one-time code in the path. That code is sent to a
 *   customer by email and is enough to leave a review as them, so the path is
 *   normalised before it reaches Google rather than stored in a report.
 *
 * Consent: there is no cookie banner. Google Consent Mode v2 defaults to
 * granted, except denied for visitors in the EEA/UK/Switzerland (where a
 * banner would be required first) and for any browser sending Global Privacy
 * Control. The Meta Pixel follows the ad setting, and stays off by default
 * for a European time zone (Meta has no region-scoped default). The pixel
 * starts on the next page after a later opt-in. window.p24Consent({ analytics: bool, ads: bool }) records a choice
 * on this browser (the privacy page has the switch); a stored choice wins
 * over the defaults on every later page.
 */
(function () {
  var CFG = window.PETS_CONFIG || {};
  var GA_ID = CFG.GA_ID || 'G-FC5WRMCXYG';
  // Malformed ids are ignored rather than loaded: a typo in config.js must not
  // send a script request to a nonsense URL on every page.
  var META_ID = /^\d{5,20}$/.test(String(CFG.META_PIXEL_ID || '')) ? String(CFG.META_PIXEL_ID) : '';
  var ADS_ID = /^AW-\d+$/.test(String(CFG.GOOGLE_ADS_ID || '')) ? String(CFG.GOOGLE_ADS_ID) : '';
  var ADS_LABELS = (ADS_ID && CFG.GOOGLE_ADS_CONVERSION_LABELS) || {};
  // Optional value for a lead, so Ads and Meta can bid on it. Applied to any
  // generate_lead that does not set its own value.
  var LEAD_VALUE = Math.max(0, Number(CFG.LEAD_VALUE) || 0);
  var LEAD_CURRENCY = /^[A-Z]{3}$/.test(String(CFG.LEAD_CURRENCY || '')) ? String(CFG.LEAD_CURRENCY) : 'INR';

  // Always defined, so a page can call trackEvent() without first checking
  // whether tracking is on here. Replaced below when GA actually loads.
  if (!window.trackEvent) window.trackEvent = function () {};

  // The stored choice, if the visitor made one: { analytics: bool, ads: bool }.
  var CONSENT_KEY = 'p24:consent';
  function readChoice() {
    try { var v = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null'); return v && typeof v === 'object' ? v : null; }
    catch (e) { return null; }
  }
  // Defined before the host checks so the privacy page's switch works (and
  // is remembered) even where nothing loads, e.g. on a preview deploy.
  window.p24Consent = function (choice) {
    var c = { analytics: !!(choice && choice.analytics), ads: !!(choice && choice.ads) };
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify(c)); } catch (e) {}
    if (window.gtag) {
      window.gtag('consent', 'update', {
        analytics_storage: c.analytics ? 'granted' : 'denied',
        ad_storage: c.ads ? 'granted' : 'denied',
        ad_user_data: c.ads ? 'granted' : 'denied',
        ad_personalization: c.ads ? 'granted' : 'denied'
      });
    }
    if (window.fbq) window.fbq('consent', c.ads ? 'grant' : 'revoke');
    return c;
  };
  window.p24Consent.current = readChoice;

  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '' ||
                host.indexOf('192.168.') === 0 || host.slice(-6) === '.local';
  // Deploy previews (Netlify, Vercel, Cloudflare Pages, Hostinger's temporary
  // domain) are the same code under a throwaway host: not real visitors.
  var isPreview = /\.(netlify\.app|vercel\.app|pages\.dev|hostingersite\.com)$/.test(host);
  if (isLocal || isPreview) return;

  // The portals behind a login are internal tooling, not the marketplace.
  var path = location.pathname;
  if (path.indexOf('/dashboard/') === 0 ||
      path.indexOf('/admin-login') === 0 ||
      path.indexOf('/admin/') === 0) return;

  // Strip the single-use review code out of the path, and out of the referrer
  // chain for the pages that follow it.
  // /review/expired/ (and the step pages opened by their real path) are
  // static pages, not codes, and stay as they are.
  function scrub(p) {
    if (/^\/review\/(expired|form|thanks)(\/|$)/.test(p)) return p;
    return p
      .replace(/^\/review\/[^/]+(\/.*)?$/, function (_m, rest) { return '/review/:code' + (rest || ''); })
      .replace(/^\/r\/[^/]+\/?$/, '/r/:code');
  }
  var cleanPath = scrub(path);

  // Google's terms forbid sending personal data, and a search box is where
  // people type phone numbers and email addresses (find-my-listing, search).
  // Anything that looks like either is blanked out before it leaves the page.
  // Only free-text fields get the phone check: ids such as a listing slug or
  // a gclid legitimately carry long digit runs.
  var FREE_TEXT = { q: 1, city: 1, cat: 1, category: 1, search_term: 1 };
  function redact(v, key) {
    if (typeof v !== 'string') return v;
    v = v.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]');
    return FREE_TEXT[key] ? v.replace(/\+?\d[\d\s().-]{6,}\d/g, '[phone]') : v;
  }
  // Event params, one level of nesting deep: GA4 ecommerce `items` is an
  // array of objects, and an item name is free text like any other.
  function cleanParams(params) {
    var out = {};
    for (var k in (params || {})) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      var v = params[k];
      if (Object.prototype.toString.call(v) === '[object Array]') {
        out[k] = v.map(function (it) {
          if (!it || typeof it !== 'object') return redact(it, k);
          var o = {};
          for (var j in it) if (Object.prototype.hasOwnProperty.call(it, j)) o[j] = redact(it[j], j);
          return o;
        });
      } else {
        out[k] = redact(v, k);
      }
    }
    return out;
  }

  // Tells us whether the raw URL can go to a tool that reads location itself
  // (the Meta Pixel sends document.location as is; it has no page_location
  // override). False when scrubbing or redaction changed anything, or the
  // query carries a key we do not keep (a reset token, a ?next= target).
  var urlIsClean = cleanPath === path;

  // txn is the membership return page's payment reference: not personal,
  // not useful in GA reports, and dropping it would keep the Purchase event
  // (which only fires on that page) from ever reaching Meta.
  var HARMLESS = ['q', 'city', 'cat', 'category', 'country', 'page',
                  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
                  'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'txn'];
  function queryIsClean(search) {
    var clean = true;
    new URLSearchParams(search || '').forEach(function (v, k) {
      if (HARMLESS.indexOf(k) === -1 || redact(v, k) !== v) clean = false;
    });
    return clean;
  }

  var cleanSearch = '';
  if (location.search) {
    // Campaign parameters must survive: GA4 reads source/medium/campaign and
    // ad-click ids from page_location, so dropping them here would file every
    // paid or emailed visit under "direct".
    var keep = ['q', 'city', 'cat', 'category', 'country', 'page',
                'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
                'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid'];
    var params = new URLSearchParams(location.search);
    var out = new URLSearchParams();
    keep.forEach(function (k) { if (params.get(k)) out.set(k, redact(params.get(k), k)); });
    if (!queryIsClean(location.search)) urlIsClean = false;
    var qs = out.toString();
    if (qs) cleanSearch = '?' + qs;
  }

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  // ---- Consent (must be queued before any config) ----
  var choice = readChoice();
  // Global Privacy Control is a legally recognised opt-out of ad sharing in
  // several US states; honour it for the ad tools, keep aggregate analytics.
  var gpc = navigator.globalPrivacyControl === true;
  var adsOk = choice ? !!choice.ads : !gpc;
  var analyticsOk = choice ? !!choice.analytics : true;
  // Visitors in the EEA, UK and Switzerland need opt-in consent, which a site
  // without a banner never gets: Google holds their storage until it does.
  // Region-scoped defaults are resolved by Google from the visitor's IP.
  if (!choice) {
    gtag('consent', 'default', {
      analytics_storage: 'denied', ad_storage: 'denied',
      ad_user_data: 'denied', ad_personalization: 'denied',
      region: ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS',
               'IE', 'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI',
               'ES', 'SE', 'GB', 'CH']
    });
  }
  gtag('consent', 'default', {
    analytics_storage: analyticsOk ? 'granted' : 'denied',
    ad_storage: adsOk ? 'granted' : 'denied',
    ad_user_data: adsOk ? 'granted' : 'denied',
    ad_personalization: adsOk ? 'granted' : 'denied'
  });

  // GA4 reads page_location (the full URL), not the Universal-Analytics era
  // page_path, so the cleaned URL has to go in page_location or the review
  // code still reaches Google. The referrer gets the same treatment for the
  // page a review link leads to.
  var cleanRef;
  try {
    if (document.referrer) {
      var ref = new URL(document.referrer);
      if (ref.host === location.host) {
        cleanRef = ref.origin + scrub(ref.pathname);
      }
    }
  } catch (e) {}

  var cfg = {
    page_location: location.origin + cleanPath + cleanSearch,
    page_path: cleanPath + cleanSearch,
    anonymize_ip: true
  };
  if (cleanRef) cfg.page_referrer = cleanRef;

  gtag('js', new Date());
  gtag('config', GA_ID, cfg);
  // Google Ads shares gtag.js with GA: one script, a second destination.
  if (ADS_ID) gtag('config', ADS_ID, cfg);

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
  (document.head || document.documentElement).appendChild(s);

  // ---- Meta Pixel ----
  // Only on pages whose address is safe to hand over whole (see urlIsClean),
  // and not for visitors who opted out of ad tracking. Automatic configuration
  // is off so the pixel does not scrape form fields or button text; keep
  // "Automatic advanced matching" off in Events Manager for the same reason.
  // Meta has no region-scoped consent default, so without a stored choice a
  // European time zone stands in for Google's IP lookup. It errs towards not
  // tracking (it also covers non-EEA Europe), which is the safe side.
  var europeTz = false;
  try { europeTz = /^(Europe\/|Atlantic\/(Canary|Madeira|Azores|Faroe|Reykjavik)$)/.test(Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch (e) {}
  // The pixel also sends document.referrer as is (its `rl` param), so the page
  // after a review link, or after a reset link, would hand the code to Meta.
  // A same-origin referrer has to pass the same test as the current URL; a
  // cross-origin one is cut to its origin by the browser's default policy.
  var refClean = true;
  try {
    if (document.referrer) {
      var r = new URL(document.referrer);
      if (r.host === location.host) refClean = scrub(r.pathname) === r.pathname && queryIsClean(r.search);
    }
  } catch (e) { refClean = false; }
  var metaOn = !!(META_ID && adsOk && urlIsClean && refClean && (choice || !europeTz));
  if (metaOn) {
    /* eslint-disable */
    !function (f, b, e, v, n, t, sc) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ?
      n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n;
      n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
      sc = b.getElementsByTagName(e)[0]; sc.parentNode.insertBefore(t, sc); }(window, document, 'script',
      'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('set', 'autoConfig', false, META_ID);
    window.fbq('init', META_ID);
    window.fbq('track', 'PageView');
  }

  // GA4 event name -> Meta standard event. Anything else stays GA-only: the
  // site's engagement events (reco_click, review_choice, ...) are not ad
  // signals and would only clutter Events Manager.
  var META_EVENTS = {
    generate_lead: 'Lead',
    sign_up: 'CompleteRegistration',
    begin_checkout: 'InitiateCheckout',
    purchase: 'Purchase',
    search: 'Search'
  };
  function metaParams(name, p) {
    var m = {};
    if (p.value != null) m.value = Number(p.value) || 0;
    if (p.currency) m.currency = p.currency;
    if (p.items && p.items.length) {
      m.content_ids = p.items.map(function (it) { return it && it.item_id; }).filter(Boolean);
      m.content_type = 'product';
      m.num_items = p.items.length;
    }
    if (p.category) m.content_category = p.category;
    if (name === 'search' && p.search_term) m.search_string = p.search_term;
    if (name === 'sign_up' && p.method) m.status = p.method;
    // Purchase needs value + currency or Meta rejects it.
    if (name === 'purchase') { m.value = m.value || 0; m.currency = m.currency || 'INR'; }
    return m;
  }

  /**
   * Report an event to Google (and any enabled ad pixel) as well as to our
   * own activity table. Safe to call before the tags have loaded — dataLayer
   * and the fbq queue hold it.
   */
  window.trackEvent = function (name, params) {
    var clean = cleanParams(params);
    if (name === 'generate_lead' && LEAD_VALUE && clean.value == null) {
      clean.value = LEAD_VALUE;
      clean.currency = clean.currency || LEAD_CURRENCY;
    }
    try {
      var ga = {};
      for (var k in clean) ga[k] = clean[k];
      // Without send_to, gtag would also hand every engagement event to the
      // Ads tag. Ads gets page views (for audiences) and conversions only.
      if (ADS_ID) ga.send_to = GA_ID;
      gtag('event', name, ga);
    } catch (e) {}

    var label = ADS_ID && ADS_LABELS[name];
    if (label) {
      try {
        var conv = { send_to: ADS_ID + '/' + label };
        if (clean.value != null) conv.value = Number(clean.value) || 0;
        if (clean.currency) conv.currency = clean.currency;
        // Google Ads de-duplicates on transaction_id.
        if (clean.transaction_id) conv.transaction_id = clean.transaction_id;
        gtag('event', 'conversion', conv);
      } catch (e) {}
    }

    if (metaOn && META_EVENTS[name]) {
      try {
        var opts = clean.transaction_id ? { eventID: String(clean.transaction_id) } : undefined;
        window.fbq('track', META_EVENTS[name], metaParams(name, clean), opts);
      } catch (e) {}
    }
  };
})();
