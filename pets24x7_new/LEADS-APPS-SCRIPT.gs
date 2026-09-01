/**
 * Pets24x7.com — Leads Apps Script
 * ---------------------------------------------------------------
 * This is the server-side script that catches form submissions
 * from listing.html and marketing.html and writes them to a
 * Google Sheet. It is *optional* — the WhatsApp flow works
 * without it. Set it up when you want a CRM-like leads log.
 *
 * SETUP (one time):
 *   1. Create a new Google Sheet called "Pets24x7 Leads".
 *      Rename the first tab to "Leads" (the script looks for it by name).
 *   2. In the sheet: Extensions > Apps Script.
 *   3. Replace the auto-generated code with the contents of THIS file.
 *   4. File > Save. Then Deploy > New deployment > Type: Web app.
 *        - Execute as:   Me
 *        - Who has access: Anyone (required for no-cors POST)
 *      Click Deploy. Authorise.
 *   5. Copy the Web App URL it gives you (looks like
 *      https://script.google.com/macros/s/AKfycb.../exec ).
 *   6. Open /config.js in this repo and paste the URL into:
 *        LEADS_WEBAPP_URL: '...'
 *      That ONE line wires every form on the site (home, marketing,
 *      legacy listing.html, and all 30k pre-rendered listing pages).
 *   7. Submit a test form. A new row should appear in the "Leads" tab.
 *
 * If you ever change the form fields, just add the new key=value
 * to the form's pushLeadToSheet({...}) call. Unknown fields are
 * appended as new columns automatically — no code change needed.
 */

function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActive().getSheetByName('Leads')
              || SpreadsheetApp.getActive().insertSheet('Leads');

    // Initialise headers on first run
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        'timestamp','source','page',
        'name','phone','email',
        'business','category','city','country','location',
        'listing_id','service','size','pet','date','notes',
        'userAgent'
      ]);
      sheet.setFrozenRows(1);
      sheet.getRange('A1:R1').setFontWeight('bold').setBackground('#EFF6FF');
    }

    var p = e && e.parameter ? e.parameter : {};
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var row = headers.map(function (h) {
      if (h === 'timestamp') return new Date();
      return p[h] != null ? p[h] : '';
    });

    // Append any keys we don't have columns for, as new columns at the end.
    var known = {};
    headers.forEach(function (h) { known[h] = true; });
    Object.keys(p).forEach(function (k) {
      if (!known[k]) {
        var newCol = sheet.getLastColumn() + 1;
        sheet.getRange(1, newCol).setValue(k).setFontWeight('bold').setBackground('#EFF6FF');
        row.push(p[k]);
        known[k] = true;
      }
    });

    sheet.appendRow(row);
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
            .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
            .setMimeType(ContentService.MimeType.JSON);
  }
}

// GET = lightweight health check so you can hit the URL in a browser.
function doGet() {
  return ContentService.createTextOutput('Pets24x7 leads webhook is live.');
}
