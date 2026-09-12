// Lifecycle, reminder and digest mail — everything that is not the immediate
// receipt for an action the recipient just took (those live in
// action-templates.ts).
//
// Three groups:
//   • account security — password and address changes, account closure
//   • reminders        — something is about to lapse, or needs a reply
//   • digests          — weekly vendor performance, admin operations summary
//
// A reminder that is not the direct consequence of a user action is marketing
// mail: it carries kind:'marketing' so an opt-out suppresses it and every send
// gets an unsubscribe link. Security notices are always transactional.

import { env } from '../env.js';
import type { MailInput } from './mailer.js';
import { Button, InfoBox, Note, Quote, Text, day, dayTime, esc, h, money, page } from './components.js';

const PARENT_DASH = () => `${env.PUBLIC_SITE_URL}/dashboard/parent/`;
const VENDOR_DASH = () => `${env.PUBLIC_SITE_URL}/dashboard/vendor/`;
const MEMBERSHIP = () => `${env.PUBLIC_SITE_URL}/membership/`;
const ADMIN_DASH = () => `${env.PUBLIC_SITE_URL}/dashboard/admin/`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ===========================================================================
// Account security — pet parent
// ===========================================================================

export function passwordResetEmail(to: string, name: string, link: string, ttlMinutes: number): MailInput {
  return {
    to,
    subject: 'Reset your Pets24x7 password',
    html: page({
      eyebrow: 'Security',
      heading: `Reset your password, ${name}`,
      intro: 'Use the button below to choose a new password. If you did not ask for this, you can ignore the email.',
      blocks: [
        Button('Choose a new password', link),
        Note(`This link works once and expires in ${ttlMinutes} minutes.`),
        Note(`If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all">${esc(link)}</span>`),
        Note('Your current password keeps working until you set a new one.'),
      ],
      preheader: `Password reset link — expires in ${ttlMinutes} minutes.`,
    }),
    text: `Hi ${name},\n\nReset your Pets24x7 password: ${link}\n\nThis link works once and expires in ${ttlMinutes} minutes. If you didn't ask for it, ignore this email.\n`,
  };
}

export function passwordChangedEmail(to: string, name: string, at: Date, ip: string | null): MailInput {
  return {
    to,
    subject: 'Your Pets24x7 password was changed',
    html: page({
      eyebrow: 'Security',
      banner: ['Password changed', 'warning'],
      heading: 'Your password was changed',
      intro: h`Hi ${name} — the password on your Pets24x7 account was just changed.`,
      blocks: [
        InfoBox([
          ['When', dayTime(at)],
          ['IP address', ip || 'unknown'],
        ]),
        Note('If this was you, nothing more to do. If it was not, reply to this email immediately and we will lock the account.'),
      ],
      preheader: 'Your Pets24x7 password was just changed.',
    }),
    text: `Hi ${name},\n\nYour Pets24x7 password was changed on ${dayTime(at)} (IP ${ip || 'unknown'}).\n\nIf this wasn't you, reply to this email immediately.\n`,
  };
}

export function emailChangedEmail(to: string, name: string, newEmail: string): MailInput {
  return {
    to,
    subject: 'The email on your Pets24x7 account changed',
    html: page({
      eyebrow: 'Security',
      banner: ['Address changed', 'warning'],
      heading: 'Your account email changed',
      intro: h`Hi ${name} — your Pets24x7 sign-in address is now ${newEmail}. This is the last message we will send to the old address.`,
      blocks: [Note('If you did not make this change, reply to this email straight away — we can undo it.')],
      preheader: `Your account email is now ${newEmail}.`,
    }),
    text: `Hi ${name},\n\nYour Pets24x7 sign-in address is now ${newEmail}. If you didn't make this change, reply to this email straight away.\n`,
  };
}

export function accountDeletedEmail(to: string, name: string): MailInput {
  return {
    to,
    subject: 'Your Pets24x7 account is closed',
    html: page({
      eyebrow: 'Account',
      heading: 'Your account is closed',
      intro: h`Hi ${name} — your Pets24x7 account, your pets' profiles and your saved places have been deleted.`,
      blocks: [
        Note('Payment records are kept for as long as tax law requires, and nothing else remains.'),
        Button('Start again any time', `${env.PUBLIC_SITE_URL}/login/`),
      ],
      preheader: 'Your Pets24x7 account has been closed.',
    }),
    text: `Hi ${name},\n\nYour Pets24x7 account and its data have been deleted. Payment records are kept only for as long as tax law requires.\n`,
  };
}

export function emailVerifiedEmail(to: string, name: string): MailInput {
  return {
    to,
    subject: 'Email verified 🎉',
    html: page({
      eyebrow: 'Account',
      banner: ['Verified', 'success'],
      heading: 'Your email is verified',
      intro: h`Thanks ${name} — this address is confirmed, so receipts, reminders and enquiry updates will reach you.`,
      blocks: [Button('Open my dashboard', PARENT_DASH())],
      preheader: 'Your email address is confirmed.',
    }),
    text: `Hi ${name},\n\nYour email is verified. Dashboard: ${PARENT_DASH()}\n`,
  };
}

// ===========================================================================
// Membership reminders — pet parent
// ===========================================================================

