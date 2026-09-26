// The recommendations digest, built on the same engine as the dashboard.
//
// jobs/engagement.ts owns cadence stamping and suppression; this file owns
// what goes into the mail. Hook-up there is two calls:
//
//   if (digestDue(p, config)) {
//     const d = await buildRecoDigest(p);
//     if (d) return { mail: d.mail, digest: true, recentPromoIds: d.recentPromoIds, onSent: d.onSent };
//   }
//
// and call d.onSent() once the send stamp is claimed, which records the digest
// impressions (surface email_digest) against its rid.

import { prisma } from '../../db.js';
import { mailSite } from '../../mail/components.js';
import type { MailInput } from '../../mail/mailer.js';
import { recoDigestEmail } from '../../mail/reco-templates.js';
import { getRecoConfig, type RecoConfig } from './config.js';
import { EMAIL_RID_TTL_SEC, lookupRid, recordServerImpressions, registerRid, type RidEntry } from './events.js';
import { forParent, parentFeed, type RecoItem } from './service.js';
import { DAY_MS, isoWeek, viewerKeyFor } from './util.js';

export type DigestFrequency = 'DAILY' | 'WEEKLY' | 'OFF';

/** 20h / 6.8d rather than 24h / 7d: sweeps run at random times of day. */
const GAP_DAYS: Record<Exclude<DigestFrequency, 'OFF'>, number> = { DAILY: 20 / 24, WEEKLY: 6.8 };

export function effectiveFrequency(p: { digestFrequency?: string | null }, config: RecoConfig): DigestFrequency {
  const f = String(p.digestFrequency ?? '').toUpperCase();
  if (f === 'DAILY' || f === 'WEEKLY' || f === 'OFF') return f;
  return config.digest.defaultFrequency;
}

/** Whether this parent is due a digest under their cadence (or the admin default). */
export function digestDue(
  p: { digestFrequency?: string | null; lastDigestAt: Date | null },
  config: RecoConfig,
  now = new Date(),
): boolean {
  if (!config.digest.enabled) return false;
  const f = effectiveFrequency(p, config);
  if (f === 'OFF') return false;
  if (!p.lastDigestAt) return true;
  return (now.getTime() - p.lastDigestAt.getTime()) / DAY_MS >= GAP_DAYS[f];
}

function parseIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** About a week of daily digests, so a listing is not repeated within the week. */
const PROMO_MEMORY = 30;

export interface BuiltDigest {
  mail: MailInput;
  recentPromoIds: string;
  rid: string;
  items: RecoItem[];
  /** Records the digest impressions; call once the send is committed. */
  onSent: () => void;
}

/**
 * The digest for one parent, or null when fewer than config.digest.minItems
 * places can be ranked (a thin list is not worth an email) or they have no
 * city (we cannot honestly say "near you").
 */
export async function buildRecoDigest(p: {
  id: string;
  name: string;
  email: string | null;
  city: string | null;
  country: string | null;
  recentPromoIds: string | null;
}): Promise<BuiltDigest | null> {
  if (!p.email || !p.city) return null;
  const config = await getRecoConfig();
  const previous = parseIds(p.recentPromoIds);

  const run = (exclude: string[]) =>
    forParent({
      parentId: p.id,
      city: p.city!,
      country: p.country ?? undefined,
      limit: config.digest.items,
      viewerKey: viewerKeyFor(p.id),
      surface: 'email_digest',
      excludeIds: exclude,
      maxSponsored: 1,
    });

  // Only real local picks count: a big-city top-up is not "near you". Judged
  // per item, not on res.fallback — that describes the whole ranked page (far
  // deeper than a digest), so any city with fewer listings than a page came
  // back 'expanded_country' even when every one of the first five was local,
  // and those parents never got a digest at all.
  // CITY_FALLBACK is also the generic "Popular in <city>" reason the engine
  // gives a local listing with nothing more specific to say (no reviews, no
  // taps yet), so the code alone does not mean "another city": only a
  // CITY_FALLBACK item from a different city is a top-up.
  const localPicks = (r: Awaited<ReturnType<typeof run>>) => {
    const here = String(r.city ?? '').toLowerCase().trim();
    return r.items.filter((i) => i.reason.code !== 'CITY_FALLBACK' || String(i.city ?? '').toLowerCase().trim() === here);
  };

  let res = await run(previous);
  // A small city runs out of fresh names. Relax to "nothing from the last
  // digest" — never to an empty exclusion, which re-mailed the exact list the
  // parent got last time. Still too thin: skip this one rather than repeat.
  // Step the memory down one digest at a time, so the oldest picks come back
  // first and a thin city does not jump straight to "anything but last time".
  const lastBatch = previous.slice(0, config.digest.items);
  let keep = previous.length;
  while (localPicks(res).length < config.digest.minItems && keep > lastBatch.length) {
    keep = Math.max(lastBatch.length, keep - config.digest.items);
    res = await run(previous.slice(0, keep));
  }
  const local = localPicks(res);
  if (local.length < config.digest.minItems || res.fallback === 'default_city') return null;

  const site = mailSite();
  const items = local.slice(0, config.digest.items);
  // Identical to the last digest (same places, any order): not worth a mail.
  const lastSet = new Set(lastBatch);
  if (lastSet.size && items.length <= lastSet.size && items.every((i) => lastSet.has(i.id))) return null;
  let deals: Array<{ title: string; offerLabel: string; vendor: string | null; endsAt: Date | null; url: string | null; code: string | null }> = [];
  if (config.digest.includeDeals) {
    const feed = await parentFeed({ parentId: p.id, city: p.city, country: p.country ?? undefined, limit: 2 }).catch(() => null);
    deals = (feed?.deals ?? []).slice(0, 2).map((d) => ({
      title: d.title,
      offerLabel: d.offerLabel,
      vendor: d.vendor,
      endsAt: d.endsAt,
      url: d.url ? `${site}${d.url.replace('reco_parent_feed', 'reco_email_digest')}` : null,
      code: d.code,
    }));
  }

  const pet = await prisma.pet
    .findFirst({ where: { ownerId: p.id }, orderBy: { createdAt: 'asc' }, select: { name: true } })
    .catch(() => null);

  const mail = recoDigestEmail(
    p.email,
    p.name,
    pet?.name ?? null,
    items.map((it) => ({
      name: it.name,
      category: it.category,
      city: it.city,
      rating: it.rating,
      reviewCount: it.review_count,
      // rid lets the landing page attribute the click (listing.html posts it).
      url: `${site}${it.url}&rid=${res.rid}`,
      reason: it.reason,
      reasons: it.reasons,
      sponsored: it.sponsored,
      label: it.label,
    })),
    { deals, week: isoWeek() },
  );

  // Email clicks land days later: keep this rid resolvable for a week so the
  // landing page's click beacon still validates.
  const entry = (await lookupRid<RecoItem>(res.rid)) as RidEntry<RecoItem> | undefined;
  if (entry) registerRid(res.rid, entry, EMAIL_RID_TTL_SEC);

  return {
    mail,
    rid: res.rid,
    items,
    recentPromoIds: JSON.stringify([...items.map((i) => i.id), ...previous].slice(0, PROMO_MEMORY)),
    onSent: () =>
      recordServerImpressions(
        'email_digest',
        res.variant,
        items.map((i) => ({ listingId: i.id, reason: i.reason.code, sponsored: i.sponsored, featuredId: i.featuredId })),
      ),
  };
}
