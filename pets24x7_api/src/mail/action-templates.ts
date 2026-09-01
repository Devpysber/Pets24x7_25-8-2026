// Every transactional mail Pets24x7 sends on a pet-parent or vendor action.
//
// One exported builder per action, each returning a ready MailInput. Callers
// send through notify()/notifyIf() so a mail failure never fails the action.
// Layout primitives live in components.ts.

import { env } from '../env.js';
import type { MailInput } from './mailer.js';
import { Button, InfoBox, Note, Quote, Text, day, dayTime, esc, h, money, page } from './components.js';
import { campaignGoalLabel } from '../payments/pricing.js';

const PARENT_DASH = () => `${env.PUBLIC_SITE_URL}/dashboard/parent/`;
const VENDOR_DASH = () => `${env.PUBLIC_SITE_URL}/dashboard/vendor/`;
const MEMBERSHIP = () => `${env.PUBLIC_SITE_URL}/membership/`;

// ===========================================================================
// Pet parent — account
// ===========================================================================

export function loginAlertEmail(
  to: string,
  name: string,
  at: Date,
  ip: string | null,
  device: string | null,
): MailInput {
  return {
    to,
    subject: 'New sign-in to your Pets24x7 account',
    html: page({
      eyebrow: 'Security',
      banner: ['New sign-in', 'info'],
      heading: `Hi ${name}`,
      intro: 'Your Pets24x7 account was just signed into. If this was you, nothing to do.',
      blocks: [
        InfoBox([
          ['When', dayTime(at)],
          ['IP address', ip || '—'],
          ['Device', (device || '—').slice(0, 60)],
        ]),
        Note("Didn't recognise this? Reply to this email and we'll lock the account."),
        Button('Open my dashboard', PARENT_DASH()),
      ],
      preheader: 'A new sign-in to your Pets24x7 account.',
    }),
    text: `Hi ${name},\n\nYour Pets24x7 account was signed into on ${dayTime(at)} (IP ${ip || '-'}, ${device || 'unknown device'}).\n\nIf this wasn't you, reply to this email.\n`,
  };
}

export function profileUpdatedEmail(to: string, name: string, changed: string[]): MailInput {
  return {
    to,
    subject: 'Your Pets24x7 profile was updated',
    html: page({
      eyebrow: 'Account',
      banner: ['Profile updated', 'success'],
      heading: `Hi ${name}`,
      intro: 'Your profile details were just changed.',
      blocks: [
        InfoBox([['Updated', changed.length ? changed.join(', ') : 'Profile details']]),
        Note("If you didn't make this change, reply to this email straight away."),
        Button('Review my profile', PARENT_DASH()),
      ],
    }),
    text: `Hi ${name},\n\nYour Pets24x7 profile was updated (${changed.join(', ') || 'profile details'}).\n\nIf this wasn't you, reply to this email.\n`,
  };
}

// ===========================================================================
// Pet parent — pets
// ===========================================================================

export function petAddedEmail(
  to: string,
  name: string,
  pet: { name: string; species: string; breed: string | null; ageYears: number | null },
): MailInput {
  return {
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
          ['Species', pet.species],
          ['Breed', pet.breed || '—'],
          ['Age', pet.ageYears == null ? '—' : `${pet.ageYears} years`],
        ]),
        Button('View my pets', PARENT_DASH()),
      ],
    }),
    text: `Hi ${name},\n\n${pet.name} (${pet.species}${pet.breed ? `, ${pet.breed}` : ''}) was added to your Pets24x7 profile.\n\nDashboard: ${PARENT_DASH()}\n`,
  };
}

export function petUpdatedEmail(to: string, name: string, petName: string): MailInput {
  return {
    to,
    subject: `${petName}'s profile was updated`,
    html: page({
      eyebrow: 'My pets',
      heading: `${petName}'s details changed`,
      intro: h`Hi ${name} — the profile for <strong>${petName}</strong> was just updated.`,
      blocks: [Button('View my pets', PARENT_DASH())],
    }),
    text: `Hi ${name},\n\nThe profile for ${petName} was updated.\n\nDashboard: ${PARENT_DASH()}\n`,
  };
}

