// Every transactional mail Pets24x7 sends on a pet-parent or vendor action.
//
// One exported builder per action, each returning a ready MailInput. Callers
// send through notify()/notifyIf() so a mail failure never fails the action.
// Layout primitives live in components.ts.

import type { MailInput } from './mailer.js';
import { Button, CodeBlock, InfoBox, Note, Quote, Text, adminDash, day, dayTime, esc, h, money, page, parentDash, siteUrl, vendorDash, who } from './components.js';
import { campaignGoalLabel } from '../payments/pricing.js';
import { digestSubject } from './reco-templates.js';

const PARENT_DASH = () => parentDash();
const VENDOR_DASH = () => vendorDash();
const MEMBERSHIP = () => siteUrl('/membership/');

// ===========================================================================
// Pet parent — account
// ===========================================================================

/**
 * The one-time code for email-OTP sign-in. Used by pet parents, vendors and
 * admins alike — the code is the credential, so the copy never names an
 * account or says whether one exists.
 */
export function loginCodeEmail(to: string, name: string | null, code: string, ttlMinutes: number): MailInput {
  const greeting = name ? `Hi ${name}` : 'Your sign-in code';
  return {
    tag: 'login_code',
    to,
    // The subject carries the code itself, so this must never be logged verbatim.
    sensitive: true,
    subject: `${code} is your Pets24x7 sign-in code`,
    html: page({
      eyebrow: 'Sign in',
      heading: greeting,
      intro: `Enter this code to finish signing in. It expires in ${ttlMinutes} minutes.`,
      blocks: [
        CodeBlock(code),
        Note(`This code expires in ${ttlMinutes} minutes and can only be used once.`),
        Note("Didn't try to sign in? Ignore this email — nobody can get in without the code."),
      ],
      preheader: `${code} — your Pets24x7 sign-in code.`,
    }),
    text: `${greeting},

Your Pets24x7 sign-in code is ${code}.
It expires in ${ttlMinutes} minutes and can only be used once.

If you didn't try to sign in, ignore this email.
`,
  };
}

/**
 * Reader-facing names for the profile columns the update routes report as
 * changed. Those routes pass the raw keys, which read as "businessName,
 * imageUrl" in a mail. Wording follows the dashboard form labels.
 */
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  phone: 'Phone',
  email: 'Email',
  city: 'City',
  country: 'Country',
  digestFrequency: 'Recommendation emails',
  businessName: 'Business name',
  category: 'Category',
  locality: 'Locality',
  address: 'Address',
  pincode: 'PIN / ZIP code',
  website: 'Website',
  whatsapp: 'WhatsApp number',
  about: 'About',
  openingHours: 'Opening hours',
  servicesList: 'Services',
  imageUrl: 'Photo',
  galleryImages: 'Photos',
};

/** "Business name, Photo" from ['businessName', 'imageUrl']; unknown keys are de-camel-cased. */
function changedFields(changed: string[]): string {
  return changed
    .map((k) => {
      if (FIELD_LABELS[k]) return FIELD_LABELS[k];
      const words = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
      return words.charAt(0).toUpperCase() + words.slice(1);
    })
    .join(', ');
}

// The sign-in alert was removed: it fired on every ordinary sign-in, so it
// trained people to ignore mail from us and buried the notices that matter.
// The events worth telling someone about — a password change, an email change,
// a claim — each have their own template above and below.
export function profileUpdatedEmail(to: string, name: string, changed: string[]): MailInput {
  name = who(name);
  const what = changedFields(changed);
  return {
    tag: 'profile_updated',
    to,
    subject: 'Your Pets24x7 profile was updated',
    html: page({
      eyebrow: 'Account',
      banner: ['Profile updated', 'success'],
      heading: `Hi ${name}`,
      intro: 'Your profile details were just changed.',
      blocks: [
        InfoBox([['Updated', what || 'Profile details']]),
        Note("If you didn't make this change, reply to this email straight away."),
        Button('Review my profile', parentDash('account')),
      ],
    }),
    text: `Hi ${name},\n\nYour Pets24x7 profile was updated (${what || 'profile details'}).\n\nIf this wasn't you, reply to this email.\n\nReview your profile: ${parentDash('account')}\n`,
  };
}

// ===========================================================================
// Pet parent — pets
// ===========================================================================

/** "2 years 3 months", "7 months", or an em dash when neither part is set. */
export function formatPetAge(years: number | null, months: number | null): string {
  const parts: string[] = [];
  if (years != null && years > 0) parts.push(`${years} year${years === 1 ? '' : 's'}`);
  if (months != null && months > 0) parts.push(`${months} month${months === 1 ? '' : 's'}`);
  if (parts.length === 0 && years === 0) return 'Under 1 month';
  return parts.length ? parts.join(' ') : '—';
}

