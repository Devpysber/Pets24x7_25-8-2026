// Admin > Recently deleted.
//
//   GET    /api/admin/trash                 list (kind, q, includeRestored)
//   POST   /api/admin/trash/:id/restore     put it back
//   DELETE /api/admin/trash/:id             forget it for good

import { Router } from 'express';

import { prisma } from '../db.js';
import { asyncHandler } from '../shared/async-handler.js';
import { requireAuth } from '../auth/middleware.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';
import { RestoreConflict, TRASH_LABEL, restoreTrash } from './trash.js';

export const adminTrashRouter = Router();
adminTrashRouter.use('/trash', requireAuth('admin'));

adminTrashRouter.get(
  '/trash',
  asyncHandler(async (req, res) => {
    const kind = String(req.query.kind ?? '');
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const includeRestored = req.query.includeRestored === '1';
    const rows = await prisma.deletedRecord.findMany({
      where: {
        ...(kind && kind in TRASH_LABEL ? { kind } : {}),
        ...(includeRestored ? {} : { restoredAt: null }),
        ...(q ? { OR: [{ label: { contains: q } }, { recordId: { contains: q } }] } : {}),
      },
      orderBy: { deletedAt: 'desc' },
      take: 300,
      select: { id: true, kind: true, recordId: true, label: true, deletedByRole: true, deletedById: true, deletedAt: true, restoredAt: true },
    });
    // Who deleted it, by name.
    const adminIds = [...new Set(rows.filter((r) => r.deletedByRole === 'admin' && r.deletedById).map((r) => r.deletedById as string))];
    const admins = adminIds.length ? await prisma.admin.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } }) : [];
    const adminName = new Map(admins.map((a) => [a.id, a.name]));
    const counts = await prisma.deletedRecord.groupBy({ by: ['kind'], where: { restoredAt: null }, _count: { _all: true } });
    res.json({
      ok: true,
      kinds: TRASH_LABEL,
      counts: Object.fromEntries(counts.map((c) => [c.kind, c._count._all])),
      rows: rows.map((r) => ({
        ...r,
        kindLabel: TRASH_LABEL[r.kind as keyof typeof TRASH_LABEL] ?? r.kind,
        deletedBy:
          r.deletedByRole === 'admin' ? adminName.get(r.deletedById ?? '') ?? 'Admin'
          : r.deletedByRole === 'pet_parent' ? 'The pet parent'
          : r.deletedByRole === 'vendor' ? 'The business'
          : 'System',
      })),
    });
  }),
);

adminTrashRouter.post(
  '/trash/:id/restore',
  asyncHandler(async (req, res) => {
    try {
      const r = await restoreTrash(req.params.id ?? '', req.auth!.sub);
      await prisma.auditLog
        .create({ data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: `${r.kind}.restore`, meta: { recordId: r.recordId, label: r.label }, ipAddress: req.ip ?? null } })
        .catch(() => {});
      res.json({ ok: true, ...r });
    } catch (err) {
      if (err instanceof RestoreConflict) throw new ConflictError(err.message);
      throw err;
    }
  }),
);

adminTrashRouter.delete(
  '/trash/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.deletedRecord.deleteMany({ where: { id: req.params.id ?? '' } });
    if (!count) throw new NotFoundError('Not found');
    res.json({ ok: true });
  }),
);
