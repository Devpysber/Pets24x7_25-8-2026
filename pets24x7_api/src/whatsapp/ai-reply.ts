// AI-written WhatsApp replies for the admin inbox.
//
// draftReply() reads the recent conversation and asks Claude for the next
// message from Pets24x7. It is used two ways:
//   - automatic chats: sent straight away (see inbox.ts), with limits
//   - any chat: "Suggest reply" in the admin, which only fills the reply box
// It returns null when the right move is to stay quiet (a bare "ok", spam).

import { prisma } from '../db.js';
import { claude, type AiTurn } from '../ai/claude.js';
import { phoneVariants } from './inbox.js';

const NO_REPLY = 'NO_REPLY';

function systemPrompt(extra: string, name: string | null): string {
  return [
    'You are the WhatsApp assistant for Pets24x7 (pets24x7.com), a pet-services marketplace listing vets, emergency animal hospitals, groomers, boarding and daycare, dog walkers, trainers, pet sitters, pet taxis, pet relocation, dental care and physiotherapy across India and the USA.',
    'People message this number to find pet care. How it works: they tell us their city, what their pet needs and when; the Pets24x7 team connects them with a listed business and helps confirm a slot. Pet parents pay no booking fee.',
    'Search link you may share, filled in: https://pets24x7.com/search/?q=<service>&city=<city> (for example https://pets24x7.com/search/?q=grooming&city=Pune).',
    '',
    'How to reply:',
    '- Reply in the language and script the person uses (English, Hindi, Hinglish, Marathi and so on).',
    '- Keep it short: one to four sentences, warm and plain. At most one emoji. No markdown, no bullet lists, no headings.',
    '- If the city, the service, or the pet (type, breed, age) is missing and matters, ask for the missing part.',
    '- Never make up businesses, names, prices, discounts, availability, timings or addresses. Say the team will confirm them.',
    '- No medical diagnosis or dosing. If it sounds urgent (bleeding, poisoning, breathing trouble, seizures, an accident), tell them to go to the nearest emergency vet right now and share the emergency search link.',
    '- Payments, refunds, complaints, account or listing problems, or the status of a particular booking: say a team member will reply here shortly.',
    '- If asked, say you are the Pets24x7 assistant and a person from the team can take over any time. Never claim to be human.',
    `- If the latest message needs no answer (a plain "ok" or "thanks" after the conversation ended, spam, abuse), reply with exactly ${NO_REPLY}.`,
    name ? `The person's WhatsApp name is ${name}.` : '',
    extra.trim() ? `\nNotes from the Pets24x7 team (follow these):\n${extra.trim()}` : '',
  ].filter(Boolean).join('\n');
}

/** The conversation as alternating turns, oldest first, ending on their message. */
async function turns(phone: string): Promise<AiTurn[]> {
  const rows = await prisma.waMessage.findMany({
    where: {
      AND: [
        { OR: [{ type: null }, { type: { not: 'status' } }] },
        { OR: [{ direction: 'INBOUND', fromNumber: { in: phoneVariants(phone) } }, { direction: 'OUTBOUND', toNumber: { in: phoneVariants(phone) } }] },
        { OR: [{ status: null }, { status: { notIn: ['failed', 'deleted'] } }] },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { direction: true, body: true, type: true },
  });
  const out: AiTurn[] = [];
  for (const m of rows.reverse()) {
    if (!m.body || /otp$/.test(m.type ?? '')) continue; // never show the model a sign-in code
    const role = m.direction === 'INBOUND' ? 'user' : 'assistant';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n' + m.body;
    else out.push({ role, content: m.body });
  }
  while (out.length && out[0]!.role !== 'user') out.shift();
  return out;
}

export async function draftReply(phone: string, opts: { instructions: string; name: string | null; forceAnswer?: boolean }): Promise<string | null> {
  const t = await turns(phone);
  if (!t.length) return null;
  if (t[t.length - 1]!.role !== 'user') {
    // Our side spoke last. For a suggestion, ask for a follow-up; automatic mode stays quiet.
    if (!opts.forceAnswer) return null;
    t.push({ role: 'user', content: '(No new message from them. Write a short, useful follow-up from Pets24x7.)' });
  }
  const text = await claude(systemPrompt(opts.instructions, opts.name), t, 400);
  const clean = text.replace(/^["']|["']$/g, '').trim();
  if (!clean || clean.toUpperCase().startsWith(NO_REPLY)) return null;
  return clean.slice(0, 1500);
}
