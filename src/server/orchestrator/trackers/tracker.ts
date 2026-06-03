/**
 * Tracker abstraction (docs/170 — inline tracker Issues tab).
 *
 * Modeled on the `agents/` registry: adding a tracker later is "write an
 * adapter + register it," and the Issues tab's sub-tabs are generated from the
 * configured-tracker registry. v1 registers Linear only; the interface is
 * shaped so a GitHub Issues adapter (deferred per the SHI-67 scope) can slot in
 * without touching the route, the registry contract, or the client.
 *
 * Trackers are repo/workspace-scoped, not session-scoped: a Linear workspace is
 * deployment-wide, so the binding lives in `CredentialStore`, not on a session.
 */

import type {
  TrackerId,
  TrackerInfo,
  TrackerIssue,
} from "../../shared/types.js";

export interface Tracker {
  /** Stable id, e.g. "linear". Drives the `?tracker=` query and the sub-tab. */
  readonly id: TrackerId;
  /** Human label for the sub-tab, e.g. "Linear". */
  readonly label: string;

  /**
   * Whether this tracker is ready to list issues — both auth (a token) and the
   * repo→tracker binding (a Linear team) are present. When false the Issues tab
   * renders a "Connect <tracker>" empty state instead of erroring.
   */
  isConfigured(): boolean;

  /** Metadata for the sub-tab switcher + configured/empty-state rendering. */
  info(): TrackerInfo;

  /**
   * List issues for the bound scope, sorted by priority (urgent first). Throws
   * if the tracker isn't configured — callers should check `isConfigured()`
   * first and surface the empty state.
   */
  listIssues(): Promise<TrackerIssue[]>;

  /** Fetch a single issue by tracker-internal id, or null if not found. */
  getIssue(id: string): Promise<TrackerIssue | null>;
}
