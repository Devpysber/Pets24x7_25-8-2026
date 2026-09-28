// Test data: what does not count as real business.
//
// The production database holds rows written by developer tooling: the fixed
// dev accounts (ids starting "dev-", e.g. dev-parent-id / dev-vendor-id),
// accounts on example.com addresses, and payments settled by the local
// payment bypass (gateway ids starting "DEV_"). They stay in the database and
// in the lists (with a Test badge), but revenue, counts and reports leave them
// out, so every figure in the admin panel is real money and real people.

import type { Prisma } from '@prisma/client';

const TEST_ID_PREFIX = 'dev-';
const TEST_EMAIL_SUFFIX = '@example.com';
const TEST_TXN_PREFIX = 'DEV_';

export function isTestAccount(a: { id?: string | null; email?: string | null } | null | undefined): boolean {
  if (!a) return false;
  return !!a.id?.startsWith(TEST_ID_PREFIX) || !!a.email?.toLowerCase().endsWith(TEST_EMAIL_SUFFIX);
}

export function isTestPayment(p: { gatewayTxnId?: string | null; merchantTxnId?: string | null; parentId?: string | null } | null | undefined): boolean {
  if (!p) return false;
  return !!p.gatewayTxnId?.startsWith(TEST_TXN_PREFIX) || !!p.merchantTxnId?.startsWith(TEST_TXN_PREFIX) || !!p.parentId?.startsWith(TEST_ID_PREFIX);
}

// Nullable columns need the explicit null branch: NOT (x LIKE 'DEV_%') is
// NULL, not true, when x is NULL, which would drop real rows.
export const REAL_PAYMENT: Prisma.PaymentWhereInput = {
  AND: [
    { OR: [{ gatewayTxnId: null }, { NOT: { gatewayTxnId: { startsWith: TEST_TXN_PREFIX } } }] },
    { NOT: { merchantTxnId: { startsWith: TEST_TXN_PREFIX } } },
    { OR: [{ parentId: null }, { NOT: { parentId: { startsWith: TEST_ID_PREFIX } } }] },
  ],
};

export const REAL_VENDOR: Prisma.VendorWhereInput = {
  AND: [
    { NOT: { id: { startsWith: TEST_ID_PREFIX } } },
    { OR: [{ email: null }, { NOT: { email: { endsWith: TEST_EMAIL_SUFFIX } } }] },
  ],
};

export const REAL_PARENT: Prisma.PetParentWhereInput = {
  AND: [
    { NOT: { id: { startsWith: TEST_ID_PREFIX } } },
    { OR: [{ email: null }, { NOT: { email: { endsWith: TEST_EMAIL_SUFFIX } } }] },
  ],
};
