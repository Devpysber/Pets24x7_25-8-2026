// Cluster-wide "only one instance runs this" for scheduled jobs.
//
// Every API process starts the same schedulers. On one server that is fine; on
// two it means two reminder sweeps an hour, two admin digests at 08:00 and,
// where a job's own per-row guard is not airtight, two copies of an email.
//
//   await withJobLock('reminder-sweep', () => runReminderSweep(), { minHoldMs: 30 * 60_000 });
//
// How: a lease row per job name in `job_locks` (model JobLock). Taking it is
// one atomic statement — UPDATE ... WHERE name = ? AND (expiresAt <= NOW(3)
// OR holder = us) — or, the first time a job name is seen, an INSERT IGNORE that the primary key
// lets exactly one instance win. The winner renews the lease every third of
// its length while the job runs, so a long sweep keeps it and a crashed or
// frozen holder loses it when the lease runs out. All times are the database
// server's NOW(3), so clock drift between API servers does not matter.
//
// Why not MySQL GET_LOCK(): that lock belongs to one connection, and Prisma
// hands each query to whichever pooled connection is free. RELEASE_LOCK can
// land on a different connection (and silently do nothing), and pinning one
// connection means an interactive $transaction held open for the whole run —
// minutes for a mail sweep — which trips the transaction timeout and takes a
// connection out of a small pool. GET_LOCK also frees the instant the run
// ends, so a peer whose timer fires a few seconds later just runs it again;
// the lease can be held on past the end on purpose (minHoldMs).
//
// Fails open in one case only: the table does not exist yet (a deploy that has
// not run `prisma db push`). Then the job runs unlocked, exactly as it did
// before this existed, and a warning says why. Any other database error skips
// the run — the job would have needed that database anyway.

import crypto from 'node:crypto';
import os from 'node:os';

import { prisma } from '../db.js';
import { logger } from '../logger.js';

/** Identifies this process in `job_locks.holder` (host:pid:random). */
export const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`.slice(0, 191);

export interface JobLockOptions {
  /**
   * Lease length. Renewed every third of this while the job runs, so it only
   * bounds how long a crashed holder blocks everyone else. Default 5 minutes.
   */
  leaseMs?: number;
  /**
   * Keep the lease at least this long after the run *started*, even when it
   * finishes sooner. Peers whose timers fire within this window skip instead
   * of running the same job again (all servers wake at 08:00 for the digest,
   * a few ms apart). Default 0: released as soon as the run ends.
   */
  minHoldMs?: number;
}

export type JobLockResult<T> = { ran: true; result: T } | { ran: false };

const DEFAULT_LEASE_MS = 5 * 60_000;
let warnedMissingTable = false;

function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  // P2021 from the query engine; raw queries surface MySQL 1146 inside P2010.
  return e?.code === 'P2021' || e?.meta?.code === '1146' || /\b1146\b|job_locks.*doesn't exist/i.test(e?.message ?? '');
}

/**
 * Takes the lease for `name` if nobody else holds a live one. Resolves true
 * when this instance now holds it. Throws on database errors.
 *
 * Re-entrant for this instance: a lease it still holds (minHoldMs keeps it past
 * the run) never blocks its own next run. Overlap inside one process is the
 * caller's job (each scheduler keeps a busy/running flag); the lease only
 * keeps the other instances out.
 */
export async function acquireJobLock(name: string, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
  const us = Math.max(1_000, Math.round(leaseMs)) * 1_000;
  const taken = await prisma.$executeRaw`
    UPDATE job_locks
       SET holder = ${INSTANCE_ID},
           expiresAt = NOW(3) + INTERVAL ${us} MICROSECOND,
           acquiredAt = NOW(3),
           updatedAt = NOW(3)
     WHERE name = ${name} AND (expiresAt <= NOW(3) OR holder = ${INSTANCE_ID})`;
  if (taken === 1) return true;
  const inserted = await prisma.$executeRaw`
    INSERT IGNORE INTO job_locks (name, holder, expiresAt, acquiredAt, updatedAt)
    VALUES (${name}, ${INSTANCE_ID}, NOW(3) + INTERVAL ${us} MICROSECOND, NOW(3), NOW(3))`;
  return inserted === 1;
}

/** Extends a lease this instance holds. False means it was lost (expired and taken). */
export async function renewJobLock(name: string, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
  const us = Math.max(1_000, Math.round(leaseMs)) * 1_000;
  const n = await prisma.$executeRaw`
    UPDATE job_locks
       SET expiresAt = NOW(3) + INTERVAL ${us} MICROSECOND, updatedAt = NOW(3)
     WHERE name = ${name} AND holder = ${INSTANCE_ID}`;
  return n === 1;
}

/**
 * Gives the lease back. With minHoldMs it stays held until that long after the
 * run was acquired (never shortened below now).
 */
export async function releaseJobLock(name: string, minHoldMs = 0): Promise<void> {
  const us = Math.max(0, Math.round(minHoldMs)) * 1_000;
  await prisma.$executeRaw`
    UPDATE job_locks
       SET expiresAt = GREATEST(NOW(3), acquiredAt + INTERVAL ${us} MICROSECOND), updatedAt = NOW(3)
     WHERE name = ${name} AND holder = ${INSTANCE_ID}`;
}

/**
 * Runs `task` only if this instance wins the lease for `name`. Resolves
 * `{ ran: false }` when another instance holds it (or the lock could not be
 * checked); rejects only if the task itself rejects.
 */
export async function withJobLock<T>(
  name: string,
  task: () => Promise<T>,
  opts: JobLockOptions = {},
): Promise<JobLockResult<T>> {
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;

  let got: boolean;
  try {
    got = await acquireJobLock(name, leaseMs);
  } catch (err) {
    if (isMissingTable(err)) {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        logger.warn(
          { job: name },
          'job_locks table missing (run `npx prisma db push`); scheduled jobs run unlocked, which duplicates them if more than one API instance is up',
        );
      }
      return { ran: true, result: await task() };
    }
    logger.warn({ err, job: name }, 'could not take the job lock; skipping this run');
    return { ran: false };
  }

  if (!got) {
    logger.debug({ job: name, instance: INSTANCE_ID }, 'job lock held elsewhere; skipping this run');
    return { ran: false };
  }

  const renew = setInterval(() => {
    renewJobLock(name, leaseMs)
      .then((ok) => {
        if (!ok) logger.warn({ job: name }, 'job lease lost while running (database stalled past the lease?)');
      })
      .catch((err) => logger.warn({ err, job: name }, 'job lease renewal failed'));
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  renew.unref?.();

  try {
    return { ran: true, result: await task() };
  } finally {
    clearInterval(renew);
    await releaseJobLock(name, opts.minHoldMs ?? 0).catch((err) =>
      logger.warn({ err, job: name }, 'job lock release failed; it expires with the lease'),
    );
  }
}