export function membershipExpiringEmail(
  to: string,
  name: string,
  planName: string,
  endsAt: Date,
  daysLeft: number,
): MailInput {
  const when = daysLeft <= 1 ? 'tomorrow' : `in ${plural(daysLeft, 'day')}`;
  return {
    kind: 'marketing',
    to,
    subject: `Your ${planName} membership ends ${when}`,
    html: page({
      eyebrow: 'Membership',
      banner: [`Ends ${when}`, 'warning'],
      heading: 'Your membership is about to end',
      intro: h`Hi ${name} — your ${planName} membership runs out on ${day(endsAt)}. Renew to keep member pricing at every partner vet, groomer and boarding house.`,
      blocks: [
        InfoBox([
          ['Plan', planName],
          ['Ends', day(endsAt)],
        ]),
        Button('Renew my membership', MEMBERSHIP()),
      ],
      preheader: `${planName} ends ${day(endsAt)}.`,
    }),
    text: `Hi ${name},\n\nYour ${planName} membership ends on ${day(endsAt)}. Renew: ${MEMBERSHIP()}\n`,
  };
}

export function membershipRenewingEmail(
  to: string,
  name: string,
  planName: string,
  amountMinor: number,
  currency: string,
  renewsAt: Date,
): MailInput {
  return {
    to,
    subject: `Your ${planName} membership renews on ${day(renewsAt)}`,
    html: page({
      eyebrow: 'Membership',
      heading: 'Renewing soon',
      intro: h`Hi ${name} — a heads-up before we charge you again. Nothing to do if you want to carry on.`,
      blocks: [
        InfoBox([
          ['Plan', planName],
          ['Amount', money(amountMinor, currency)],
          ['Renews on', day(renewsAt)],
        ]),
        Button('Manage my membership', MEMBERSHIP()),
        Note('Cancel any time before that date and you will not be charged.'),
      ],
      preheader: `${planName} renews ${day(renewsAt)} for ${money(amountMinor, currency)}.`,
    }),
    text: `Hi ${name},\n\nYour ${planName} membership renews on ${day(renewsAt)} for ${money(amountMinor, currency)}.\nManage it: ${MEMBERSHIP()}\n`,
  };
}

export function membershipUpgradedEmail(
  to: string,
  name: string,
  fromPlan: string,
  toPlan: string,
  creditMinor: number,
  currency: string,
  endsAt: Date | null,
): MailInput {
  const rows: Array<[string, string]> = [
    ['Previous plan', fromPlan],
    ['New plan', toPlan],
  ];
  if (creditMinor > 0) rows.push(['Unused time credited', money(creditMinor, currency)]);
  rows.push(['Runs until', day(endsAt)]);
  return {
    to,
    subject: `You are now on ${toPlan}`,
    html: page({
      eyebrow: 'Membership',
      banner: ['Plan changed', 'success'],
      heading: `Welcome to ${toPlan}`,
      intro: h`Hi ${name} — you have moved from ${fromPlan} to ${toPlan}. Your new benefits are live right now.`,
      blocks: [InfoBox(rows), Button('See what is included', MEMBERSHIP())],
      preheader: `You are now on ${toPlan}.`,
    }),
    text: `Hi ${name},\n\nYou moved from ${fromPlan} to ${toPlan}${creditMinor > 0 ? `, with ${money(creditMinor, currency)} of unused time credited` : ''}. It runs until ${day(endsAt)}.\n`,
  };
}

export function winbackEmail(to: string, name: string, planName: string): MailInput {
  return {
    kind: 'marketing',
    to,
    subject: 'Come back to Pets24x7 membership',
    html: page({
      eyebrow: 'Membership',
      heading: 'Your pets miss the perks',
      intro: h`Hi ${name} — your ${planName} membership ended a while ago. Member pricing, priority booking and vet discounts come back the moment you rejoin.`,
      blocks: [Button('Rejoin in a minute', MEMBERSHIP()), Note('No lock-in. Cancel whenever you like.')],
      preheader: 'Member pricing is one click away.',
    }),
    text: `Hi ${name},\n\nYour ${planName} membership ended. Rejoin any time: ${MEMBERSHIP()}\n`,
  };
}

// ===========================================================================
// Payments — receipts and states
// ===========================================================================

export function paymentReceiptEmail(
  to: string,
  name: string,
  what: string,
  amountMinor: number,
  currency: string,
  merchantTxnId: string,
  paidAt: Date,
): MailInput {
  return {
    to,
    subject: `Receipt — ${money(amountMinor, currency)} for ${what}`,
    html: page({
      eyebrow: 'Receipt',
      banner: ['Payment received', 'success'],
      heading: 'Thanks — payment received',
      intro: h`Hi ${name} — here is your receipt for ${what}. Keep it for your records.`,
      blocks: [
        InfoBox([
          ['Item', what],
          ['Amount paid', money(amountMinor, currency)],
          ['Paid on', dayTime(paidAt)],
          ['Reference', merchantTxnId],
        ]),
        Note('Need a GST invoice with your business details? Reply to this email and we will send one.'),
      ],
      preheader: `${money(amountMinor, currency)} paid for ${what}.`,
    }),
    text: `Hi ${name},\n\nReceipt for ${what}.\nAmount: ${money(amountMinor, currency)}\nPaid: ${dayTime(paidAt)}\nReference: ${merchantTxnId}\n`,
  };
}