/** "Small mammal" from the PetSpecies enum value SMALL_MAMMAL; free text passes through. */
function formatSpecies(species: string): string {
  const s = String(species ?? '').trim();
  if (!/^[A-Z_]+$/.test(s)) return s;
  const words = s.replace(/_+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function petAddedEmail(
  to: string,
  name: string,
  pet: { name: string; species: string; breed: string | null; ageYears: number | null; ageMonths?: number | null },
): MailInput {
  name = who(name);
  const species = formatSpecies(pet.species);
  return {
    tag: 'pet_added',
    to,
    subject: `${pet.name} has been added to your profile`,
    html: page({
      eyebrow: 'My pets',
      banner: ['Pet added', 'success'],
      heading: `${pet.name} is on board`,
      intro: h`Nice one, ${name}. We'll use ${pet.name}'s details to point you at the right vets, groomers and boarding nearby.`,
      blocks: [
        InfoBox([
          ['Name', pet.name],
          ['Species', species],
          ['Breed', pet.breed || '—'],
          ['Age', formatPetAge(pet.ageYears, pet.ageMonths ?? null)],
        ]),
        Button('View my pets', parentDash('pets')),
      ],
    }),
    text: `Hi ${name},\n\n${pet.name} (${species}${pet.breed ? `, ${pet.breed}` : ''}) was added to your Pets24x7 profile.\n\nDashboard: ${parentDash('pets')}\n`,
  };
}

export function petUpdatedEmail(to: string, name: string, petName: string): MailInput {
  name = who(name);
  return {
    tag: 'pet_updated',
    to,
    subject: `${petName}'s profile was updated`,
    html: page({
      eyebrow: 'My pets',
      heading: `${petName}'s details changed`,
      intro: h`Hi ${name} — the profile for <strong>${petName}</strong> was just updated.`,
      blocks: [Button('View my pets', parentDash('pets'))],
      preheader: `${petName}'s profile was just updated.`,
    }),
    text: `Hi ${name},\n\nThe profile for ${petName} was updated.\n\nDashboard: ${parentDash('pets')}\n`,
  };
}

export function petRemovedEmail(to: string, name: string, petName: string): MailInput {
  name = who(name);
  return {
    tag: 'pet_removed',
    to,
    subject: `${petName} was removed from your profile`,
    html: page({
      eyebrow: 'My pets',
      banner: ['Pet removed', 'warning'],
      heading: `${petName} was removed`,
      intro: h`Hi ${name} — <strong>${petName}</strong> is no longer on your Pets24x7 profile.`,
      blocks: [
        Note("Removed by mistake? Add the pet again from your dashboard — it only takes a moment."),
        Button('Open my dashboard', parentDash('pets')),
      ],
      preheader: `${petName} was removed from your profile.`,
    }),
    text: `Hi ${name},\n\n${petName} was removed from your Pets24x7 profile. You can add the pet again from your dashboard: ${parentDash('pets')}\n`,
  };
}

// ===========================================================================
// Pet parent — saved businesses
// ===========================================================================

export function listingSavedEmail(to: string, name: string, listingName: string | null): MailInput {
  const what = listingName || 'a business';
  name = who(name);
  return {
    tag: 'listing_saved',
    to,
    subject: `Saved: ${what}`,
    html: page({
      eyebrow: 'Saved',
      heading: 'Added to your saved list',
      intro: h`Hi ${name} — <strong>${what}</strong> is saved to your Pets24x7 account, so it's one click away next time.`,
      blocks: [Button('View saved businesses', PARENT_DASH())],
      preheader: `${what} is saved to your account.`,
    }),
    text: `Hi ${name},\n\n${what} was saved to your Pets24x7 account.\n\nDashboard: ${PARENT_DASH()}\n`,
  };
}

// ===========================================================================
// Pet parent — memberships & payments
// ===========================================================================

export function membershipActivatedEmail(
  to: string,
  name: string,
  plan: { name: string; priceMinor: number; currency: string; discountPercent?: number },
  endsAt: Date | null,
  merchantTxnId: string,
  invoiceUrl?: string,
): MailInput {
  name = who(name);
  return {
    tag: 'membership_activated',
    to,
    subject: `Your ${plan.name} membership is active`,
    html: page({
      eyebrow: 'Membership',
      banner: ['Payment received', 'success'],
      heading: `You're in, ${name}`,
      intro: h`Your <strong>${plan.name}</strong> membership is active right away.`,
      blocks: [
        InfoBox([
          ['Plan', plan.name],
          ['Amount paid', money(plan.priceMinor, plan.currency)],
          ...(plan.discountPercent
            ? ([['Member discount', `Up to ${plan.discountPercent}% off`]] as Array<[string, string]>)
            : []),
          ['Active until', day(endsAt)],
          ['Reference', merchantTxnId],
        ]),
        Button('Open my dashboard', parentDash('membership')),
        ...(invoiceUrl
          ? [Note(`Need an invoice? <a href="${esc(invoiceUrl)}" style="color:#c2410c;font-weight:600">Download it here</a> — it opens in your browser and prints to PDF.`)]
          : []),
        Note('Keep this email as your receipt.'),
      ],
      preheader: `${plan.name} active until ${day(endsAt)}.`,
    }),
    text:
      `Hi ${name},

Your ${plan.name} membership is active.
` +
      `Amount paid: ${money(plan.priceMinor, plan.currency)}
` +
      `Active until: ${day(endsAt)}
Reference: ${merchantTxnId}
` +
      (invoiceUrl ? `
Invoice: ${invoiceUrl}
` : '') +
      `
Dashboard: ${parentDash('membership')}
`,
  };
}

export function membershipCancelledEmail(to: string, name: string, planName: string, endsAt: Date | null): MailInput {
  name = who(name);
  return {
    tag: 'membership_cancelled',
    to,
    subject: 'Auto-renew turned off',
    html: page({
      eyebrow: 'Membership',
      banner: ['Auto-renew off', 'warning'],
      heading: 'Auto-renew is off',
      intro: h`Hi ${name} — we've turned off auto-renew on your <strong>${planName}</strong> membership.`,
      blocks: [
        InfoBox([
          ['Plan', planName],
          ['Benefits until', day(endsAt)],
          ['Next charge', 'None'],
        ]),
        Note("Nothing is lost — you keep every benefit until that date."),
        Button('Resume auto-renew', MEMBERSHIP()),
      ],
      preheader: `Benefits continue until ${day(endsAt)}, no more charges.`,
    }),
    text: `Hi ${name},\n\nAuto-renew is off for your ${planName} membership. Benefits stay active until ${day(endsAt)} and you won't be charged again.\n\nResume anytime: ${MEMBERSHIP()}\n`,
  };
}

export function membershipResumedEmail(to: string, name: string, planName: string, endsAt: Date | null): MailInput {
  name = who(name);
  return {
    tag: 'membership_resumed',
    to,
    subject: 'Auto-renew is back on',
    html: page({
      eyebrow: 'Membership',
      banner: ['Auto-renew on', 'success'],
      heading: 'Auto-renew resumed',
      intro: h`Hi ${name} — auto-renew is back on for your <strong>${planName}</strong> membership.`,
      blocks: [
        InfoBox([['Plan', planName], ['Next renewal', day(endsAt)]]),
        Button('Open my dashboard', parentDash('membership')),
      ],
      preheader: `Next renewal ${day(endsAt)}.`,
    }),
    text: `Hi ${name},\n\nAuto-renew is back on for your ${planName} membership. Next renewal: ${day(endsAt)}.\n\nDashboard: ${parentDash('membership')}\n`,
  };
}

export function membershipExpiredEmail(to: string, name: string, planName: string): MailInput {
  name = who(name);
  return {
    tag: 'membership_expired',
    to,
    subject: 'Your Pets24x7 membership has ended',
    html: page({
      eyebrow: 'Membership',
      banner: ['Membership ended', 'warning'],
      heading: `Your ${planName} plan has ended`,
      intro: h`Hi ${name} — your membership term is over, so member pricing and priority support are paused.`,
      blocks: [
        Note('Your account, pets and saved businesses all stay exactly as they are.'),
        Button('Renew my membership', MEMBERSHIP()),
      ],
      preheader: `Your ${planName} plan has ended.`,
    }),
    text: `Hi ${name},\n\nYour ${planName} membership has ended. Your account, pets and saved businesses are untouched.\n\nRenew: ${MEMBERSHIP()}\n`,
  };
}

/**
 * Where "Try again" should go. A vendor whose campaign or featured payment
 * failed must land on the vendor Grow page, not the pet-parent membership page.
 */
export function retryUrlFor(what: string): string {
  return /campaign|featured|placement/i.test(what) ? vendorDash('grow') : MEMBERSHIP();
}

export function paymentFailedEmail(
  to: string,
  name: string,
  what: string,
  amountMinor: number,
  currency: string,
  merchantTxnId: string,
  retryUrl: string = retryUrlFor(what),
): MailInput {
  name = who(name);
  return {
    tag: 'payment_failed',
    to,
    subject: 'Your payment did not go through',
    html: page({
      eyebrow: 'Payment',
      banner: ['Payment failed', 'danger'],
      heading: 'Payment failed',
      intro: h`Hi ${name} — your payment for <strong>${what}</strong> didn't complete, so nothing was activated.`,
      blocks: [
        InfoBox([['Amount', money(amountMinor, currency)], ['Reference', merchantTxnId]]),
        Note('If money left your account, your bank returns it — usually within 5 working days.'),
        Button('Try again', retryUrl),
      ],
      preheader: `Payment for ${what} did not complete — nothing was activated.`,
    }),
    text: `Hi ${name},\n\nYour payment for ${what} (${money(amountMinor, currency)}, ref ${merchantTxnId}) did not complete, so nothing was activated.\n\nAny debited amount is returned by your bank, usually within 5 working days.\n\nTry again: ${retryUrl}\n`,
  };
}

export function paymentRefundedEmail(
  to: string,
  name: string,
  what: string,
  amountMinor: number,
  currency: string,
  merchantTxnId: string,
): MailInput {
  name = who(name);
  return {
    tag: 'payment_refunded',
    to,
    subject: 'Your refund is on its way',
    html: page({
      eyebrow: 'Payment',
      banner: ['Refund issued', 'info'],
      heading: 'Refund issued',
      intro: h`Hi ${name} — we've refunded your payment for <strong>${what}</strong>.`,
      blocks: [
        InfoBox([
          ['Amount refunded', money(amountMinor, currency)],
          ['Reference', merchantTxnId],
          ['Expect it by', 'Within 5–7 working days'],
        ]),
        Note('The refund goes back to the account you paid from. Any access tied to this payment has ended.'),
      ],
      preheader: `${money(amountMinor, currency)} refunded for ${what}.`,
    }),
    text: `Hi ${name},\n\nWe've refunded ${money(amountMinor, currency)} for ${what} (ref ${merchantTxnId}). It reaches the account you paid from within 5-7 working days.\n`,
  };
}

// ===========================================================================
// Enquiries — both sides
// ===========================================================================

export function enquiryReceivedEmail(to: string, name: string, listingName: string | null): MailInput {
  const target = listingName ? `<strong>${esc(listingName)}</strong>` : 'the Pets24x7 team';
  name = who(name);
  return {
    tag: 'enquiry_received',
    to,
    subject: 'We got your enquiry',
    html: page({
      eyebrow: 'Enquiry',
      banner: ['Enquiry sent', 'success'],
      heading: 'Enquiry received',
      intro: h`Thanks ${name} — your enquiry has reached ` + target + '.',
      blocks: [
        Note("You'll usually hear back within a few hours. We follow up on WhatsApp if there's no reply."),
        Button('Browse more services', siteUrl()),
      ],
      preheader: `Your enquiry reached ${listingName || 'the business'}.`,
    }),
    text: `Hi ${name},\n\nYour enquiry reached ${listingName ?? 'the Pets24x7 team'}. You'll usually hear back within a few hours.\n\nBrowse more services: ${siteUrl()}\n`,
  };
}

export function enquiryStatusEmail(
  to: string,
  name: string,
  listingName: string | null,
  status: 'RESPONDED' | 'COMPLETED' | 'ARCHIVED' | 'NEW',
): MailInput {
  const biz = listingName || 'The business';
  const copy: Record<string, { subject: string; heading: string; intro: string }> = {
    RESPONDED: {
      subject: 'Your enquiry has been picked up',
      heading: 'Someone is on it',
      intro: `${biz} has picked up your enquiry and should be in touch shortly.`,
    },
    COMPLETED: {
      subject: 'Your enquiry is closed',
      heading: 'Enquiry closed',
      intro: `${biz} has marked your enquiry as handled. We hope it went well.`,
    },
    ARCHIVED: {
      subject: 'Your enquiry was archived',
      heading: 'Enquiry archived',
      intro: `${biz} archived your enquiry. If you still need help, send a fresh one — we'll chase it.`,
    },
    NEW: {
      subject: 'Your enquiry was reopened',
      heading: 'Enquiry reopened',
      intro: `${biz} has reopened your enquiry.`,
    },
  };
  const c = copy[status]!;
  name = who(name);
  return {
    tag: 'enquiry_status',
    to,
    subject: c.subject,
    html: page({
      eyebrow: 'Enquiry',
      heading: c.heading,
      intro: h`Hi ${name} — ${c.intro}`,
      blocks: [Button('View my enquiries', parentDash('enquiries'))],
      preheader: c.intro,
    }),
    text: `Hi ${name},\n\n${c.intro}\n\nDashboard: ${parentDash('enquiries')}\n`,
  };
}

export function vendorNewEnquiryEmail(
  to: string,
  businessName: string,
  enquiry: {
    name: string;
    phone: string;
    petType: string | null;
    preferredDate: Date | null;
    notes: string;
    city: string | null;
  },
): MailInput {
  // Digits-only dial string, so the call / WhatsApp buttons work from a phone.
  const digits = String(enquiry.phone ?? '').replace(/[^\d+]/g, '');
  const dial = digits.replace(/\D/g, '').length >= 7 ? digits : '';
  businessName = who(businessName, 'there');
  return {
    tag: 'vendor_new_enquiry',
    to,
    subject: `New enquiry for ${businessName}`,
    html: page({
      eyebrow: 'Lead',
      banner: ['New enquiry', 'success'],
      heading: 'You have a new enquiry',
      intro: h`A pet parent just enquired about <strong>${businessName}</strong>. Call them first — speed wins the booking.`,
      blocks: [
        InfoBox([
          ['Name', enquiry.name],
          ['Phone', enquiry.phone],
          ['Pet', enquiry.petType || '—'],
          ['Preferred date', enquiry.preferredDate ? day(enquiry.preferredDate) : '—'],
          ['City', enquiry.city || '—'],
        ]),
        Quote(enquiry.notes || 'No message left.'),
        ...(dial
          ? [Button(`Call ${enquiry.name}`, `tel:${dial}`),
             Note(`Prefer WhatsApp? <a href="${esc(`https://wa.me/${dial.replace(/^\+/, '')}`)}" style="color:#c2410c;font-weight:600">Message them on WhatsApp</a> &middot; <a href="${esc(vendorDash('enquiries'))}" style="color:#c2410c;font-weight:600">Open in dashboard</a>`)]
          : [Button('Open vendor dashboard', vendorDash('enquiries'))]),
      ],
      preheader: `${enquiry.name} · ${enquiry.phone}`,
    }),
    text: `New enquiry for ${businessName}\n\nName: ${enquiry.name}\nPhone: ${enquiry.phone}\nPet: ${enquiry.petType || '-'}\nPreferred date: ${enquiry.preferredDate ? day(enquiry.preferredDate) : '-'}\nCity: ${enquiry.city || '-'}\n\n${enquiry.notes || 'No message left.'}\n\nDashboard: ${vendorDash('enquiries')}\n`,
  };
}

// ===========================================================================
// Vendor — account lifecycle
// ===========================================================================

export function vendorWelcomeEmail(to: string, businessName: string, listingName: string): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'vendor_welcome',
    to,
    subject: 'Your Pets24x7 listing is claimed',
    html: page({
      eyebrow: 'Vendor',
      banner: ['Listing claimed', 'success'],
      heading: `Welcome, ${businessName}`,
      intro: h`You've claimed <strong>${listingName}</strong> on Pets24x7. Enquiries now come straight to you.`,
      blocks: [
        Text('Next: add your services and photos so parents can see what you offer, then start collecting reviews.'),
        Button('Complete my profile', vendorDash('listing')),
      ],
      preheader: `You've claimed ${listingName} — enquiries now come straight to you.`,
    }),
    text: `Welcome, ${businessName}!\n\nYou've claimed ${listingName} on Pets24x7. Enquiries now come straight to you.\n\nComplete your profile: ${vendorDash('listing')}\n`,
  };
}

/**
 * `pending`: the account is not approved yet, so the edit is saved but kept off
 * the public listing until approval (see syncVendorToListingIndex).
 */
export function vendorProfileUpdatedEmail(to: string, businessName: string, changed: string[], pending = false): MailInput {
  businessName = who(businessName, 'there');
  const what = changedFields(changed);
  return {
    tag: 'vendor_profile_updated',
    to,
    subject: 'Your business profile was updated',
    html: page({
      eyebrow: 'Vendor',
      banner: ['Profile updated', 'success'],
      heading: 'Profile updated',
      intro: pending
        ? h`The profile for <strong>${businessName}</strong> was just changed. It goes live on your listing once your account is approved.`
        : h`The public profile for <strong>${businessName}</strong> was just changed. It's live on your listing now.`,
      blocks: [
        InfoBox([['Updated', what || 'Business details']]),
        Button('View my listing', vendorDash('listing')),
      ],
      preheader: pending
        ? `${what || 'Your profile'} just changed. It goes live once you are approved.`
        : `${what || 'Your profile'} just changed and is live.`,
    }),
    text: `Hi ${businessName},\n\nYour Pets24x7 profile was updated (${what || 'business details'}) ${pending ? 'and goes live on your listing once your account is approved' : 'and is live on your listing'}.\n\nDashboard: ${vendorDash('listing')}\n`,
  };
}

export function vendorApprovedEmail(to: string, businessName: string): MailInput {
  return {
    tag: 'vendor_approved',
    to,
    subject: 'Your Pets24x7 listing is approved',
    html: page({
      eyebrow: 'Vendor',
      banner: ['Approved', 'success'],
      heading: "You're live",
      intro: h`<strong>${businessName}</strong> is approved and visible to pet parents across Pets24x7.`,
      blocks: [
        Text('You can now send review requests, list services, run campaigns and feature your listing.'),
        Button('Open vendor dashboard', VENDOR_DASH()),
      ],
      preheader: `${businessName} is approved and visible to pet parents now.`,
    }),
    text: `Hi ${businessName},\n\nYour Pets24x7 listing is approved and live. You can now send review requests, list services, run campaigns and feature your listing.\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function vendorRejectedEmail(to: string, businessName: string, reason: string | null): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'vendor_rejected',
    to,
    subject: 'About your Pets24x7 listing claim',
    html: page({
      eyebrow: 'Vendor',
      banner: ['Not approved', 'danger'],
      heading: 'We could not approve this claim',
      intro: h`Your claim for <strong>${businessName}</strong> wasn't approved.`,
      blocks: [
        ...(reason ? [InfoBox([['Reason', reason]])] : []),
        Note('Think this is a mistake? Reply to this email with proof of ownership and we\'ll take another look.'),
      ],
      preheader: `Your claim for ${businessName} was not approved.`,
    }),
    text: `Hi,\n\nYour Pets24x7 claim for ${businessName} was not approved.${reason ? `\nReason: ${reason}` : ''}\n\nReply to this email with proof of ownership and we'll review it again.\n`,
  };
}

