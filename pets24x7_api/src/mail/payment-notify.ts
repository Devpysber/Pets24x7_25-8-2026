// Team copy of every successful payment. Recipients come from
// PAYMENT_NOTIFY_EMAILS; the buyer's own receipt is sent by each purchase flow.

import { env } from '../env.js';
import { notify } from './notify.js';
import { adminPaymentReceivedEmail } from './lifecycle-templates.js';

export function notifyPaymentReceived(detail: Parameters<typeof adminPaymentReceivedEmail>[1]): void {
  const buyer = (detail.buyerEmail ?? '').trim().toLowerCase();
  for (const to of env.PAYMENT_NOTIFY_EMAILS) {
    // The buyer already has a receipt; no second copy if they are on the list.
    if (to === buyer) continue;
    notify(adminPaymentReceivedEmail(to, detail));
  }
}
