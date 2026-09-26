// Reason codes — why an item was recommended.
//
// Every item carries one primary reason (the largest positive score component)
// as a closed enum plus display text, so the UI can style it and the stats can
// be grouped by it, and a legacy `reasons: string[]` whose first entry is the
// same text (the parent dashboard's chip renderer reads that).

export const REASON_CODES = [
  'PET_NEED',
  'SAVED_SIMILAR',
  'ENQUIRED_SIMILAR',
  'VIEWED_SIMILAR',
  'POPULAR_NEARBY',
  'TOP_RATED',
  'HIGHLY_REVIEWED',
  'OWNER_MANAGED',
  'PREMIUM_PARTNER',
  'NEW_IN_CITY',
  'SAME_CATEGORY',
  'SAME_AREA',
  'NEAR_CITY',
  'CITY_FALLBACK',
  'SPONSORED',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  code: ReasonCode;
  text: string;
  refListingId?: string;
  refName?: string;
}

/** A scored component that can explain itself. */
export interface Component {
  code: ReasonCode;
  value: number;
  text: string;
  refListingId?: string;
  refName?: string;
  /** False when the component moved the score but is not worth saying out loud. */
  sayable: boolean;
}

export function toReason(c: Component): Reason {
  return {
    code: c.code,
    text: c.text,
    ...(c.refListingId ? { refListingId: c.refListingId } : {}),
    ...(c.refName ? { refName: c.refName } : {}),
  };
}

/**
 * Primary reason = the biggest positive, sayable component; up to two more
 * become the secondary chips. `fallback` is used when nothing qualifies.
 */
export function pickReasons(components: Component[], fallback: Reason): { reason: Reason; reasons: string[] } {
  // A paid-plan boost is always the headline reason when present, so a
  // listing lifted by a subscription is never presented as a purely organic pick.
  const ranked = components
    .filter((c) => c.sayable && c.value > 0)
    .sort((a, b) => Number(b.code === 'PREMIUM_PARTNER') - Number(a.code === 'PREMIUM_PARTNER') || b.value - a.value);
  const reason = ranked[0] ? toReason(ranked[0]) : fallback;
  const texts = [reason.text];
  for (const c of ranked.slice(ranked[0] ? 1 : 0)) {
    if (texts.length >= 3) break;
    if (!texts.includes(c.text)) texts.push(c.text);
  }
  return { reason, reasons: texts };
}

export const text = {
  savedSimilar: (name: string) => `Because you saved ${name}`,
  enquiredSimilar: (category: string) => `Because you enquired about ${category.toLowerCase()}`,
  viewedSimilar: (name: string) => `Because you viewed ${name}`,
  petNeed: (petName: string | null, why: string) => `For ${petName || 'your pet'}: ${why}`,
  popular: (n: number, windowDays: number) =>
    `${n} pet parent${n === 1 ? '' : 's'} contacted them ${windowDays === 30 ? 'this month' : `in the last ${windowDays} days`}`,
  topRated: (rating: number) => `${rating.toFixed(1)}★ on Google`,
  highlyReviewed: (n: number) => `${n} Google reviews`,
  ownerManaged: () => 'Owner-managed on Pets24x7',
  premiumPartner: () => 'Pets24x7 premium partner',
  newInCity: (city: string) => `New in ${city}`,
  sameCategory: (category: string, city: string) => `Another ${category.toLowerCase()} in ${city}`,
  sameArea: (area: string) => `Also in ${area}`,
  nearCity: (city: string) => `Near ${city}`,
  cityFallback: (city: string) => `Also in ${city}`,
};
