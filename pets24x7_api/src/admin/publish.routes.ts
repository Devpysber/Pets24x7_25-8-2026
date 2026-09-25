// Admin "Publish site": re-export the listings table to the static site and
// re-render it now, instead of waiting for the nightly timer.
//
//   POST /api/admin/publish          -> 202 { ok, requested, alreadyRunning, status }
//   GET  /api/admin/publish/status   -> 200 { ok, enabled, pending, status }
//
// The API never builds the site itself and never runs a shell. The render is
// ~40k files and belongs to ops/pets24x7-publish.sh under its own systemd unit
// (pets24x7-publish.service), which takes a lock, builds a fresh release and
// swaps the docroot symlink. This route only asks for a run, one of two ways,
// both configured by the operator and neither shaped by the request:
//
//   PUBLISH_TRIGGER_FILE  a path the API may write (e.g.
//                         /opt/pets24x7/run/publish.request). The
//                         pets24x7-publish.path unit starts the service when
//                         it appears; the script deletes it when it starts, so
//                         requests made during a run coalesce into one more
//                         run. Works under the API unit's NoNewPrivileges=true.
//   PUBLISH_COMMAND       an absolute command line run with execFile (no
//                         shell), split on whitespace, e.g.
//                         "/usr/bin/sudo -n /usr/bin/systemctl start --no-block pets24x7-publish.service".
//                         sudo needs NoNewPrivileges off for the API unit; see
//                         DEPLOY.md "Managing listings" for the sudoers line.
//
// With neither set the endpoint answers 501 and says how to enable it.
//
//   PUBLISH_STATUS_FILE   JSON the publish script writes at start and finish
//                         (default /var/lib/pets24x7/publish-status.json).

import { Router } from 'express';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { HttpError } from '../shared/errors.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { logger } from '../logger.js';

export const adminPublishRouter = Router();

const DEFAULT_STATUS_FILE = '/var/lib/pets24x7/publish-status.json';
const COMMAND_TIMEOUT_MS = 15_000;

// A publish is minutes of CPU and ~1 GB of disk churn. A few per ten minutes
// covers "fix, publish, spot a typo, publish again"; anything past that is a
// stuck button or a script. Keyed on client IP, shared across instances.
const publishLimiter = makeLimiter('admin-publish', {
  windowMs: 10 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'rate_limited', message: 'Too many publish requests. Wait a few minutes; the nightly run also picks up every change.' },
});

function config() {
  const trigger = (process.env.PUBLISH_TRIGGER_FILE ?? '').trim();
  const command = (process.env.PUBLISH_COMMAND ?? '').trim();
  const statusFile = (process.env.PUBLISH_STATUS_FILE ?? '').trim() || DEFAULT_STATUS_FILE;
  return {
    trigger: trigger && path.isAbsolute(trigger) ? trigger : '',
    argv: command ? command.split(/\s+/) : [],
    statusFile,
  };
}

type PublishStatus = {
  state?: string;
  trigger?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  release?: string | null;
  pages?: number | null;
  listings?: number | null;
  cities?: number | null;
  message?: string | null;
  lastSuccessAt?: string | null;
  lastSuccessRelease?: string | null;
};

const STATUS_KEYS: Array<keyof PublishStatus> = [
  'state', 'trigger', 'startedAt', 'finishedAt', 'release', 'pages', 'listings', 'cities', 'message',
  'lastSuccessAt', 'lastSuccessRelease',
];

/** The script's status file, reduced to known keys. null when absent/unreadable. */
async function readStatus(file: string): Promise<PublishStatus | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of STATUS_KEYS) {
      const v = obj[k];
      if (v === null || typeof v === 'number' || (typeof v === 'string' && v.length <= 2000)) out[k] = v;
    }
    // A run killed hard (OOM, reboot) never writes its final state. After the
    // unit's own 45-minute timeout "running" can no longer be true.
    if (out.state === 'running' && typeof out.startedAt === 'string') {
      const age = Date.now() - Date.parse(out.startedAt);
      if (Number.isFinite(age) && age > 50 * 60_000) out.state = 'stale';
    }
    return out as PublishStatus;
  } catch {
    return { state: 'unknown', message: 'status file is not valid JSON' };
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function runCommand(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  return new Promise((resolve, reject) => {
    execFile(
      cmd!,
      args,
      // Fixed argv, no shell, no request data, a bare PATH: the operator's
      // command line is the only thing that runs.
      { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim().slice(0, 300);
          reject(new Error(detail || 'publish command failed'));
        } else resolve();
      },
    );
  });
}

adminPublishRouter.post(
  '/publish',
  requireAuth('admin'),
  publishLimiter,
  asyncHandler(async (req, res) => {
    const cfg = config();
    if (!cfg.trigger && !cfg.argv.length) {
      throw new HttpError(
        501,
        'Publishing from the admin panel is not enabled on this server. Set PUBLISH_TRIGGER_FILE (or PUBLISH_COMMAND) ' +
          'in the API environment — see DEPLOY.md, "Managing listings". The nightly publish still runs.',
        'publish_disabled',
      );
    }
    if (cfg.argv.length && !path.isAbsolute(cfg.argv[0]!)) {
      throw new HttpError(501, 'PUBLISH_COMMAND must start with an absolute path.', 'publish_misconfigured');
    }

    const before = await readStatus(cfg.statusFile);
    const requestedAt = new Date().toISOString();
    try {
      if (cfg.trigger) {
        // Written then renamed, so the path unit never sees a half-written file.
        await mkdir(path.dirname(cfg.trigger), { recursive: true });
        const tmp = `${cfg.trigger}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify({ requestedAt, by: req.auth!.sub }) + '\n', { mode: 0o644 });
        await rename(tmp, cfg.trigger);
      } else {
        await runCommand(cfg.argv);
      }
    } catch (err) {
      logger.error({ err }, 'publish request failed');
      throw new HttpError(
        502,
        'The publish could not be started: ' + (err instanceof Error ? err.message : 'unknown error'),
        'publish_failed',
      );
    }

    await prisma.auditLog
      .create({
        data: {
          actorType: 'ADMIN',
          actorId: req.auth!.sub,
          action: 'site.publish',
          meta: { requestedAt, via: cfg.trigger ? 'trigger_file' : 'command' },
          ipAddress: req.ip ?? null,
        },
      })
      .catch(() => {});

    const alreadyRunning = before?.state === 'running';
    res.status(202).json({
      ok: true,
      requested: true,
      requestedAt,
      alreadyRunning,
      message: alreadyRunning
        ? 'A publish is already running. Another run starts when it finishes, so this change is included.'
        : 'Publish started. The site usually updates within 5–10 minutes.',
      status: before,
    });
  }),
);

adminPublishRouter.get(
  '/publish/status',
  requireAuth('admin'),
  asyncHandler(async (_req, res) => {
    const cfg = config();
    const [status, pending] = await Promise.all([
      readStatus(cfg.statusFile),
      cfg.trigger ? exists(cfg.trigger) : Promise.resolve(false),
    ]);
    res.json({
      ok: true,
      enabled: Boolean(cfg.trigger || cfg.argv.length),
      // A request is waiting for the path unit (or for the current run to end).
      pending,
      status,
    });
  }),
);
