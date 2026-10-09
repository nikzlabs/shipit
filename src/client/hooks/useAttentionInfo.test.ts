import { describe, it, expect } from "vitest";
import { computeAttentionReason, rowAttentionInputs, runAttentionReason, type AttentionInputs } from "./useAttentionInfo.js";
import type { SessionListRow } from "../../server/shared/types.js";
import type { PrCardState } from "../stores/pr-store.js";
import type { PrStatusSummary } from "../../server/shared/types/github-types.js";

function inputs(overrides: Partial<AttentionInputs> = {}): AttentionInputs {
  return {
    card: undefined,
    status: undefined,
    isAgentRunning: false,
    awaitingPermission: false,
    hasBackgroundTasks: false,
    autoFixEnabled: false,
    autoResolveEnabled: false,
    resolved: false,
    muted: false,
    workspaceBlockKind: undefined,
    runReason: null,
    runAwaitingAnswer: false,
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

  describe("background tasks (docs/235)", () => {
    it("stays silent while background work is outstanding", () => {

      expect(computeAttentionReason(inputs({ hasBackgroundTasks: true }))).toBeNull();
    });

    it("reports 'Waiting for your input' once the tasks drain", () => {
      expect(computeAttentionReason(inputs({ hasBackgroundTasks: false }))).toBe(
        "Waiting for your input",
      );
    });

    it("does NOT mask a blocked permission prompt", () => {

      expect(
        computeAttentionReason(inputs({ hasBackgroundTasks: true, awaitingPermission: true })),
      ).toBe("Needs your approval to continue");
    });
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

    it("stays silent on an optimistically-merged card whose poller status is still open", () => {
      expect(
        computeAttentionReason(
          inputs({
            status: status({ prState: "open" }),
            card: card({
              phase: "merged",
              autoMerge: {
                enabled: true,
                mergeMethod: "squash",
                error: { code: "no_branch_protection", message: "x", settingsUrl: "y" },
              },
            }),
          }),
        ),
      ).toBeNull();
    });

    it.each(["merged", "closed"] as const)(
      "stays silent on a %s PR still carrying an auto-merge error",
      (prState) => {

        // anything to block must not keep the session flagged.
        expect(
          computeAttentionReason(
            inputs({
              status: status({ prState }),
              card: card({
                phase: "merged",
                autoMerge: {
                  enabled: true,
                  mergeMethod: "squash",
                  error: { code: "no_branch_protection", message: "x", settingsUrl: "y" },
                },
              }),
            }),
          ),
        ).toBeNull();
      },
    );

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

      expect(computeAttentionReason(inputs({ resolved: true, status: status({ prState: "open" }) }))).toBeNull();
    });

    it("stays silent for a resolved session carrying a stale CI failure", () => {

      expect(computeAttentionReason(inputs({ resolved: true, card: card({ checks: FAILURE }) }))).toBeNull();
    });

    it("still surfaces a blocked permission prompt — a live signal outranks resolved", () => {
      expect(computeAttentionReason(inputs({ resolved: true, awaitingPermission: true }))).toBe(
        "Needs your approval to continue",
      );
    });
  });

  describe("muted session (docs/277)", () => {
    it("silences the plain idle reason", () => {
      expect(computeAttentionReason(inputs({ muted: true }))).toBeNull();
    });

    it("silences a CI failure with auto-fix off", () => {

      expect(
        computeAttentionReason(inputs({ muted: true, card: card({ checks: FAILURE }) })),
      ).toBeNull();
    });

    it("silences a merge conflict", () => {
      expect(
        computeAttentionReason(inputs({ muted: true, status: status({ mergeable: "conflicting" }) })),
      ).toBeNull();
    });

    it("silences an auto-merge configuration blocker", () => {
      expect(
        computeAttentionReason(inputs({
          muted: true,
          card: card({
            autoMerge: {
              enabled: true,
              mergeMethod: "squash",
              error: { code: "no-permission", message: "Auto-merge is not enabled", settingsUrl: "https://example.test" },
            },
          }),
        })),
      ).toBeNull();
    });

    it("silences a blocked permission prompt too", () => {

      expect(computeAttentionReason(inputs({ muted: true, awaitingPermission: true }))).toBeNull();
    });

    it("restores the reason once the mute is gone", () => {
      expect(computeAttentionReason(inputs({ muted: false }))).toBe("Waiting for your input");
    });
  });

  describe("broken workspace (docs/298)", () => {
    it("names the block that is holding the workspace", () => {
      expect(computeAttentionReason(inputs({ workspaceBlockKind: "conflict" })))
        .toBe("Workspace has an unresolved merge or rebase");
      expect(computeAttentionReason(inputs({ workspaceBlockKind: "no-repository" })))
        .toBe("Workspace is no longer a git repository");
    });

    it("survives the running-agent and background-task short-circuits (req 4)", () => {
      expect(
        computeAttentionReason(inputs({ workspaceBlockKind: "conflict", isAgentRunning: true })),
      ).toBe("Workspace has an unresolved merge or rebase");
      expect(
        computeAttentionReason(inputs({ workspaceBlockKind: "conflict", hasBackgroundTasks: true })),
      ).toBe("Workspace has an unresolved merge or rebase");
    });

    it("survives a resolved PR — the incident session was merged weeks earlier", () => {
      expect(
        computeAttentionReason(inputs({ workspaceBlockKind: "conflict", resolved: true })),
      ).toBe("Workspace has an unresolved merge or rebase");
    });

    it("yields to a blocked permission prompt, which is the more immediate block", () => {
      expect(
        computeAttentionReason(inputs({ workspaceBlockKind: "conflict", awaitingPermission: true })),
      ).toBe("Needs your approval to continue");
    });

    it("stays silent while the session is muted (req 5)", () => {
      expect(
        computeAttentionReason(inputs({ workspaceBlockKind: "conflict", muted: true })),
      ).toBeNull();
    });

    it("outranks the ordinary CI-failure reason", () => {
      expect(
        computeAttentionReason(inputs({
          workspaceBlockKind: "unreadable",
          card: card({ checks: FAILURE }),
        })),
      ).toBe("Workspace has a file ShipIt can't read");
    });
  });

  describe("scheduled run (docs/324-scheduled-sessions reqs 21, 31)", () => {
    const PENDING = { state: "pending" as const, total: 1, passed: 0, failed: 0, pending: 1 };
    const question = "Waiting for your answer";

    it("reports a run's question before the PR's silences", () => {
      expect(computeAttentionReason(inputs({ runReason: question, status: status({ prState: "merged" }) }))).toBe(question);
      expect(computeAttentionReason(inputs({ runReason: question, card: card({ phase: "closed" }) }))).toBe(question);
      expect(computeAttentionReason(inputs({ runReason: question, card: card({ checks: PENDING }) }))).toBe(question);
      expect(computeAttentionReason(inputs({
        runReason: question,
        card: card({ autoMerge: { enabled: true, mergeMethod: "squash" } }),
      }))).toBe(question);
    });

    it("stays silent while the run works, and once it is finished", () => {
      expect(computeAttentionReason(inputs({ runReason: question, isAgentRunning: true }))).toBeNull();
      expect(computeAttentionReason(inputs({ runReason: question, resolved: true }))).toBeNull();
      expect(computeAttentionReason(inputs({ runReason: question, muted: true }))).toBeNull();
    });

    it("reports a run's question while background work goes on, which the scheduler does not count as going (req 23)", () => {
      const waiting = { runReason: question, runAwaitingAnswer: true, hasBackgroundTasks: true };
      expect(computeAttentionReason(inputs(waiting))).toBe(question);
      expect(computeAttentionReason(inputs({ ...waiting, resolved: true }))).toBeNull();
      expect(computeAttentionReason(inputs({ ...waiting, isAgentRunning: true }))).toBeNull();
      // Any other reason a run has still waits for the background work, as the scheduler does.
      expect(computeAttentionReason(inputs({ runReason: "Run stopped on an error", hasBackgroundTasks: true }))).toBeNull();
    });
  });
});

