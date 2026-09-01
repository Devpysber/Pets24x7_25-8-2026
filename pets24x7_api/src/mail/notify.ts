// Fire-and-forget wrapper around sendMail.
//
// Action mails are a side effect of a request, never part of it: the HTTP
// response must not wait on SMTP, and a mail failure must not surface as an
// error. Callers that have no address to send to pass `null`.

import type { MailInput } from './mailer.js';
import { sendMail } from './mailer.js';

export function notify(input: MailInput | null | undefined): void {
  if (!input) return;
  void sendMail(input).catch(() => {});
}

/** Builds a mail only when an address exists; keeps call sites free of `if`. */
export function notifyIf(
  to: string | null | undefined,
  build: (to: string) => MailInput,
): void {
  if (!to) return;
  notify(build(to));
}