export function vendorSuspendedEmail(to: string, businessName: string): MailInput {
  return {
    tag: 'vendor_suspended',
    to,
    subject: 'Your Pets24x7 listing has been suspended',
    html: page({
      eyebrow: 'Vendor',
      banner: ['Suspended', 'danger'],
      heading: 'Listing suspended',
      intro: h`<strong>${businessName}</strong> is temporarily hidden from Pets24x7 and is not receiving enquiries.`,
      blocks: [Note('Reply to this email and we\'ll walk you through what is needed to restore it.')],
      preheader: `${businessName} is temporarily hidden and not receiving enquiries.`,
    }),
    text: `Hi,\n\n${businessName} has been suspended on Pets24x7 and is not receiving enquiries. Reply to this email to sort it out.\n`,
  };
}

// ===========================================================================
// Vendor — services
// ===========================================================================

export function serviceAddedEmail(
  to: string,
  businessName: string,
  service: { name: string; priceMinor: number; currency: string; durationLabel: string },
): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'service_added',
    to,
    subject: `"${service.name}" is on your listing`,
    html: page({
      eyebrow: 'Services',
      banner: ['Service added', 'success'],
      heading: 'Service added',
      intro: h`<strong>${service.name}</strong> now shows on the ${businessName} listing.`,
      blocks: [
        InfoBox([
          ['Service', service.name],
          ['Price', money(service.priceMinor, service.currency)],
          ['Duration', service.durationLabel],
        ]),
        Button('Manage services', vendorDash('services')),
      ],
      preheader: `${service.name} now shows on your listing.`,
    }),
    text: `Hi ${businessName},\n\n"${service.name}" (${money(service.priceMinor, service.currency)}, ${service.durationLabel}) was added to your listing.\n\nDashboard: ${vendorDash('services')}\n`,
  };
}