export function paymentPendingEmail(to: string, name: string, what: string, merchantTxnId: string): MailInput {
  return {
    to,
    subject: 'Your payment is still processing',
    html: page({
      eyebrow: 'Payment',
      banner: ['Processing', 'info'],
      heading: 'Still waiting on your bank',
      intro: h`Hi ${name} — your payment for ${what} has not confirmed yet. Banks sometimes take a few minutes.`,
      blocks: [
        InfoBox([['Reference', merchantTxnId]]),
        Note('Do not pay again. If it fails, the money never leaves your account, and we will email you either way.'),
      ],
      preheader: 'Your payment is still processing.',
    }),
    text: `Hi ${name},\n\nYour payment for ${what} (ref ${merchantTxnId}) is still processing. Don't pay again — we'll email you the moment it settles.\n`,
  };
}

export function refundInitiatedEmail(
  to: string,
  name: string,
  what: string,
  amountMinor: number,
  currency: string,
  merchantTxnId: string,
): MailInput {
  return {
    to,
    subject: 'Your refund has been started',
    html: page({
      eyebrow: 'Payment',
      banner: ['Refund started', 'info'],
      heading: 'Refund on its way',
      intro: h`Hi ${name} — we have asked your bank to return the money you paid for ${what}.`,
      blocks: [
        InfoBox([
          ['Amount', money(amountMinor, currency)],
          ['Reference', merchantTxnId],
          ['Expect it by', 'Within 5–7 working days'],
        ]),
        Note('It goes back to the card or account you paid from. Your bank decides the exact day.'),
      ],
      preheader: `${money(amountMinor, currency)} refund started.`,
    }),
    text: `Hi ${name},\n\nA refund of ${money(amountMinor, currency)} for ${what} (ref ${merchantTxnId}) has been started. It reaches you within 5-7 working days.\n`,
  };
}

export function paymentRetryEmail(
  to: string,
  name: string,
  what: string,
  amountMinor: number,
  currency: string,
): MailInput {
  return {
    to,
    subject: `Payment for ${what} did not go through`,
    html: page({
      eyebrow: 'Payment',
      banner: ['Payment failed', 'danger'],
      heading: 'That payment did not go through',
      intro: h`Hi ${name} — your bank declined the ${money(amountMinor, currency)} payment for ${what}. Nothing has been charged.`,
      blocks: [
        Button('Try again', MEMBERSHIP()),
        Note('A different card, UPI app or net banking usually clears it. Cards often decline online payments until you enable them in your bank app.'),
      ],
      preheader: 'Your payment was declined — nothing was charged.',
    }),
    text: `Hi ${name},\n\nThe ${money(amountMinor, currency)} payment for ${what} was declined and nothing was charged. Try again: ${MEMBERSHIP()}\n`,
  };
}

// ===========================================================================
// Pet care reminders — pet parent
// ===========================================================================

export function petBirthdayEmail(to: string, name: string, petName: string, age: number | null): MailInput {
  return {
    kind: 'marketing',
    to,
    subject: `Happy birthday, ${petName}! 🎂`,
    html: page({
      eyebrow: 'Today',
      heading: `Happy birthday, ${petName}!`,
      intro: h`Hi ${name} — ${petName} is${age ? ` ${age} today` : ' celebrating today'}. Groomers and pet bakeries near you would love to make a fuss.`,
      blocks: [
        Button('Find a treat nearby', `${env.PUBLIC_SITE_URL}/`),
        Note('A yearly check-up around a birthday is the easiest one to remember.'),
      ],
      preheader: `${petName} is celebrating today.`,
    }),
    text: `Hi ${name},\n\nHappy birthday to ${petName}! Find something nearby: ${env.PUBLIC_SITE_URL}/\n`,
  };
}

export function vaccinationDueEmail(
  to: string,
  name: string,
  petName: string,
  vaccine: string,
  dueAt: Date,
): MailInput {
  return {
    kind: 'marketing',
    to,
    subject: `${petName}'s ${vaccine} is due`,
    html: page({
      eyebrow: 'Reminder',
      banner: ['Due soon', 'warning'],
      heading: `${petName} is due for a ${vaccine}`,
      intro: h`Hi ${name} — ${petName}'s ${vaccine} is due on ${day(dueAt)}. Book a vet near you before it lapses.`,
      blocks: [
        Button('Find a vet nearby', `${env.PUBLIC_SITE_URL}/`),
        Note('Already done? Update the date on your dashboard and we will stop reminding you.'),
      ],
      preheader: `${vaccine} due ${day(dueAt)}.`,
    }),
    text: `Hi ${name},\n\n${petName}'s ${vaccine} is due on ${day(dueAt)}. Find a vet: ${env.PUBLIC_SITE_URL}/\n`,
  };
}

