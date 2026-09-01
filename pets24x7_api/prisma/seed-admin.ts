// Bootstrap the first admin from SEED_ADMIN_* env vars.
// Idempotent — running twice updates the existing row's password to whatever's in .env.
//
// Usage:
//   npm run seed:admin

import bcrypt from 'bcrypt';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';

async function main() {
  if (!env.SEED_ADMIN_EMAIL || !env.SEED_ADMIN_PASSWORD) {
    console.error('[seed-admin] SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set in .env');
    process.exit(1);
  }

  const email = env.SEED_ADMIN_EMAIL.toLowerCase();
  const passwordHash = await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 12);

  const admin = await prisma.admin.upsert({
    where: { email },
    update: { passwordHash, name: env.SEED_ADMIN_NAME ?? 'Pets24x7 Admin' },
    create: {
      email,
      passwordHash,
      name: env.SEED_ADMIN_NAME ?? 'Pets24x7 Admin',
      role: 'OWNER',
    },
  });

  console.log(`[seed-admin] ok — admin ready: ${admin.email} (id=${admin.id})`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
