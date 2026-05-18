/**
 * AutoFixManager — auto-fix state machine extracted from PrStatusPoller.
 *
 * Owns the per-session auto-fix state map and the CI-state-transition logic
 * that decides when to (a) reset attempt counters on a new push, (b) mark
 * the loop as idle once CI turns green, and (c) trigger a fresh fix attempt
 * when CI fails.
 *
 * No knowledge of GitHub, no I/O — the poller injects a `fetchAndFixCb`
 * which actually fetches logs and prompts the agent. This module just runs
 * the bookkeeping.
 */

import type { AutoFixState, PrStatusSummary } from "../shared/types/github-types.js";
import { extractFailedCheckRuns, extractHeadSha, type GraphQLPrNode } from "./pr-status-parser.js";

export const MAX_AUTO_FIX_ATTEMPTS = 3;

/** Callback that performs the actual fix — fetching CI logs and prompting the agent. */
export type FetchAndFixCb = (
  sessionId: string,
  owner: string,
  repo: string,
  failedChecks: { databaseId: number; name: string; conclusion: string; title: string }[],
) => Promise<void>;

export class AutoFixManager {
  /** sessionId → auto-fix state */
  private states = new Map<string, AutoFixState>();

  constructor(
    private readonly onChange: (sessionId: string) => void,
    private fetchAndFixCb?: FetchAndFixCb,
  ) {}

  /** Update the fetch-and-fix callback (allows late binding from the poller constructor). */
  setFetchAndFixCb(cb: FetchAndFixCb | undefined): void {
    this.fetchAndFixCb = cb;
  }

  /** Get auto-fix state for a session. */
  get(sessionId: string): AutoFixState | undefined {
    return this.states.get(sessionId);
  }

  /** Drop state for a session (untrack). */
  delete(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /** Set auto-fix enabled/disabled for a session. Returns the updated state. */
  setEnabled(sessionId: string, enabled: boolean): AutoFixState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { enabled, attemptCount: 0, lastHeadSha: "", status: "idle" };
      this.states.set(sessionId, state);
    } else {
      state.enabled = enabled;
      if (!enabled && state.status === "running") {
        state.status = "idle";
      }
    }

    this.onChange(sessionId);
    return state;
  }

  /** Increment attempt count for auto-fix and set status to running. */
  markRunning(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    state.attemptCount++;
    state.status = "running";

    this.onChange(sessionId);
  }

  /** Handle auto-fix state transitions when CI status changes. */
  handleTransition(
    sessionId: string,
    current: PrStatusSummary,
    prNode: GraphQLPrNode,
    owner: string,
    repo: string,
  ): void {
    const state = this.states.get(sessionId);
    if (!state?.enabled) return;

    const headSha = extractHeadSha(prNode);

    // Reset attempt counter when head SHA changes (new code pushed)
    if (headSha && state.lastHeadSha && headSha !== state.lastHeadSha) {
      state.attemptCount = 0;
      state.status = "idle";
    }
    if (headSha) {
      state.lastHeadSha = headSha;
    }

    // CI now success — auto-fix loop is done
    if (current.checks.state === "success" && state.status === "running") {
      state.status = "idle";
      return;
    }

    // CI now failure — trigger auto-fix if not exhausted
    if (
      current.checks.state === "failure" &&
      state.status !== "running" &&
      state.status !== "exhausted" &&
      state.attemptCount < MAX_AUTO_FIX_ATTEMPTS
    ) {
      const failedChecks = extractFailedCheckRuns(prNode);
      if (failedChecks.length > 0 && this.fetchAndFixCb) {
        // Trigger the fix asynchronously
        this.fetchAndFixCb(sessionId, owner, repo, failedChecks).catch((err: unknown) => {
          console.error(`[pr-poller] Auto-fix error for ${sessionId}:`, err);
        });
      }
    }

    // Check exhaustion
    if (state.attemptCount >= MAX_AUTO_FIX_ATTEMPTS) {
      state.status = "exhausted";
    }
  }
}