export function serviceUpdatedEmail(to: string, businessName: string, serviceName: string): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'service_updated',
    to,
    subject: `"${serviceName}" was updated`,
    html: page({
      eyebrow: 'Services',
      heading: 'Service updated',
      intro: h`The details for <strong>${serviceName}</strong> on the ${businessName} listing were changed and are live.`,
      blocks: [Button('Manage services', vendorDash('services'))],
      preheader: `${serviceName} was updated and is live.`,
    }),
    text: `Hi ${businessName},\n\n"${serviceName}" was updated on your listing.\n\nDashboard: ${vendorDash('services')}\n`,
  };
}

export function serviceRemovedEmail(to: string, businessName: string, serviceName: string): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'service_removed',
    to,
    subject: `"${serviceName}" was removed`,
    html: page({
      eyebrow: 'Services',
      banner: ['Service removed', 'warning'],
      heading: 'Service removed',
      intro: h`<strong>${serviceName}</strong> no longer appears on the ${businessName} listing.`,
      blocks: [Button('Manage services', vendorDash('services'))],
      preheader: `${serviceName} was removed from your listing.`,
    }),
    text: `Hi ${businessName},\n\n"${serviceName}" was removed from your listing.\n\nDashboard: ${vendorDash('services')}\n`,
  };
}

export function serviceModeratedEmail(
  to: string,
  businessName: string,
  serviceName: string,
  status: 'ACTIVE' | 'HIDDEN',
): MailInput {
  const hidden = status === 'HIDDEN';
  businessName = who(businessName, 'there');
  return {
    tag: 'service_moderated',
    to,
    subject: hidden ? `"${serviceName}" was hidden by our team` : `"${serviceName}" is visible again`,
    html: page({
      eyebrow: 'Services',
      banner: hidden ? ['Hidden by moderation', 'warning'] : ['Restored', 'success'],
      heading: hidden ? 'A service was hidden' : 'Service restored',
      intro: hidden
        ? h`Our team hid <strong>${serviceName}</strong> on the ${businessName} listing while we check it.`
        : h`<strong>${serviceName}</strong> is showing on the ${businessName} listing again.`,
      blocks: [
        ...(hidden ? [Note('Reply to this email if you think this was a mistake — we read every reply.')] : []),
        Button('Manage services', vendorDash('services')),
      ],
      preheader: hidden ? `${serviceName} was hidden while we check it.` : `${serviceName} is visible again.`,
    }),
    text:
      (hidden
        ? `Hi ${businessName},\n\nOur team hid "${serviceName}" on your listing while we check it. Reply to this email if that looks wrong.\n`
        : `Hi ${businessName},\n\n"${serviceName}" is visible on your listing again.\n`) +
      `\nManage services: ${vendorDash('services')}\n`,
  };
}

// ===========================================================================
// Vendor — reviews
// ===========================================================================

