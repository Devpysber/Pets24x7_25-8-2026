// Admin-tunable knobs for recommendations and sponsored placement.
//
// Stored as one JSON document in Setting 'reco:config'. The 'reco:' prefix is
// reserved, so the free-form settings editor cannot write it; the only writer
// is PUT /api/admin/reco/config, which validates through RecoConfigSchema.
// Each instance re-reads it at most every 60 seconds, so a saved change is live
// everywhere within a minute.

import { z } from 'zod';

import { prisma } from '../../db.js';
import { logger } from '../../logger.js';

export const RECO_CONFIG_KEY = 'reco:config';

const weight = z.number().min(-100).max(100);
const frequency = z.enum(['DAILY', 'WEEKLY', 'OFF']);

const WeightsSchema = z.object({
  rating: weight,
  reviews: weight,
  popularity: weight,
  saves: weight,
  petNeed: weight,
  affinity: weight,
  savedSimilar: weight,
  viewedSimilar: weight,
  sameArea: weight,
  claimed: weight,
  contactable: weight,
  fresh: weight,
  p24Reviews: weight,
  featuredOrganic: weight,
  seenPenalty: weight,
  /** Active paid vendor plan (Silver/Gold/Diamond), scaled by tier. Disclosed on the card. */
  paidPlan: weight,
});

export type RecoWeights = z.infer<typeof WeightsSchema>;

export const RecoConfigSchema = z
  .object({
    version: z.literal(1),
    weights: WeightsSchema,
    sponsored: z.object({
      enabled: z.boolean(),
      label: z.string().trim().min(1).max(24),
      positions: z.array(z.number().int().min(1).max(24)).max(6),
      maxPerList: z.number().int().min(0).max(6),
      maxShare: z.number().min(0).max(0.5),
      perViewerDailyCap: z.number().int().min(1).max(100),
      requireRelevance: z.boolean(),
      maxSlotsPerCityCategory: z.number().int().min(1).max(50).nullable(),
    }),
    diversity: z.object({
      maxPerCategory: z.number().int().min(1).max(24),
      /** Max points of per-viewer, per-day ordering nudge on personalised lists (0 = off). */
      exploration: z.number().min(0).max(20),
    }),
    popularity: z.object({
      windowDays: z.number().int().min(7).max(90),
      minTaps: z.number().int().min(1).max(100),
    }),
    digest: z.object({
      enabled: z.boolean(),
      defaultFrequency: frequency,
      items: z.number().int().min(3).max(8),
      minItems: z.number().int().min(1).max(8),
      includeDeals: z.boolean(),
    }),
    vendor: z.object({
      minCompetitorsForBoost: z.number().int().min(0).max(1000),
      minCompletenessForBoost: z.number().int().min(0).max(100),
      renewWithinDays: z.number().int().min(1).max(30),
    }),
    admin: z.object({
      staleEnquiryHours: z.number().int().min(1).max(24 * 14),
      underperformCtrRatio: z.number().min(0).max(1),
    }),
    experiment: z.object({
      enabled: z.boolean(),
      splitPct: z.number().int().min(0).max(100),
      weightsB: WeightsSchema.partial(),
    }),
    cacheTtlSec: z.object({
      parent: z.number().int().min(10).max(3600),
      public: z.number().int().min(10).max(3600),
      vendor: z.number().int().min(10).max(3600),
      admin: z.number().int().min(60).max(3600),
    }),
    fallbackCity: z.object({
      IN: z.string().trim().min(1).max(80),
      US: z.string().trim().min(1).max(80),
    }),
  })
  .superRefine((c, ctx) => {
    if (new Set(c.sponsored.positions).size !== c.sponsored.positions.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sponsored', 'positions'], message: 'Positions must be unique' });
    }
    if (c.sponsored.positions.length > Math.max(c.sponsored.maxPerList, 0) && c.sponsored.maxPerList > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sponsored', 'positions'],
        message: 'List no more positions than maxPerList',
      });
    }
    if (c.digest.minItems > c.digest.items) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['digest', 'minItems'], message: 'minItems cannot exceed items' });
    }
  });

export type RecoConfig = z.infer<typeof RecoConfigSchema>;

