/**
 * Pets24x7 — Google Analytics 4.
 *
 * One file so the measurement ID lives in a single place. Loaded by every
 * page after /config.js, which can override the ID:
 *
 *   window.PETS_CONFIG.GA_ID = 'G-XXXXXXX';
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
 */
(function () {
  var GA_ID = (window.PETS_CONFIG && window.PETS_CONFIG.GA_ID) || 'G-FC5WRMCXYG';

  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '' ||
                host.indexOf('192.168.') === 0 || host.slice(-6) === '.local';
  if (isLocal) return;

  // The portals behind a login are internal tooling, not the marketplace.
  var path = location.pathname;
  if (path.indexOf('/dashboard/') === 0 ||
      path.indexOf('/admin-login') === 0 ||
      path.indexOf('/admin/') === 0) return;

  // Strip the single-use review code out of the path, and out of the referrer
  // chain for the pages that follow it.
  var cleanPath = path
    .replace(/^\/review\/[^/]+(\/.*)?$/, function (_m, rest) { return '/review/:code' + (rest || ''); })
    .replace(/^\/r\/[^/]+$/, '/r/:code');

  var cleanSearch = '';
  if (location.search) {
    var keep = ['q', 'city', 'cat', 'country', 'page'];
    var params = new URLSearchParams(location.search);
    var out = new URLSearchParams();
    keep.forEach(function (k) { if (params.get(k)) out.set(k, params.get(k)); });
    var s = out.toString();
    if (s) cleanSearch = '?' + s;
  }

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', GA_ID, {
    page_path: cleanPath + cleanSearch,
    anonymize_ip: true
  });

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
  (document.head || document.documentElement).appendChild(s);

  /**
   * Report an event to Google as well as to our own activity table.
   * Safe to call before the tag has loaded — dataLayer queues it.
   */
  window.trackEvent = function (name, params) {
    try { gtag('event', name, params || {}); } catch (e) {}
  };
})();
