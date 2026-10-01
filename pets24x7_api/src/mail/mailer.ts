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
import { LOGO_CID, NAVY_TEXT, UNSUBSCRIBE_SLOT, esc, logoUrl, withTracking } from './components.js';
import { LOGO_PNG_BASE64 } from './logo-data.js';
import { prisma } from '../db.js';

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

/**
 * Proves the relay actually accepts our credentials.
 *
 * sendMail never throws, so a wrong SMTP_PASS otherwise shows up only as mail
 * that silently never arrives. Called once at boot, and by the admin console.
 */
export async function verifyMailTransport(): Promise<{ ok: boolean; error?: string }> {
  const tx = transporter();
  if (!tx) return { ok: false, error: 'SMTP_USER / SMTP_PASS not set — sending is a logged no-op' };
  try {
    await tx.verify();
    logger.info({ host: env.SMTP_HOST, user: env.SMTP_USER }, '[mail] SMTP relay accepted our credentials');
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(
      { host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, error },
      '[mail] SMTP login FAILED — no outbound mail will be delivered',
    );
    return { ok: false, error };
  }
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
  /**
   * The message carries a live credential in its subject or body — a one-time
   * sign-in code. Keeps it out of the logs: a code hashed in the database is
   * not secret if journalctl prints it in the clear for its whole lifetime.
   */
  sensitive?: boolean;
  /**
   * Send even when the development guard would suppress it. Only the explicit
   * `npm run mail:check` test message sets this.
   */
  force?: boolean;
  /**
   * Short snake_case id of the template (e.g. 'membership_activated'). Becomes
   * utm_medium on every link to our own site, so clicks are attributable.
   */
  tag?: string;
  /** utm_campaign for those links. Defaults to the mail kind. */
  campaign?: string;
}

/**
 * Adds the unsubscribe line to a rendered marketing template, or clears the
 * slot on anything else. Done here rather than inside each template so a
 * template can never ship marketing mail without one.
 *
 * The line lands in the Footer's UNSUBSCRIBE_SLOT, inside the card next to the
 * legal links; HTML that did not come from page() gets it before </body>.
 * Exported so scripts/mail-preview.ts renders exactly what is sent.
 */
export function withUnsubscribeFooter(html: string, url: string | null): string {
  if (!url) return html.split(UNSUBSCRIBE_SLOT).join('');
  // The URL carries a raw '&' between query params — must be entity-escaped
  // before it can sit inside an href="..." attribute value.
  const safeUrl = url.replace(/&/g, '&amp;');
  // The slot sits on the navy footer, so its link is light; the fallback block
  // below sits on the pale canvas and needs the dark grey instead.
  const line = (color: string): string =>
    `<br>You are receiving occasional Pets24x7 suggestions. ` +
    `<a href="${safeUrl}" style="color:${color};text-decoration:underline">Unsubscribe</a>.`;
  if (html.includes(UNSUBSCRIBE_SLOT)) return html.split(UNSUBSCRIBE_SLOT).join(line(NAVY_TEXT));
  const block =
    `<div style="max-width:600px;margin:0 auto;padding:0 20px 28px;text-align:center;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:12px;line-height:18px;color:#6b7280">${line('#4b5563').slice(4)}</div>`;
  return html.includes('</body>') ? html.replace('</body>', `${block}</body>`) : html + block;
}

/**
 * Points the logo <img> at an inline attachment instead of the website.
 * Gmail fetches remote images through its own proxy, and when that fetch fails
 * the header is left blank; an embedded image always renders. Returns the HTML
 * unchanged, with no attachment, when the mail carries no logo.
 */
export function withInlineLogo(html: string): { html: string; attachments: Array<Record<string, unknown>> } {
  const remote = `src="${esc(logoUrl())}"`;
  if (!html.includes(remote)) return { html, attachments: [] };
  return {
    html: html.split(remote).join(`src="cid:${LOGO_CID}"`),
    attachments: [
      {
        filename: 'pets24x7-logo.png',
        content: Buffer.from(LOGO_PNG_BASE64, 'base64'),
        contentType: 'image/png',
        cid: LOGO_CID,
        contentDisposition: 'inline',
      },
    ],
  };
}

/** Plain-text twin of withUnsubscribeFooter. */
export function withUnsubscribeText(text: string, url: string | null): string {
  return url ? `${text}\n\nDon't want these emails? Unsubscribe: ${url}\n` : text;
}

/**
 * Best-effort send. Never throws: a mail outage must not fail a signup, so the
 * caller gets `false` and the error is logged.
 */
/**
 * One row per attempt in email_log (admin > Emails > Sent log). Never throws
 * and never delays the send. A message carrying a sign-in code keeps its
 * subject redacted and its body out of the log.
 */