export const RECO_DEFAULTS: RecoConfig = {
  version: 1,
  weights: {
    rating: 30,
    reviews: 12,
    popularity: 14,
    saves: 6,
    petNeed: 26,
    affinity: 22,
    savedSimilar: 18,
    viewedSimilar: 12,
    sameArea: 6,
    claimed: 10,
    contactable: 6,
    fresh: 4,
    p24Reviews: 8,
    // Paid placement never inflates the organic score; it only enters through
    // the labelled sponsored slots (blend.ts).
    featuredOrganic: 0,
    seenPenalty: -40,
    // A paid subscription ("Priority Search Ranking" / "Top Search Result
    // Boost") lifts a business in organic lists. Unlike featuredOrganic this is
    // shown to the reader: the card says "Pets24x7 premium partner".
    paidPlan: 40,
  },
  sponsored: {
    enabled: true,
    label: 'Sponsored',
    positions: [2, 7],
    maxPerList: 2,
    maxShare: 0.25,
    perViewerDailyCap: 6,
    requireRelevance: true,
    maxSlotsPerCityCategory: null,
  },
  diversity: { maxPerCategory: 3, exploration: 4 },
  popularity: { windowDays: 30, minTaps: 3 },
  digest: { enabled: true, defaultFrequency: 'WEEKLY', items: 5, minItems: 3, includeDeals: true },
  vendor: { minCompetitorsForBoost: 10, minCompletenessForBoost: 70, renewWithinDays: 5 },
  admin: { staleEnquiryHours: 48, underperformCtrRatio: 0.5 },
  experiment: { enabled: false, splitPct: 50, weightsB: {} },
  cacheTtlSec: { parent: 300, public: 600, vendor: 300, admin: 900 },
  fallbackCity: { IN: 'Mumbai', US: 'New York' },
};

const CONFIG_TTL_MS = 60_000;

let cached: { config: RecoConfig; updatedAt: Date | null; updatedBy: string | null; loadedAt: number } | null = null;
let loading: Promise<void> | null = null;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge where arrays and scalars replace, objects merge. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

/** Stored JSON merged over the defaults; anything invalid falls back to defaults. */
function fromStored(value: unknown): RecoConfig {
  const merged = deepMerge(RECO_DEFAULTS, value);
  const parsed = RecoConfigSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  logger.warn({ issues: parsed.error.issues.slice(0, 5) }, 'reco:config is invalid — using defaults');
  return RECO_DEFAULTS;
}

async function load(): Promise<void> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: RECO_CONFIG_KEY } });
    cached = {
      config: row ? fromStored(row.value) : RECO_DEFAULTS,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
      loadedAt: Date.now(),
    };
  } catch {
    // DB offline: keep the last good copy, or defaults if there never was one.
    cached = cached
      ? { ...cached, loadedAt: Date.now() }
      : { config: RECO_DEFAULTS, updatedAt: null, updatedBy: null, loadedAt: Date.now() };
  }
}

/** Current config, re-read at most every 60s. */
export async function getRecoConfig(): Promise<RecoConfig> {
  if (!cached || Date.now() - cached.loadedAt > CONFIG_TTL_MS) {
    if (!loading) loading = load().finally(() => (loading = null));
    // A stale copy is served while a refresh runs; only the first call waits.
    if (!cached) await loading;
  }
  return cached!.config;
}

/** Last loaded config without waiting (defaults before the first load). */
export function recoConfigSync(): RecoConfig {
  if (!cached || Date.now() - cached.loadedAt > CONFIG_TTL_MS) void getRecoConfig();
  return cached?.config ?? RECO_DEFAULTS;
}

export async function getRecoConfigMeta(): Promise<{ config: RecoConfig; updatedAt: Date | null; updatedBy: string | null }> {
  await getRecoConfig();
  return { config: cached!.config, updatedAt: cached!.updatedAt, updatedBy: cached!.updatedBy };
}

/**
 * Validates a partial update against the full schema after merging it over the
 * current config, then persists it. Throws ZodError (→ 400 validation_failed)
 * on bad input.
 */
export async function saveRecoConfig(partial: unknown, adminId: string): Promise<RecoConfig> {
  const current = await getRecoConfig();
  const next = RecoConfigSchema.parse(deepMerge(current, partial));
  const row = await prisma.setting.upsert({
    where: { key: RECO_CONFIG_KEY },
    update: { value: next as unknown as object, updatedBy: adminId },
    create: { key: RECO_CONFIG_KEY, value: next as unknown as object, updatedBy: adminId },
  });
  cached = { config: next, updatedAt: row.updatedAt, updatedBy: row.updatedBy, loadedAt: Date.now() };
  return next;
}

/** Forces the next getRecoConfig() to re-read the database. */
export function invalidateRecoConfig(): void {
  if (cached) cached.loadedAt = 0;
}

/** Weights for an experiment arm. */
export function weightsFor(config: RecoConfig, variant: 'A' | 'B'): RecoWeights {
  if (variant === 'B' && config.experiment.enabled) return { ...config.weights, ...config.experiment.weightsB };
  return config.weights;
}