export function petRemovedEmail(to: string, name: string, petName: string): MailInput {
  return {
    to,
    subject: `${petName} was removed from your profile`,
    html: page({
      eyebrow: 'My pets',
      banner: ['Pet removed', 'warning'],
      heading: `${petName} was removed`,
      intro: h`Hi ${name} — <strong>${petName}</strong> is no longer on your Pets24x7 profile.`,
      blocks: [
        Note("Removed by mistake? Add the pet again from your dashboard — it only takes a moment."),
        Button('Open my dashboard', PARENT_DASH()),
      ],
    }),
    text: `Hi ${name},\n\n${petName} was removed from your Pets24x7 profile. You can add the pet again from your dashboard: ${PARENT_DASH()}\n`,
  };
}

// ===========================================================================
// Pet parent — saved businesses
// ===========================================================================

export function listingSavedEmail(to: string, name: string, listingName: string | null): MailInput {
  const what = listingName || 'a business';
  return {
    to,
    subject: `Saved: ${what}`,
    html: page({
      eyebrow: 'Saved',
      heading: 'Added to your saved list',
      intro: h`Hi ${name} — <strong>${what}</strong> is saved to your Pets24x7 account, so it's one click away next time.`,
      blocks: [Button('View saved businesses', PARENT_DASH())],
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
): MailInput {
  return {
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
        Button('Open my dashboard', PARENT_DASH()),
        Note('Keep this email as your receipt.'),
      ],
      preheader: `${plan.name} active until ${day(endsAt)}.`,
    }),
    text: `Hi ${name},\n\nYour ${plan.name} membership is active.\nAmount paid: ${money(plan.priceMinor, plan.currency)}\nActive until: ${day(endsAt)}\nReference: ${merchantTxnId}\n\nDashboard: ${PARENT_DASH()}\n`,
  };
}

export function membershipCancelledEmail(to: string, name: string, planName: string, endsAt: Date | null): MailInput {
  return {
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
    }),
    text: `Hi ${name},\n\nAuto-renew is off for your ${planName} membership. Benefits stay active until ${day(endsAt)} and you won't be charged again.\n\nResume anytime: ${MEMBERSHIP()}\n`,
  };
}

export function membershipResumedEmail(to: string, name: string, planName: string, endsAt: Date | null): MailInput {
  return {
    to,
    subject: 'Auto-renew is back on',
    html: page({
      eyebrow: 'Membership',
      banner: ['Auto-renew on', 'success'],
      heading: 'Auto-renew resumed',
      intro: h`Hi ${name} — auto-renew is back on for your <strong>${planName}</strong> membership.`,
      blocks: [
        InfoBox([['Plan', planName], ['Next renewal', day(endsAt)]]),
        Button('Open my dashboard', PARENT_DASH()),
      ],
    }),
    text: `Hi ${name},\n\nAuto-renew is back on for your ${planName} membership. Next renewal: ${day(endsAt)}.\n\nDashboard: ${PARENT_DASH()}\n`,
  };
}

export function membershipExpiredEmail(to: string, name: string, planName: string): MailInput {
  return {
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
    }),
    text: `Hi ${name},\n\nYour ${planName} membership has ended. Your account, pets and saved businesses are untouched.\n\nRenew: ${MEMBERSHIP()}\n`,
  };
}

export function paymentFailedEmail(
  to: string,
  name: string,
  what: string,
  amountMinor: number,
  currency: string,
  merchantTxnId: string,
): MailInput {
  return {
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
        Button('Try again', MEMBERSHIP()),
      ],
    }),
    text: `Hi ${name},\n\nYour payment for ${what} (${money(amountMinor, currency)}, ref ${merchantTxnId}) did not complete, so nothing was activated.\n\nAny debited amount is returned by your bank, usually within 5 working days.\n\nTry again: ${MEMBERSHIP()}\n`,
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
  return {
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
    }),
    text: `Hi ${name},\n\nWe've refunded ${money(amountMinor, currency)} for ${what} (ref ${merchantTxnId}). It reaches the account you paid from within 5-7 working days.\n`,
  };
}