export function reviewRequestsSentEmail(
  to: string,
  businessName: string,
  stats: { sent: number; failed: number; remainingToday: number },
): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'review_requests_sent',
    to,
    subject: `${stats.sent} review request${stats.sent === 1 ? '' : 's'} sent`,
    html: page({
      eyebrow: 'Reviews',
      banner: ['Requests sent', 'success'],
      heading: 'Review requests are on their way',
      intro: h`We've sent your customers a WhatsApp asking them to review <strong>${businessName}</strong>.`,
      blocks: [
        InfoBox([
          ['Sent', String(stats.sent)],
          ['Failed', String(stats.failed)],
          ['Remaining today', String(stats.remainingToday)],
        ]),
        Note('We email you the moment a review lands.'),
        Button('Track requests', vendorDash('reviews')),
      ],
      preheader: `${stats.sent} sent · ${stats.failed} failed · ${stats.remainingToday} left today.`,
    }),
    text: `Hi ${businessName},\n\n${stats.sent} review request(s) sent, ${stats.failed} failed, ${stats.remainingToday} left in today's cap.\n\nDashboard: ${vendorDash('reviews')}\n`,
  };
}

export function vendorNewReviewEmail(
  to: string,
  businessName: string,
  review: { reviewerName: string; rating: number; text: string },
): MailInput {
  const stars = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
  businessName = who(businessName, 'there');
  return {
    tag: 'vendor_new_review',
    to,
    subject: `New ${review.rating}-star review for ${businessName}`,
    html: page({
      eyebrow: 'Reviews',
      banner: [`${stars}  ${review.rating}/5`, review.rating >= 4 ? 'success' : 'warning'],
      heading: 'You got a new review',
      intro: h`From <strong>${review.reviewerName}</strong>.`,
      blocks: [
        Quote(review.text),
        Note('It goes live on your listing once our team has checked it — usually within a day.'),
        Button('View my reviews', vendorDash('reviews')),
      ],
      preheader: `${review.rating}/5 from ${review.reviewerName}`,
    }),
    text: `New ${review.rating}-star review for ${businessName}\n\nFrom: ${review.reviewerName}\n"${review.text}"\n\nIt goes live after moderation, usually within a day.\n\nDashboard: ${vendorDash('reviews')}\n`,
  };
}

export function reviewPublishedEmail(
  to: string,
  businessName: string,
  review: { reviewerName: string; rating: number },
): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'review_published',
    to,
    subject: 'A review just went live on your listing',
    html: page({
      eyebrow: 'Reviews',
      banner: ['Published', 'success'],
      heading: 'Review published',
      intro: h`The ${review.rating}-star review from <strong>${review.reviewerName}</strong> is now public on the ${businessName} listing.`,
      blocks: [
        Note('Replying to reviews lifts conversion — a short, warm reply is enough.'),
        Button('Reply to it', vendorDash('reviews')),
      ],
      preheader: `${review.rating}-star review from ${review.reviewerName} is now public.`,
    }),
    text: `Hi ${businessName},\n\nThe ${review.rating}-star review from ${review.reviewerName} is now live on your listing.\n\nReply from your dashboard: ${vendorDash('reviews')}\n`,
  };
}

export function reviewRejectedEmail(
  to: string,
  businessName: string,
  review: { reviewerName: string; rating: number },
  reason: string | null,
): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'review_rejected',
    to,
    subject: 'A review on your listing was not published',
    html: page({
      eyebrow: 'Reviews',
      banner: ['Not published', 'warning'],
      heading: 'Review rejected by moderation',
      intro: h`The ${review.rating}-star review from <strong>${review.reviewerName}</strong> did not pass our checks, so it will not appear on the ${businessName} listing.`,
      blocks: [...(reason ? [InfoBox([['Reason', reason]])] : []), Button('View my reviews', vendorDash('reviews'))],
      preheader: `${review.rating}-star review from ${review.reviewerName} was not published.`,
    }),
    text: `Hi ${businessName},\n\nThe ${review.rating}-star review from ${review.reviewerName} was not published.${reason ? `\nReason: ${reason}` : ''}\n\nDashboard: ${vendorDash('reviews')}\n`,
  };
}

export function reviewReplyPostedEmail(to: string, businessName: string, reviewerName: string): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'review_reply_posted',
    to,
    subject: 'Your reply is live',
    html: page({
      eyebrow: 'Reviews',
      banner: ['Reply posted', 'success'],
      heading: 'Reply posted',
      intro: h`Your reply to <strong>${reviewerName}</strong> is now showing under their review on the ${businessName} listing.`,
      blocks: [Button('View my reviews', vendorDash('reviews'))],
      preheader: `Your reply to ${reviewerName} is live.`,
    }),
    text: `Hi ${businessName},\n\nYour reply to ${reviewerName} is live under their review.\n\nDashboard: ${vendorDash('reviews')}\n`,
  };
}

// ===========================================================================
// Vendor — marketing campaigns
// ===========================================================================

export function campaignCreatedEmail(
  to: string,
  businessName: string,
  campaign: { goal: string; durationDays: number; priceMinor: number; currency: string },
  merchantTxnId: string,
): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'campaign_created',
    to,
    subject: 'Finish paying for your campaign',
    html: page({
      eyebrow: 'Marketing',
      banner: ['Awaiting payment', 'warning'],
      heading: 'Your campaign is reserved',
      intro: h`We've held a <strong>${campaignGoalLabel(campaign.goal)}</strong> campaign for ${businessName}. It starts once payment clears.`,
      blocks: [
        InfoBox([
          ['Goal', campaignGoalLabel(campaign.goal)],
          ['Duration', `${campaign.durationDays} days`],
          ['Amount', money(campaign.priceMinor, campaign.currency)],
          ['Reference', merchantTxnId],
        ]),
        Button('Complete payment', vendorDash('grow')),
      ],
      preheader: `${campaignGoalLabel(campaign.goal)} campaign reserved — pay to start it.`,
    }),
    text: `Hi ${businessName},\n\nYour ${campaignGoalLabel(campaign.goal)} campaign (${campaign.durationDays} days, ${money(campaign.priceMinor, campaign.currency)}, ref ${merchantTxnId}) is reserved and awaiting payment.\n\nDashboard: ${vendorDash('grow')}\n`,
  };
}

export function campaignSubmittedEmail(
  to: string,
  businessName: string,
  campaign: { goal: string; durationDays: number; priceMinor: number; currency: string },
  merchantTxnId: string,
  invoiceUrl: string | null = null,
): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'campaign_submitted',
    to,
    subject: 'Campaign paid — now in review',
    html: page({
      eyebrow: 'Marketing',
      banner: ['In review', 'info'],
      heading: 'Your campaign is in review',
      intro: h`Thanks ${businessName} — payment received. Our team checks every campaign before it runs; you'll get another email the moment it goes live.`,
      blocks: [
        InfoBox([
          ['Goal', campaignGoalLabel(campaign.goal)],
          ['Duration', `${campaign.durationDays} days`],
          ['Amount paid', money(campaign.priceMinor, campaign.currency)],
          ['Reference', merchantTxnId],
        ]),
        Button('Track my campaign', vendorDash('grow')),
        ...(invoiceUrl ? [invoiceNote(invoiceUrl)] : []),
      ],
      preheader: 'Payment received — your campaign is in review.',
    }),
    text: `Hi ${businessName},\n\nPayment received for your ${campaignGoalLabel(campaign.goal)} campaign (${campaign.durationDays} days, ${money(campaign.priceMinor, campaign.currency)}, ref ${merchantTxnId}). It is now in review; we'll email you when it goes live.\n\nDashboard: ${vendorDash('grow')}\n${invoiceUrl ? `Invoice: ${invoiceUrl}\n` : ''}`,
  };
}

