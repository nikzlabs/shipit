import type {
  LimitsRefreshResult,
  SubscriptionLimits,
  SubscriptionLimitsMap,
} from "../shared/types.js";
import type { LimitsProvider } from "./agents/types.js";

export interface LimitsRegistryOptions {
  /** Keyed by `${serviceId}:${billingMode}`, not CLI identity. */
  providers: Map<string, LimitsProvider>;
  sseBroadcast: (event: string, data: unknown) => void;
}

export class LimitsRegistry {
  private providers: Map<string, LimitsProvider>;
  private sseBroadcast: (event: string, data: unknown) => void;
  private cache = new Map<string, Map<string, SubscriptionLimits>>();

  constructor(opts: LimitsRegistryOptions) {
    this.providers = opts.providers;
    this.sseBroadcast = opts.sseBroadcast;
  }

  getSnapshot(): SubscriptionLimitsMap {
    const out: SubscriptionLimitsMap = {};
    for (const [modeKey, byRoute] of this.cache) {
      if (byRoute.size === 0) continue;
      out[modeKey] = Object.fromEntries(byRoute);
    }
    return out;
  }

  markAuthRefreshed(modeKey: string): void {
    void this.refreshOne(modeKey).catch((err: unknown) => {
      console.error(`[limits] refresh for ${modeKey} failed:`, err);
    });
  }

  async refreshNow(
    modeKey: string,
    reason: "manual" | "seed",
    routeId?: string,
  ): Promise<LimitsRefreshResult[]> {
    const provider = this.providers.get(modeKey);
    if (!provider?.refreshNow) {
      return routeId ? [{ routeId, outcome: "unavailable" }] : [];
    }
    // Manual refresh must specify a route to avoid spending other accounts' request budgets.
    const routes = routeId ? [routeId] : provider.routeIds();
    const results: LimitsRefreshResult[] = [];
    for (const route of routes) {
      try {
        results.push(await provider.refreshNow(reason, route));
      } catch (err) {
        console.error(`[limits] on-demand refresh for ${modeKey}/${route} failed:`, err);
        results.push({ routeId: route, outcome: "failed", detail: errMsg(err) });
      }
    }
    await this.refreshOne(modeKey);
    return results;
  }

  markSignedOut(modeKey: string, routeId?: string): void {
    if (routeId === undefined) {
      const had = this.cache.delete(modeKey);
      if (had) this.broadcast();
      return;
    }
    this.providers.get(modeKey)?.forgetRoute(routeId);
    const byRoute = this.cache.get(modeKey);
    if (byRoute?.delete(routeId)) {
      if (byRoute.size === 0) this.cache.delete(modeKey);
      this.broadcast();
    }
  }

  private async refreshOne(modeKey: string): Promise<void> {
    const provider = this.providers.get(modeKey);
    if (!provider) return;
    let changed = false;
    const live = new Set(provider.routeIds());
    for (const routeId of live) {
      const snapshot = await provider.fetch(routeId);
      if (this.applySnapshot(modeKey, routeId, snapshot)) changed = true;
    }
    const byRoute = this.cache.get(modeKey);
    if (byRoute) {
      for (const routeId of [...byRoute.keys()]) {
        if (!live.has(routeId)) {
          byRoute.delete(routeId);
          changed = true;
        }
      }
      if (byRoute.size === 0) this.cache.delete(modeKey);
    }
    if (changed) this.broadcast();
  }

  private applySnapshot(
    modeKey: string,
    routeId: string,
    snapshot: SubscriptionLimits | null,
  ): boolean {
    const byRoute = this.cache.get(modeKey);
    if (snapshot === null) {
      if (!byRoute?.delete(routeId)) return false;
      if (byRoute.size === 0) this.cache.delete(modeKey);
      return true;
    }
    const prev = byRoute?.get(routeId);
    const isChange =
      prev?.plan !== snapshot.plan ||
      prev.lockedUntil !== snapshot.lockedUntil ||
      !windowEqual(prev.session, snapshot.session) ||
      !windowEqual(prev.weekly, snapshot.weekly);
    if (byRoute) byRoute.set(routeId, snapshot);
    else this.cache.set(modeKey, new Map([[routeId, snapshot]]));
    return isChange;
  }

  private broadcast(): void {
    this.sseBroadcast("subscription_limits", { limits: this.getSnapshot() });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function windowEqual(
  a: SubscriptionLimits["session"],
  b: SubscriptionLimits["session"],
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.usedPct === b.usedPct && a.resetAt === b.resetAt;
}