// ===========================================================================
// Enquiries — both sides
// ===========================================================================

export function enquiryReceivedEmail(to: string, name: string, listingName: string | null): MailInput {
  const target = listingName ? `<strong>${esc(listingName)}</strong>` : 'the Pets24x7 team';
  return {
    to,
    subject: 'We got your enquiry',
    html: page({
      eyebrow: 'Enquiry',
      banner: ['Enquiry sent', 'success'],
      heading: 'Enquiry received',
      intro: h`Thanks ${name} — your enquiry has reached ` + target + '.',
      blocks: [
        Note("You'll usually hear back within a few hours. We follow up on WhatsApp if there's no reply."),
        Button('Browse more services', `${env.PUBLIC_SITE_URL}/`),
      ],
    }),
    text: `Hi ${name},\n\nYour enquiry reached ${listingName ?? 'the Pets24x7 team'}. You'll usually hear back within a few hours.\n`,
  };
}

export function enquiryStatusEmail(
  to: string,
  name: string,
  listingName: string | null,
  status: 'RESPONDED' | 'COMPLETED' | 'ARCHIVED' | 'NEW',
): MailInput {
  const who = listingName || 'The business';
  const copy: Record<string, { subject: string; heading: string; intro: string }> = {
    RESPONDED: {
      subject: 'Your enquiry has been picked up',
      heading: 'Someone is on it',
      intro: `${who} has picked up your enquiry and should be in touch shortly.`,
    },
    COMPLETED: {
      subject: 'Your enquiry is closed',
      heading: 'Enquiry closed',
      intro: `${who} has marked your enquiry as handled. We hope it went well.`,
    },
    ARCHIVED: {
      subject: 'Your enquiry was archived',
      heading: 'Enquiry archived',
      intro: `${who} archived your enquiry. If you still need help, send a fresh one — we'll chase it.`,
    },
    NEW: {
      subject: 'Your enquiry was reopened',
      heading: 'Enquiry reopened',
      intro: `${who} has reopened your enquiry.`,
    },
  };
  const c = copy[status]!;
  return {
    to,
    subject: c.subject,
    html: page({
      eyebrow: 'Enquiry',
      heading: c.heading,
      intro: h`Hi ${name} — ${c.intro}`,
      blocks: [Button('View my enquiries', PARENT_DASH())],
    }),
    text: `Hi ${name},\n\n${c.intro}\n\nDashboard: ${PARENT_DASH()}\n`,
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
  return {
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
        Button('Open vendor dashboard', VENDOR_DASH()),
      ],
      preheader: `${enquiry.name} · ${enquiry.phone}`,
    }),
    text: `New enquiry for ${businessName}\n\nName: ${enquiry.name}\nPhone: ${enquiry.phone}\nPet: ${enquiry.petType || '-'}\nPreferred date: ${enquiry.preferredDate ? day(enquiry.preferredDate) : '-'}\nCity: ${enquiry.city || '-'}\n\n${enquiry.notes || 'No message left.'}\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

// ===========================================================================
// Vendor — account lifecycle
// ===========================================================================

export function vendorWelcomeEmail(to: string, businessName: string, listingName: string): MailInput {
  return {
    to,
    subject: 'Your Pets24x7 listing is claimed',
    html: page({
      eyebrow: 'Vendor',
      banner: ['Listing claimed', 'success'],
      heading: `Welcome, ${businessName}`,
      intro: h`You've claimed <strong>${listingName}</strong> on Pets24x7. Enquiries now come straight to you.`,
      blocks: [
        Text('Next: add your services and photos so parents can see what you offer, then start collecting reviews.'),
        Button('Complete my profile', VENDOR_DASH()),
      ],
    }),
    text: `Welcome, ${businessName}!\n\nYou've claimed ${listingName} on Pets24x7. Enquiries now come straight to you.\n\nComplete your profile: ${VENDOR_DASH()}\n`,
  };
}

