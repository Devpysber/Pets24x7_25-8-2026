// Recommendation engine.
//
// Ranks listings for one pet parent from signals we actually hold: the pets on
// the account, what the parent has enquired about or saved, the city, and each
// listing's public Google rating. Every recommendation carries the reasons that
// produced it, so the UI can show *why* — an unexplained list is indistinguishable
// from a random one.
//
// Deliberately synchronous and pure once the inputs are gathered: no network, no
// model, no hidden state. Tunable weights live in WEIGHTS.

import type { ListingRecord } from '../listings/index.js';

export interface PetSignal {
  species: string;
  breed?: string | null;
  ageYears?: number | null;
  vaccinated?: boolean;
}

export interface RecommendInput {
  pets: PetSignal[];
  /** Category slugs the parent already enquired about, newest first. */
  enquiredCategories: string[];
  /** Category slugs the parent saved. */
  savedCategories: string[];
  /** Listing ids already enquired about or saved — demoted, not hidden. */
  knownListingIds: string[];
  /** Listing ids with an active paid Featured placement. */
  featuredListingIds: string[];
  /** Listing ids claimed by an approved vendor. */
  claimedListingIds: string[];
}

export interface Recommendation {
  listing: ListingRecord;
  score: number;
  reasons: string[];
}

const WEIGHTS = {
  rating: 30, // 0..1 normalised Google rating
  reviews: 12, // log-scaled review volume — confidence in that rating
  petNeed: 26, // category matches what these pets need
  affinity: 22, // category the parent has already shown interest in
  claimed: 10, // a real owner is behind the listing, so enquiries get answered
  featured: 14, // paid placement, applied only after relevance
  contactable: 6, // has a phone number
  seenPenalty: -40, // already enquired about or saved
};

/**
 * Category needs implied by a pet. Keyed by category_slug so this survives
 * display-name copy edits.
 */
function needsForPet(pet: PetSignal): Array<{ slug: string; reason: string; weight: number }> {
  const out: Array<{ slug: string; reason: string; weight: number }> = [];
  const species = String(pet.species || '').toUpperCase();
  const age = typeof pet.ageYears === 'number' ? pet.ageYears : null;
  const name = 'your pet';

  if (pet.vaccinated === false) {
    out.push({ slug: 'vaccination-centers', reason: `${name} is not marked vaccinated`, weight: 1 });
  }

  if (species === 'DOG') {
    out.push(
      { slug: 'pet-walking', reason: 'dogs need regular walks', weight: 0.8 },
      { slug: 'pet-training-obedience-behavior', reason: 'training for dogs', weight: 0.6 },
      { slug: 'pet-grooming-spa', reason: 'grooming for dogs', weight: 0.7 },
      { slug: 'pet-boarding-daycare', reason: 'boarding when you travel', weight: 0.6 },
    );
  } else if (species === 'CAT') {
    out.push(
      { slug: 'pet-sitting-in-home-care', reason: 'cats do better sitting at home', weight: 0.9 },
      { slug: 'pet-grooming-spa', reason: 'grooming for cats', weight: 0.6 },
      { slug: 'veterinary-clinics', reason: 'routine cat check-ups', weight: 0.6 },
    );
  } else if (species === 'BIRD' || species === 'REPTILE' || species === 'SMALL_MAMMAL') {
    out.push(
      { slug: 'specialty-vets-exotics-avian-reptiles', reason: `specialist vets treat ${species.toLowerCase().replace('_', ' ')}s`, weight: 1 },
      { slug: 'pet-sitting-in-home-care', reason: 'in-home care suits exotics', weight: 0.5 },
    );
  } else {
    out.push({ slug: 'veterinary-clinics', reason: 'general vet care', weight: 0.5 });
  }

  if (age != null && age >= 8) {
    out.push(
      { slug: 'pet-physiotherapy-rehab', reason: 'senior pets benefit from physio', weight: 0.8 },
      { slug: 'pet-dental-care', reason: 'dental care matters more with age', weight: 0.7 },
    );
  }
  if (age != null && age <= 1) {
    out.push(
      { slug: 'vaccination-centers', reason: 'puppies and kittens need their shot course', weight: 0.9 },
      { slug: 'pet-training-obedience-behavior', reason: 'early training sticks best', weight: 0.7 },
    );
  }

  // Everyone should know where the nearest emergency hospital is.
  out.push({ slug: 'emergency-animal-hospital', reason: 'good to have an emergency vet saved', weight: 0.35 });
  return out;
}

