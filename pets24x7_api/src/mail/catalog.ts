// Admin-facing registry of every transactional template.
//
// Each entry knows how to build itself from a plain data object, and carries
// realistic sample data so the admin preview renders without a live parent,
// vendor or payment on hand. Keep this in sync when a template is added —
// scripts/mail-preview.ts and the admin console both read from here.

import type { MailInput } from './mailer.js';
import type { MailKind } from './optout.js';
import { Button, Note, Text, esc, page } from './components.js';
import { verifyEmail, welcomeEmail } from './templates.js';
import * as T from './action-templates.js';

export interface CatalogEntry {
  id: string;
  category: 'Generic' | 'Pet parent' | 'Vendor' | 'Payments';
  label: string;
  description: string;
  /**
   * How an admin-console send of this template is classified. Defaults to
   * 'marketing' at the send site — opt-outs are honoured unless a template is
   * explicitly a transactional re-send (a verification link, a receipt).
   */
  kind?: MailKind;
  /** Realistic filler so a preview renders with no live row. */
  sample: Record<string, unknown>;
  build: (to: string, d: Record<string, any>) => MailInput;
}

const soon = () => new Date(Date.now() + 30 * 864e5);
const PARENT = 'Ashish';
const BIZ = "Coco's Pet Boarding";
const PLAN = { name: 'Gold · Monthly', priceMinor: 49900, currency: 'INR', discountPercent: 30 };

/** Free-form message an admin types — the one template with no fixed copy. */
function customEmail(to: string, d: Record<string, any>): MailInput {
  const bodyHtml = String(d.message ?? '')
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:24px">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return {
    to,
    subject: String(d.subject ?? 'A message from Pets24x7'),
    html: page({
      eyebrow: d.eyebrow ? String(d.eyebrow) : undefined,
      heading: String(d.heading ?? d.subject ?? 'A message from Pets24x7'),
      intro: bodyHtml ? '' : 'No message body.',
      blocks: [
        ...(bodyHtml ? [Text(bodyHtml)] : []),
        ...(d.buttonUrl && d.buttonLabel ? [Button(String(d.buttonLabel), String(d.buttonUrl))] : []),
        ...(d.footnote ? [Note(esc(String(d.footnote)))] : []),
      ],
      preheader: String(d.subject ?? ''),
    }),
    text: `${String(d.message ?? '')}\n${d.buttonUrl ? `\n${d.buttonUrl}\n` : ''}`,
  };
}