export function vendorProfileUpdatedEmail(to: string, businessName: string, changed: string[]): MailInput {
  return {
    to,
    subject: 'Your business profile was updated',
    html: page({
      eyebrow: 'Vendor',
      banner: ['Profile updated', 'success'],
      heading: 'Profile updated',
      intro: h`The public profile for <strong>${businessName}</strong> was just changed. It's live on your listing now.`,
      blocks: [
        InfoBox([['Updated', changed.length ? changed.join(', ') : 'Business details']]),
        Button('View my listing', VENDOR_DASH()),
      ],
    }),
    text: `Hi ${businessName},\n\nYour Pets24x7 profile was updated (${changed.join(', ') || 'business details'}) and is live on your listing.\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function vendorApprovedEmail(to: string, businessName: string): MailInput {
  return {
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
    }),
    text: `Hi ${businessName},\n\nYour Pets24x7 listing is approved and live. You can now send review requests, list services, run campaigns and feature your listing.\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function vendorRejectedEmail(to: string, businessName: string, reason: string | null): MailInput {
  return {
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
    }),
    text: `Hi,\n\nYour Pets24x7 claim for ${businessName} was not approved.${reason ? `\nReason: ${reason}` : ''}\n\nReply to this email with proof of ownership and we'll review it again.\n`,
  };
}

