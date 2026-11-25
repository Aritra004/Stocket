import { getEntitlementStatus } from "./payments-client";

/** Explicit local test bypass; production always requires server verification. */
export function isArchiveExportEnabled(): boolean {
  return (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") && process.env.NEXT_PUBLIC_EXPORT_TEST_BYPASS === "true";
}

export const ARCHIVE_EXPORT_DISABLED = "A verified one-time license is required. Open Unlock archive to pay or recover your license.";

/** Called immediately before export in both the browser client and worker.
 * No localStorage value, checkout callback, or client-provided license ID grants access.
 */
export async function assertArchiveExportEnabled(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (isArchiveExportEnabled()) return;
  const entitlement = await getEntitlementStatus(signal);
  if (entitlement.status !== "active") throw new Error(entitlement.status === "pending"
    ? "Payment confirmation is still pending. Check payment status on Unlock archive; export will become available after capture is verified."
    : entitlement.status === "revoked" ? "This license is no longer active. Open Unlock archive for its current status or recover another license." : ARCHIVE_EXPORT_DISABLED);
}