export function campaignApprovedEmail(
  to: string,
  businessName: string,
  campaign: { goal: string; durationDays: number },
  endsAt: Date | null,
): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'campaign_approved',
    to,
    subject: 'Your campaign is live',
    html: page({
      eyebrow: 'Marketing',
      banner: ['Live now', 'success'],
      heading: 'Campaign approved and running',
      intro: h`Your <strong>${campaignGoalLabel(campaign.goal)}</strong> campaign for ${businessName} is live and pushing your listing to pet parents.`,
      blocks: [
        InfoBox([['Goal', campaignGoalLabel(campaign.goal)], ['Runs for', `${campaign.durationDays} days`], ['Ends', day(endsAt)]]),
        Button('See performance', vendorDash('grow')),
      ],
      preheader: `Your campaign is live, running until ${day(endsAt)}.`,
    }),
    text: `Hi ${businessName},\n\nYour ${campaignGoalLabel(campaign.goal)} campaign is live and runs for ${campaign.durationDays} days, ending ${day(endsAt)}.\n\nDashboard: ${vendorDash('grow')}\n`,
  };
}

export function campaignCancelledEmail(to: string, businessName: string, goal: string): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'campaign_cancelled',
    to,
    subject: 'Your campaign was cancelled',
    html: page({
      eyebrow: 'Marketing',
      banner: ['Cancelled', 'danger'],
      heading: 'Campaign cancelled',
      intro: h`Your <strong>${campaignGoalLabel(goal)}</strong> campaign for ${businessName} has been cancelled and is not running.`,
      blocks: [Note('If you were charged, the refund follows automatically. Reply here with any questions.')],
      preheader: 'Your campaign was cancelled and is not running.',
    }),
    text: `Hi ${businessName},\n\nYour ${campaignGoalLabel(goal)} campaign was cancelled and is not running. Any charge is refunded automatically.\n`,
  };
}

export function campaignCompletedEmail(to: string, businessName: string, goal: string): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'campaign_completed',
    to,
    subject: 'Your campaign has finished',
    html: page({
      eyebrow: 'Marketing',
      banner: ['Completed', 'info'],
      heading: 'Campaign finished',
      intro: h`Your <strong>${campaignGoalLabel(goal)}</strong> campaign for ${businessName} has run its full term.`,
      blocks: [
        Note('Enquiries that came in during the run are all in your dashboard.'),
        Button('Run it again', vendorDash('grow')),
      ],
      preheader: 'Your campaign has run its full term.',
    }),
    text: `Hi ${businessName},\n\nYour ${campaignGoalLabel(goal)} campaign has finished its run. Every enquiry it brought in is in your dashboard: ${vendorDash('grow')}\n`,
  };
}

// ===========================================================================
// Vendor — featured listings
// ===========================================================================

/** The "download your invoice" line under a vendor receipt. */
const invoiceNote = (url: string) =>
  Note(`Need an invoice? <a href="${esc(url)}" style="color:#c2410c;font-weight:600">Download it here</a> — sign in to your business account and it opens in your browser, ready to print to PDF.`);

export function featuredLiveEmail(
  to: string,
  businessName: string,
  featured: { priceMinor: number; currency: string; durationDays: number },
  endsAt: Date | null,
  merchantTxnId: string,
  startsAt: Date | null = null,
  invoiceUrl: string | null = null,
): MailInput {
  // A slot bought while another is still running is queued, not live — telling
  // the vendor "you're featured now" would be wrong for its whole first term.
  const queued = Boolean(startsAt && startsAt.getTime() > Date.now());
  const rows: [string, string][] = [['Duration', `${featured.durationDays} days`]];
  if (queued) rows.push(['Starts', day(startsAt)]);
  rows.push(
    ['Featured until', day(endsAt)],
    ['Amount paid', money(featured.priceMinor, featured.currency)],
    ['Reference', merchantTxnId],
  );
  businessName = who(businessName, 'there');
  return {
    tag: 'featured_live',
    to,
    subject: queued ? 'Your featured placement is booked' : 'Your listing is now featured',
    html: page({
      eyebrow: 'Featured',
      banner: queued ? ['Booked', 'info'] : ['Boost active', 'success'],
      heading: queued ? "You're booked" : "You're featured",
      intro: queued
        ? h`<strong>${businessName}</strong> is booked for the top of its category and city results, starting when your current placement ends.`
        : h`<strong>${businessName}</strong> is now boosted to the top of its category and city results.`,
      blocks: [
        InfoBox(rows),
        Button('See my placement', vendorDash('grow')),
        ...(invoiceUrl ? [invoiceNote(invoiceUrl)] : []),
      ],
    }),
    text:
      (queued
        ? `Hi ${businessName},\n\nYour featured placement is booked for ${featured.durationDays} days, starting ${day(startsAt)} and running until ${day(endsAt)}. Paid: ${money(featured.priceMinor, featured.currency)} (ref ${merchantTxnId}).\n\nDashboard: ${vendorDash('grow')}\n`
        : `Hi ${businessName},\n\nYour listing is featured for ${featured.durationDays} days, until ${day(endsAt)}. Paid: ${money(featured.priceMinor, featured.currency)} (ref ${merchantTxnId}).\n\nDashboard: ${vendorDash('grow')}\n`) +
      (invoiceUrl ? `Invoice: ${invoiceUrl}\n` : ''),
  };
}

export function featuredEndedEmail(to: string, businessName: string, cancelled = false): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'featured_ended',
    to,
    subject: cancelled ? 'Your featured placement was cancelled' : 'Your featured placement has ended',
    html: page({
      eyebrow: 'Featured',
      banner: cancelled ? ['Cancelled', 'danger'] : ['Boost ended', 'warning'],
      heading: cancelled ? 'Featured placement cancelled' : 'Featured placement ended',
      intro: cancelled
        ? h`The featured boost for <strong>${businessName}</strong> was cancelled and is no longer running.`
        : h`The featured boost for <strong>${businessName}</strong> has run its full term. Your listing is back in normal ranking.`,
      blocks: [Button('Feature it again', vendorDash('grow'))],
      preheader: cancelled ? 'Your featured placement was cancelled.' : 'Your featured placement has ended.',
    }),
    text: cancelled
      ? `Hi ${businessName},\n\nYour featured placement was cancelled.\n\nDashboard: ${vendorDash('grow')}\n`
      : `Hi ${businessName},\n\nYour featured placement has ended and your listing is back in normal ranking.\n\nFeature it again: ${vendorDash('grow')}\n`,
  };
}

