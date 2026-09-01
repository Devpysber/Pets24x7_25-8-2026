// Copy non-TS runtime assets that `tsc` ignores into dist/ so `npm start`
// (node dist/server.js) has everything it needs — chiefly the EJS admin views.
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  ['src/admin/views', 'dist/admin/views'],
];

for (const [from, to] of pairs) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  if (!existsSync(src)) { console.warn(`[copy-assets] skip (missing): ${from}`); continue; }
  await mkdir(path.dirname(dst), { recursive: true });
  await cp(src, dst, { recursive: true });
  console.log(`[copy-assets] ${from} -> ${to}`);
}
