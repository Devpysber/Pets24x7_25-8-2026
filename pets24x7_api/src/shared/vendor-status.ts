/**
 * Which vendor account states count as "approved enough to spend money".
 *
 * A listing claimed through the claim flow lands as CLAIMED and a business that
 * registered itself lands as ACTIVE. Only ACTIVE was being accepted, so a
 * perfectly legitimate claimed vendor was told their account "must be approved"
 * and could not buy a campaign, a featured slot, or send review requests.
 */
export const APPROVED_VENDOR_STATUSES = ['ACTIVE', 'CLAIMED'] as const;

export function isVendorApproved(status: string | null | undefined): boolean {
  return !!status && (APPROVED_VENDOR_STATUSES as readonly string[]).includes(status);
}