export function petPhotoUpdatedEmail(
  to: string,
  name: string,
  petName: string,
  removed = false,
): MailInput {
  name = who(name);
  return {
    tag: 'pet_photo_updated',
    to,
    subject: removed ? `${petName}'s photo was removed` : `${petName} has a new photo`,
    html: page({
      eyebrow: 'My pets',
      banner: removed ? ['Photo removed', 'warning'] : ['Photo updated', 'success'],
      heading: removed ? `${petName}'s photo was removed` : `${petName} looks great`,
      intro: removed
        ? h`Hi ${name} — the photo on ${petName}'s profile was removed. You can add a new one anytime.`
        : h`Hi ${name} — ${petName}'s new profile photo is saved and showing on your dashboard.`,
      blocks: [Button('View my pets', parentDash('pets'))],
    }),
    text: removed
      ? `Hi ${name},\n\n${petName}'s photo was removed. Add a new one anytime: ${parentDash('pets')}\n`
      : `Hi ${name},\n\n${petName}'s new profile photo is saved.\n\nDashboard: ${parentDash('pets')}\n`,
  };
}

export function listingUnsavedEmail(to: string, name: string, listingName: string | null): MailInput {
  const what = listingName || 'A business';
  name = who(name);
  return {
    tag: 'listing_unsaved',
    to,
    subject: `Removed from your saved list`,
    html: page({
      eyebrow: 'Saved',
      banner: ['Removed', 'warning'],
      heading: 'Removed from your saved list',
      intro: h`Hi ${name} — ${what} is no longer saved to your Pets24x7 account.`,
      blocks: [Button('Browse services', siteUrl())],
      preheader: `${what} was removed from your saved list.`,
    }),
    text: `Hi ${name},\n\n${what} was removed from your saved list.\n\nBrowse services: ${siteUrl()}\n`,
  };
}

export function featuredCreatedEmail(
  to: string,
  businessName: string,
  featured: { priceMinor: number; currency: string; durationDays: number },
  merchantTxnId: string,
): MailInput {
  businessName = who(businessName, 'there');
  return {
    tag: 'featured_created',
    to,
    subject: 'Finish paying for your featured placement',
    html: page({
      eyebrow: 'Featured',
      banner: ['Awaiting payment', 'warning'],
      heading: 'Your boost is reserved',
      intro: h`We've held a featured placement for ${businessName}. It goes live as soon as payment clears.`,
      blocks: [
        InfoBox([
          ['Duration', `${featured.durationDays} days`],
          ['Amount', money(featured.priceMinor, featured.currency)],
          ['Reference', merchantTxnId],
        ]),
        Button('Complete payment', vendorDash('grow')),
      ],
    }),
    text: `Hi ${businessName},\n\nYour featured placement (${featured.durationDays} days, ${money(featured.priceMinor, featured.currency)}, ref ${merchantTxnId}) is reserved and awaiting payment.\n\nDashboard: ${vendorDash('grow')}\n`,
  };
}

// ===========================================================================
// Vendor — subscription plans
// ===========================================================================

const periodLabel = (p: string | null | undefined) => (p === 'ANNUAL' ? 'Annual' : 'Monthly');

/** A paid vendor plan is live. Doubles as the receipt for the purchase. */
export function vendorSubscriptionActivatedEmail(
  to: string,
  businessName: string,
  plan: { planName: string; billingPeriod: string; amountMinor: number; currency?: string },
  endsAt: Date | null,
  merchantTxnId: string,
): MailInput {
  businessName = who(businessName);
  const currency = plan.currency || 'INR';
  const label = `${plan.planName} (${periodLabel(plan.billingPeriod)})`;
  return {
    tag: 'vendor_subscription_activated',
    to,
    subject: `Your ${plan.planName} plan is active`,
    html: page({
      eyebrow: 'Subscription',
      banner: ['Payment received', 'success'],
      heading: `${plan.planName} is live`,
      intro: h`Hi ${businessName} — your <strong>${label}</strong> plan is active right away. Your badge and lead limits are already updated on your listing.`,
      blocks: [
        InfoBox([
          ['Plan', label],
          ['Amount paid', money(plan.amountMinor, currency)],
          ['Active until', day(endsAt)],
          ['Reference', merchantTxnId],
        ]),
        Button('View my plan', vendorDash('subscriptions')),
        Note('Plans do not renew automatically, so we will remind you before this one ends. Keep this email as your receipt.'),
      ],
      preheader: `${label} active until ${day(endsAt)}.`,
    }),
    text: `Hi ${businessName},\n\nYour ${label} plan is active.\nAmount paid: ${money(plan.amountMinor, currency)}\nActive until: ${day(endsAt)}\nReference: ${merchantTxnId}\n\nPlans do not renew automatically.\n\nDashboard: ${vendorDash('subscriptions')}\n`,
  };
}

/** A paid vendor plan ends soon. Nothing auto-renews, so this is the nudge. */
export function vendorSubscriptionExpiringEmail(to: string, businessName: string, planName: string, endsAt: Date): MailInput {
  businessName = who(businessName);
  return {
    tag: 'vendor_subscription_expiring',
    to,
    subject: `Your ${planName} plan ends on ${day(endsAt)}`,
    html: page({
      eyebrow: 'Subscription',
      banner: ['Ending soon', 'warning'],
      heading: 'Your plan is ending soon',
      intro: h`Hi ${businessName} — your <strong>${planName}</strong> plan ends on ${day(endsAt)}. After that your listing moves back to the free Basic tier.`,
      blocks: [Button('Renew my plan', vendorDash('subscriptions')), Note('Renewing before it ends adds the new term on top, so no days are lost.')],
      preheader: `${planName} ends ${day(endsAt)}.`,
    }),
    text: `Hi ${businessName},\n\nYour ${planName} plan ends on ${day(endsAt)}, then your listing moves back to the free Basic tier. Renewing early adds the new term on top.\n\nRenew: ${vendorDash('subscriptions')}\n`,
  };
}

/** A paid vendor plan has lapsed back to the free tier. */
export function vendorSubscriptionExpiredEmail(to: string, businessName: string, planName: string): MailInput {
  businessName = who(businessName);
  return {
    tag: 'vendor_subscription_expired',
    to,
    subject: `Your ${planName} plan has ended`,
    html: page({
      eyebrow: 'Subscription',
      banner: ['Plan ended', 'warning'],
      heading: `Your ${planName} plan has ended`,
      intro: h`Hi ${businessName} — your paid plan is over, so your listing is back on the free Basic tier. Your listing, reviews and enquiries are untouched.`,
      blocks: [Button('Choose a plan', vendorDash('subscriptions'))],
      preheader: 'Your listing is back on the Basic tier.',
    }),
    text: `Hi ${businessName},\n\nYour ${planName} plan has ended and your listing is back on the free Basic tier. Your listing, reviews and enquiries are untouched.\n\nChoose a plan: ${vendorDash('subscriptions')}\n`,
  };
}

export interface RecommendedItem {
  name: string;
  category: string;
  city?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  reasons?: string[];
  url?: string | null;
}

/**
 * Personalised picks. The reasons come from the ranking engine, so the mail
 * explains itself rather than looking like an untargeted blast.
 */
