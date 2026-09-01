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

  /* --------- Paste your published listings CSV URL here --------- */
  CSV_URL: '',
  /* Example:
  CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vXXXX/pub?output=csv',
  */

  /* --------- Brand constants (don't usually need to change) --------- */
  WHATSAPP_NUMBER: '919930090487',
  BRAND: 'Pets24x7'
};
