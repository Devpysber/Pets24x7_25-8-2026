// Recommendation engine — legacy entry point.
//
// The ranking now lives in feed/reco/ (one engine behind the dashboard, the
// public pages, the email digest, vendor and admin insights). This wrapper keeps
// the original signature and output so existing callers (jobs/engagement.ts)
// keep compiling and behaving: it ranks the pool it is given on the shared
// engine, with the admin-tuned weights, and adds `reasonCode`.
//
// Differences from the old in-file scorer, all deliberate:
//   • paid Featured placement no longer inflates the organic score (weight
//     featuredOrganic, default 0) — sponsored slots are blended separately and
//     labelled;
//   • popularity, saves and Pets24x7 reviews from the shared signals snapshot
//     contribute, and a lapsed annual vaccination counts as a need.

import type { ListingRecord } from '../listings/index.js';
import { recoConfigSync } from './reco/config.js';
import { rank, buildIntent, type PetSignal as EnginePetSignal } from './reco/engine.js';
import type { ReasonCode } from './reco/reasons.js';
import { signals } from './reco/signals.js';

export type PetSignal = EnginePetSignal;
export { needsForPet } from './reco/engine.js';

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
  reasonCode: ReasonCode;
}

export function recommend(
  listings: ListingRecord[],
  input: RecommendInput,
  limit = 12,
): Recommendation[] {
  if (listings.length === 0 || limit <= 0) return [];
  const config = recoConfigSync();
  // Saved categories carry no listing reference here, so they count as
  // interest (affinity) exactly as the old scorer treated them.
  const intent = buildIntent(input.pets, {
    enquiries: [...input.enquiredCategories, ...input.savedCategories].map((category) => ({ listingId: null, category })),
    saved: [],
    viewed: [],
  });
  for (const id of input.knownListingIds) if (id) intent.known.add(id);

  const first = listings[0]!;
  const ranked = rank({
    city: first.city,
    country: String(first.country),
    intent,
    weights: config.weights,
    config,
    snap: signals(),
    depth: limit,
    pool: listings,
    extraClaimed: new Set(input.claimedListingIds),
    featuredIds: new Set(input.featuredListingIds),
    cityLabel: first.city,
  });
  return ranked.map((r) => ({ listing: r.listing, score: r.score, reasons: r.reasons, reasonCode: r.reason.code }));
}
