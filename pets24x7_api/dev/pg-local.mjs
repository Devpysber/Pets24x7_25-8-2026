// Local embedded Postgres for backend dev.
// Real Postgres 16 binary, no Docker / admin needed.
//   npm run db:local        -> start, keep running (Ctrl+C to stop)
//   npm run db:local -- --stop-after-init   -> init + createDB, then exit
//
// Data lives in pets24x7_api/.pgdata (gitignored). Port 5433, user/pass postgres/postgres.
import EmbeddedPostgres from 'embedded-postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', '.pgdata');

const DB_NAME = 'pets24x7';
const stopAfterInit = process.argv.includes('--stop-after-init');

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: 5433,
  persistent: true,
  // Force UTF8 — Windows libc locale otherwise picks WIN1252 and chokes on ₹ etc.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

const fresh = await (async () => {
  try {
    const { access } = await import('node:fs/promises');
    await access(path.join(dataDir, 'PG_VERSION'));
    return false;
  } catch {
    return true;
  }
})();

if (fresh) {
  console.log('[pg-local] initialising cluster in', dataDir);
  await pg.initialise();
}

await pg.start();
console.log('[pg-local] started on postgresql://postgres:postgres@localhost:5433');

try {
  await pg.createDatabase(DB_NAME);
  console.log('[pg-local] created database', DB_NAME);
} catch (e) {
  if (/already exists/i.test(String(e?.message))) {
    console.log('[pg-local] database', DB_NAME, 'already exists');
  } else {
    throw e;
  }
}

if (stopAfterInit) {
  await pg.stop();
  console.log('[pg-local] stopped (init-only mode)');
  process.exit(0);
}

const shutdown = async () => {
  console.log('\n[pg-local] stopping...');
  try { await pg.stop(); } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log('[pg-local] ready. Ctrl+C to stop.');
