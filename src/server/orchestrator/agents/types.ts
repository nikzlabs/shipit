import type {
  LimitsRefreshResult,
  SubscriptionLimits,
  SubscriptionLimitsWindow,
} from "../../shared/types.js";
import type { BillingMode } from "../../shared/catalogue/types.js";

export interface LimitsProvider {
  readonly serviceId: string;
  readonly billingMode: BillingMode;

  routeIds(): string[];

  /** Return the cached snapshot or null; must not throw. */
  fetch(routeId: string): Promise<SubscriptionLimits | null>;

  setRateLimits(
    session: SubscriptionLimitsWindow | null,
    weekly: SubscriptionLimitsWindow | null,
    routeId: string,
  ): void;

  forgetRoute(routeId: string): void;

  /** Seed skips existing API snapshots; manual refresh still respects per-route 429 lockouts. */
  refreshNow?(reason: "manual" | "seed", routeId: string): Promise<LimitsRefreshResult>;
}