describe("runAttentionReason", () => {
  const row = (overrides: Partial<SessionListRow> = {}): SessionListRow => ({
    id: "run", title: "Sweep · Oct 7", createdAt: "", lastUsedAt: "", remoteUrl: "", scheduleId: "sched-1", ...overrides,
  });

  it("is null for a session that is not a run", () => {
    expect(runAttentionReason(row({ scheduleId: undefined, awaitingAnswer: true, lastTurnOutcome: "errored" }), true))
      .toBeNull();
  });

  it("names a question, an error, an exhausted quota and a manual step", () => {
    expect(runAttentionReason(row({ awaitingAnswer: true }), true)).toBe("Waiting for your answer");
    expect(runAttentionReason(row({ lastTurnOutcome: "errored" }), true)).toBe("Run stopped on an error");
    expect(runAttentionReason(row({ lastTurnOutcome: "quota-refused" }), true)).toBe("Run stopped: out of quota");
    expect(runAttentionReason(row({ manualStepCount: 1 }), true)).toBe("A manual step needs you");
    expect(runAttentionReason(row({ manualStepCount: 3 }), true)).toBe("3 manual steps need you");
    expect(runAttentionReason(row({ lastTurnOutcome: "ok" }), true)).toBeNull();
  });

  it("ignores manual steps while the status card is off, as the card itself does", () => {
    expect(runAttentionReason(row({ manualStepCount: 2 }), false)).toBeNull();
  });

  it("marks a run's question for the background-work rule, and only a run's", () => {
    expect(rowAttentionInputs(row({ awaitingAnswer: true }), false).runAwaitingAnswer).toBe(true);
    expect(rowAttentionInputs(row({ scheduleId: undefined, awaitingAnswer: true }), false).runAwaitingAnswer).toBe(false);
  });
});
