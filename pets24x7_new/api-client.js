/**
 * Pets24x7 — shared API client.
 * Used by /login/, /parent-login/, /vendor-login/, /dashboard/*.
 *
 * API base resolved at runtime:
 *   - localhost / 127.0.0.1  -> http://localhost:4000   (local dev)
 *   - anything else          -> https://api.pets24x7.com
 *
 * Override in config.js if needed:
 *   window.PETS_CONFIG.API_BASE = 'https://staging-api.pets24x7.com';
 *
 * Cookies (httpOnly JWT) carry auth across origins — every call sets
 * credentials:'include'. Backend CORS allows pets24x7.com + subdomains.
 */
(function () {
  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
  var defaultBase = isLocal ? 'http://localhost:4000' : 'https://api.pets24x7.com';
  var BASE = (window.PETS_CONFIG && window.PETS_CONFIG.API_BASE) || defaultBase;

  function req(method, path, body) {
    var opts = {
      method: method,
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(BASE + path, opts).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'bad_json' }; }).then(function (data) {
        if (!r.ok) {
          var err = new Error(data.message || data.error || ('HTTP ' + r.status));
          err.status = r.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  window.api = {
    base: BASE,
    get:    function (p)        { return req('GET',    p); },
    post:   function (p, body)  { return req('POST',   p, body || {}); },
    patch:  function (p, body)  { return req('PATCH',  p, body || {}); },
    del:    function (p)        { return req('DELETE', p); },

    // Auth helpers
    me:               function ()                        { return req('GET',  '/api/me'); },
    logout:           function ()                        { return req('POST', '/api/me/logout', {}); },

    parentRequestOtp: function (p)                       { return req('POST', '/api/parent/request-otp', p); },
    parentVerify:     function (phone, code)             { return req('POST', '/api/parent/verify',      { phone: phone, code: code }); },

    vendorRequestOtp: function (phone)                   { return req('POST', '/api/vendor/request-otp', { phone: phone }); },
    vendorVerify:     function (p)                       { return req('POST', '/api/vendor/verify',      p); },

    // Dashboards
    parentDashboard:  function ()                        { return req('GET',  '/api/parent/dashboard'); },
    parentPets:       function ()                        { return req('GET',  '/api/parent/pets'); },
    parentPetCreate:  function (p)                       { return req('POST', '/api/parent/pets', p); },
    parentPetUpdate:  function (id, p)                   { return req('PATCH', '/api/parent/pets/' + encodeURIComponent(id), p); },
    parentPetDelete:  function (id)                      { return req('DELETE', '/api/parent/pets/' + encodeURIComponent(id)); },

    vendorDashboard:  function ()                        { return req('GET',  '/api/vendor/dashboard'); },
    vendorListing:    function ()                        { return req('GET',  '/api/vendor/listing'); },
    vendorPatch:      function (p)                       { return req('PATCH','/api/vendor/profile', p); },

    // Vendor reviews (Phase 3.1)
    vendorReviewRequests:     function ()              { return req('GET',  '/api/vendor/reviews/requests'); },
    vendorReviewRequestBulk:  function (customers)     { return req('POST', '/api/vendor/reviews/requests/bulk', { customers: customers }); },
    vendorReviewsCollected:   function ()              { return req('GET',  '/api/vendor/reviews'); },

    // Public review APIs (no auth)
    reviewContext:    function (code)                    { return req('GET',  '/api/reviews/' + encodeURIComponent(code)); },
    reviewChoose:     function (code, choice)            { return req('POST', '/api/reviews/' + encodeURIComponent(code) + '/choose', { choice: choice }); },
    reviewSubmit:     function (code, payload)           { return req('POST', '/api/reviews/' + encodeURIComponent(code) + '/submit', payload); },

    // Memberships + payments
    membershipPlans:    function ()        { return req('GET',  '/api/memberships/plans'); },
    membershipMe:       function ()        { return req('GET',  '/api/memberships/me'); },
    membershipCheckout: function (planId)  { return req('POST', '/api/memberships/checkout', { planId: planId }); },
    paymentStatus:      function (txn)     { return req('GET',  '/api/memberships/payment/' + encodeURIComponent(txn)); },

    // Public listing lookup (no auth)
    listingByPhone:   function (phone)                   { return req('GET',  '/api/listings/by-phone?p=' + encodeURIComponent(phone)); },
    listingsSearch:   function (params) {
      params = params || {};
      var q = encodeURIComponent(params.q || '');
      var cat = encodeURIComponent(params.category || '');
      var city = encodeURIComponent(params.city || '');
      var limit = params.limit || 60;
      return req('GET', '/api/listings/search?q=' + q + '&category=' + cat + '&city=' + city + '&limit=' + limit);
    }
  };

  // Tiny global helpers shared across login/dashboard pages.
  window.fmtErr = function (e) { return (e && (e.message || e.error)) || 'Something went wrong'; };
  window.requireRole = function (role, redirectTo) {
    return window.api.me().then(function (r) {
      if (!r.role || r.role !== role) { location.href = redirectTo || '/login/'; return null; }
      return r;
    }).catch(function () { location.href = redirectTo || '/login/'; return null; });
  };
})();
