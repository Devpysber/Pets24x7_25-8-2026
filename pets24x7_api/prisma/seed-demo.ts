// Create demo accounts for Pet Parent and Vendor.
// Usage: npx tsx prisma/seed-demo.ts

import bcrypt from 'bcrypt';
import { prisma } from '../src/db.js';

async function main() {
  console.log('[seed-demo] Seeding demo accounts...');

  // 1. Pet Parent Demo Account
  const parentEmail = 'parent@pets24x7.com';
  const parentPassword = 'Password123!';
  const parentPhone = '+919876543210';
  const passwordHash = await bcrypt.hash(parentPassword, 12);

  const parent = await prisma.petParent.upsert({
    where: { email: parentEmail },
    update: {
      name: 'Demo Pet Parent',
      passwordHash,
      phone: parentPhone,
      city: 'Mumbai',
      country: 'IN',
      emailVerified: true,
      emailVerifiedAt: new Date(),
    },
    create: {
      email: parentEmail,
      name: 'Demo Pet Parent',
      passwordHash,
      phone: parentPhone,
      city: 'Mumbai',
      country: 'IN',
      emailVerified: true,
      emailVerifiedAt: new Date(),
    },
  });

  console.log(`[seed-demo] Pet Parent ready: ${parent.email} (Phone: ${parent.phone})`);

  // Add a demo pet for the Pet Parent
  const existingPet = await prisma.pet.findFirst({ where: { ownerId: parent.id, name: 'Buddy' } });
  if (!existingPet) {
    await prisma.pet.create({
      data: {
        ownerId: parent.id,
        name: 'Buddy',
        species: 'DOG',
        breed: 'Golden Retriever',
        ageYears: 3,
        gender: 'Male',
        vaccinated: true,
        notes: 'Friendly, loves playing fetch.',
      },
    });
    console.log('[seed-demo] Created demo pet Buddy for Pet Parent');
  }

  // 2. Vendor Demo Account
  const vendorEmail = 'vendor@pets24x7.com';
  const vendorPhone = '+919876543211';

  const vendor = await prisma.vendor.upsert({
    where: { phone: vendorPhone },
    update: {
      businessName: 'Happy Paws Pet Care',
      email: vendorEmail,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      city: 'Mumbai',
      country: 'IN',
      category: 'pet-grooming-spa',
      status: 'ACTIVE',
      profileCompletion: 100,
    },
    create: {
      phone: vendorPhone,
      businessName: 'Happy Paws Pet Care',
      email: vendorEmail,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      city: 'Mumbai',
      country: 'IN',
      category: 'pet-grooming-spa',
      status: 'ACTIVE',
      profileCompletion: 100,
      claimedAt: new Date(),
      approvedAt: new Date(),
    },
  });

  console.log(`[seed-demo] Vendor ready: ${vendor.businessName} (${vendor.email} / ${vendor.phone})`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
