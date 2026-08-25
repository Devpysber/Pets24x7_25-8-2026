// Phone normalisation — strip everything except digits and a leading +.
// Stored format in DB: E.164 ("+919930090487"). Matching tolerates spaces, dashes, leading 0.
const DIGITS = /[^0-9+]/g;

export function normalizePhone(raw: string, defaultCountry: 'IN' | 'US' = 'IN'): string {
  if (!raw) return '';
  let p = raw.trim().replace(DIGITS, '');
  if (!p.startsWith('+')) {
    // strip leading 00
    if (p.startsWith('00')) p = '+' + p.slice(2);
    // pure 10-digit numbers get the default country code
    else if (p.length === 10) p = (defaultCountry === 'IN' ? '+91' : '+1') + p;
    // strip Indian leading 0
    else if (p.startsWith('0') && p.length === 11) p = '+91' + p.slice(1);
    else if (!p.startsWith('+')) p = '+' + p;
  }
  return p;
}

// Compact form for keying lookups against scraped Google data (which often
// stores "+91 99300 90487" or "+91-9930090487"). We only keep digits.
export function digitsOnly(raw: string): string {
  return (raw || '').replace(/[^0-9]/g, '');
}

// Return the trailing N digits of a number — useful when the scrape format
// (e.g. "+1 305-239-9299") matches the user-typed form ("3052399299") only
// on the last 10 digits.
export function lastDigits(raw: string, n: number): string {
  const d = digitsOnly(raw);
  return d.length <= n ? d : d.slice(d.length - n);
}