export function recommendationsEmail(
  to: string,
  name: string,
  petName: string | null,
  items: RecommendedItem[],
): MailInput {
  const cards = items
    .slice(0, 5)
    .map((it) => {
      const stars = it.rating ? `★ ${Number(it.rating).toFixed(1)}` : '';
      const reviews = it.reviewCount ? ` · ${it.reviewCount} Google reviews` : '';
      const shown = `${stars}${reviews}`.toLowerCase();
      const why = (it.reasons ?? [])
        .filter((r) => {
          const t = r.toLowerCase();
          return !(t.includes('on google') || t.includes('google reviews')) || !shown;
        })
        .slice(0, 2)
        .join(' · ');
      const title = it.url
        ? `<a href="${esc(it.url)}" style="color:#111827;text-decoration:none">${esc(it.name)}</a>`
        : esc(it.name);
      return `<tr><td style="padding:14px 0;border-top:1px solid #eceef2">
        <div style="font-size:15px;font-weight:700;line-height:1.35">${title}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:3px">${esc(it.category)}${it.city ? ` · ${esc(it.city)}` : ''}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:3px">${esc(stars)}${esc(reviews)}</div>
        ${why ? `<div style="font-size:12px;color:#c2410c;font-weight:600;margin-top:5px">${esc(why)}</div>` : ''}
      </td></tr>`;
    })
    .join('');

  const forPet = petName ? ` for ${petName}` : '';
  name = who(name);
  return {
    tag: 'recommendations',
    kind: 'marketing',
    to,
    // Same rotating subject as the reco digest: leads with this mail's first pick.
    subject: digestSubject(to, petName, items.slice(0, 5)),
    html: page({
      eyebrow: 'Recommendations',
      heading: petName ? `Picked for ${petName}` : 'Picked for you',
      intro: h`Hi ${name} — these are the best-rated places near you that match what ${petName ?? 'your pet'} actually needs.`,
      blocks: [
        `<tr><td class="pad" style="padding:8px 44px 0"><table width="100%">${cards}</table></td></tr>`,
        Button('See all recommendations', PARENT_DASH()),
        Note('Ranked from your pets, what you have enquired about, and public Google ratings.'),
      ],
      preheader: items.length ? `${items.length} places near you${forPet}` : 'Your recommendations',
    }),
    text:
      `Hi ${name},\n\nPicked${forPet}:\n\n` +
      items
        .slice(0, 5)
        .map(
          (it) =>
            `- ${it.name} (${it.category})${it.rating ? ` — ${Number(it.rating).toFixed(1)}★` : ''}` +
            ((it.reasons ?? []).length ? `\n  why: ${(it.reasons ?? []).slice(0, 2).join(' · ')}` : ''),
        )
        .join('\n') +
      `\n\nDashboard: ${PARENT_DASH()}\n`,
  };
}

export function importFinishedEmail(
  to: string,
  name: string,
  job: {
    target: string;
    fileName: string | null;
    totalRows: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  },
): MailInput {
  const clean = job.failed === 0;
  name = who(name);
  return {
    tag: 'import_finished',
    to,
    subject: `Import finished — ${job.created} added, ${job.updated} updated`,
    html: page({
      eyebrow: 'Admin',
      banner: clean ? ['Import complete', 'success'] : ['Completed with errors', 'warning'],
      heading: 'Import finished',
      intro: h`Hi ${name} — your ${job.target} import has finished processing.`,
      blocks: [
        InfoBox([
          ['File', job.fileName || 'pasted data'],
          ['Rows read', String(job.totalRows)],
          ['Created', String(job.created)],
          ['Updated', String(job.updated)],
          ['Skipped', String(job.skipped)],
          ['Failed', String(job.failed)],
        ]),
        ...(clean ? [] : [Note('Failed rows are listed in the admin Import view, with the reason for each.')]),
        Button('Open admin', adminDash('import')),
      ],
      preheader: `${job.created} created · ${job.updated} updated · ${job.failed} failed`,
    }),
    text: `Hi ${name},\n\n${job.target} import finished.\nFile: ${job.fileName || 'pasted data'}\nRows: ${job.totalRows}\nCreated: ${job.created}\nUpdated: ${job.updated}\nSkipped: ${job.skipped}\nFailed: ${job.failed}\n\nAdmin: ${adminDash('import')}\n`,
  };
}

export function claimCredentialsEmail(
  to: string,
  businessName: string,
  tempPassword: string,
): MailInput {
  const loginUrl = siteUrl('/vendor-login/');
  businessName = who(businessName, 'there');
  return {
    tag: 'claim_credentials',
    to,
    sensitive: true,
    subject: `Welcome to Pets24x7! Temporary Credentials for ${businessName}`,
    html: page({
      eyebrow: 'Listing Claimed',
      heading: `Welcome to Pets24x7!`,
      intro: h`Your business owner account for ${businessName} has been created.`,
      blocks: [
        InfoBox([
          ['Login Email', to],
          ['Temporary Password', tempPassword],
        ]),
        Button('Login to Pets24x7', loginUrl),
        Note('For security, you will be required to create a new password after your first login.'),
      ],
      preheader: `Temporary login credentials for ${businessName} on Pets24x7.`,
    }),
    text: `Welcome to Pets24x7!

Your business owner account for ${businessName} has been created.

Login Email: ${to}
Temporary Password: ${tempPassword}

Login to Pets24x7: ${loginUrl}

For security, you will be required to create a new password after your first login.
`,
  };
}

export function businessRegisteredEmail(
  to: string,
  businessName: string,
  city: string,
): MailInput {
  const dashboardUrl = vendorDash('listing');
  businessName = who(businessName, 'there');
  return {
    tag: 'business_registered',
    to,
    subject: `Your Pets24x7 business has been registered successfully`,
    html: page({
      eyebrow: 'Business Registered',
      heading: `Congratulations!`,
      intro: h`Your business listing for ${businessName} in ${city} has been created successfully.`,
      blocks: [
        InfoBox([
          ['Business Name', businessName],
          ['City', city],
          ['Login Email', to],
        ]),
        Button('Go to Vendor Dashboard', dashboardUrl),
        Note('You can now log in to manage your business listing, update contact details, and view customer enquiries.'),
      ],
      preheader: `Your business ${businessName} is registered on Pets24x7.`,
    }),
    text: `Your Pets24x7 business has been registered successfully.

Business: ${businessName}
City: ${city}

You can now log in to manage your business listing: ${dashboardUrl}
`,
  };
}


// ===========================================================================
// Admin — account security
// ===========================================================================

/**
 * Sent to the address on file whenever an admin's own email or password
 * changes, so a change nobody made is noticed by the person who did not make it.
 */
export function adminProfileChangedEmail(
  to: string,
  name: string,
  change: { emailChanged: boolean; passwordChanged: boolean; newEmail: string | null },
): MailInput {
  const what = [
    change.passwordChanged ? 'the password' : null,
    change.emailChanged ? 'the sign-in email' : null,
  ].filter(Boolean).join(' and ');
  name = who(name);
  return {
    tag: 'admin_profile_changed',
    to,
    sensitive: true,
    subject: `Your Pets24x7 admin account changed`,
    html: page({
      eyebrow: 'Admin security',
      banner: ['Account updated', 'info'],
      heading: 'Your admin account was updated',
      intro: h`Hi ${name} — ${what || 'your profile'} on your Pets24x7 admin account was just changed.`,
      blocks: [
        InfoBox([
          ['Password changed', change.passwordChanged ? 'Yes — other sessions were signed out' : 'No'],
          ['Email changed', change.emailChanged ? `Yes — now ${change.newEmail ?? '—'}` : 'No'],
          ['When', dayTime(new Date())],
        ]),
        Note('If this was not you, change the password immediately and tell the other admins.'),
      ],
      preheader: 'An admin account setting was changed.',
    }),
    text: `Your Pets24x7 admin account was updated (${what || 'profile'}).\nIf this was not you, change the password immediately.\n`,
  };
}