export function petCheckupEmail(to: string, name: string, petName: string, monthsSince: number): MailInput {
  return {
    kind: 'marketing',
    to,
    subject: `Time for ${petName}'s check-up`,
    html: page({
      eyebrow: 'Reminder',
      heading: `${petName} is due a check-up`,
      intro: h`Hi ${name} — it has been ${plural(monthsSince, 'month')} since ${petName}'s last recorded vet visit. A yearly look-over catches the expensive things early.`,
      blocks: [Button('Book a vet near you', `${env.PUBLIC_SITE_URL}/`)],
      preheader: `${petName} is due a check-up.`,
    }),
    text: `Hi ${name},\n\nIt's been ${plural(monthsSince, 'month')} since ${petName}'s last vet visit. Find one nearby: ${env.PUBLIC_SITE_URL}/\n`,
  };
}

export function inactivityNudgeEmail(to: string, name: string, city: string | null): MailInput {
  const where = city ? ` in ${city}` : ' near you';
  return {
    kind: 'marketing',
    to,
    subject: 'New pet services near you',
    html: page({
      eyebrow: 'Nearby',
      heading: `New places${where}`,
      intro: h`Hi ${name} — we have added new vets, groomers and boarding houses${where} since you last looked.`,
      blocks: [Button('See what is new', PARENT_DASH())],
      preheader: `New pet services${where}.`,
    }),
    text: `Hi ${name},\n\nNew pet services${where}. Take a look: ${PARENT_DASH()}\n`,
  };
}

export function dealNearbyEmail(
  to: string,
  name: string,
  deal: { title: string; businessName: string; city: string | null; endsAt: Date | null; url?: string },
): MailInput {
  return {
    kind: 'marketing',
    to,
    subject: `${deal.businessName}: ${deal.title}`,
    html: page({
      eyebrow: 'Member deal',
      heading: deal.title,
      intro: h`Hi ${name} — ${deal.businessName}${deal.city ? ` in ${deal.city}` : ''} is running this for Pets24x7 members.`,
      blocks: [
        ...(deal.endsAt ? [InfoBox([['Offer ends', day(deal.endsAt)]] as Array<[string, string]>)] : []),
        Button('See the offer', deal.url || `${env.PUBLIC_SITE_URL}/`),
      ],
      preheader: `${deal.title} at ${deal.businessName}.`,
    }),
    text: `Hi ${name},\n\n${deal.businessName}: ${deal.title}${deal.endsAt ? ` (ends ${day(deal.endsAt)})` : ''}\n${deal.url || env.PUBLIC_SITE_URL}\n`,
  };
}

export function eventReminderEmail(
  to: string,
  name: string,
  ev: { title: string; startsAt: Date; venue: string | null; city: string | null; url?: string },
): MailInput {
  return {
    kind: 'marketing',
    to,
    subject: `${ev.title} — ${day(ev.startsAt)}`,
    html: page({
      eyebrow: 'Event',
      heading: ev.title,
      intro: h`Hi ${name} — this is happening near you soon.`,
      blocks: [
        InfoBox([
          ['When', dayTime(ev.startsAt)],
          ['Where', [ev.venue, ev.city].filter(Boolean).join(', ') || 'See listing'],
        ]),
        Button('Event details', ev.url || `${env.PUBLIC_SITE_URL}/`),
      ],
      preheader: `${ev.title} on ${day(ev.startsAt)}.`,
    }),
    text: `Hi ${name},\n\n${ev.title}\n${dayTime(ev.startsAt)}\n${[ev.venue, ev.city].filter(Boolean).join(', ')}\n${ev.url || env.PUBLIC_SITE_URL}\n`,
  };
}

export function referralInviteEmail(to: string, fromName: string, link: string): MailInput {
  return {
    kind: 'marketing',
    to,
    subject: `${fromName} thinks your pet would like Pets24x7`,
    html: page({
      eyebrow: 'Invitation',
      heading: `${fromName} invited you`,
      intro: h`${fromName} uses Pets24x7 to find vets, groomers and boarding — and thought you might too.`,
      blocks: [
        Button('See what is near me', link),
        Note('Free to join. We never share your details with a business until you send an enquiry.'),
      ],
      preheader: `${fromName} invited you to Pets24x7.`,
    }),
    text: `${fromName} invited you to Pets24x7: ${link}\n`,
  };
}

export function enquiryReplyEmail(to: string, name: string, businessName: string, message: string): MailInput {
  return {
    to,
    subject: `${businessName} replied to your enquiry`,
    html: page({
      eyebrow: 'Enquiry',
      banner: ['New reply', 'success'],
      heading: `${businessName} got back to you`,
      intro: h`Hi ${name} — here is what they said.`,
      blocks: [Quote(message), Button('Open my enquiries', PARENT_DASH())],
      preheader: `${businessName} replied to your enquiry.`,
    }),
    text: `Hi ${name},\n\n${businessName} replied:\n\n"${message}"\n\n${PARENT_DASH()}\n`,
  };
}

export function reviewThanksEmail(to: string, name: string, businessName: string): MailInput {
  return {
    to,
    subject: 'Thanks for the review',
    html: page({
      eyebrow: 'Reviews',
      heading: 'Thanks for writing that',
      intro: h`Hi ${name} — your review of ${businessName} is live. It is the single most useful thing for the next pet parent deciding where to go.`,
      blocks: [Button('Review somewhere else', PARENT_DASH())],
      preheader: `Your review of ${businessName} is live.`,
    }),
    text: `Hi ${name},\n\nYour review of ${businessName} is live. Thank you.\n`,
  };
}

