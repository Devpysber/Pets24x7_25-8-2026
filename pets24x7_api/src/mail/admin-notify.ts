// Resolves who gets an admin-facing alert.
//
// Alerts raised by a public request (a vendor signing up, say) have no logged-in
// admin to address. ADMIN_NOTIFY_EMAIL names the inbox explicitly; without it
// the OWNER admins on record are used, so a fresh deployment still gets mail.

import { prisma } from '../db.js';
import { env } from '../env.js';
import { logger } from '../logger.js';

export async function adminNotifyEmails(): Promise<string[]> {
  const explicit = env.ADMIN_NOTIFY_EMAIL;
  if (explicit) return [explicit];
  try {
    const admins = await prisma.admin.findMany({
      where: { role: 'OWNER' },
      select: { email: true },
      orderBy: { createdAt: 'asc' },
      take: 5,
    });
    if (admins.length > 0) return admins.map((a) => a.email);
  } catch (err) {
    logger.warn({ err }, '[mail] admin recipient lookup failed');
  }
  return env.SEED_ADMIN_EMAIL ? [env.SEED_ADMIN_EMAIL] : [];
}