export const MAIL_CATALOG: CatalogEntry[] = [
  {
    id: 'custom',
    category: 'Generic',
    label: 'Free-form message',
    description: 'Type your own subject and body. Wrapped in the branded Pets24x7 layout, with an optional button.',
    sample: {
      subject: 'A quick update from Pets24x7',
      heading: 'A quick update',
      message: 'Hi there,\n\nWe have added new boarding partners in your city this week.\n\n— Team Pets24x7',
      buttonLabel: 'Browse services',
      buttonUrl: 'https://pets24x7.com/',
    },
    build: customEmail,
  },

  {
    id: 'admin/import_finished',
    kind: 'transactional',
    category: 'Generic',
    label: 'Import finished',
    description: 'Summary emailed to the admin who ran a bulk import.',
    sample: {
      name: 'Admin',
      job: { target: 'Vendors / businesses', fileName: 'vendors-august.csv', totalRows: 240, created: 198, updated: 34, skipped: 6, failed: 2 },
    },
    build: (to, d) => T.importFinishedEmail(to, d.name, d.job),
  },

  // ---------------- Pet parent ----------------
  {
    id: 'parent/welcome',
    kind: 'transactional',
    category: 'Pet parent',
    label: 'Welcome',
    description: 'Sent once, when a pet parent first signs in or verifies their email.',
    sample: { name: PARENT },
    build: (to, d) => welcomeEmail(to, d.name),
  },
  {
    id: 'parent/verify',
    kind: 'transactional',
    category: 'Pet parent',
    label: 'Verify email',
    description: 'One-time verification link. Dies on first click, expires after the configured TTL.',
    sample: { name: PARENT, link: 'https://pets24x7.com/api/parent/email/verify?token=sample', ttlMinutes: 10 },
    build: (to, d) => verifyEmail(to, d.name, d.link, Number(d.ttlMinutes ?? 10)),
  },
  {
    id: 'parent/login_alert',
    kind: 'transactional',
    category: 'Pet parent',
    label: 'New sign-in alert',
    description: 'Security notice on every sign-in after the first.',
    sample: { name: PARENT, ip: '49.36.12.8', device: 'Chrome on Windows' },
    build: (to, d) => T.loginAlertEmail(to, d.name, new Date(), d.ip ?? null, d.device ?? null),
  },
  {
    id: 'parent/profile_updated',
    kind: 'transactional',
    category: 'Pet parent',
    label: 'Profile updated',
    description: 'Confirms a change to name, email, city or country.',
    sample: { name: PARENT, changed: ['name', 'city'] },
    build: (to, d) => T.profileUpdatedEmail(to, d.name, d.changed ?? []),
  },
  {
    id: 'parent/pet_added',
    kind: 'transactional',
    category: 'Pet parent',
    label: 'Pet added',
    description: 'A pet was added to the parent profile.',
    sample: { name: PARENT, pet: { name: 'Bruno', species: 'DOG', breed: 'Labrador', ageYears: 3 } },
    build: (to, d) => T.petAddedEmail(to, d.name, d.pet),
  },
  {
    id: 'parent/pet_updated',
    kind: 'transactional',
    category: 'Pet parent',
    label: 'Pet updated',
    description: "A pet's details changed.",
    sample: { name: PARENT, petName: 'Bruno' },
    build: (to, d) => T.petUpdatedEmail(to, d.name, d.petName),
  },
  {
    id: 'parent/pet_photo_updated',
    kind: 'transactional',
    category: 'Pet parent',
    label: 'Pet photo updated',
    description: "A pet's profile photo was added, replaced or removed.",
    sample: { name: PARENT, petName: 'Bruno', removed: false },
    build: (to, d) => T.petPhotoUpdatedEmail(to, d.name, d.petName, Boolean(d.removed)),
  },
  {
    id: 'parent/pet_removed',
    kind: 'transactional',
    category: 'Pet parent',
    label: 'Pet removed',
    description: 'A pet was deleted from the profile.',
    sample: { name: PARENT, petName: 'Bruno' },
    build: (to, d) => T.petRemovedEmail(to, d.name, d.petName),
  },
  {
    id: 'parent/recommendations',
    category: 'Pet parent',
    label: 'Personalised recommendations',
    description: "Ranked picks from the parent's pets, past enquiries and city. Sent when they add their first pet, and available to send by hand.",
    sample: {
      name: PARENT,
      petName: 'Bruno',
      items: [
        { name: "Coco's Pet Boarding and Homestay", category: 'Pet Boarding & Daycare', city: 'Mumbai', rating: 5, reviewCount: 475, reasons: ['boarding when you travel', '5.0★ on Google'] },
        { name: 'All 4 Pet Care NX', category: 'Pet Walking', city: 'Mumbai', rating: 5, reviewCount: 461, reasons: ['dogs need regular walks'] },
        { name: 'Hakimji Clinic', category: 'Emergency Animal Hospital', city: 'Mumbai', rating: 5, reviewCount: 475, reasons: ['good to have an emergency vet saved'] },
      ],
    },
    build: (to, d) => T.recommendationsEmail(to, d.name, d.petName ?? null, d.items ?? []),
  },
  {
    id: 'parent/listing_saved',
    kind: 'transactional',
    category: 'Pet parent',
    label: 'Business saved',
    description: 'A listing was bookmarked to the parent account.',
    sample: { name: PARENT, listingName: BIZ },
    build: (to, d) => T.listingSavedEmail(to, d.name, d.listingName ?? null),
  },
  {
    id: 'parent/listing_unsaved',
    kind: 'transactional',
    category: 'Pet parent',
    label: 'Business unsaved',
    description: 'A saved business was removed from the parent account.',
    sample: { name: PARENT, listingName: BIZ },
    build: (to, d) => T.listingUnsavedEmail(to, d.name, d.listingName ?? null),
  },
  {
    id: 'parent/enquiry_received',
    kind: 'transactional',
    category: 'Pet parent',
    label: 'Enquiry acknowledged',
    description: "Confirms the parent's enquiry reached the business.",
    sample: { name: PARENT, listingName: BIZ },
    build: (to, d) => T.enquiryReceivedEmail(to, d.name, d.listingName ?? null),
  },
  {
    id: 'parent/enquiry_status',
    kind: 'transactional',
    category: 'Pet parent',
    label: 'Enquiry status changed',
    description: 'Vendor or admin moved the enquiry to responded / completed / archived.',
    sample: { name: PARENT, listingName: BIZ, status: 'RESPONDED' },
    build: (to, d) => T.enquiryStatusEmail(to, d.name, d.listingName ?? null, d.status ?? 'RESPONDED'),
  },

  // ---------------- Payments & membership ----------------
  {
    id: 'payment/membership_activated',
    kind: 'transactional',
    category: 'Payments',
    label: 'Membership activated',
    description: 'Receipt sent the moment a membership payment clears.',
    sample: { name: PARENT, plan: PLAN, merchantTxnId: 'P24_SAMPLE_1' },
    build: (to, d) => T.membershipActivatedEmail(to, d.name, d.plan, soon(), d.merchantTxnId),
  },
  {
    id: 'payment/membership_cancelled',
    kind: 'transactional',
    category: 'Payments',
    label: 'Auto-renew turned off',
    description: 'Parent cancelled auto-renew; benefits run to the end of the term.',
    sample: { name: PARENT, planName: PLAN.name },
    build: (to, d) => T.membershipCancelledEmail(to, d.name, d.planName, soon()),
  },
  {
    id: 'payment/membership_resumed',
    kind: 'transactional',
    category: 'Payments',
    label: 'Auto-renew resumed',
    description: 'Parent switched auto-renew back on.',
    sample: { name: PARENT, planName: PLAN.name },
    build: (to, d) => T.membershipResumedEmail(to, d.name, d.planName, soon()),
  },
  {
    id: 'payment/membership_expired',
    kind: 'transactional',
    category: 'Payments',
    label: 'Membership ended',
    description: 'Sent by the expiry sweep when a term runs out.',
    sample: { name: PARENT, planName: PLAN.name },
    build: (to, d) => T.membershipExpiredEmail(to, d.name, d.planName),
  },
  {
    id: 'payment/failed',
    kind: 'transactional',
    category: 'Payments',
    label: 'Payment failed',
    description: 'Gateway reported a failure; nothing was activated.',
    sample: { name: PARENT, what: 'your Gold · Monthly membership', amountMinor: 49900, currency: 'INR', merchantTxnId: 'P24_SAMPLE_2' },
    build: (to, d) => T.paymentFailedEmail(to, d.name, d.what, Number(d.amountMinor), d.currency ?? 'INR', d.merchantTxnId),
  },
  {
    id: 'payment/refunded',
    kind: 'transactional',
    category: 'Payments',
    label: 'Refund issued',
    description: 'Admin refunded a successful payment.',
    sample: { name: PARENT, what: 'your Gold · Monthly membership', amountMinor: 49900, currency: 'INR', merchantTxnId: 'P24_SAMPLE_3' },
    build: (to, d) => T.paymentRefundedEmail(to, d.name, d.what, Number(d.amountMinor), d.currency ?? 'INR', d.merchantTxnId),
  },

  // ---------------- Vendor ----------------
  {
    id: 'vendor/new_enquiry',
    kind: 'transactional',
    category: 'Vendor',
    label: 'New enquiry lead',
    description: 'A pet parent enquired about the claimed listing.',
    sample: {
      businessName: BIZ,
      enquiry: { name: PARENT, phone: '+919930090487', petType: 'Dog', notes: 'Need boarding for 3 nights.', city: 'Mumbai' },
    },
    build: (to, d) =>
      T.vendorNewEnquiryEmail(to, d.businessName, {
        name: d.enquiry?.name,
        phone: d.enquiry?.phone,
        petType: d.enquiry?.petType ?? null,
        preferredDate: d.enquiry?.preferredDate ? new Date(d.enquiry.preferredDate) : soon(),
        notes: d.enquiry?.notes ?? '',
        city: d.enquiry?.city ?? null,
      }),
  },
  {
    id: 'vendor/welcome',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Listing claimed',
    description: 'First successful claim of a listing.',
    sample: { businessName: BIZ, listingName: "Coco's Pet Boarding and Homestay" },
    build: (to, d) => T.vendorWelcomeEmail(to, d.businessName, d.listingName),
  },
  {
    id: 'vendor/profile_updated',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Business profile updated',
    description: 'Public listing details were changed by the vendor.',
    sample: { businessName: BIZ, changed: ['businessName', 'imageUrl'] },
    build: (to, d) => T.vendorProfileUpdatedEmail(to, d.businessName, d.changed ?? []),
  },
  {
    id: 'vendor/approved',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Vendor approved',
    description: 'Admin approved the claim; listing is live.',
    sample: { businessName: BIZ },
    build: (to, d) => T.vendorApprovedEmail(to, d.businessName),
  },
  {
    id: 'vendor/rejected',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Claim rejected',
    description: 'Admin rejected the claim, with an optional reason.',
    sample: { businessName: BIZ, reason: 'Phone number did not match the listing.' },
    build: (to, d) => T.vendorRejectedEmail(to, d.businessName, d.reason ?? null),
  },
  {
    id: 'vendor/suspended',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Vendor suspended',
    description: 'Listing hidden and no longer receiving enquiries.',
    sample: { businessName: BIZ },
    build: (to, d) => T.vendorSuspendedEmail(to, d.businessName),
  },
  {
    id: 'vendor/service_added',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Service added',
    description: 'A service was published on the listing.',
    sample: { businessName: BIZ, service: { name: 'Night boarding', priceMinor: 90000, currency: 'INR', durationLabel: 'Per night' } },
    build: (to, d) => T.serviceAddedEmail(to, d.businessName, d.service),
  },
  {
    id: 'vendor/service_updated',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Service updated',
    description: 'Service details changed.',
    sample: { businessName: BIZ, serviceName: 'Night boarding' },
    build: (to, d) => T.serviceUpdatedEmail(to, d.businessName, d.serviceName),
  },
  {
    id: 'vendor/service_removed',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Service removed',
    description: 'Service deleted from the listing.',
    sample: { businessName: BIZ, serviceName: 'Night boarding' },
    build: (to, d) => T.serviceRemovedEmail(to, d.businessName, d.serviceName),
  },
  {
    id: 'vendor/service_moderated',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Service hidden / restored',
    description: 'Admin moderation hid or restored a service.',
    sample: { businessName: BIZ, serviceName: 'Night boarding', status: 'HIDDEN' },
    build: (to, d) => T.serviceModeratedEmail(to, d.businessName, d.serviceName, d.status === 'ACTIVE' ? 'ACTIVE' : 'HIDDEN'),
  },
  {
    id: 'vendor/review_requests_sent',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Review requests sent',
    description: 'Summary after a bulk WhatsApp review-request run.',
    sample: { businessName: BIZ, stats: { sent: 12, failed: 1, remainingToday: 37 } },
    build: (to, d) => T.reviewRequestsSentEmail(to, d.businessName, d.stats),
  },
  {
    id: 'vendor/new_review',
    kind: 'transactional',
    category: 'Vendor',
    label: 'New review received',
    description: 'A customer submitted a review; still pending moderation.',
    sample: { businessName: BIZ, review: { reviewerName: 'Priya', rating: 5, text: 'Took great care of my labrador.' } },
    build: (to, d) => T.vendorNewReviewEmail(to, d.businessName, d.review),
  },
  {
    id: 'vendor/review_published',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Review published',
    description: 'Moderation approved a review; it is now public.',
    sample: { businessName: BIZ, review: { reviewerName: 'Priya', rating: 5 } },
    build: (to, d) => T.reviewPublishedEmail(to, d.businessName, d.review),
  },
  {
    id: 'vendor/review_rejected',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Review rejected',
    description: 'Moderation blocked a review, with an optional reason.',
    sample: { businessName: BIZ, review: { reviewerName: 'Priya', rating: 2 }, reason: 'Contained personal contact details.' },
    build: (to, d) => T.reviewRejectedEmail(to, d.businessName, d.review, d.reason ?? null),
  },
  {
    id: 'vendor/review_reply_posted',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Reply posted',
    description: "The vendor's reply is live under a review.",
    sample: { businessName: BIZ, reviewerName: 'Priya' },
    build: (to, d) => T.reviewReplyPostedEmail(to, d.businessName, d.reviewerName),
  },
  {
    id: 'vendor/campaign_created',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Campaign awaiting payment',
    description: 'Campaign reserved at checkout, payment not yet cleared.',
    sample: { businessName: BIZ, campaign: { goal: 'LEADS', durationDays: 30, priceMinor: 299900, currency: 'INR' }, merchantTxnId: 'P24_SAMPLE_4' },
    build: (to, d) => T.campaignCreatedEmail(to, d.businessName, d.campaign, d.merchantTxnId),
  },
  {
    id: 'vendor/campaign_submitted',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Campaign paid, in review',
    description: 'Payment cleared; awaiting admin approval.',
    sample: { businessName: BIZ, campaign: { goal: 'LEADS', durationDays: 30, priceMinor: 299900, currency: 'INR' }, merchantTxnId: 'P24_SAMPLE_4' },
    build: (to, d) => T.campaignSubmittedEmail(to, d.businessName, d.campaign, d.merchantTxnId),
  },
  {
    id: 'vendor/campaign_approved',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Campaign live',
    description: 'Admin approved the campaign; the clock has started.',
    sample: { businessName: BIZ, campaign: { goal: 'LEADS', durationDays: 30 } },
    build: (to, d) => T.campaignApprovedEmail(to, d.businessName, d.campaign, soon()),
  },
  {
    id: 'vendor/campaign_cancelled',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Campaign cancelled',
    description: 'Campaign stopped before or during its run.',
    sample: { businessName: BIZ, goal: 'LEADS' },
    build: (to, d) => T.campaignCancelledEmail(to, d.businessName, d.goal),
  },
  {
    id: 'vendor/campaign_completed',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Campaign finished',
    description: 'Campaign ran its full term.',
    sample: { businessName: BIZ, goal: 'LEADS' },
    build: (to, d) => T.campaignCompletedEmail(to, d.businessName, d.goal),
  },
  {
    id: 'vendor/featured_created',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Featured awaiting payment',
    description: 'Featured placement reserved at checkout, payment not yet cleared.',
    sample: { businessName: BIZ, featured: { priceMinor: 199900, currency: 'INR', durationDays: 30 }, merchantTxnId: 'P24_SAMPLE_5' },
    build: (to, d) => T.featuredCreatedEmail(to, d.businessName, d.featured, d.merchantTxnId),
  },
  {
    id: 'vendor/featured_live',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Listing featured',
    description: 'Featured placement paid and active.',
    sample: { businessName: BIZ, featured: { priceMinor: 199900, currency: 'INR', durationDays: 30 }, merchantTxnId: 'P24_SAMPLE_5' },
    build: (to, d) => T.featuredLiveEmail(to, d.businessName, d.featured, soon(), d.merchantTxnId),
  },
  {
    id: 'vendor/featured_ended',
    kind: 'transactional',
    category: 'Vendor',
    label: 'Featured ended / cancelled',
    description: 'Placement expired, or was cancelled by an admin.',
    sample: { businessName: BIZ, cancelled: false },
    build: (to, d) => T.featuredEndedEmail(to, d.businessName, Boolean(d.cancelled)),
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return MAIL_CATALOG.find((e) => e.id === id);
}
