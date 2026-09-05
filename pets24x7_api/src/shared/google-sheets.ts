import { logger } from '../logger.js';

export interface GoogleSheetsListingPayload {
  listingId: string;
  businessName: string;
  category?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  whatsapp?: string | null;
  address?: string | null;
  locality?: string | null;
  pincode?: string | null;
  claimStatus?: string | null;
  createdAt?: string | Date | null;
}

/**
 * Sanitizes cell values to prevent CSV / Google Sheets formula injection (=, +, -, @)
 */
export function sanitizeSheetCell(value: any): string {
  if (value === null || value === undefined) return '';
  const str = String(value).trim();
  if (str.startsWith('=') || str.startsWith('+') || str.startsWith('-') || str.startsWith('@')) {
    return "'" + str;
  }
  return str;
}

export async function syncListingsToGoogleSheets(listings: GoogleSheetsListingPayload[]): Promise<{ synced: number; failed: number }> {
  if (!listings.length) return { synced: 0, failed: 0 };

  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL || process.env.GOOGLE_APPS_SCRIPT_URL;

  const sanitizedRows = listings.map((l) => ({
    listingId: sanitizeSheetCell(l.listingId),
    businessName: sanitizeSheetCell(l.businessName),
    category: sanitizeSheetCell(l.category || 'Pet Service'),
    city: sanitizeSheetCell(l.city || ''),
    phone: sanitizeSheetCell(l.phone || ''),
    email: sanitizeSheetCell(l.email || ''),
    website: sanitizeSheetCell(l.website || ''),
    whatsapp: sanitizeSheetCell(l.whatsapp || ''),
    address: sanitizeSheetCell(l.address || ''),
    locality: sanitizeSheetCell(l.locality || ''),
    pincode: sanitizeSheetCell(l.pincode || ''),
    claimStatus: sanitizeSheetCell(l.claimStatus || 'UNCLAIMED'),
    createdAt: sanitizeSheetCell(l.createdAt ? new Date(l.createdAt).toISOString() : new Date().toISOString()),
  }));

  if (!webhookUrl) {
    logger.info({ count: sanitizedRows.length }, 'Google Sheets sync (dev mode/unconfigured): logged rows safely');
    return { synced: sanitizedRows.length, failed: 0 };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'SYNC_LISTINGS',
        timestamp: new Date().toISOString(),
        rows: sanitizedRows,
      }),
    });

    if (response.ok) {
      logger.info({ count: sanitizedRows.length }, 'Google Sheets sync successful');
      return { synced: sanitizedRows.length, failed: 0 };
    } else {
      logger.warn({ status: response.status, statusText: response.statusText }, 'Google Sheets webhook returned non-200');
      return { synced: 0, failed: sanitizedRows.length };
    }
  } catch (err: any) {
    logger.error({ error: err?.message || err }, 'Google Sheets sync failed');
    return { synced: 0, failed: sanitizedRows.length };
  }
}