/** 0..1 confidence from review volume; 200+ reviews is treated as saturated. */
function reviewConfidence(count: number): number {
  if (!count || count < 0) return 0;
  return Math.min(1, Math.log10(count + 1) / Math.log10(201));
}

export function recommend(
  listings: ListingRecord[],
  input: RecommendInput,
  limit = 12,
): Recommendation[] {
  const featured = new Set(input.featuredListingIds);
  const claimed = new Set(input.claimedListingIds);
  const known = new Set(input.knownListingIds);

  // Collapse per-pet needs into one weighted map, keeping the best reason text.
  const need = new Map<string, { weight: number; reason: string }>();
  for (const pet of input.pets) {
    for (const n of needsForPet(pet)) {
      const cur = need.get(n.slug);
      if (!cur || n.weight > cur.weight) need.set(n.slug, { weight: n.weight, reason: n.reason });
    }
  }

  // Recency-weighted affinity: the most recent enquiry counts most.
  const affinity = new Map<string, number>();
  input.enquiredCategories.forEach((slug, i) => {
    if (!slug) return;
    affinity.set(slug, Math.max(affinity.get(slug) ?? 0, 1 / (1 + i * 0.5)));
  });
  for (const slug of input.savedCategories) {
    if (!slug) continue;
    affinity.set(slug, Math.max(affinity.get(slug) ?? 0, 0.7));
  }

  // With no pets, no enquiries and nothing saved there is nothing to be
  // relevant *to*. Rather than return an almost-empty list, fall back to
  // ranking the city on public signals alone and say so in the reason.
  const hasSignals = need.size > 0 || affinity.size > 0;

  const scored: Recommendation[] = [];
  for (const l of listings) {
    const slug = l.category_slug || '';
    const reasons: string[] = [];
    let score = 0;

    const rating = typeof l.rating === 'number' ? l.rating : 0;
    if (rating > 0) {
      score += WEIGHTS.rating * Math.max(0, (rating - 3) / 2); // 3.0 → 0, 5.0 → 1
      if (rating >= 4.7) reasons.push(`${rating.toFixed(1)}★ on Google`);
    }

    const conf = reviewConfidence(l.review_count);
    score += WEIGHTS.reviews * conf;
    if (l.review_count >= 100) reasons.push(`${l.review_count} Google reviews`);

    const n = need.get(slug);
    if (n) {
      score += WEIGHTS.petNeed * n.weight;
      reasons.push(n.reason);
    }

    const aff = affinity.get(slug) ?? 0;
    if (aff > 0) {
      score += WEIGHTS.affinity * aff;
      reasons.push(`you looked at ${l.category.toLowerCase()} before`);
    }

    if (claimed.has(l.id)) {
      score += WEIGHTS.claimed;
      reasons.push('owner-managed on Pets24x7');
    }
    if (featured.has(l.id)) {
      score += WEIGHTS.featured;
      reasons.push('featured');
    }
    if (l.phone) score += WEIGHTS.contactable;

    if (known.has(l.id)) {
      score += WEIGHTS.seenPenalty;
      reasons.push('you already contacted them');
    }

    // Nothing relevant matched — skip rather than pad the list with filler.
    // Only applies once we have something to be relevant to.
    if (hasSignals && !n && aff === 0 && !featured.has(l.id)) continue;
    if (!hasSignals && reasons.length === 0) reasons.push(`well rated in ${l.city}`);

    scored.push({ listing: l, score, reasons: reasons.slice(0, 3) });
  }

  scored.sort((a, b) => b.score - a.score);

  // Spread categories so one category can't monopolise the list: at most 3 of
  // any single category before every other category has had a turn.
  const perCategory = new Map<string, number>();
  const spread: Recommendation[] = [];
  const overflow: Recommendation[] = [];
  for (const r of scored) {
    const slug = r.listing.category_slug || 'other';
    const used = perCategory.get(slug) ?? 0;
    if (used < 3) {
      perCategory.set(slug, used + 1);
      spread.push(r);
    } else {
      overflow.push(r);
    }
    if (spread.length >= limit) break;
  }
  return [...spread, ...overflow].slice(0, limit);
}
