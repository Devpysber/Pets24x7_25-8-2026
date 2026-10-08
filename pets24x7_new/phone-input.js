/* Phone number with a country dialling-code picker. Enhances every
   <input data-phone> (and fields added later): a "+91" picker sits in front of
   the input, which then holds only the national number. Read the full number
   with PhoneField.value(input) -> "+919876543210" ('' when empty) and check it
   with PhoneField.error(input) -> '' or a message. Self-contained, no deps.

   data-phone-country="US" picks the starting country (default IN). A value
   that already starts with "+" (an edit form) selects its own country. */
(function () {
  'use strict';

  // ISO code | name | dialling code. India and the USA first, the rest A-Z.
  var LIST = (
    'IN|India|91;US|United States|1;' +
    'AF|Afghanistan|93;AL|Albania|355;DZ|Algeria|213;AS|American Samoa|1684;AD|Andorra|376;AO|Angola|244;' +
    'AI|Anguilla|1264;AG|Antigua and Barbuda|1268;AR|Argentina|54;AM|Armenia|374;AW|Aruba|297;AU|Australia|61;' +
    'AT|Austria|43;AZ|Azerbaijan|994;BS|Bahamas|1242;BH|Bahrain|973;BD|Bangladesh|880;BB|Barbados|1246;' +
    'BY|Belarus|375;BE|Belgium|32;BZ|Belize|501;BJ|Benin|229;BM|Bermuda|1441;BT|Bhutan|975;BO|Bolivia|591;' +
    'BA|Bosnia and Herzegovina|387;BW|Botswana|267;BR|Brazil|55;VG|British Virgin Islands|1284;BN|Brunei|673;' +
    'BG|Bulgaria|359;BF|Burkina Faso|226;BI|Burundi|257;KH|Cambodia|855;CM|Cameroon|237;CA|Canada|1;' +
    'CV|Cape Verde|238;KY|Cayman Islands|1345;CF|Central African Republic|236;TD|Chad|235;CL|Chile|56;' +
    'CN|China|86;CO|Colombia|57;KM|Comoros|269;CG|Congo|242;CD|Congo (DRC)|243;CK|Cook Islands|682;' +
    'CR|Costa Rica|506;CI|Côte d’Ivoire|225;HR|Croatia|385;CU|Cuba|53;CW|Curaçao|599;CY|Cyprus|357;' +
    'CZ|Czechia|420;DK|Denmark|45;DJ|Djibouti|253;DM|Dominica|1767;DO|Dominican Republic|1809;EC|Ecuador|593;' +
    'EG|Egypt|20;SV|El Salvador|503;GQ|Equatorial Guinea|240;ER|Eritrea|291;EE|Estonia|372;SZ|Eswatini|268;' +
    'ET|Ethiopia|251;FK|Falkland Islands|500;FO|Faroe Islands|298;FJ|Fiji|679;FI|Finland|358;FR|France|33;' +
    'GF|French Guiana|594;PF|French Polynesia|689;GA|Gabon|241;GM|Gambia|220;GE|Georgia|995;DE|Germany|49;' +
    'GH|Ghana|233;GI|Gibraltar|350;GR|Greece|30;GL|Greenland|299;GD|Grenada|1473;GP|Guadeloupe|590;GU|Guam|1671;' +
    'GT|Guatemala|502;GN|Guinea|224;GW|Guinea-Bissau|245;GY|Guyana|592;HT|Haiti|509;HN|Honduras|504;' +
    'HK|Hong Kong|852;HU|Hungary|36;IS|Iceland|354;ID|Indonesia|62;IR|Iran|98;IQ|Iraq|964;IE|Ireland|353;' +
    'IL|Israel|972;IT|Italy|39;JM|Jamaica|1876;JP|Japan|81;JO|Jordan|962;KZ|Kazakhstan|7;KE|Kenya|254;' +
    'KI|Kiribati|686;XK|Kosovo|383;KW|Kuwait|965;KG|Kyrgyzstan|996;LA|Laos|856;LV|Latvia|371;LB|Lebanon|961;' +
    'LS|Lesotho|266;LR|Liberia|231;LY|Libya|218;LI|Liechtenstein|423;LT|Lithuania|370;LU|Luxembourg|352;' +
    'MO|Macau|853;MG|Madagascar|261;MW|Malawi|265;MY|Malaysia|60;MV|Maldives|960;ML|Mali|223;MT|Malta|356;' +
    'MH|Marshall Islands|692;MQ|Martinique|596;MR|Mauritania|222;MU|Mauritius|230;YT|Mayotte|262;MX|Mexico|52;' +
    'FM|Micronesia|691;MD|Moldova|373;MC|Monaco|377;MN|Mongolia|976;ME|Montenegro|382;MS|Montserrat|1664;' +
    'MA|Morocco|212;MZ|Mozambique|258;MM|Myanmar|95;NA|Namibia|264;NR|Nauru|674;NP|Nepal|977;NL|Netherlands|31;' +
    'NC|New Caledonia|687;NZ|New Zealand|64;NI|Nicaragua|505;NE|Niger|227;NG|Nigeria|234;KP|North Korea|850;' +
    'MK|North Macedonia|389;MP|Northern Mariana Islands|1670;NO|Norway|47;OM|Oman|968;PK|Pakistan|92;PW|Palau|680;' +
    'PS|Palestine|970;PA|Panama|507;PG|Papua New Guinea|675;PY|Paraguay|595;PE|Peru|51;PH|Philippines|63;' +
    'PL|Poland|48;PT|Portugal|351;PR|Puerto Rico|1787;QA|Qatar|974;RE|Réunion|262;RO|Romania|40;RU|Russia|7;' +
    'RW|Rwanda|250;KN|Saint Kitts and Nevis|1869;LC|Saint Lucia|1758;VC|Saint Vincent and the Grenadines|1784;' +
    'WS|Samoa|685;SM|San Marino|378;ST|São Tomé and Príncipe|239;SA|Saudi Arabia|966;SN|Senegal|221;' +
    'RS|Serbia|381;SC|Seychelles|248;SL|Sierra Leone|232;SG|Singapore|65;SX|Sint Maarten|1721;SK|Slovakia|421;' +
    'SI|Slovenia|386;SB|Solomon Islands|677;SO|Somalia|252;ZA|South Africa|27;KR|South Korea|82;SS|South Sudan|211;' +
    'ES|Spain|34;LK|Sri Lanka|94;SD|Sudan|249;SR|Suriname|597;SE|Sweden|46;CH|Switzerland|41;SY|Syria|963;' +
    'TW|Taiwan|886;TJ|Tajikistan|992;TZ|Tanzania|255;TH|Thailand|66;TL|Timor-Leste|670;TG|Togo|228;TO|Tonga|676;' +
    'TT|Trinidad and Tobago|1868;TN|Tunisia|216;TR|Turkey|90;TM|Turkmenistan|993;TC|Turks and Caicos Islands|1649;' +
    'TV|Tuvalu|688;VI|US Virgin Islands|1340;UG|Uganda|256;UA|Ukraine|380;AE|United Arab Emirates|971;' +
    'GB|United Kingdom|44;UY|Uruguay|598;UZ|Uzbekistan|998;VU|Vanuatu|678;VA|Vatican City|379;VE|Venezuela|58;' +
    'VN|Vietnam|84;YE|Yemen|967;ZM|Zambia|260;ZW|Zimbabwe|263'
  ).split(';').map(function (s) { var p = s.split('|'); return { iso: p[0], name: p[1], dial: p[2] }; });

  var BY_ISO = {};
  LIST.forEach(function (c) { BY_ISO[c.iso] = c; });
  // For reading "+1..." / "+7..." back, the main country of a shared code wins.
  var PREFERRED = { '1': 'US', '7': 'RU', '44': 'GB', '262': 'RE', '599': 'CW' };
  // Countries whose numbers keep their leading 0 after the country code.
  var KEEPS_ZERO = { IT: 1, SM: 1, VA: 1 };

  var css = document.createElement('style');
  css.textContent =
    '.ph-wrap{display:flex;align-items:stretch;width:100%;gap:0;position:relative}' +
    '.ph-cc{position:relative;flex:0 0 auto;display:flex;align-items:center;gap:4px;padding:0 10px 0 12px;' +
    'border:1px solid var(--border,#E2E8F0);border-right:0;border-radius:10px 0 0 10px;background:var(--bg-alt,#F8FAFC);' +
    'font-weight:600;font-size:14px;color:var(--text,#0F172A);white-space:nowrap;cursor:pointer}' +
    '.ph-cc .ph-iso{font-size:11px;font-weight:700;color:var(--text-muted,#64748B);letter-spacing:.3px}' +
    '.ph-cc svg{color:var(--text-muted,#64748B)}' +
    '.ph-cc select{position:absolute;inset:0;width:100%!important;height:100%;opacity:0;cursor:pointer;margin:0!important;padding:0!important;border:0!important;font-size:16px}' +
    '.ph-cc:focus-within{border-color:var(--primary,#2563EB);box-shadow:0 0 0 3.5px rgba(37,99,235,.12);z-index:1}' +
    '.ph-wrap>input{flex:1 1 auto;min-width:0;width:auto!important;margin:0!important}';
  (document.head || document.documentElement).appendChild(css);

  var CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  function digits(s) { return String(s || '').replace(/\D/g, ''); }

  // "+919876543210" -> { iso: 'IN', national: '9876543210' }; longest code wins.
  function parse(full) {
    var d = digits(full);
    for (var len = 4; len >= 1; len--) {
      var code = d.slice(0, len);
      var hits = LIST.filter(function (c) { return c.dial === code; });
      if (!hits.length) continue;
      var iso = PREFERRED[code] && BY_ISO[PREFERRED[code]] ? PREFERRED[code] : hits[0].iso;
      return { iso: iso, national: d.slice(len) };
    }
    return null;
  }

  function enhance(input) {
    if (input.dataset.phEnhanced) return;
    input.dataset.phEnhanced = '1';

    var wrap = document.createElement('span');
    wrap.className = 'ph-wrap';
    var cs = window.getComputedStyle(input);
    wrap.style.marginTop = cs.marginTop; wrap.style.marginBottom = cs.marginBottom;
    input.parentNode.insertBefore(wrap, input);

    var cc = document.createElement('span');
    cc.className = 'ph-cc';
    // match the page's own field corners
    var r = cs.borderTopLeftRadius || '10px';
    cc.style.borderRadius = r + ' 0 0 ' + r;
    input.style.setProperty('border-radius', '0 ' + r + ' ' + r + ' 0', 'important');
    var face = document.createElement('span');
    var sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Country code' + (input.id ? ' for ' + (labelText(input) || 'phone') : ''));
    LIST.forEach(function (c, i) {
      var o = document.createElement('option');
      o.value = c.iso;
      o.textContent = c.name + ' (+' + c.dial + ')';
      sel.appendChild(o);
      if (i === 1) { // divider after India and the USA
        var sep = document.createElement('option');
        sep.disabled = true; sep.textContent = '────────';
        sel.appendChild(sep);
      }
    });
    cc.appendChild(face);
    cc.insertAdjacentHTML('beforeend', CHEVRON);
    cc.appendChild(sel);
    wrap.appendChild(cc);
    wrap.appendChild(input);

    input.type = 'tel';
    input.setAttribute('inputmode', 'tel');
    input.setAttribute('autocomplete', input.getAttribute('autocomplete') === 'tel' ? 'tel-national' : (input.getAttribute('autocomplete') || 'tel-national'));
    if (/^\s*\+/.test(input.placeholder)) input.placeholder = input.placeholder.replace(/^\s*\+\d+\s*/, '');

    function paint() {
      var c = BY_ISO[sel.value] || BY_ISO.IN;
      face.innerHTML = '<span class="ph-iso">' + c.iso + '</span> +' + c.dial;
      if (sel.value === 'IN' || sel.value === 'US' || sel.value === 'CA') {
        input.placeholder = sel.value === 'IN' ? '98765 43210' : '(555) 123-4567';
      } else if (!input.dataset.phKeepPlaceholder) {
        input.placeholder = 'Phone number';
      }
    }
    sel.addEventListener('change', function () { sel.dataset.touched = '1'; paint(); input.dispatchEvent(new Event('input', { bubbles: true })); });

    input._phSelect = sel;
    setCountry(input, input.getAttribute('data-phone-country') || 'IN', true);
    if (/^\s*(\+|00)/.test(input.value)) setValue(input, input.value);
    paint();
    input._phPaint = paint;

    // A pasted or typed "+44 20..." picks its own country once the field is
    // left (not mid-typing, where "+1" would snap to the USA before "+1268").
    function absorb() {
      var v = input.value;
      if (/^\s*(\+|00)\d/.test(v)) {
        var p = parse(v.replace(/^\s*00/, '+'));
        if (p) { sel.value = p.iso; sel.dataset.touched = '1'; input.value = p.national; paint(); }
      }
    }
    input.addEventListener('change', absorb);
    input.addEventListener('paste', function () { setTimeout(absorb, 0); });
  }

  function labelText(input) {
    var l = input.id && document.querySelector('label[for="' + input.id + '"]');
    return l ? l.textContent.replace(/\*|\(.*?\)/g, '').trim().toLowerCase() : '';
  }

  // Follow another country control, unless the person already picked a code.
  function setCountry(input, iso, force) {
    var sel = input._phSelect;
    if (!sel || !BY_ISO[iso]) return;
    if (!force && sel.dataset.touched) return;
    sel.value = iso;
    if (input._phPaint) input._phPaint();
  }

  function setValue(input, full) {
    var sel = input._phSelect;
    var v = String(full || '').trim();
    if (!sel) { input.value = v; return; }
    if (/^(\+|00)/.test(v)) {
      var p = parse(v.replace(/^00/, '+'));
      if (p) { sel.value = p.iso; input.value = p.national; if (input._phPaint) input._phPaint(); return; }
    }
    input.value = v;
  }

  function value(input) {
    var sel = input._phSelect;
    var raw = String(input.value || '').trim();
    if (!raw) return '';
    if (!sel) return raw;
    if (/^(\+|00)/.test(raw)) return '+' + digits(raw.replace(/^00/, ''));
    var c = BY_ISO[sel.value] || BY_ISO.IN;
    var n = digits(raw);
    if (!KEEPS_ZERO[c.iso]) n = n.replace(/^0+/, '');
    // "1 555..." typed into a +1 field, or "91 98765..." into +91.
    if (n.length > 10 && n.indexOf(c.dial) === 0 && (c.iso === 'IN' || c.dial === '1')) n = n.slice(c.dial.length);
    return '+' + c.dial + n;
  }

  function error(input) {
    var full = value(input);
    if (!full) return input.required ? 'Enter a phone number.' : '';
    var sel = input._phSelect;
    var iso = sel ? sel.value : 'IN';
    var c = BY_ISO[iso] || BY_ISO.IN;
    var n = full.slice(1 + c.dial.length);
    if (iso === 'IN' && !/^[6-9]\d{9}$/.test(n)) return 'Enter a 10-digit Indian mobile number.';
    if (c.dial === '1' && !/^\d{10}$/.test(n)) return 'Enter a 10-digit number.';
    if (n.length < 4 || full.length > 16) return 'Check the phone number.';
    return '';
  }

  function scan(root) {
    (root && root.querySelectorAll ? root : document).querySelectorAll('input[data-phone]').forEach(enhance);
  }

  window.PhoneField = { enhance: enhance, value: value, error: error, setCountry: setCountry, setValue: setValue, scan: scan };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { scan(document); });
  else scan(document);
})();
