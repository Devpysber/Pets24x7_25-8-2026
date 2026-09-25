// Run a job a few times a day, at times nobody can predict.
//
// The promotional sweeps used to run every four hours from whenever the process
// last booted. Two problems with that. A deploy silently moved every send time,
// so a restart at 03:00 mailed people at 03:00; and a fixed interval from a
// fixed offset is the most machine-looking send pattern there is, which is one
// of the things spam filters weigh.
//
// This picks the slots for the day at random inside a sending window, in the
// audience's own timezone, and re-plans after midnight.
//
// What it does NOT change: how often any one person hears from us. That is
// enforced per recipient in the database (Vendor.lastMarketingAt and the pet
// parent equivalent, one promotional email every MIN_GAP_DAYS). Running the
// sweep four times a day means it catches whoever became eligible since the
// last run — not that anybody gets four emails.
//
// Several API instances must agree on the day's slots, or N servers would run
// N random schedules. So the "random" draw is seeded from the job name, the
// local day and a server secret: every instance computes the same slots, which
// outsiders still cannot predict. Every run then takes the cluster-wide lease
// for the job name (shared/job-lock.ts) and holds it for minGapMinutes after
// starting, so the instances that wake at the same minute skip — one run per
// slot across the cluster, whatever the instance count.

import crypto from 'node:crypto';

import { env } from '../env.js';
import { logger } from '../logger.js';
import { withJobLock } from '../shared/job-lock.js';

/** Minutes past midnight, in the target timezone. */
const IST_OFFSET_MIN = 5 * 60 + 30;

export interface RandomDailyOptions {
  /** Fewest runs in a day. */
  minRuns?: number;
  /** Most runs in a day. */
  maxRuns?: number;
  /** Earliest hour a run may land on, in the target timezone. */
  startHour?: number;
  /** Latest hour a run may land on. */
  endHour?: number;
  /** Keep slots at least this far apart, so two do not land together. */
  minGapMinutes?: number;
  /** Minutes offset from UTC for the audience's timezone. Defaults to IST. */
  timezoneOffsetMinutes?: number;
  /**
   * How long a run keeps the cluster lease after it starts, so other
   * instances skip their slots meanwhile. Defaults to minGapMinutes.
   */
  clusterHoldMinutes?: number;
}

interface Plan {
  timers: NodeJS.Timeout[];
  dayKey: string;
}

const running = new Map<string, Plan>();
/** Jobs with a run in flight right now. */
const busy = new Set<string>();

/** A uniform draw in [0, 1). */
type Rng = () => number;

/**
 * Deterministic generator (mulberry32) seeded from the job, the day and
 * JWT_SECRET, so every instance draws the same slots for the same day.
 */
function seededRng(name: string, dayKey: string): Rng {
  let a = crypto.createHash('sha256').update(`${env.JWT_SECRET}:${name}:${dayKey}`).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * Times of day, in minutes past local midnight, spread across the window and
 * jittered inside their own slice. Slicing first is what keeps four sends from
 * clustering into one hour, which pure random picks do often.
 */
function pickSlots(rng: Rng, count: number, startHour: number, endHour: number, minGap: number): number[] {
  const from = startHour * 60;
  const to = endHour * 60;
  const span = Math.max(0, to - from);
  if (span === 0 || count <= 0) return [];

  const slice = Math.floor(span / count);
  const slots: number[] = [];
  for (let i = 0; i < count; i++) {
    const base = from + i * slice;
    // Leave room so the jitter cannot push a slot into the next slice.
    const top = Math.max(base, base + slice - minGap);
    slots.push(randInt(rng, base, top));
  }
  return slots.sort((a, b) => a - b);
}

function localDayKey(now: Date, tzOffset: number): string {
  const shifted = new Date(now.getTime() + tzOffset * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Milliseconds from now until the given local minute-of-day, today. */
function msUntilLocalMinute(now: Date, minuteOfDay: number, tzOffset: number): number {
  const shifted = new Date(now.getTime() + tzOffset * 60_000);
  const localMidnightUtcMs = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
  ) - tzOffset * 60_000;
  return localMidnightUtcMs + minuteOfDay * 60_000 - now.getTime();
}

/**
 * Plan today's runs and re-plan after midnight. Slots already in the past when
 * planning happens are skipped rather than fired late — a restart must never
 * turn into a send, or a crash loop becomes a mail loop.
 */
export function startRandomDailyJob(
  name: string,
  task: () => Promise<unknown>,
  opts: RandomDailyOptions = {},
): void {
  if (running.has(name)) return;

  const minRuns = opts.minRuns ?? 3;
  const maxRuns = opts.maxRuns ?? 4;
  const startHour = opts.startHour ?? 9;
  const endHour = opts.endHour ?? 20;
  const minGap = opts.minGapMinutes ?? 90;
  const tz = opts.timezoneOffsetMinutes ?? IST_OFFSET_MIN;
  const holdMs = (opts.clusterHoldMinutes ?? minGap) * 60_000;

  const plan = () => {
    const previous = running.get(name);
    if (previous) for (const t of previous.timers) clearTimeout(t);

    const now = new Date();
    const dayKey = localDayKey(now, tz);
    const rng = seededRng(name, dayKey);
    const runs = randInt(rng, minRuns, maxRuns);
    const slots = pickSlots(rng, runs, startHour, endHour, minGap);

    const timers: NodeJS.Timeout[] = [];
    const planned: string[] = [];

    for (const minuteOfDay of slots) {
      const delay = msUntilLocalMinute(now, minuteOfDay, tz);
      const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
      const mm = String(minuteOfDay % 60).padStart(2, '0');
      if (delay <= 0) continue; // already past today
      planned.push(`${hh}:${mm}`);
      timers.push(
        setTimeout(() => {
          // A sweep that is still running when the next slot arrives (a large
          // list, a slow SMTP relay) is left to finish; the slot is dropped
          // rather than starting a second, overlapping pass.
          if (busy.has(name)) {
            logger.warn({ job: name }, 'previous run still in progress; skipping this slot');
            return;
          }
          busy.add(name);
          withJobLock(name, task, { minHoldMs: holdMs })
            .then((r) => { if (!r.ran) logger.info({ job: name }, 'another instance ran this slot; skipped'); })
            .catch((err) => logger.warn({ err, job: name }, 'scheduled job failed'))
            .finally(() => busy.delete(name));
        }, delay),
      );
    }

    // Re-plan a few minutes after local midnight, with the same guard.
    const untilTomorrow = msUntilLocalMinute(now, 24 * 60 + 5, tz);
    timers.push(setTimeout(plan, Math.max(60_000, untilTomorrow)));

    running.set(name, { timers, dayKey });
    logger.info(
      { job: name, day: dayKey, runs: planned.length, at: planned },
      planned.length ? 'scheduled random daily runs' : 'no runs left in today window; will plan tomorrow',
    );
  };

  plan();
}

/** Cancels a planned job. Used by tests and by a clean shutdown. */
export function stopRandomDailyJob(name: string): void {
  const p = running.get(name);
  if (!p) return;
  for (const t of p.timers) clearTimeout(t);
  running.delete(name);
}
