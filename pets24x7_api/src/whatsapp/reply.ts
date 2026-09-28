// Send a reply in an inbox chat on whichever sender is active, and make sure
// it lands in the message log (the linked-number sender logs its own rows).

import { prisma } from '../db.js';
import { sendText, whatsappProvider } from './cloud-api.js';
import { baileysSend } from './baileys.js';
import { phoneVariants } from './inbox.js';

export async function sendReply(phone: string, text: string, how: 'auto' | 'manual'): Promise<{ messageId: string; provider: 'baileys' | 'meta' }> {
  const provider = whatsappProvider();
  if (!provider) throw new Error('No WhatsApp sender is working. Link a number in Settings.');
  if (provider === 'baileys') {
    // Writing first to someone who never messaged us is held to the stricter
    // per-number cap, like a notice; answering them is a normal reply.
    const theyWrote = how === 'auto' || (await prisma.waMessage.count({ where: { direction: 'INBOUND', fromNumber: { in: phoneVariants(phone) } } })) > 0;
    const r = await baileysSend(phone, text, how === 'auto' ? 'auto' : theyWrote ? 'reply' : 'notice');
    return { ...r, provider };
  }
  if (phone.startsWith('lid:')) throw new Error('This chat can only be answered from the linked number.');
  // Meta: free text is allowed inside the 24-hour window after they wrote.
  const r = await sendText(phone, text);
  await prisma.waMessage
    .create({ data: { waMessageId: r.messageId || null, direction: 'OUTBOUND', toNumber: phone, type: `meta:${how}`, status: 'sent', body: text } })
    .catch(() => {});
  return { ...r, provider };
}
