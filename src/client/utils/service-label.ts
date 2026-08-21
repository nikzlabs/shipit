/**
 * docs/252 req 16 — how a `(service, billing mode)` group names itself.
 *
 * Read from the catalogue rather than from a hand-kept table, so a group's name
 * follows the same source the picker and Settings use. A group whose service the
 * catalogue no longer carries falls back to the raw id: a retired service's
 * history stays valuable, and an id is a worse label but never a wrong one.
 */

import { getService } from "../../server/shared/catalogue/index.js";
import type { BillingMode } from "../../server/shared/catalogue/types.js";

export function serviceLabel(serviceId: string): string {
  return getService(serviceId)?.name ?? serviceId;
}

/** The pill beside the service name. Deliberately the words the picker uses. */
export function billingModeLabel(mode: BillingMode): string {
  return mode === "sub" ? "Subscription" : "API key";
}