function logMail(input: MailInput, kind: MailKind, status: 'sent' | 'failed' | 'suppressed' | 'not_sent', extra: { error?: string; messageId?: string } = {}): void {
  prisma.emailLog
    .create({
      data: {
        to: input.to.slice(0, 320),
        subject: (input.sensitive ? '[sign-in code]' : input.subject).slice(0, 500),
        tag: input.tag ? input.tag.slice(0, 80) : null,
        kind,
        status,
        error: extra.error ? extra.error.slice(0, 2000) : null,
        messageId: extra.messageId ? extra.messageId.slice(0, 255) : null,
        html: input.sensitive ? null : input.html,
      },
    })
    .catch((err) => logger.warn({ err }, '[mail] could not write the email log'));
}

export async function sendMail(rawInput: MailInput): Promise<boolean> {
  const kind: MailKind = rawInput.kind ?? 'transactional';
  // Tag own-site links with UTM parameters before anything logs or sends it.
  const input = withTracking(rawInput);
  if (kind === 'marketing') {
    let suppressed = false;
    try {
      suppressed = await isOptedOut(input.to);
    } catch (err) {
      // A suppression-list outage must not silently start mailing opted-out
      // people, so fail closed.
      logger.error({ err, to: input.to }, '[mail] opt-out check failed — suppressing');
      logMail(input, kind, 'suppressed', { error: 'opt-out check failed' });
      return false;
    }
    if (suppressed) {
      logger.info({ to: input.to, subject: input.subject }, '[mail] suppressed — recipient opted out');
      logMail(input, kind, 'suppressed', { error: 'recipient opted out' });
      return false;
    }
  }

  // A developer running without SMTP still needs the verification link, so the
  // body is logged — except when it carries a credential. The OTP flow already
  // surfaces its code separately in development.
  const safeSubject = input.sensitive ? '[redacted — contains a sign-in code]' : input.subject;

  // Outside production, mail is logged rather than sent: dev databases carry
  // real-looking addresses that belong to other people, and jobs run on a timer.
  if (env.NODE_ENV !== 'production' && !env.MAIL_ALLOW_DEV_SEND && !input.force) {
    // The body is logged so a developer can still click a verification link
    // offline — except when it carries a credential.
    logger.info(
      { to: input.to, subject: safeSubject, ...(input.sensitive ? {} : { text: input.text }) },
      '[mail] not sent — NODE_ENV is not production (set MAIL_ALLOW_DEV_SEND=true to override)',
    );
    logMail(input, kind, 'not_sent', { error: 'not production (dev)' });
    return false;
  }

  const tx = transporter();
  if (!tx) {
    logger.warn(
      { to: input.to, subject: safeSubject, ...(input.sensitive ? {} : { text: input.text }) },
      '[mail] SMTP not configured — message not sent',
    );
    logMail(input, kind, 'not_sent', { error: 'SMTP not configured' });
    return false;
  }
  try {
    const { kind: _kind, sensitive: _sensitive, force: _force, tag: _tag, campaign: _campaign, ...message } = input;
    const unsub = kind === 'marketing' ? unsubscribeUrl(input.to) : null;
    message.html = withUnsubscribeFooter(message.html, unsub);
    message.text = withUnsubscribeText(message.text, unsub);
    const headers =
      kind === 'marketing'
        ? {
            'List-Unsubscribe': `<${unsubscribeUrl(input.to)}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          }
        : undefined;
    // The sent log keeps the remote-logo version: the admin console previews it
    // in a browser, where a cid: reference would not resolve.
    const logged = message.html;
    const inline = withInlineLogo(message.html);
    const info = await tx.sendMail({
      from: env.MAIL_FROM,
      ...message,
      html: inline.html,
      ...(inline.attachments.length ? { attachments: inline.attachments } : {}),
      ...(headers ? { headers } : {}),
    });
    logger.info({ to: input.to, subject: safeSubject, messageId: info.messageId }, '[mail] sent');
    logMail({ ...input, html: logged }, kind, 'sent', { messageId: info.messageId });
    return true;
  } catch (err) {
    logger.error({ err, to: input.to, subject: safeSubject }, '[mail] send failed');
    logMail(input, kind, 'failed', { error: (err as Error)?.message ?? String(err) });
    return false;
  }
}

/** Email log rows older than 90 days are deleted once a day. */
export function startEmailLogPrune(): void {
  const run = () =>
    prisma.emailLog
      .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } })
      .catch((err) => logger.warn({ err }, '[mail] email log prune failed'));
  setTimeout(run, 120_000).unref?.();
  setInterval(run, 24 * 3_600_000).unref?.();
}