export function vendorSuspendedEmail(to: string, businessName: string): MailInput {
  return {
    to,
    subject: 'Your Pets24x7 listing has been suspended',
    html: page({
      eyebrow: 'Vendor',
      banner: ['Suspended', 'danger'],
      heading: 'Listing suspended',
      intro: h`<strong>${businessName}</strong> is temporarily hidden from Pets24x7 and is not receiving enquiries.`,
      blocks: [Note('Reply to this email and we\'ll walk you through what is needed to restore it.')],
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
  return {
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
        Button('Manage services', VENDOR_DASH()),
      ],
    }),
    text: `Hi ${businessName},\n\n"${service.name}" (${money(service.priceMinor, service.currency)}, ${service.durationLabel}) was added to your listing.\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function serviceUpdatedEmail(to: string, businessName: string, serviceName: string): MailInput {
  return {
    to,
    subject: `"${serviceName}" was updated`,
    html: page({
      eyebrow: 'Services',
      heading: 'Service updated',
      intro: h`The details for <strong>${serviceName}</strong> on the ${businessName} listing were changed and are live.`,
      blocks: [Button('Manage services', VENDOR_DASH())],
    }),
    text: `Hi ${businessName},\n\n"${serviceName}" was updated on your listing.\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function serviceRemovedEmail(to: string, businessName: string, serviceName: string): MailInput {
  return {
    to,
    subject: `"${serviceName}" was removed`,
    html: page({
      eyebrow: 'Services',
      banner: ['Service removed', 'warning'],
      heading: 'Service removed',
      intro: h`<strong>${serviceName}</strong> no longer appears on the ${businessName} listing.`,
      blocks: [Button('Manage services', VENDOR_DASH())],
    }),
    text: `Hi ${businessName},\n\n"${serviceName}" was removed from your listing.\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function serviceModeratedEmail(
  to: string,
  businessName: string,
  serviceName: string,
  status: 'ACTIVE' | 'HIDDEN',
): MailInput {
  const hidden = status === 'HIDDEN';
  return {
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
        Button('Manage services', VENDOR_DASH()),
      ],
    }),
    text: hidden
      ? `Hi ${businessName},\n\nOur team hid "${serviceName}" on your listing while we check it. Reply to this email if that looks wrong.\n`
      : `Hi ${businessName},\n\n"${serviceName}" is visible on your listing again.\n`,
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
  return {
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
        Button('Track requests', VENDOR_DASH()),
      ],
    }),
    text: `Hi ${businessName},\n\n${stats.sent} review request(s) sent, ${stats.failed} failed, ${stats.remainingToday} left in today's cap.\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function vendorNewReviewEmail(
  to: string,
  businessName: string,
  review: { reviewerName: string; rating: number; text: string },
): MailInput {
  const stars = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
  return {
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
        Button('View my reviews', VENDOR_DASH()),
      ],
      preheader: `${review.rating}/5 from ${review.reviewerName}`,
    }),
    text: `New ${review.rating}-star review for ${businessName}\n\nFrom: ${review.reviewerName}\n"${review.text}"\n\nIt goes live after moderation, usually within a day.\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function reviewPublishedEmail(
  to: string,
  businessName: string,
  review: { reviewerName: string; rating: number },
): MailInput {
  return {
    to,
    subject: 'A review just went live on your listing',
    html: page({
      eyebrow: 'Reviews',
      banner: ['Published', 'success'],
      heading: 'Review published',
      intro: h`The ${review.rating}-star review from <strong>${review.reviewerName}</strong> is now public on the ${businessName} listing.`,
      blocks: [
        Note('Replying to reviews lifts conversion — a short, warm reply is enough.'),
        Button('Reply to it', VENDOR_DASH()),
      ],
    }),
    text: `Hi ${businessName},\n\nThe ${review.rating}-star review from ${review.reviewerName} is now live on your listing.\n\nReply from your dashboard: ${VENDOR_DASH()}\n`,
  };
}

export function reviewRejectedEmail(
  to: string,
  businessName: string,
  review: { reviewerName: string; rating: number },
  reason: string | null,
): MailInput {
  return {
    to,
    subject: 'A review on your listing was not published',
    html: page({
      eyebrow: 'Reviews',
      banner: ['Not published', 'warning'],
      heading: 'Review rejected by moderation',
      intro: h`The ${review.rating}-star review from <strong>${review.reviewerName}</strong> did not pass our checks, so it will not appear on the ${businessName} listing.`,
      blocks: [...(reason ? [InfoBox([['Reason', reason]])] : []), Button('View my reviews', VENDOR_DASH())],
    }),
    text: `Hi ${businessName},\n\nThe ${review.rating}-star review from ${review.reviewerName} was not published.${reason ? `\nReason: ${reason}` : ''}\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function reviewReplyPostedEmail(to: string, businessName: string, reviewerName: string): MailInput {
  return {
    to,
    subject: 'Your reply is live',
    html: page({
      eyebrow: 'Reviews',
      banner: ['Reply posted', 'success'],
      heading: 'Reply posted',
      intro: h`Your reply to <strong>${reviewerName}</strong> is now showing under their review on the ${businessName} listing.`,
      blocks: [Button('View my reviews', VENDOR_DASH())],
    }),
    text: `Hi ${businessName},\n\nYour reply to ${reviewerName} is live under their review.\n\nDashboard: ${VENDOR_DASH()}\n`,
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
  return {
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
        Button('Complete payment', VENDOR_DASH()),
      ],
    }),
    text: `Hi ${businessName},\n\nYour ${campaignGoalLabel(campaign.goal)} campaign (${campaign.durationDays} days, ${money(campaign.priceMinor, campaign.currency)}, ref ${merchantTxnId}) is reserved and awaiting payment.\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function campaignSubmittedEmail(
  to: string,
  businessName: string,
  campaign: { goal: string; durationDays: number; priceMinor: number; currency: string },
  merchantTxnId: string,
): MailInput {
  return {
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
        Button('Track my campaign', VENDOR_DASH()),
      ],
    }),
    text: `Hi ${businessName},\n\nPayment received for your ${campaignGoalLabel(campaign.goal)} campaign (${campaign.durationDays} days, ${money(campaign.priceMinor, campaign.currency)}, ref ${merchantTxnId}). It is now in review; we'll email you when it goes live.\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function campaignApprovedEmail(
  to: string,
  businessName: string,
  campaign: { goal: string; durationDays: number },
  endsAt: Date | null,
): MailInput {
  return {
    to,
    subject: 'Your campaign is live',
    html: page({
      eyebrow: 'Marketing',
      banner: ['Live now', 'success'],
      heading: 'Campaign approved and running',
      intro: h`Your <strong>${campaignGoalLabel(campaign.goal)}</strong> campaign for ${businessName} is live and pushing your listing to pet parents.`,
      blocks: [
        InfoBox([['Goal', campaignGoalLabel(campaign.goal)], ['Runs for', `${campaign.durationDays} days`], ['Ends', day(endsAt)]]),
        Button('See performance', VENDOR_DASH()),
      ],
    }),
    text: `Hi ${businessName},\n\nYour ${campaignGoalLabel(campaign.goal)} campaign is live and runs for ${campaign.durationDays} days, ending ${day(endsAt)}.\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function campaignCancelledEmail(to: string, businessName: string, goal: string): MailInput {
  return {
    to,
    subject: 'Your campaign was cancelled',
    html: page({
      eyebrow: 'Marketing',
      banner: ['Cancelled', 'danger'],
      heading: 'Campaign cancelled',
      intro: h`Your <strong>${campaignGoalLabel(goal)}</strong> campaign for ${businessName} has been cancelled and is not running.`,
      blocks: [Note('If you were charged, the refund follows automatically. Reply here with any questions.')],
    }),
    text: `Hi ${businessName},\n\nYour ${campaignGoalLabel(goal)} campaign was cancelled and is not running. Any charge is refunded automatically.\n`,
  };
}

export function campaignCompletedEmail(to: string, businessName: string, goal: string): MailInput {
  return {
    to,
    subject: 'Your campaign has finished',
    html: page({
      eyebrow: 'Marketing',
      banner: ['Completed', 'info'],
      heading: 'Campaign finished',
      intro: h`Your <strong>${campaignGoalLabel(goal)}</strong> campaign for ${businessName} has run its full term.`,
      blocks: [
        Note('Enquiries that came in during the run are all in your dashboard.'),
        Button('Run it again', VENDOR_DASH()),
      ],
    }),
    text: `Hi ${businessName},\n\nYour ${campaignGoalLabel(goal)} campaign has finished its run. Every enquiry it brought in is in your dashboard: ${VENDOR_DASH()}\n`,
  };
}

// ===========================================================================
// Vendor — featured listings
// ===========================================================================

export function featuredLiveEmail(
  to: string,
  businessName: string,
  featured: { priceMinor: number; currency: string; durationDays: number },
  endsAt: Date | null,
  merchantTxnId: string,
  startsAt: Date | null = null,
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
  return {
    to,
    subject: queued ? 'Your featured placement is booked' : 'Your listing is now featured',
    html: page({
      eyebrow: 'Featured',
      banner: queued ? ['Booked', 'info'] : ['Boost active', 'success'],
      heading: queued ? "You're booked" : "You're featured",
      intro: queued
        ? h`<strong>${businessName}</strong> is booked for the top of its category and city results, starting when your current placement ends.`
        : h`<strong>${businessName}</strong> is now boosted to the top of its category and city results.`,
      blocks: [InfoBox(rows), Button('See my placement', VENDOR_DASH())],
    }),
    text: queued
      ? `Hi ${businessName},\n\nYour featured placement is booked for ${featured.durationDays} days, starting ${day(startsAt)} and running until ${day(endsAt)}. Paid: ${money(featured.priceMinor, featured.currency)} (ref ${merchantTxnId}).\n\nDashboard: ${VENDOR_DASH()}\n`
      : `Hi ${businessName},\n\nYour listing is featured for ${featured.durationDays} days, until ${day(endsAt)}. Paid: ${money(featured.priceMinor, featured.currency)} (ref ${merchantTxnId}).\n\nDashboard: ${VENDOR_DASH()}\n`,
  };
}

export function featuredEndedEmail(to: string, businessName: string, cancelled = false): MailInput {
  return {
    to,
    subject: cancelled ? 'Your featured placement was cancelled' : 'Your featured placement has ended',
    html: page({
      eyebrow: 'Featured',
      banner: cancelled ? ['Cancelled', 'danger'] : ['Boost ended', 'warning'],
      heading: cancelled ? 'Featured placement cancelled' : 'Featured placement ended',
      intro: cancelled
        ? h`The featured boost for <strong>${businessName}</strong> was cancelled and is no longer running.`
        : h`The featured boost for <strong>${businessName}</strong> has run its full term. Your listing is back in normal ranking.`,
      blocks: [Button('Feature it again', VENDOR_DASH())],
    }),
    text: cancelled
      ? `Hi ${businessName},\n\nYour featured placement was cancelled.\n\nDashboard: ${VENDOR_DASH()}\n`
      : `Hi ${businessName},\n\nYour featured placement has ended and your listing is back in normal ranking.\n\nFeature it again: ${VENDOR_DASH()}\n`,
  };
}

export function petPhotoUpdatedEmail(
  to: string,
  name: string,
  petName: string,
  removed = false,
): MailInput {
  return {
    to,
    subject: removed ? `${petName}'s photo was removed` : `${petName} has a new photo`,
    html: page({
      eyebrow: 'My pets',
      banner: removed ? ['Photo removed', 'warning'] : ['Photo updated', 'success'],
      heading: removed ? `${petName}'s photo was removed` : `${petName} looks great`,
      intro: removed
        ? h`Hi ${name} — the photo on ${petName}'s profile was removed. You can add a new one anytime.`
        : h`Hi ${name} — ${petName}'s new profile photo is saved and showing on your dashboard.`,
      blocks: [Button('View my pets', PARENT_DASH())],
    }),
    text: removed
      ? `Hi ${name},\n\n${petName}'s photo was removed. Add a new one anytime: ${PARENT_DASH()}\n`
      : `Hi ${name},\n\n${petName}'s new profile photo is saved.\n\nDashboard: ${PARENT_DASH()}\n`,
  };
}

export function listingUnsavedEmail(to: string, name: string, listingName: string | null): MailInput {
  const what = listingName || 'A business';
  return {
    to,
    subject: `Removed from your saved list`,
    html: page({
      eyebrow: 'Saved',
      banner: ['Removed', 'warning'],
      heading: 'Removed from your saved list',
      intro: h`Hi ${name} — ${what} is no longer saved to your Pets24x7 account.`,
      blocks: [Button('Browse services', `${env.PUBLIC_SITE_URL}/`)],
    }),
    text: `Hi ${name},\n\n${what} was removed from your saved list.\n`,
  };
}

export function featuredCreatedEmail(
  to: string,
  businessName: string,
  featured: { priceMinor: number; currency: string; durationDays: number },
  merchantTxnId: string,
): MailInput {
  return {
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
        Button('Complete payment', VENDOR_DASH()),
      ],
    }),
    text: `Hi ${businessName},\n\nYour featured placement (${featured.durationDays} days, ${money(featured.priceMinor, featured.currency)}, ref ${merchantTxnId}) is reserved and awaiting payment.\n\nDashboard: ${VENDOR_DASH()}\n`,
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
      const why = (it.reasons ?? []).slice(0, 2).join(' · ');
      const title = it.url
        ? `<a href="${esc(it.url)}" style="color:#111827;text-decoration:none">${esc(it.name)}</a>`
        : esc(it.name);
      return `<tr><td style="padding:14px 0;border-top:1px solid #eceef2">
        <div style="font-size:15px;font-weight:700;line-height:1.35">${title}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:3px">${esc(it.category)}${it.city ? ` · ${esc(it.city)}` : ''}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:3px">${esc(stars)}${esc(reviews)}</div>
        ${why ? `<div style="font-size:12px;color:#ff6b35;font-weight:600;margin-top:5px">${esc(why)}</div>` : ''}
      </td></tr>`;
    })
    .join('');

  const forPet = petName ? ` for ${petName}` : '';
  return {
    kind: 'marketing',
    to,
    subject: petName ? `Picked for ${petName}` : 'Pet services picked for you',
    html: page({
      eyebrow: 'Recommendations',
      heading: petName ? `Picked for ${petName}` : 'Picked for you',
      intro: h`Hi ${name} — these are the best-rated places near you that match what${forPet} actually needs.`,
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
  return {
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
        Button('Open admin', `${env.PUBLIC_SITE_URL}/dashboard/admin/`),
      ],
      preheader: `${job.created} created · ${job.updated} updated · ${job.failed} failed`,
    }),
    text: `Hi ${name},\n\n${job.target} import finished.\nFile: ${job.fileName || 'pasted data'}\nRows: ${job.totalRows}\nCreated: ${job.created}\nUpdated: ${job.updated}\nSkipped: ${job.skipped}\nFailed: ${job.failed}\n`,
  };
}
