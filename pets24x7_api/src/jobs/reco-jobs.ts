// Background work for the recommendation engine (feed/reco/):
//
//   • signals snapshot   every 5 min (featured, claimed, taps, views, saves, reviews)
//   • admin insights     every 15 min (action center, trends, featured delivery)
//   • stats flush        every 60 s   (impression/click counters → RecoStatDaily)
//
// Started once from server.ts after the listings index is loaded, on every
// instance (not behind RUN_JOBS). None of it sends mail. With several
// instances, only the admin insights are cluster-wide work, so only they take
// the job lease: the winner computes and publishes to the shared kv, the rest
// read that copy. The snapshot feeds this process's own ranking and the flush
// drains this process's own counters (atomic increments), so both stay
// per-instance and unlocked.
//
// On SIGTERM/SIGINT the pending counters are flushed (bounded to a few seconds)
// before the process exits, so a deploy does not drop the last minute of
// impressions.

import { logger } from '../logger.js';
import { withJobLock } from '../shared/job-lock.js';
import { recomputeAdminInsights } from '../feed/reco/admin-insights.js';
import { flushRecoStats, startRecoStatsFlush } from '../feed/reco/events.js';
import { startSignalsRefresh } from '../feed/reco/signals.js';

const INSIGHTS_INTERVAL_MS = 15 * 60_000;

let started = false;

function startInsightsJob(intervalMs = INSIGHTS_INTERVAL_MS): void {
  // Held for most of the interval, so peers whose timers fire a moment later
  // skip rather than recompute the same thing.
  // The lease is re-entrant for this instance, so a slow run is kept from
  // overlapping its own next tick here instead.
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    void withJobLock('reco-admin-insights', () => recomputeAdminInsights(), { minHoldMs: intervalMs - 5_000 })
      .catch((err) => logger.warn({ err }, 'reco admin insights job failed'))
      .finally(() => { busy = false; });
  };
  // First run shortly after boot, once the listings index and snapshot are warm.
  setTimeout(run, 60_000).unref?.();
  setInterval(run, intervalMs).unref?.();
}

export function startRecoJobs(): void {
  if (started) return;
  started = true;
  startSignalsRefresh();
  startInsightsJob();
  startRecoStatsFlush();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      let exited = false;
      const done = () => {
        if (exited) return;
        exited = true;
        // The handler replaced the default action; re-raise so the process
        // exits exactly as it would have without us.
        process.kill(process.pid, signal);
      };
      const timeout = setTimeout(done, 3000);
      timeout.unref?.();
      flushRecoStats()
        .catch((err) => logger.warn({ err }, 'reco stats flush on shutdown failed'))
        .finally(() => {
          clearTimeout(timeout);
          done();
        });
    });
  }
}