// ===========================================================================
// Vendor — claim, verification, reminders, digests
// ===========================================================================

export function vendorClaimSubmittedEmail(to: string, businessName: string, listingName: string): MailInput {
  return {
    to,
    subject: `We have your claim for ${listingName}`,
    html: page({
      eyebrow: 'Claim',
      banner: ['Awaiting review', 'info'],
      heading: 'Claim received',
      intro: h`Thanks ${businessName} — we have your claim for ${listingName}. An admin checks it by hand, usually within one working day.`,
      blocks: [
        Text('Nothing else is needed from you right now. We will email the moment it is approved.'),
        Button('Open my dashboard', VENDOR_DASH()),
      ],
      preheader: `Your claim for ${listingName} is with our team.`,
    }),
    text: `Hi ${businessName},\n\nWe have your claim for ${listingName}. An admin reviews it by hand, usually within a working day.\n`,
  };
}

export function vendorClaimReminderEmail(
  to: string,
  businessName: string,
  listingName: string,
  daysWaiting: number,
): MailInput {
  return {
    kind: 'marketing',
    to,
    subject: 'Still finishing your Pets24x7 listing?',
    html: page({
      eyebrow: 'Claim',
      heading: 'Your listing is half-finished',
      intro: h`Hi ${businessName} — ${listingName} has been waiting ${plural(daysWaiting, 'day')} with no photos, services or opening hours. Listings with all three get several times more enquiries.`,
      blocks: [Button('Finish my listing', VENDOR_DASH()), Note('It takes about five minutes.')],
      preheader: 'Finish your listing to start getting enquiries.',
    }),
    text: `Hi ${businessName},\n\n${listingName} is still missing photos, services or hours. Finish it: ${VENDOR_DASH()}\n`,
  };
}

export function vendorEmailVerifiedEmail(to: string, businessName: string): MailInput {
  return {
    to,
    subject: 'Business email verified',
    html: page({
      eyebrow: 'Account',
      banner: ['Verified', 'success'],
      heading: 'This address is verified',
      intro: h`Thanks ${businessName} — enquiry alerts, payment receipts and review notifications will now reach this address.`,
      blocks: [Button('Open my dashboard', VENDOR_DASH())],
      preheader: 'Your business email is verified.',
    }),
    text: `Hi ${businessName},\n\nYour business email is verified. Dashboard: ${VENDOR_DASH()}\n`,
  };
}

export function vendorEnquiryUnansweredEmail(
  to: string,
  businessName: string,
  count: number,
  oldestAt: Date,
): MailInput {
  return {
    to,
    subject: count === 1 ? 'An enquiry is still waiting for you' : `${count} enquiries are still waiting`,
    html: page({
      eyebrow: 'Enquiries',
      banner: ['Needs a reply', 'warning'],
      heading: count === 1 ? 'One enquiry is waiting' : `${count} enquiries are waiting`,
      intro: h`Hi ${businessName} — ${plural(count, 'enquiry', 'enquiries')} on your listing have had no reply. The oldest came in on ${day(oldestAt)}.`,
      blocks: [
        Button('Reply now', `${VENDOR_DASH()}?view=enquiries`),
        Note('Pet parents usually book the first business that answers. A one-line reply is enough.'),
      ],
      preheader: `${plural(count, 'enquiry', 'enquiries')} waiting for a reply.`,
    }),
    text: `Hi ${businessName},\n\n${plural(count, 'enquiry', 'enquiries')} on your listing have had no reply — oldest ${day(oldestAt)}.\nReply: ${VENDOR_DASH()}?view=enquiries\n`,
  };
}

export function vendorWeeklyDigestEmail(
  to: string,
  businessName: string,
  stats: { views: number; enquiries: number; reviews: number; rating: number | null; weekEnding: Date },
): MailInput {
  return {
    kind: 'marketing',
    to,
    subject: `Your week: ${stats.enquiries} enquiries, ${stats.views} views`,
    html: page({
      eyebrow: 'Weekly summary',
      heading: 'How your listing did this week',
      intro: h`Hi ${businessName} — here is your week to ${day(stats.weekEnding)}.`,
      blocks: [
        InfoBox([
          ['Listing views', String(stats.views)],
          ['Enquiries', String(stats.enquiries)],
          ['New reviews', String(stats.reviews)],
          ['Rating', stats.rating ? `${stats.rating.toFixed(1)} ★` : 'No rating yet'],
        ]),
        Button('Open my dashboard', VENDOR_DASH()),
        Note('Asking happy customers for a review is the fastest way to move these numbers.'),
      ],
      preheader: `${stats.enquiries} enquiries and ${stats.views} views this week.`,
    }),
    text: `Hi ${businessName},\n\nWeek to ${day(stats.weekEnding)}:\nViews: ${stats.views}\nEnquiries: ${stats.enquiries}\nNew reviews: ${stats.reviews}\nRating: ${stats.rating ? stats.rating.toFixed(1) : 'n/a'}\n`,
  };
}

