/**
 * useCiDisplay — the single derivation of "what should the CI surfaces show?"
 *
 * Every CI surface (inline card indicator, PR detail panel, sidebar dot, merge
 * button gating) reads through this so they can't disagree about whether a PR
 * is still waiting on CI.
 *
 * The interesting case is `state: "pending"` with `total: 0`. That is not a
 * real GitHub reading — it's the poller's grace override for "the repo runs CI
 * but no check has registered for this head yet" (`CiGraceTracker`). The
 * override carries a deadline (`checks.graceUntil`); past it, an empty check
 * set is **terminal**, not transitional, and must render as such.
 *
 * Expiring it here rather than waiting for the server to re-broadcast is what
 * makes the spinner bounded. Grace expiry is only *observed* on a poll, and
 * polling pauses when the last viewer detaches (`PollingGlobalGate`) — so a
 * summary persisted just before the gate closed is rehydrated on the next page
 * load as a pending state the server won't revisit until a poll happens to
 * run. That is the "CI indicator spins forever" report (nikzlabs/shipit#1730).
 *
 * `deriveCiDisplay` is pure (testable, usable outside React); `useCiDisplay`
 * wraps it with a timer that re-renders exactly once at the deadline so a card
 * left open across the transition flips without user interaction.
 */

import { useEffect, useState } from "react";
import type { PrCardState } from "../stores/pr-store.js";

type Checks = PrCardState["checks"];

export type CiDisplay =
  /** The poller hasn't reported yet — we don't know whether CI exists. */
  | { kind: "unknown" }
  /** Settled: this PR has no check runs and none are coming. Terminal. */
  | { kind: "none" }
  | { kind: "pending"; passed: number; total: number }
  | { kind: "success"; total: number }
  | { kind: "failure"; passed: number; failed: number; total: number };

/**
 * Map a raw checks summary to what the UI should show at instant `now`.
 *
 * `undefined` checks stay `"unknown"` rather than collapsing to `"none"`:
 * callers gate the merge button on `"none"`, and treating "haven't heard from
 * the poller" as "no CI applies" would flash the button in the gap between PR
 * creation and the first poll.
 */
export function deriveCiDisplay(checks: Checks, now: number = Date.now()): CiDisplay {
  if (!checks) return { kind: "unknown" };

  switch (checks.state) {
    case "success":
      return { kind: "success", total: checks.total };
    case "failure":
      return {
        kind: "failure",
        passed: checks.passed,
        failed: checks.failed,
        total: checks.total,
      };
    case "none":
      return { kind: "none" };
    case "pending": {
      // A forced-pending override whose window has closed is really "none".
      // Only `total === 0` qualifies — once GitHub reports actual checks the
      // pending state is genuine and has no deadline attached.
      if (
        checks.total === 0
        && checks.graceUntil !== undefined
        && now >= checks.graceUntil
      ) {
        return { kind: "none" };
      }
      return { kind: "pending", passed: checks.passed, total: checks.total };
    }
  }
}

/**
 * React binding for {@link deriveCiDisplay}. Schedules a single re-render at
 * the grace deadline so an open card retires its spinner on time instead of
 * waiting for the next unrelated store update.
 */
export function useCiDisplay(checks: Checks): CiDisplay {
  const [, forceRender] = useState(0);
  const graceUntil = checks?.state === "pending" && checks.total === 0
    ? checks.graceUntil
    : undefined;

  useEffect(() => {
    if (graceUntil === undefined) return;
    const delay = graceUntil - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => { forceRender((n) => n + 1); }, delay + 100);
    return () => { clearTimeout(timer); };
  }, [graceUntil]);

  return deriveCiDisplay(checks);
}
