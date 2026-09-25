// Vendor profile completion: the one definition every screen quotes.
//
// The vendor dashboard (/api/vendor/dashboard), the recommendations panel
// (/api/reco/vendor) and the admin upsell list each used to compute their own
// percentage from different inputs — the dashboard weighted account steps
// (claim, approval, email), the reco panel counted eight profile fields — so
// the same vendor read 70% on one screen and 25% on the next. Every caller now
// passes what it knows to profileCompletion() and prints the same number.

import { isVendorApproved } from '../shared/vendor-status.js';

export interface ProfileCompletionInput {
  listingId: string | null;
  status: string;
  email: string | null;
  emailVerified?: boolean | null;
  imageUrl?: string | null;
  /** Vendor.galleryImages: JSON text array. */
  galleryImages?: string | null;
  about?: string | null;
  servicesList?: string | null;
  openingHours?: string | null;
  website?: string | null;
  whatsapp?: string | null;
  /** The claimed directory listing's own website, which also counts. */
  listingWebsite?: string | null;
  /** Rows in the services table; a priced service counts as listing services. */
  serviceCount?: number;
  /** Any review (any status) on the vendor or its listing. */
  hasReviews?: boolean;
}

/**
 * Checklist keys. The account-step keys (claim_listing, add_email,
 * admin_approve, add_services, collect_reviews) are the ones the vendor
 * dashboard already binds one-click actions to; keep them stable.
 */
export type CompletionKey =
  | 'claim_listing'
  | 'admin_approve'
  | 'add_email'
  | 'add_photo'
  | 'add_gallery'
  | 'add_about'
  | 'add_services'
  | 'add_hours'
  | 'add_website'
  | 'add_whatsapp'
  | 'collect_reviews';

/** The older /api/reco/vendor `completeness.missing` vocabulary, still served. */
export type LegacyMissing = 'photo' | 'gallery' | 'about' | 'services' | 'hours' | 'website' | 'whatsapp' | 'email_verified';

export interface CompletionItem {
  key: CompletionKey;
  label: string;
  done: boolean;
  weight: number;
}

export interface ProfileCompletion {
  percent: number;
  checklist: CompletionItem[];
  /** Open profile fields in the legacy vocabulary (account steps excluded). */
  missing: LegacyMissing[];
}

const has = (s: string | null | undefined) => !!s && s.trim().length > 0;

function nonEmptyJsonArray(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length > 0;
  } catch {
    return raw.trim().length > 0;
  }
}

/** Weights sum to 100. */
export function profileCompletion(v: ProfileCompletionInput): ProfileCompletion {
  const servicesDone = has(v.servicesList) || (v.serviceCount ?? 0) > 0;
  const websiteDone = has(v.website) || has(v.listingWebsite);
  const emailDone = !!v.email && !!v.emailVerified;
  const checklist: CompletionItem[] = [
    { key: 'claim_listing', label: 'Claim your listing', done: !!v.listingId, weight: 15 },
    // CLAIMED is an approved state too (claim flow), not only ACTIVE.
    { key: 'admin_approve', label: 'Approval from Pets24x7 admin', done: isVendorApproved(v.status), weight: 10 },
    // An unverified address does not count: it is where receipts and enquiry
    // alerts go, so it has to be one we know reaches them.
    { key: 'add_email', label: 'Add and verify a business email', done: emailDone, weight: 10 },
    { key: 'add_photo', label: 'Add a storefront photo', done: has(v.imageUrl), weight: 10 },
    { key: 'add_gallery', label: 'Add gallery photos', done: nonEmptyJsonArray(v.galleryImages), weight: 5 },
    { key: 'add_about', label: 'Describe your business', done: has(v.about), weight: 10 },
    { key: 'add_services', label: 'List at least one service', done: servicesDone, weight: 10 },
    { key: 'add_hours', label: 'Add opening hours', done: has(v.openingHours), weight: 10 },
    { key: 'add_website', label: 'Add your website', done: websiteDone, weight: 5 },
    { key: 'add_whatsapp', label: 'Add a WhatsApp number', done: has(v.whatsapp), weight: 10 },
    { key: 'collect_reviews', label: 'Collect your first review', done: !!v.hasReviews, weight: 5 },
  ];
  const percent = Math.min(100, checklist.reduce((s, i) => s + (i.done ? i.weight : 0), 0));

  const missing: LegacyMissing[] = [];
  if (!has(v.imageUrl)) missing.push('photo');
  if (!nonEmptyJsonArray(v.galleryImages)) missing.push('gallery');
  if (!has(v.about)) missing.push('about');
  if (!servicesDone) missing.push('services');
  if (!has(v.openingHours)) missing.push('hours');
  if (!websiteDone) missing.push('website');
  if (!has(v.whatsapp)) missing.push('whatsapp');
  if (!emailDone) missing.push('email_verified');

  return { percent, checklist, missing };
}
