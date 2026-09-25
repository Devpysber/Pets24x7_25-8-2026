/**
 * Pets24x7.com — site-wide config.
 *
 * This is the SINGLE place to set the two integrations:
 *
 *   LEADS_WEBAPP_URL — Google Apps Script Web App URL that captures
 *                      every form submission into a Google Sheet.
 *                      Setup: see LEADS-APPS-SCRIPT.gs in this folder.
 *
 *   CSV_URL          — Google Sheet "Publish to web" CSV URL for the
 *                      listings dataset. When set, the site auto-refreshes
 *                      the home page index from this sheet in the background
 *                      (legacy city.html fallback uses it too).
 *                      Setup: see SETUP.md  →  "Live listings data sheet".
 *
 * Loaded by every page on the site. Leave the values empty until your
 * sheets are ready — the site keeps working from the bundled snapshot.
 */
window.PETS_CONFIG = {
  /* --------- Paste your Apps Script Web App URL here --------- */
  LEADS_WEBAPP_URL: '',
  /* Example:
  LEADS_WEBAPP_URL: 'https://script.google.com/macros/s/AKfycbXXXXXXXXXX/exec',
  */

  /* --------- Paste your published listings CSV URL here ---------
     The sheet must have the pets.csv columns (id, name, city, country, ...).
     Cleared 2026-09-24: the sheet that was here (1BKs1GbE...) is a
     wedding-venue export (venue_id, venue_name, city_name, ...), not pets
     data. /pets-loader.js already rejected it, so every visitor paid for a
     useless download. Empty = the site runs on the bundled snapshot. */
  CSV_URL: '',
  /* Example:
  CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vXXXX/pub?output=csv',
  */

  /* --------- Google Analytics 4 measurement ID ---------
     Set here to override the default baked into /analytics.js. Leave as is
     unless the property changes. Localhost and the signed-in dashboards are
     never tracked — see analytics.js for why. */
  GA_ID: 'G-FC5WRMCXYG',

  /* --------- Ad pixels (optional; empty = off) ---------
     Loaded by /analytics.js under the same rules as GA: never on localhost,
     deploy previews or the dashboards, and the same PII scrubbing. Every
     trackEvent() on the site reaches whichever of these are set.

     META_PIXEL_ID   — Meta (Facebook/Instagram) Pixel id, digits only.
                       Sends PageView, plus Lead / CompleteRegistration /
                       InitiateCheckout / Purchase / Search mapped from the
                       GA4 events generate_lead / sign_up / begin_checkout /
                       purchase / search.
     GOOGLE_ADS_ID   — Google Ads tag id, e.g. 'AW-123456789'.
     GOOGLE_ADS_CONVERSION_LABELS — GA4 event name -> conversion label from
                       Google Ads (Goals > Conversions > the action > Tag
                       setup). Only listed events count as conversions:
                         { purchase: 'AbCdEfGh123', generate_lead: 'XyZ987' } */
  META_PIXEL_ID: '',
  GOOGLE_ADS_ID: '',
  GOOGLE_ADS_CONVERSION_LABELS: {},
  /* Optional value of one lead (generate_lead), in LEAD_CURRENCY, so Google
     Ads and Meta can optimise for it. 0 = leads are counted without a value. */
  LEAD_VALUE: 0,
  LEAD_CURRENCY: 'INR',

  /* --------- Brand constants (don't usually need to change) --------- */
  WHATSAPP_NUMBER: '919930090487',
  BRAND: 'Pets24x7'
};