export function vendorReviewNudgeEmail(to: string, businessName: string, reviewCount: number): MailInput {
  return {
    kind: 'marketing',
    to,
    subject: 'Ask this week’s customers for a review',
    html: page({
      eyebrow: 'Reviews',
      heading: 'Reviews decide who gets called',
      intro: h`Hi ${businessName} — you have ${plural(reviewCount, 'review')}. Businesses above twenty reviews get roughly twice the enquiries on Pets24x7.`,
      blocks: [
        Button('Send review requests', `${VENDOR_DASH()}?view=reviews`),
        Note('Paste in customer numbers and we send the WhatsApp asks for you.'),
      ],
      preheader: 'Send this week’s review requests.',
    }),
    text: `Hi ${businessName},\n\nYou have ${plural(reviewCount, 'review')}. Send more requests: ${VENDOR_DASH()}?view=reviews\n`,
  };
}

export function featuredExpiringEmail(
  to: string,
  businessName: string,
  endsAt: Date,
  daysLeft: number,
): MailInput {
  return {
    to,
    subject: `Your featured placement ends in ${plural(daysLeft, 'day')}`,
    html: page({
      eyebrow: 'Featured',
      banner: [`Ends ${day(endsAt)}`, 'warning'],
      heading: 'Your featured placement is ending',
      intro: h`Hi ${businessName} — top-of-city placement for your listing ends on ${day(endsAt)}. Renew to stay above the fold.`,
      blocks: [Button('Renew placement', `${VENDOR_DASH()}?view=marketing&featured=1`)],
      preheader: `Featured placement ends ${day(endsAt)}.`,
    }),
    text: `Hi ${businessName},\n\nYour featured placement ends on ${day(endsAt)}. Renew: ${VENDOR_DASH()}?view=marketing&featured=1\n`,
  };
}

export function campaignEndingEmail(
  to: string,
  businessName: string,
  goal: string,
  endsAt: Date,
  daysLeft: number,
): MailInput {
  return {
    to,
    subject: `Your campaign ends in ${plural(daysLeft, 'day')}`,
    html: page({
      eyebrow: 'Marketing',
      banner: [`Ends ${day(endsAt)}`, 'warning'],
      heading: 'Your campaign is nearly done',
      intro: h`Hi ${businessName} — your ${goal} campaign finishes on ${day(endsAt)}. Extend it now and the ads keep running without a gap.`,
      blocks: [Button('Extend the campaign', `${VENDOR_DASH()}?view=marketing`)],
      preheader: `Campaign ends ${day(endsAt)}.`,
    }),
    text: `Hi ${businessName},\n\nYour ${goal} campaign ends on ${day(endsAt)}. Extend it: ${VENDOR_DASH()}?view=marketing\n`,
  };
}

export function campaignReportEmail(
  to: string,
  businessName: string,
  goal: string,
  stats: { impressions: number; clicks: number; enquiries: number; spendMinor: number; currency: string },
): MailInput {
  const cpe = stats.enquiries > 0 ? money(Math.round(stats.spendMinor / stats.enquiries), stats.currency) : '—';
  return {
    to,
    subject: `Campaign report — ${stats.enquiries} enquiries`,
    html: page({
      eyebrow: 'Marketing',
      heading: 'How your campaign did',
      intro: h`Hi ${businessName} — final numbers for your ${goal} campaign.`,
      blocks: [
        InfoBox([
          ['Impressions', stats.impressions.toLocaleString('en-IN')],
          ['Clicks', stats.clicks.toLocaleString('en-IN')],
          ['Enquiries', String(stats.enquiries)],
          ['Spend', money(stats.spendMinor, stats.currency)],
          ['Cost per enquiry', cpe],
        ]),
        Button('Run it again', `${VENDOR_DASH()}?view=marketing`),
      ],
      preheader: `${stats.enquiries} enquiries for ${money(stats.spendMinor, stats.currency)}.`,
    }),
    text: `Hi ${businessName},\n\n${goal} campaign results:\nImpressions: ${stats.impressions}\nClicks: ${stats.clicks}\nEnquiries: ${stats.enquiries}\nSpend: ${money(stats.spendMinor, stats.currency)}\nCost per enquiry: ${cpe}\n`,
  };
}

export function vendorPhotosUpdatedEmail(to: string, businessName: string, count: number): MailInput {
  return {
    to,
    subject: 'Your listing photos are live',
    html: page({
      eyebrow: 'Listing',
      banner: ['Photos live', 'success'],
      heading: 'Your photos are up',
      intro: h`Hi ${businessName} — ${plural(count, 'photo')} now show on your listing. Listings with photos get noticeably more enquiries.`,
      blocks: [Button('View my listing', VENDOR_DASH())],
      preheader: `${plural(count, 'photo')} are live on your listing.`,
    }),
    text: `Hi ${businessName},\n\n${plural(count, 'photo')} are live on your listing: ${VENDOR_DASH()}\n`,
  };
}

export function vendorReactivatedEmail(to: string, businessName: string): MailInput {
  return {
    to,
    subject: 'Your listing is live again',
    html: page({
      eyebrow: 'Account',
      banner: ['Reinstated', 'success'],
      heading: 'Your listing is back',
      intro: h`Hi ${businessName} — the suspension on your listing has been lifted and it is visible to pet parents again.`,
      blocks: [Button('Open my dashboard', VENDOR_DASH())],
      preheader: 'Your listing is live again.',
    }),
    text: `Hi ${businessName},\n\nYour listing is live again: ${VENDOR_DASH()}\n`,
  };
}

