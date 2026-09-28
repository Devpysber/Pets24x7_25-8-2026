// Send a reply in an inbox chat on whichever sender is active, and make sure
// it lands in the message log (the linked-number sender logs its own rows).

import { prisma } from '../db.js';
import { sendText, whatsappProvider } from './cloud-api.js';
import { baileysSend } from './baileys.js';

export async function sendReply(phone: string, text: string, how: 'auto' | 'manual'): Promise<{ messageId: string; provider: 'baileys' | 'meta' }> {
  const provider = whatsappProvider();
  if (!provider) throw new Error('No WhatsApp sender is working. Link a number in Settings.');
  if (provider === 'baileys') {
    const r = await baileysSend(phone, text, how === 'auto' ? 'auto' : 'reply');
    return { ...r, provider };
  }
  // Meta: free text is allowed inside the 24-hour window after they wrote.
  const r = await sendText(phone, text);
  await prisma.waMessage
    .create({ data: { waMessageId: r.messageId || null, direction: 'OUTBOUND', toNumber: phone, type: `meta:${how}`, status: 'sent', body: text } })
    .catch(() => {});
  return { ...r, provider };
}
