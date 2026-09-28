// Minimal Claude (Anthropic Messages API) client, used to draft WhatsApp
// replies. No SDK: one POST with a timeout. Every caller has a non-AI
// fallback, so a failure here only means "use the template".

import { env } from '../env.js';
import { logger } from '../logger.js';

export function aiConfigured(): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

export interface AiTurn { role: 'user' | 'assistant'; content: string }

export async function claude(system: string, messages: AiTurn[], maxTokens = 400): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('AI is not set up (ANTHROPIC_API_KEY is missing).');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: env.AI_MODEL, max_tokens: maxTokens, system, messages }),
    signal: AbortSignal.timeout(25_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.warn({ status: res.status, err: data?.error?.message }, 'ai: request failed');
    throw new Error(data?.error?.message || `AI request failed (${res.status})`);
  }
  const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
  if (!text) throw new Error('AI returned an empty reply');
  return text;
}
