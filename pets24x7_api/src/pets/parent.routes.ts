// Pet Parent dashboard + Pet CRUD.
// All routes require an active pet_parent JWT.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { NotFoundError, ForbiddenError } from '../shared/errors.js';

export const parentDashboardRouter = Router();

parentDashboardRouter.use(requireAuth('pet_parent'));

// ----- Dashboard summary -----
parentDashboardRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const parentId = req.auth!.sub;
    let parent: any = null;
    let pets: any[] = [];
    let enquiries: any[] = [];

    try {
      const [p, pt, e] = await Promise.all([
        prisma.petParent.findUnique({
          where: { id: parentId },
          select: { id: true, name: true, phone: true, email: true, city: true, country: true },
        }),
        prisma.pet.findMany({ where: { ownerId: parentId }, orderBy: { createdAt: 'desc' } }),
        prisma.enquiry.findMany({
          where: { petParentId: parentId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);
      parent = p; pets = pt; enquiries = e;
    } catch {
      // DB connection offline
    }

    if (!parent) {
      if (process.env.NODE_ENV === 'development') {
        parent = {
          id: parentId,
          name: 'Dev Pet Parent',
          phone: '+91 9876543210',
          email: 'alex.parent@example.com',
          city: 'Mumbai',
          country: 'IN',
        };
        pets = [
          {
            id: 'pet-dev-1',
            name: 'Buddy',
            species: 'DOG',
            breed: 'Golden Retriever',
            ageYears: 3,
            vaccinated: true,
            notes: 'Friendly and vaccinated',
          },
        ];
      } else {
        throw new NotFoundError('Parent record missing');
      }
    }

    res.json({
      ok: true,
      parent,
      pets,
      enquiries,
      nearbyDeals: [],
      upcomingEvents: [],
      membership: { active: true, plan: 'Gold · Annual', renewsAt: '2027-08-14' },
    });
  }),
);

// ----- Pet CRUD -----
const PetBody = z.object({
  name: z.string().min(1).max(40),
  species: z.enum(['DOG','CAT','BIRD','RABBIT','REPTILE','SMALL_MAMMAL','OTHER']),
  breed: z.string().max(60).optional(),
  ageYears: z.number().int().min(0).max(50).optional(),
  vaccinated: z.boolean().optional(),
  notes: z.string().max(500).optional(),
  avatarUrl: z.string().url().optional(),
});

parentDashboardRouter.get(
  '/pets',
  asyncHandler(async (req, res) => {
    const list = await prisma.pet.findMany({
      where: { ownerId: req.auth!.sub },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ ok: true, pets: list });
  }),
);

parentDashboardRouter.post(
  '/pets',
  asyncHandler(async (req, res) => {
    const body = PetBody.parse(req.body);
    const pet = await prisma.pet.create({
      data: { ...body, ownerId: req.auth!.sub },
    });
    res.status(201).json({ ok: true, pet });
  }),
);

parentDashboardRouter.patch(
  '/pets/:id',
  asyncHandler(async (req, res) => {
    const body = PetBody.partial().parse(req.body);
    const existing = await prisma.pet.findUnique({ where: { id: req.params.id ?? '' } });
    if (!existing) throw new NotFoundError('Pet not found');
    if (existing.ownerId !== req.auth!.sub) throw new ForbiddenError();
    const pet = await prisma.pet.update({ where: { id: existing.id }, data: body });
    res.json({ ok: true, pet });
  }),
);

parentDashboardRouter.delete(
  '/pets/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.pet.findUnique({ where: { id: req.params.id ?? '' } });
    if (!existing) throw new NotFoundError('Pet not found');
    if (existing.ownerId !== req.auth!.sub) throw new ForbiddenError();
    await prisma.pet.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  }),
);
