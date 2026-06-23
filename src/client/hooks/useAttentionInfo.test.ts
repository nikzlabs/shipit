import { describe, it, expect } from "vitest";
import { computeAttentionReason, type AttentionInputs } from "./useAttentionInfo.js";
import type { PrCardState } from "../stores/pr-store.js";
import type { PrStatusSummary } from "../../server/shared/types/github-types.js";

/** Build inputs with sane defaults; override per case. */
function inputs(overrides: Partial<AttentionInputs> = {}): AttentionInputs {
  return {
    card: undefined,
    status: undefined,
    isAgentRunning: false,
    awaitingPermission: false,
    autoFixEnabled: false,
    autoResolveEnabled: false,
    resolved: false,
    ...overrides,
  };
}

function card(overrides: Partial<PrCardState> = {}): PrCardState {
  return { cardId: "c1", phase: "open", ...overrides } as PrCardState;
}

function status(overrides: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return { prState: "open", mergeable: "mergeable", ...overrides } as PrStatusSummary;
}

const FAILURE = { state: "failure" as const, total: 3, passed: 1, failed: 2, pending: 0 };

describe("computeAttentionReason", () => {
  it("returns null while the agent is running, masking everything else", () => {
    expect(
      computeAttentionReason(inputs({ isAgentRunning: true, card: card({ checks: FAILURE }) })),
    ).toBeNull();
  });

  describe("awaiting permission (Thread C)", () => {
    it("surfaces a blocked permission prompt as the highest-priority reason", () => {
      expect(computeAttentionReason(inputs({ awaitingPermission: true }))).toBe(
        "Needs your approval to continue",
      );
    });

    it("outranks the agent-running short-circuit (the agent is held inside the gated call)", () => {
      expect(
        computeAttentionReason(
          inputs({ awaitingPermission: true, isAgentRunning: true, card: card({ checks: FAILURE }) }),
        ),
      ).toBe("Needs your approval to continue");
    });
  });

  describe("CI failure", () => {
    it("notifies when auto-fix is off", () => {
      expect(computeAttentionReason(inputs({ card: card({ checks: FAILURE }) }))).toBe(
        "CI checks failed",
      );
    });

    it("stays silent when auto-fix is enabled and a retry is still coming (idle/deferred)", () => {
      for (const s of ["idle", "deferred"] as const) {
        expect(
          computeAttentionReason(
            inputs({
              autoFixEnabled: true,
              card: card({ checks: FAILURE, autoFix: { status: s, attemptCount: 1, maxAttempts: 3 } }),
            }),
          ),
        ).toBeNull();
      }
    });

    it("stays silent while a fix is actively running, even if the setting reads off", () => {
      expect(
        computeAttentionReason(
          inputs({
            card: card({ checks: FAILURE, autoFix: { status: "running", attemptCount: 1, maxAttempts: 3 } }),
          }),
        ),
      ).toBeNull();
    });

    it("notifies when the fix loop is exhausted — now the user must act", () => {
      expect(
        computeAttentionReason(
          inputs({
            autoFixEnabled: true,
            card: card({ checks: FAILURE, autoFix: { status: "exhausted", attemptCount: 3, maxAttempts: 3 } }),
          }),
        ),
      ).toBe("CI fix failed after 3 attempts");
    });
  });

  describe("merge conflict", () => {
    const conflicting = status({ mergeable: "conflicting" });

    it("notifies when auto-resolve is off", () => {
      expect(computeAttentionReason(inputs({ status: conflicting, card: card() }))).toBe(
        "PR has merge conflicts",
      );
    });

    it("stays silent when auto-resolve is enabled and a retry is still coming", () => {
      for (const s of ["idle", "deferred", "running"] as const) {
        expect(
          computeAttentionReason(
            inputs({
              autoResolveEnabled: true,
              status: conflicting,
              card: card({ autoResolve: { status: s, attemptCount: 1, maxAttempts: 3 } }),
            }),
          ),
        ).toBeNull();
      }
    });

    it("notifies when the resolve loop is exhausted", () => {
      expect(
        computeAttentionReason(
          inputs({
            autoResolveEnabled: true,
            status: conflicting,
            card: card({ autoResolve: { status: "exhausted", attemptCount: 3, maxAttempts: 3 } }),
          }),
        ),
      ).toBe("Conflict resolution failed after 3 attempts");
    });

    it("still notifies on conflict when auto-merge is on but auto-resolve is off", () => {
      expect(
        computeAttentionReason(
          inputs({
            status: conflicting,
            card: card({ autoMerge: { enabled: true, mergeMethod: "squash" } }),
          }),
        ),
      ).toBe("PR has merge conflicts");
    });
  });

  describe("auto-merge", () => {
    it("notifies on a config blocker auto-merge cannot pass", () => {
      expect(
        computeAttentionReason(
          inputs({
            card: card({
              autoMerge: {
                enabled: true,
                mergeMethod: "squash",
                error: { code: "no_branch_protection", message: "x", settingsUrl: "y" },
              },
            }),
          }),
        ),
      ).toBe("Auto-merge needs repo configuration");
    });

    it("stays silent on an idle clean open PR when auto-merge owns the merge", () => {
      expect(
        computeAttentionReason(
          inputs({
            status: status({ checks: undefined }),
            card: card({ autoMerge: { enabled: true, mergeMethod: "squash" } }),
          }),
        ),
      ).toBeNull();
    });
  });

  describe("default idle", () => {
    it("notifies 'Waiting for your input' when nothing is automated", () => {
      expect(computeAttentionReason(inputs({ status: status() }))).toBe("Waiting for your input");
    });

    it("stays silent while checks are pending", () => {
      expect(
        computeAttentionReason(inputs({ card: card({ checks: { state: "pending", total: 1, passed: 0, failed: 0, pending: 1 } }) })),
      ).toBeNull();
    });

    it("stays silent once the PR is merged or closed", () => {
      expect(computeAttentionReason(inputs({ status: status({ prState: "merged" }) }))).toBeNull();
      expect(computeAttentionReason(inputs({ status: status({ prState: "closed" }) }))).toBeNull();
    });
  });

  describe("resolved session (matches the sidebar 'Recently resolved' grouping)", () => {
    it("stays silent for a resolved session even when its pr-store status still reads open", () => {
      // The grouping demotes on SessionInfo.mergedAt/closedAt; the pr-store
      // status lags and can still say "open" → would otherwise be "Waiting for
      // your input" on a row already in "Recently resolved".
      expect(computeAttentionReason(inputs({ resolved: true, status: status({ prState: "open" }) }))).toBeNull();
    });

    it("stays silent for a resolved session carrying a stale CI failure", () => {
      // A merged PR can still carry a `failure` checks state; without the
      // resolved short-circuit this read as "CI checks failed".
      expect(computeAttentionReason(inputs({ resolved: true, card: card({ checks: FAILURE }) }))).toBeNull();
    });

    it("still surfaces a blocked permission prompt — a live signal outranks resolved", () => {
      expect(computeAttentionReason(inputs({ resolved: true, awaitingPermission: true }))).toBe(
        "Needs your approval to continue",
      );
    });
  });
});
