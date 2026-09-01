// Outbound transactional email over Gmail SMTP (app password).
//
// Credentials live in SMTP_USER / SMTP_PASS. When they are unset — the usual
// local-dev case — sending is a no-op that logs the message (and the raw link,
// so a developer can still click through a verification flow offline).

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { env } from '../env.js';
import { logger } from '../logger.js';
import type { MailKind } from './optout.js';
import { isOptedOut, unsubscribeUrl } from './optout.js';

let cached: Transporter | null = null;

export function mailEnabled(): boolean {
  return Boolean(env.SMTP_USER && env.SMTP_PASS);
}

function transporter(): Transporter | null {
  if (!mailEnabled()) return null;
  if (!cached) {
    cached = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! },
    });
  }
  return cached;
}

export interface MailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Defaults to 'transactional'. Only 'marketing' mail is suppressed for
   * opted-out addresses and carries unsubscribe headers.
   */
  kind?: MailKind;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Appends the unsubscribe line to a rendered template. Injected here rather
 * than inside each template so a template can never ship marketing mail
 * without one.
 */
function withUnsubscribeFooter(html: string, url: string): string {
  const block =
    `<div style="max-width:600px;margin:0 auto;padding:0 20px 28px;text-align:center;font-family:${FONT}">` +
    `<p style="margin:0;font-size:12px;line-height:18px;color:#9ca3af">` +
    `You are receiving occasional Pets24x7 suggestions. ` +
    `<a href="${url}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a>.` +
    `</p></div>`;
  return html.includes('</body>') ? html.replace('</body>', `${block}</body>`) : html + block;
}

/**
 * Best-effort send. Never throws: a mail outage must not fail a signup, so the
 * caller gets `false` and the error is logged.
 */
export async function sendMail(input: MailInput): Promise<boolean> {
  const kind: MailKind = input.kind ?? 'transactional';
  if (kind === 'marketing') {
    let suppressed = false;
    try {
      suppressed = await isOptedOut(input.to);
    } catch (err) {
      // A suppression-list outage must not silently start mailing opted-out
      // people, so fail closed.
      logger.error({ err, to: input.to }, '[mail] opt-out check failed — suppressing');
      return false;
    }
    if (suppressed) {
      logger.info({ to: input.to, subject: input.subject }, '[mail] suppressed — recipient opted out');
      return false;
    }
  }

  const tx = transporter();
  if (!tx) {
    logger.warn({ to: input.to, subject: input.subject, text: input.text }, '[mail] SMTP not configured — message not sent');
    return false;
  }
  try {
    const { kind: _kind, ...message } = input;
    if (kind === 'marketing') {
      const url = unsubscribeUrl(input.to);
      message.html = withUnsubscribeFooter(message.html, url);
      message.text = `${message.text}

Don't want these emails? Unsubscribe: ${url}
`;
    }
    const headers =
      kind === 'marketing'
        ? {
            'List-Unsubscribe': `<${unsubscribeUrl(input.to)}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          }
        : undefined;
    const info = await tx.sendMail({ from: env.MAIL_FROM, ...message, ...(headers ? { headers } : {}) });
    logger.info({ to: input.to, subject: input.subject, messageId: info.messageId }, '[mail] sent');
    return true;
  } catch (err) {
    logger.error({ err, to: input.to, subject: input.subject }, '[mail] send failed');
    return false;
  }
}
