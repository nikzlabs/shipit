/**
 * Configured-tracker registry (docs/170).
 *
 * Holds the set of trackers ShipIt knows about and drives the Issues tab's
 * sub-tabs. v1 always registers Linear (the only supported tracker); each
 * tracker reports `isConfigured()` so the client can render either the list or
 * a "Connect" empty state. A GitHub adapter (deferred per SHI-67 scope) would
 * register here too.
 *
 * The registry is rebuilt per request from `CredentialStore` rather than cached
 * as a singleton: a Linear token/team binding can change at runtime (the user
 * connects/disconnects in settings), and an adapter instance captures the
 * binding at construction.
 */

import type { CredentialStore } from "../credential-store.js";
import type { TrackerId, TrackerInfo } from "../../shared/types.js";
import type { Tracker } from "./tracker.js";
import { LinearTracker, type FetchImpl } from "./linear/adapter.js";

export class TrackerRegistry {
  private readonly trackers: Tracker[];

  constructor(trackers: Tracker[]) {
    this.trackers = trackers;
  }

  /** Metadata for every known tracker — drives the sub-tab switcher. */
  list(): TrackerInfo[] {
    return this.trackers.map((t) => t.info());
  }

  get(id: TrackerId): Tracker | undefined {
    return this.trackers.find((t) => t.id === id);
  }
}

/**
 * Build the registry from persisted credentials. `fetchImpl` is injectable so
 * integration tests can stub Linear's GraphQL endpoint.
 */
export function buildTrackerRegistry(
  credentialStore: CredentialStore,
  fetchImpl?: FetchImpl,
): TrackerRegistry {
  const linear = new LinearTracker({
    token: credentialStore.getLinearToken(),
    team: credentialStore.getLinearTeam(),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  // GitHub Issues adapter is deferred (docs/170 scope) — register it here when built.
  return new TrackerRegistry([linear]);
}
