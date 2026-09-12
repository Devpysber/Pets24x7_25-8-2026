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
  // Local dev: serve.py reverse-proxies /api, /dev, /admin, /r to the backend,
  // so use a same-origin (relative) base — the JWT cookie then rides every
  // request in all browsers. Prod: the real api. subdomain.
  var defaultBase = isLocal ? '' : 'https://api.pets24x7.com';
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
    me:               function (role)                    { return req('GET',  '/api/me' + (role ? '?role=' + encodeURIComponent(role) : '')); },
    logout:           function ()                        { return req('POST', '/api/me/logout', {}); },

    parentRequestOtp: function (p)                       { return req('POST', '/api/parent/request-otp', p); },
    parentVerify:     function (phone, code)             { return req('POST', '/api/parent/verify',      { phone: phone, code: code }); },

    // Email + password auth (manual signup needs a verification click; Google
    // sign-in is trusted straight away because Google already proved the address).
    siteConfig:       function ()                        { return req('GET',  '/api/config'); },
    parentSignup:     function (p)                       { return req('POST', '/api/parent/email/signup', p); },
    parentLogin:      function (email, password)         { return req('POST', '/api/parent/email/login',  { email: email, password: password }); },
    parentResend:     function (email)                   { return req('POST', '/api/parent/email/resend', { email: email }); },
    parentForgot:     function (email)                   { return req('POST', '/api/parent/email/forgot', { email: email }); },
    parentResetPassword: function (token, password)      { return req('POST', '/api/parent/email/reset',  { token: token, password: password }); },
    parentGoogle:     function (credential)              { return req('POST', '/api/parent/google',       { credential: credential }); },

    // Email OTP sign-in (primary login path for all three roles)
    parentEmailOtpRequest: function (email)              { return req('POST', '/api/parent/email/otp/request', { email: email }); },
    parentEmailOtpVerify:  function (p)                  { return req('POST', '/api/parent/email/otp/verify',  p); },
    vendorEmailOtpRequest: function (email)              { return req('POST', '/api/vendor/email/otp/request', { email: email }); },
    vendorEmailOtpVerify:  function (email, code)        { return req('POST', '/api/vendor/email/otp/verify',  { email: email, code: code }); },
    vendorGoogle:          function (credential)        { return req('POST', '/api/vendor/google', { credential: credential }); },
    adminEmailOtpRequest:  function (email)              { return req('POST', '/api/admin/email/otp/request',  { email: email }); },
    adminEmailOtpVerify:   function (email, code)        { return req('POST', '/api/admin/email/otp/verify',   { email: email, code: code }); },

    vendorRequestOtp: function (phone)                   { return req('POST', '/api/vendor/request-otp', { phone: phone }); },
    vendorVerify:     function (p)                       { return req('POST', '/api/vendor/verify',      p); },

    adminLogin:       function (email, password)         { return req('POST', '/api/admin/login', { email: email, password: password }); },

    // Admin email console
    adminMailTemplates: function ()                      { return req('GET',  '/api/admin/mail/templates'); },
    adminMailPreview:   function (templateId, data)      { return req('POST', '/api/admin/mail/preview', { templateId: templateId, data: data || {} }); },
    adminMailAudience:  function (audience)              { return req('POST', '/api/admin/mail/audience/count', { audience: audience }); },
    adminMailSend:      function (p)                     { return req('POST', '/api/admin/mail/send', p); },

    // Admin data import
    adminImportTargets: function ()                      { return req('GET',  '/api/admin/import/targets'); },
    adminImportCategories: function ()                   { return req('GET',  '/api/admin/import/categories'); },
    adminImportStats:   function ()                      { return req('GET',  '/api/admin/import/stats'); },
    adminImportHistory: function ()                      { return req('GET',  '/api/admin/import/history'); },
    adminImportPreview: function (p)                     { return req('POST', '/api/admin/import/preview', p); },
    adminImportAnalyze: function (p)                     { return req('POST', '/api/admin/import/analyze', p); },
    adminImportCommit:  function (p)                     { return req('POST', '/api/admin/import/commit', p); },
    adminImportHistoryJob: function (id)                 { return req('GET',  '/api/admin/import/history/' + encodeURIComponent(id)); },
    adminImportRetrySheets: function (id)                { return req('POST', '/api/admin/import/retry-sheets/' + encodeURIComponent(id)); },

    // Dashboards
    recommendations:  function (p) {
      var qs = Object.keys(p || {}).filter(function (k) { return p[k]; })
        .map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
      return req('GET', '/api/recommendations' + (qs ? '?' + qs : ''));
    },

    parentDashboard:  function ()                        { return req('GET',  '/api/parent/dashboard'); },
    parentPets:       function ()                        { return req('GET',  '/api/parent/pets'); },
    parentPetCreate:  function (p)                       { return req('POST', '/api/parent/pets', p); },
    parentPetUpdate:  function (id, p)                   { return req('PATCH', '/api/parent/pets/' + encodeURIComponent(id), p); },
    parentPetDelete:  function (id)                      { return req('DELETE', '/api/parent/pets/' + encodeURIComponent(id)); },
    parentProfileUpdate: function (p)                    { return req('PATCH', '/api/parent/profile', p); },
    parentEnquiries:  function ()                        { return req('GET',  '/api/enquiries/mine'); },

    parentSaved:      function ()                        { return req('GET',    '/api/parent/saved'); },
    parentSave:       function (p)                       { return req('POST',   '/api/parent/saved', p); },
    parentUnsave:     function (listingId)               { return req('DELETE', '/api/parent/saved/' + encodeURIComponent(listingId)); },

    vendorDashboard:  function ()                        { return req('GET',  '/api/vendor/dashboard'); },
    vendorListing:    function ()                        { return req('GET',  '/api/vendor/listing'); },
    vendorEnquiries:  function ()                        { return req('GET',  '/api/vendor/enquiries'); },
    vendorEnquiryStatus: function (id, status)           { return req('PATCH', '/api/vendor/enquiries/' + encodeURIComponent(id), { status: status }); },
    vendorReviewReply:   function (id, reply)            { return req('PATCH', '/api/vendor/reviews/' + encodeURIComponent(id) + '/reply', { reply: reply }); },
    vendorPatch:      function (p)                       { return req('PATCH','/api/vendor/profile', p); },
    vendorEmailResend:function ()                        { return req('POST', '/api/vendor/email/resend'); },

    // Business Claim + Registration System API helpers
    claimSearch:                function (p)             { return req('POST', '/api/vendor/claim/search', p); },
    claimVerifyPhone:           function (p)             { return req('POST', '/api/vendor/claim/verify-phone', p); },
    claimSubmitEmail:           function (p)             { return req('POST', '/api/vendor/claim/submit-email', p); },
    claimFirstLoginPassword:    function (p)             { return req('POST', '/api/vendor/claim/first-login-change-password', p); },
    vendorRegisterBusiness:     function (p)             { return req('POST', '/api/vendor/register-business', p); },
    vendorPasswordLogin:        function (loginKey, pass){ return req('POST', '/api/vendor/login', { loginKey: loginKey, password: pass }); },
    vendorMyBusiness:           function ()              { return req('GET',  '/api/vendor/my-business'); },
    vendorUpdateMyBusiness:     function (p)             { return req('PATCH', '/api/vendor/my-business', p); },
    vendorChangePassword:       function (p)             { return req('POST', '/api/vendor/change-password', p); },

    // Vendor services
    vendorServices:       function ()        { return req('GET',    '/api/vendor/services'); },
    vendorServiceCreate:  function (p)       { return req('POST',   '/api/vendor/services', p); },
    vendorServiceUpdate:  function (id, p)   { return req('PATCH',  '/api/vendor/services/' + encodeURIComponent(id), p); },
    vendorServiceDelete:  function (id)      { return req('DELETE', '/api/vendor/services/' + encodeURIComponent(id)); },

    // Vendor marketing campaigns
    vendorCampaigns:        function ()      { return req('GET',  '/api/vendor/campaigns'); },
    vendorCampaignCreate:   function (p)     { return req('POST', '/api/vendor/campaigns', p); },
    vendorCampaignStatus:   function (txn)   { return req('GET',  '/api/vendor/campaigns/payment/' + encodeURIComponent(txn)); },

    // Vendor featured listing
    vendorFeatured:         function ()      { return req('GET',  '/api/vendor/featured'); },
    vendorFeaturedCreate:   function (p)     { return req('POST', '/api/vendor/featured', p); },
    vendorFeaturedStatus:   function (txn)   { return req('GET',  '/api/vendor/featured/payment/' + encodeURIComponent(txn)); },

    // Vendor subscriptions & checkout
    vendorSubPlans:    function ()           { return req('GET',  '/api/vendor/subscriptions/plans'); },
    vendorSubMe:       function ()           { return req('GET',  '/api/vendor/subscriptions/me'); },
    vendorSubCheckout: function (p)          { return req('POST', '/api/vendor/subscriptions/checkout', p); },
    vendorSubVerify:   function (p)          { return req('POST', '/api/vendor/subscriptions/verify', p); },

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
    razorpayVerify:     function (p)        { return req('POST', '/api/payments/razorpay/verify', p); },
    membershipCancel:   function ()        { return req('POST', '/api/memberships/cancel', {}); },
    membershipResume:   function ()        { return req('POST', '/api/memberships/resume', {}); },
    paymentStatus:      function (txn)     { return req('GET',  '/api/memberships/payment/' + encodeURIComponent(txn)); },

    // Nearby feed (public)
    deals:  function (city, category) {
      var qs = []; if (city) qs.push('city=' + encodeURIComponent(city)); if (category) qs.push('category=' + encodeURIComponent(category));
      return req('GET', '/api/deals' + (qs.length ? '?' + qs.join('&') : ''));
    },
    events: function (city) { return req('GET', '/api/events' + (city ? '?city=' + encodeURIComponent(city) : '')); },

    // Public listing reviews (Pets24x7-hosted, published)
    listingReviews: function (listingId) { return req('GET', '/api/reviews/listing/' + encodeURIComponent(listingId)); },
    listingReviewCreate: function (listingId, body) { return req('POST', '/api/reviews/listing/' + encodeURIComponent(listingId), body); },

    // Enquiries
    enquiryCreate:    function (p)                       { return req('POST', '/api/enquiries', p); },

    // Records a tap that never becomes an enquiry — the phone number, WhatsApp,
    // the website link. Best-effort by design: a failure here must never stop
    // the customer reaching the business.
    activityLog:      function (listingId, kind, source) {
      try {
        return req('POST', '/api/activity', { listingId: listingId, kind: kind, source: source || 'listing_page' })
          .catch(function () {});
      } catch (e) { return Promise.resolve(); }
    },

    // Featured listings (public)
    featuredList:     function (city, category) {
      var qs = [];
      if (city) qs.push('city=' + encodeURIComponent(city));
      if (category) qs.push('category=' + encodeURIComponent(category));
      return req('GET', '/api/featured' + (qs.length ? '?' + qs.join('&') : ''));
    },

    // Admin JSON API
    adminOverview:      function ()          { return req('GET',  '/api/admin/overview'); },
    adminVendors:       function (status)    { return req('GET',  '/api/admin/vendors' + (status ? '?status=' + encodeURIComponent(status) : '')); },
    adminVendorStatus:  function (id, body)  { return req('POST', '/api/admin/vendors/' + encodeURIComponent(id) + '/status', body); },
    adminParents:       function ()          { return req('GET',  '/api/admin/parents'); },
    adminListings:      function ()          { return req('GET',  '/api/admin/listings'); },
    adminServices:      function ()          { return req('GET',  '/api/admin/services'); },
    adminEnquiries:     function ()          { return req('GET',  '/api/admin/enquiries'); },
    adminMarketing:     function ()          { return req('GET',  '/api/admin/marketing'); },
    adminCampaignStatus:function (id, body)  { return req('POST', '/api/admin/marketing/' + encodeURIComponent(id) + '/status', body); },
    adminPayments:      function (status)    { return req('GET',  '/api/admin/payments' + (status ? '?status=' + encodeURIComponent(status) : '')); },
    adminMemberships:   function (status)    { return req('GET',  '/api/admin/memberships' + (status ? '?status=' + encodeURIComponent(status) : '')); },
    adminReviews:       function (status)    { return req('GET',  '/api/admin/reviews' + (status ? '?status=' + encodeURIComponent(status) : '')); },
    adminReviewPublish: function (id)        { return req('POST', '/api/admin/reviews/' + encodeURIComponent(id) + '/publish', {}); },
    adminReviewReject:  function (id, reason){ return req('POST', '/api/admin/reviews/' + encodeURIComponent(id) + '/reject', { reason: reason || '' }); },
    adminReports:       function ()          { return req('GET',  '/api/admin/reports'); },
    adminGrowPlans:       function ()          { return req('GET',  '/api/admin/grow-plans'); },
    adminGrowPlanSave:    function (body)      { return req('POST', '/api/admin/grow-plans', body); },
    adminGrowPlanUpdate:  function (id, body)  { return req('PUT',  '/api/admin/grow-plans/' + encodeURIComponent(id), body); },
    adminGrowBuyers:      function ()          { return req('GET',  '/api/admin/grow-buyers'); },
    adminGrowBuyerStatus: function (id, status){ return req('POST', '/api/admin/grow-buyers/' + encodeURIComponent(id) + '/status', { status: status }); },

    // Subscriptions API
    adminParentSubPlans:      function ()          { return req('GET',  '/api/admin/subscriptions/parent-plans'); },
    adminParentSubPlanSave:   function (body)      { return req('POST', '/api/admin/subscriptions/parent-plans', body); },
    adminParentSubPlanUpdate: function (id, body)  { return req('PUT',  '/api/admin/subscriptions/parent-plans/' + encodeURIComponent(id), body); },
    adminParentSubscribers:   function ()          { return req('GET',  '/api/admin/subscriptions/parent-subscribers'); },
    adminParentSubStatus:     function (id, status){ return req('POST', '/api/admin/subscriptions/parent-subscribers/' + encodeURIComponent(id) + '/status', { status: status }); },

    adminVendorSubPlans:      function ()          { return req('GET',  '/api/admin/subscriptions/vendor-plans'); },
    adminVendorSubPlanSave:   function (body)      { return req('POST', '/api/admin/subscriptions/vendor-plans', body); },
    adminVendorSubPlanUpdate: function (id, body)  { return req('PUT',  '/api/admin/subscriptions/vendor-plans/' + encodeURIComponent(id), body); },
    adminVendorSubscribers:   function ()          { return req('GET',  '/api/admin/subscriptions/vendor-subscribers'); },
    adminVendorSubStatus:     function (id, status){ return req('POST', '/api/admin/subscriptions/vendor-subscribers/' + encodeURIComponent(id) + '/status', { status: status }); },

    adminEnquiryStatus:function (id, status){ return req('POST', '/api/admin/enquiries/' + encodeURIComponent(id) + '/status', { status: status }); },
    adminServiceStatus:function (id, status){ return req('POST', '/api/admin/services/' + encodeURIComponent(id) + '/status', { status: status }); },
    adminVendorCreate: function (body)      { return req('POST', '/api/admin/vendors', body); },
    adminVendorDelete: function (id)        { return req('DELETE', '/api/admin/vendors/' + encodeURIComponent(id)); },
    adminParentDelete: function (id)        { return req('DELETE', '/api/admin/parents/' + encodeURIComponent(id)); },

    adminPlans:        function ()          { return req('GET',  '/api/admin/plans'); },
    adminPlanCreate:   function (body)      { return req('POST', '/api/admin/plans', body); },
    adminPlanUpdate:   function (id, body)  { return req('PATCH','/api/admin/plans/' + encodeURIComponent(id), body); },

    adminPaymentRefund:function (id, reason){ return req('POST', '/api/admin/payments/' + encodeURIComponent(id) + '/refund', { reason: reason || '' }); },

    adminFeatured:       function ()          { return req('GET',  '/api/admin/featured'); },
    adminFeaturedStatus: function (id, status){ return req('POST', '/api/admin/featured/' + encodeURIComponent(id) + '/status', { status: status }); },

    adminDeals:        function ()          { return req('GET',    '/api/admin/deals'); },
    adminDealCreate:   function (body)      { return req('POST',   '/api/admin/deals', body); },
    adminDealUpdate:   function (id, body)  { return req('PATCH',  '/api/admin/deals/' + encodeURIComponent(id), body); },
    adminDealDelete:   function (id)        { return req('DELETE', '/api/admin/deals/' + encodeURIComponent(id)); },

    adminEvents:       function ()          { return req('GET',    '/api/admin/events'); },
    adminEventCreate:  function (body)      { return req('POST',   '/api/admin/events', body); },
    adminEventUpdate:  function (id, body)  { return req('PATCH',  '/api/admin/events/' + encodeURIComponent(id), body); },
    adminEventDelete:  function (id)        { return req('DELETE', '/api/admin/events/' + encodeURIComponent(id)); },

    adminWaMessages:  function (dir)        { return req('GET',  '/api/admin/wa-messages' + (dir ? '?direction=' + encodeURIComponent(dir) : '')); },
    adminAudit:       function ()          { return req('GET',  '/api/admin/audit'); },
    adminActivity:    function (kind)      { return req('GET',  '/api/admin/activity' + (kind ? '?kind=' + encodeURIComponent(kind) : '')); },
    adminListing:       function (id)       { return req('GET',    '/api/admin/listings/' + encodeURIComponent(id)); },
    adminListingUpdate: function (id, body) { return req('PATCH',  '/api/admin/listings/' + encodeURIComponent(id), body); },
    adminListingDelete: function (id)       { return req('DELETE', '/api/admin/listings/' + encodeURIComponent(id)); },
    adminSettings:    function ()          { return req('GET',  '/api/admin/settings'); },
    adminMyProfile:   function ()          { return req('GET',   '/api/admin/me/profile'); },
    adminMyProfileSave: function (body)    { return req('PATCH', '/api/admin/me/profile', body); },
    adminSettingsSave:function (obj)       { return req('PUT',  '/api/admin/settings', obj); },

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
  /**
   * Session guard for a role-protected page.
   *
   * Only a definitive answer from the server signs someone out. A dropped
   * connection, a restarting API or a 5xx says nothing about whether the
   * cookie is still good, and redirecting on those is what made a signed-in
   * user land back on the login page mid-session. Those are retried with a
   * short backoff; only role:null, 401 or 403 redirects.
   *
   * Resolves with the /api/me payload, or null when it redirected. Rejects
   * with the last error when the API stayed unreachable - the caller should
   * show a retry banner rather than assume anything about the session.
   */
  window.requireRole = function (role, redirectTo) {
    var target = redirectTo || '/login/';
    var delays = [400, 1200, 3000];

    function bounce() { location.href = target; return null; }

    function attempt(n) {
      return window.api.me(role).then(function (r) {
        if (!r || !r.role || r.role !== role) return bounce();
        return r;
      }).catch(function (err) {
        var status = err && err.status;
        if (status === 401 || status === 403) return bounce();
        if (n < delays.length) {
          return new Promise(function (resolve) { setTimeout(resolve, delays[n]); })
            .then(function () { return attempt(n + 1); });
        }
        throw err;
      });
    }
    return attempt(0);
  };

  /** True when an error says nothing about the session and must not sign anyone out. */
  window.isTransientApiError = function (err) {
    var s = err && err.status;
    return !s || s >= 500;
  };
})();
