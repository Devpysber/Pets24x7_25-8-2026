// "Claim your listing" campaign.
//
//   node scripts/claim-campaign.mjs            # dry run: prints who would get it
//   node scripts/claim-campaign.mjs --send     # actually sends
//
// Dry run is the default on purpose. This mails real business owners, and an
// outbound send cannot be taken back.
//
// Audience: vendor rows that have an email, have never completed a claim, and
// whose address looks deliverable. Test and example addresses are skipped —
// mailing them earns bounces, and bounces are what move a sending domain onto
// a blocklist, taking the sign-in codes and receipts down with it.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { sendMail } from '../dist/mail/mailer.js';
import { claimListingEmail } from '../dist/mail/promo-templates.js';
import { getListingById, initListingsIndex } from '../dist/listings/index.js';

const prisma = new PrismaClient();
const SEND = process.argv.includes('--send');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 500);

/** Addresses that exist to make a demo work, not to receive mail. */
const UNDELIVERABLE = /@(example|test|localhost|invalid|sample)\.|@pets24x7\.com$|^(test|demo|vendor|admin)@/i;
/** The scraped data has junk in the email column — "Dog and cat Clinic" and the
 *  like. Anything that is not shaped like an address is dropped rather than
 *  handed to the mail server, which would reject it and count against us. */
const LOOKS_LIKE_EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

const log = (m) => process.stdout.write(m + '\n');

async function main() {
  await initListingsIndex();

  const vendors = await prisma.vendor.findMany({
    where: {
      email: { not: null },
      claimedAt: null,
      status: { notIn: ['SUSPENDED', 'REJECTED'] },
    },
    select: { id: true, businessName: true, email: true, city: true, listingId: true, lastPromoKind: true },
    take: LIMIT,
  });

  const optedOut = new Set(
    (await prisma.emailOptOut.findMany({ select: { email: true } })).map((r) => r.email.toLowerCase()),
  );

  const targets = [];
  const skipped = { undeliverable: 0, optedOut: 0, alreadySent: 0 };

  for (const v of vendors) {
    const email = v.email.toLowerCase();
    if (!LOOKS_LIKE_EMAIL.test(email) || UNDELIVERABLE.test(email)) { skipped.undeliverable++; continue; }
    if (optedOut.has(email)) { skipped.optedOut++; continue; }
    // Never send the same campaign twice to the same business.
    if (v.lastPromoKind === 'claim_listing') { skipped.alreadySent++; continue; }
    targets.push(v);
  }

  log(`Vendors with an email and no completed claim: ${vendors.length}`);
  log(`  skipped — undeliverable/test address: ${skipped.undeliverable}`);
  log(`  skipped — opted out:                  ${skipped.optedOut}`);
  log(`  skipped — already had this campaign:  ${skipped.alreadySent}`);
  log(`  would send to:                        ${targets.length}`);
  for (const t of targets) log(`    ${t.businessName} <${t.email}>`);

  if (!SEND) {
    log('\nDry run. Nothing was sent. Re-run with --send to mail the list above.');
    return;
  }

  let sent = 0;
  let failed = 0;
  for (const v of targets) {
    const listing = v.listingId ? getListingById(v.listingId) : null;
    const site = (process.env.PUBLIC_SITE_URL ?? 'https://pets24x7.com').replace(/\/+$/, '');
    const listingUrl = listing
      ? `${site}/${String(listing.country).toLowerCase()}/${listing.city_slug}/${listing.id}/`
      : null;
    try {
      await sendMail(claimListingEmail(v.email, {
        businessName: v.businessName,
        city: v.city,
        listingUrl,
        rating: listing ? Number(listing.rating) || null : null,
        reviewCount: listing?.review_count ?? null,
      }));
      // Stamped so a re-run cannot mail the same business twice.
      await prisma.vendor.update({
        where: { id: v.id },
        data: { lastMarketingAt: new Date(), lastPromoKind: 'claim_listing' },
      });
      sent++;
    } catch (err) {
      failed++;
      log(`  ! ${v.email}: ${err.message}`);
    }
  }
  log(`\nSent ${sent}${failed ? `, ${failed} failed` : ''}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
