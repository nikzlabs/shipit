/**
 * AutoMergeManager — auto-merge state machine extracted from PrStatusPoller.
 *
 * Owns the per-session auto-merge state map and the "ShipIt-managed" merge
 * loop that runs when GitHub native auto-merge isn't available (no branch
 * protection rules configured). The poller drives `handleManaged()` on
 * every observed PR update; this module decides whether to call the merge
 * REST API and updates state in place.
 */

import type { GitHubAuthManager } from "./github-auth.js";
import type { AutoMergeState, PrAutoMergeError, PrStatusSummary } from "../shared/types/github-types.js";

export class AutoMergeManager {
  /** sessionId → auto-merge state */
  private states = new Map<string, AutoMergeState>();

  constructor(
    private readonly githubAuth: GitHubAuthManager,
    private readonly onChange: (sessionId: string) => void,
  ) {}

  /** Get auto-merge state for a session. */
  get(sessionId: string): AutoMergeState | undefined {
    return this.states.get(sessionId);
  }

  /** Drop state for a session (untrack). */
  delete(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /** Set auto-merge enabled/disabled for a session. */
  setEnabled(sessionId: string, enabled: boolean): AutoMergeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { enabled, mergeMethod: "squash" };
      this.states.set(sessionId, state);
    } else {
      state.enabled = enabled;
      if (enabled) {
        // Clear any previous error when re-enabling
        delete state.error;
      } else {
        // Clear managed flag when disabling
        state.managed = false;
        delete state.settingsUrl;
      }
    }

    this.onChange(sessionId);
    return state;
  }

  /** Mark auto-merge as ShipIt-managed (GitHub native unavailable). */
  setManaged(sessionId: string, managed: boolean, settingsUrl?: string): void {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { enabled: false, mergeMethod: "squash", managed, settingsUrl };
      this.states.set(sessionId, state);
    } else {
      state.managed = managed;
      state.settingsUrl = settingsUrl;
    }

    this.onChange(sessionId);
  }

  /** Set an auto-merge error (toggle reverts to OFF). */
  setError(sessionId: string, error: PrAutoMergeError): void {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { enabled: false, mergeMethod: "squash", error };
      this.states.set(sessionId, state);
    } else {
      state.error = error;
    }

    this.onChange(sessionId);
  }

  /** Set the preferred merge method for a session. */
  setMergeMethod(sessionId: string, method: "squash" | "merge" | "rebase"): void {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { enabled: false, mergeMethod: method };
      this.states.set(sessionId, state);
    } else {
      state.mergeMethod = method;
    }

    this.onChange(sessionId);
  }

  /** Handle ShipIt-managed auto-merge: merge via REST when CI passes. */
  async handleManaged(
    sessionId: string,
    summary: PrStatusSummary,
    owner: string,
    repo: string,
  ): Promise<void> {
    const mergeState = this.states.get(sessionId);
    if (!mergeState?.enabled || !mergeState.managed) return;

    // Merge when CI passes, or when there are no required checks at all.
    // Mirrors the client's `isCiPassed || isCiNone` mergeability rule
    // (docs/113) so a docs-only PR with path-filtered CI ("none") isn't left
    // stuck: native auto-merge falls back to managed, the manual button hides,
    // and this executor must finish the merge. `pending`/`failure` stay excluded.
    if (summary.checks.state !== "success" && summary.checks.state !== "none") return;

    if (summary.mergeable === "conflicting") {
      mergeState.error = {
        code: "no_branch_protection",
        message: "PR has merge conflicts",
        settingsUrl: summary.prUrl,
      };
      this.onChange(sessionId);
      return;
    }

    // "unknown" — GitHub hasn't computed mergeability yet. Wait for the next
    // poller tick rather than racing into a merge attempt that would fail.
    if (summary.mergeable !== "mergeable") return;

    // Attempt the merge via REST API
    const result = await this.githubAuth.mergePullRequest(
      owner, repo, summary.prNumber, mergeState.mergeMethod,
    );

    if (result.success) {
      // Merge succeeded — disable, poller will detect merged state next cycle
      mergeState.enabled = false;
      mergeState.managed = false;
      delete mergeState.error;
      this.onChange(sessionId);
    } else {
      // Merge failed — surface error, stays enabled for retry next poll
      mergeState.error = {
        code: "no_branch_protection",
        message: result.message,
        settingsUrl: summary.prUrl,
      };
      this.onChange(sessionId);
    }
  }
}
