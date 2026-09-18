import type { CodexAuthManager } from "./auth-manager.js";
import type { LimitsProvider } from "../types.js";
import type { SubscriptionLimits, SubscriptionLimitsWindow } from "../../../shared/types.js";

export interface CodexLimitsDeps {
  codexAuthManager: Pick<CodexAuthManager, "getAccessToken">;
  now?: () => number;
}

export class CodexLimitsProvider implements LimitsProvider {
  readonly serviceId = "openai";
  readonly billingMode = "sub" as const;
  private codexAuthManager: Pick<CodexAuthManager, "getAccessToken">;
  private now: () => number;
  private latest = new Map<string, {
    session: SubscriptionLimitsWindow | null;
    weekly: SubscriptionLimitsWindow | null;
    at: number;
  }>();

  constructor(deps: CodexLimitsDeps) {
    this.codexAuthManager = deps.codexAuthManager;
    this.now = deps.now ?? (() => Date.now());
  }

  setRateLimits(
    session: SubscriptionLimitsWindow | null,
    weekly: SubscriptionLimitsWindow | null,
    routeId: string,
  ): void {
    const now = this.now();
    const previous = this.latest.get(routeId) ?? null;
    this.latest.set(routeId, {
      session: preserveWindowAnchor(previous?.session ?? null, session, now),
      weekly: preserveWindowAnchor(previous?.weekly ?? null, weekly, now),
      at: now,
    });
  }

  routeIds(): string[] {
    return [...this.latest.keys()];
  }

  forgetRoute(routeId: string): void {
    this.latest.delete(routeId);
  }

  async fetch(routeId: string): Promise<SubscriptionLimits | null> {
    const latest = this.latest.get(routeId);
    if (!latest) return null;
    let plan: string | null = null;
    const tokenResult = await this.codexAuthManager.getAccessToken();
    if (tokenResult.token !== null) {
      plan = tokenResult.plan;
    }
    return {
      serviceId: this.serviceId,
      billingMode: this.billingMode,
      routeId,
      plan,
      session: latest.session,
      weekly: latest.weekly,
      // Codex sends both windows together; an absent window is unavailable, not pending.
      availableWindows: [
        ...(latest.session ? (["session"] as const) : []),
        ...(latest.weekly ? (["weekly"] as const) : []),
      ],
      fetchedAt: latest.at,
    };
  }
}

/** Keep Codex's rolling reset updates from moving the time marker back to zero. */
function preserveWindowAnchor(
  previous: SubscriptionLimitsWindow | null,
  incoming: SubscriptionLimitsWindow | null,
  now: number,
): SubscriptionLimitsWindow | null {
  if (!incoming || !previous?.startedAt) return incoming;
  const previousReset = Date.parse(previous.resetAt);
  if (!Number.isFinite(previousReset) || previousReset <= now) return incoming;
  return { ...incoming, startedAt: previous.startedAt };
}