export function vendorPayoutNoticeEmail(
  to: string,
  businessName: string,
  amountMinor: number,
  currency: string,
  periodEnding: Date,
): MailInput {
  return {
    to,
    subject: `Payout of ${money(amountMinor, currency)} sent`,
    html: page({
      eyebrow: 'Payouts',
      banner: ['Payout sent', 'success'],
      heading: 'Your payout is on the way',
      intro: h`Hi ${businessName} — we have sent your payout for the period ending ${day(periodEnding)}.`,
      blocks: [
        InfoBox([
          ['Amount', money(amountMinor, currency)],
          ['Period ending', day(periodEnding)],
        ]),
        Note('It reaches your registered bank account within two working days.'),
      ],
      preheader: `${money(amountMinor, currency)} payout sent.`,
    }),
    text: `Hi ${businessName},\n\nPayout of ${money(amountMinor, currency)} for the period ending ${day(periodEnding)} is on its way.\n`,
  };
}

// ===========================================================================
// Admin / internal
// ===========================================================================

export function adminNewClaimEmail(
  to: string,
  adminName: string,
  vendor: { businessName: string; phone: string; city: string | null; listingName: string | null },
): MailInput {
  return {
    to,
    subject: `Claim to review — ${vendor.businessName}`,
    html: page({
      eyebrow: 'Admin',
      banner: ['Needs review', 'warning'],
      heading: 'A vendor claimed a listing',
      intro: h`Hi ${adminName} — ${vendor.businessName} is waiting for approval.`,
      blocks: [
        InfoBox([
          ['Business', vendor.businessName],
          ['Phone', vendor.phone],
          ['City', vendor.city || '—'],
          ['Listing', vendor.listingName || '—'],
        ]),
        Button('Review the claim', `${ADMIN_DASH()}?view=vendors&status=PENDING`),
      ],
      preheader: `${vendor.businessName} is waiting for approval.`,
    }),
    text: `Hi ${adminName},\n\n${vendor.businessName} (${vendor.phone}) claimed ${vendor.listingName || 'a listing'}. Review: ${ADMIN_DASH()}?view=vendors&status=PENDING\n`,
  };
}

export function adminDailySummaryEmail(
  to: string,
  adminName: string,
  stats: {
    date: Date;
    signups: number;
    claims: number;
    enquiries: number;
    payments: number;
    revenueMinor: number;
    currency: string;
    pendingClaims: number;
  },
): MailInput {
  return {
    to,
    subject: `Pets24x7 daily — ${money(stats.revenueMinor, stats.currency)}, ${stats.signups} signups`,
    html: page({
      eyebrow: 'Admin',
      heading: 'Yesterday on Pets24x7',
      intro: h`Hi ${adminName} — the numbers for ${day(stats.date)}.`,
      blocks: [
        InfoBox([
          ['New pet parents', String(stats.signups)],
          ['Listing claims', String(stats.claims)],
          ['Enquiries', String(stats.enquiries)],
          ['Payments', String(stats.payments)],
          ['Revenue', money(stats.revenueMinor, stats.currency)],
          ['Claims awaiting review', String(stats.pendingClaims)],
        ]),
        Button('Open admin', ADMIN_DASH()),
      ],
      preheader: `${stats.signups} signups · ${money(stats.revenueMinor, stats.currency)} revenue.`,
    }),
    text: `Hi ${adminName},\n\n${day(stats.date)}\nSignups: ${stats.signups}\nClaims: ${stats.claims}\nEnquiries: ${stats.enquiries}\nPayments: ${stats.payments}\nRevenue: ${money(stats.revenueMinor, stats.currency)}\nPending claims: ${stats.pendingClaims}\n`,
  };
}

export function adminPaymentAlertEmail(
  to: string,
  adminName: string,
  detail: { merchantTxnId: string; amountMinor: number; currency: string; reason: string; who: string },
): MailInput {
  return {
    to,
    subject: `Payment problem — ${detail.merchantTxnId}`,
    html: page({
      eyebrow: 'Admin',
      banner: ['Needs attention', 'danger'],
      heading: 'A payment needs a human',
      intro: h`Hi ${adminName} — this payment could not be settled automatically.`,
      blocks: [
        InfoBox([
          ['Reference', detail.merchantTxnId],
          ['Payer', detail.who],
          ['Amount', money(detail.amountMinor, detail.currency)],
          ['Problem', detail.reason],
        ]),
        Button('Open payments', `${ADMIN_DASH()}?view=payments`),
      ],
      preheader: `${detail.merchantTxnId} needs attention.`,
    }),
    text: `Hi ${adminName},\n\nPayment ${detail.merchantTxnId} (${money(detail.amountMinor, detail.currency)}, ${detail.who}) needs attention: ${detail.reason}\n`,
  };
}

export function adminBroadcastEmail(
  to: string,
  heading: string,
  body: string,
  ctaLabel?: string,
  ctaUrl?: string,
): MailInput {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:24px">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return {
    kind: 'marketing',
    to,
    subject: heading,
    html: page({
      eyebrow: 'Pets24x7',
      heading,
      intro: '',
      blocks: [Text(paragraphs), ...(ctaLabel && ctaUrl ? [Button(ctaLabel, ctaUrl)] : [])],
      preheader: heading,
    }),
    text: `${body}\n${ctaUrl ? `\n${ctaUrl}\n` : ''}`,
  };
}

export function maintenanceNoticeEmail(to: string, name: string, startsAt: Date, minutes: number): MailInput {
  return {
    to,
    subject: 'Planned maintenance on Pets24x7',
    html: page({
      eyebrow: 'Notice',
      banner: ['Scheduled', 'info'],
      heading: 'Short planned downtime',
      intro: h`Hi ${name} — Pets24x7 will be offline for about ${minutes} minutes from ${dayTime(startsAt)} while we upgrade.`,
      blocks: [
        Note('Nothing you have saved is affected. Enquiries sent during the window may take a little longer to arrive.'),
      ],
      preheader: `Maintenance ${dayTime(startsAt)}, about ${minutes} minutes.`,
    }),
    text: `Hi ${name},\n\nPets24x7 will be offline for about ${minutes} minutes from ${dayTime(startsAt)}.\n`,
  };
}

// ===========================================================================
// Admin — the daily briefing
// ===========================================================================

/**
 * One message a day covering what happened and what is waiting. The queue goes
 * first: those are the items that stay broken until someone acts.
 */
export function adminDailyDigestEmail(
  to: string,
  d: {
    pendingVendors: number;
    pendingReviews: number;
    pendingCampaigns: number;
    unansweredEnquiries: number;
    newEnquiries: number;
    newParents: number;
    newVendors: number;
    newListings: number;
    paymentsCount: number;
    paymentsRupees: number;
    phoneTaps: number;
    whatsappTaps: number;
    listingViews: number;
    reviewsSubmitted: number;
  },
  siteUrl: string,
): MailInput {
  const site = siteUrl.replace(/\/+$/, '');
  const waiting = d.pendingVendors + d.pendingReviews + d.pendingCampaigns + d.unansweredEnquiries;
  const money = d.paymentsRupees > 0 ? `₹${d.paymentsRupees.toLocaleString('en-IN')}` : '—';

  return {
    to,
    subject: waiting > 0
      ? `Pets24x7 daily: ${waiting} waiting on you`
      : `Pets24x7 daily: ${d.newEnquiries} enquiries, ${d.newParents + d.newVendors} new accounts`,
    html: page({
      eyebrow: 'Admin',
      banner: waiting > 0 ? [`${waiting} item${waiting === 1 ? '' : 's'} need a decision`, 'warning'] : ['All clear', 'success'],
      heading: 'Yesterday on Pets24x7',
      intro: waiting > 0
        ? 'These are waiting on someone in the admin panel. Everything below them is just what moved.'
        : 'Nothing is waiting on a decision. Here is what moved yesterday.',
      blocks: [
        InfoBox([
          ['Vendors awaiting approval', String(d.pendingVendors)],
          ['Reviews awaiting moderation', String(d.pendingReviews)],
          ['Campaigns awaiting review', String(d.pendingCampaigns)],
          ['Enquiries still unanswered', String(d.unansweredEnquiries)],
        ]),
        Button('Open the admin panel', `${site}/dashboard/admin/`),
        InfoBox([
          ['New enquiries', String(d.newEnquiries)],
          ['New pet parents', String(d.newParents)],
          ['New businesses', String(d.newVendors)],
          ['Listings added', String(d.newListings)],
          ['Reviews submitted', String(d.reviewsSubmitted)],
          ['Payments', `${d.paymentsCount} · ${money}`],
        ]),
        InfoBox([
          ['Phone number taps', String(d.phoneTaps)],
          ['WhatsApp taps', String(d.whatsappTaps)],
          ['Listing views', String(d.listingViews)],
        ]),
        Note('Taps are pet owners who contacted a business directly from a listing — they never become an enquiry row, so this is the only place they show up.'),
      ],
      preheader: waiting > 0 ? `${waiting} waiting · ${d.newEnquiries} new enquiries` : `${d.newEnquiries} new enquiries`,
    }),
    text:
      `Pets24x7 daily\n\n` +
      `Waiting on you:\n` +
      `  Vendors awaiting approval: ${d.pendingVendors}\n` +
      `  Reviews awaiting moderation: ${d.pendingReviews}\n` +
      `  Campaigns awaiting review: ${d.pendingCampaigns}\n` +
      `  Enquiries unanswered: ${d.unansweredEnquiries}\n\n` +
      `Yesterday:\n` +
      `  Enquiries: ${d.newEnquiries}\n  Pet parents: ${d.newParents}\n  Businesses: ${d.newVendors}\n` +
      `  Listings added: ${d.newListings}\n  Reviews: ${d.reviewsSubmitted}\n  Payments: ${d.paymentsCount} (${money})\n` +
      `  Phone taps: ${d.phoneTaps}  WhatsApp taps: ${d.whatsappTaps}  Views: ${d.listingViews}\n\n` +
      `${site}/dashboard/admin/\n`,
  };
}
