import { describe, it, expect, vi } from "vitest";
import { DISPATCH_SETUP_FAILURE, type SessionRunnerInterface } from "../session-runner.js";
import type { PreparedDispatch } from "../prepared-dispatch.js";
import type { DispatchAdmission } from "../session-runner.js";
import type { TurnOutcome } from "../turn-settlement.js";
import { ServiceError } from "./types.js";
import {
  armFollowupNote,
  buildFollowupPrompt,
  closeFollowupWindow,
  deliverRebaseFollowup,
  followupWindowOpen,
  openFollowupWindow,
  type RebaseFollowup,
} from "./rebase-followup.js";

let nextSession = 0;
const sessionId = (): string => `followup-session-${++nextSession}`;

describe("rebase-followup: the arm window", () => {
  it("appends notes across conflict rounds rather than replacing them", () => {
    const id = sessionId();
    const attempt = openFollowupWindow(id);

    armFollowupNote(id, "re-run codegen");
    const second = armFollowupNote(id, "update the PR body");

    expect(second.notes).toBe(2);
    expect(closeFollowupWindow(id, attempt)).toEqual(["re-run codegen", "update the PR body"]);
  });

  it("drops an identical repeat, so the prompt does not carry the same instruction twice", () => {
    const id = sessionId();
    const attempt = openFollowupWindow(id);

    armFollowupNote(id, "re-run codegen");
    armFollowupNote(id, "  re-run codegen  ");

    expect(closeFollowupWindow(id, attempt)).toEqual(["re-run codegen"]);
  });

  it("refuses an arm with no rebase in progress: ShipIt carries a note only across its own rebase", () => {
    const id = sessionId();

    let thrown: unknown;
    try {
      armFollowupNote(id, "re-run codegen");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).statusCode).toBe(409);
  });

  it("refuses an empty note: without one the follow-up turn would carry nothing", () => {
    const id = sessionId();
    openFollowupWindow(id);

    for (const empty of ["", "   ", undefined]) {
      let thrown: unknown;
      try {
        armFollowupNote(id, empty);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ServiceError);
      expect((thrown as ServiceError).statusCode).toBe(400);
    }
  });

  it("a stale close leaves a newer attempt's window intact", () => {
    // The auto-resolve deadline does not cancel the flow it raced, so a timed-out flow can
    // settle long after the next attempt opened its own window.
    const id = sessionId();
    const stale = openFollowupWindow(id);
    const current = openFollowupWindow(id);
    armFollowupNote(id, "the new attempt's note");

    expect(closeFollowupWindow(id, stale)).toEqual([]);
    expect(followupWindowOpen(id)).toBe(true);
    expect(closeFollowupWindow(id, current)).toEqual(["the new attempt's note"]);
    expect(followupWindowOpen(id)).toBe(false);
  });
});

describe("rebase-followup: the follow-up prompt", () => {
  const followup = (over: Partial<RebaseFollowup> = {}): RebaseFollowup => ({
    notes: ["re-run codegen"],
    baseBranch: "main",
    headFrom: "aaaaaaaaaaaa",
    headTo: "bbbbbbbbbbbb",
    forcePushed: true,
    ...over,
  });

  it("carries the agent's own notes, the base branch, the SHA move and the rewrite warning", () => {
    const text = buildFollowupPrompt(followup({ notes: ["re-run codegen", "update the PR body"] }));

    expect(text).toContain("- re-run codegen");
    expect(text).toContain("- update the PR body");
    expect(text).toContain("`main`");
    expect(text).toContain("aaaaaaa");
    expect(text).toContain("bbbbbbb");
    expect(text).toContain("Re-read any file before editing it");
  });

  it("says the remote is still on the pre-rebase commits when the push did not happen", () => {
    expect(buildFollowupPrompt(followup({ forcePushed: false }))).toContain("NOT pushed");
    expect(buildFollowupPrompt(followup({ forcePushed: true }))).toContain("force-pushed");
  });
});

interface DispatchCall {
  opts: PreparedDispatch;
  admission: DispatchAdmission | undefined;
}

function fakeDeps(outcome: Promise<TurnOutcome>) {
  const calls: DispatchCall[] = [];
  const appendPendingAgentNotice = vi.fn();
  const runner = {
    sessionId: "s1",
    dispatch: (opts: PreparedDispatch, admission?: DispatchAdmission) => {
      calls.push({ opts, admission });
      return { settled: outcome };
    },
  } as unknown as SessionRunnerInterface;
  return { deps: { runner, sessionManager: { appendPendingAgentNotice } }, calls, appendPendingAgentNotice };
}

const FOLLOWUP: RebaseFollowup = {
  notes: ["re-run codegen"],
  baseBranch: "main",
  headFrom: "aaaaaaaaaaaa",
  headTo: "bbbbbbbbbbbb",
  forcePushed: true,
};

const settled = (outcome: TurnOutcome): Promise<TurnOutcome> => Promise.resolve(outcome);

describe("rebase-followup: delivery", () => {
  it("dispatches a system turn that keeps ordinary post-turn handling, queued behind user work", () => {
    const { deps, calls } = fakeDeps(settled({ status: "completed", errored: false }));

    deliverRebaseFollowup(deps, FOLLOWUP);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.text).toContain("re-run codegen");
    expect(calls[0]!.opts.systemTurn).toBe(true);
    // "none" belongs to the resolution turn; this turn's own edits must be committed and pushed.
    expect(calls[0]!.opts.postTurn).toBeUndefined();
    expect(calls[0]!.admission).toEqual({ whenBusy: "queue" });
  });

  it("parks the note for the next turn when the dispatch never reached the agent", async () => {
    const never: TurnOutcome[] = [
      { status: "refused", errored: true, detail: "a system turn is in progress" },
      { status: "dropped", errored: true, detail: "runner disposed mid-turn" },
      { status: "errored", errored: true, detail: `${DISPATCH_SETUP_FAILURE}: no worker` },
    ];
    for (const outcome of never) {
      const { deps, appendPendingAgentNotice } = fakeDeps(settled(outcome));

      deliverRebaseFollowup(deps, FOLLOWUP);
      await vi.waitFor(() => expect(appendPendingAgentNotice).toHaveBeenCalledTimes(1));

      expect(appendPendingAgentNotice.mock.calls[0]![1]).toContain("re-run codegen");
    }
  });

  it("does NOT park a turn that errored after running — the agent may have done the work", async () => {
    // An adapter error settles `errored` for a turn the agent executed, so the status alone
    // cannot mean "never delivered"; only the setup-failure detail can.
    const ran = fakeDeps(settled({ status: "errored", errored: true, detail: "Agent error" }));
    deliverRebaseFollowup(ran.deps, FOLLOWUP);
    const control = fakeDeps(settled({
      status: "errored",
      errored: true,
      detail: `${DISPATCH_SETUP_FAILURE}: no worker`,
    }));
    deliverRebaseFollowup(control.deps, FOLLOWUP);

    await vi.waitFor(() => expect(control.appendPendingAgentNotice).toHaveBeenCalled());

    expect(ran.appendPendingAgentNotice).not.toHaveBeenCalled();
  });

  it("does NOT park a turn the user interrupted — stopping it was a decision", async () => {
    const interrupted = fakeDeps(settled({ status: "interrupted", errored: false }));
    deliverRebaseFollowup(interrupted.deps, FOLLOWUP);
    // A control delivery settling the same way proves the wait below is long enough to
    // have seen a park, so "not called" is an observation rather than a race.
    const control = fakeDeps(settled({ status: "dropped", errored: true }));
    deliverRebaseFollowup(control.deps, FOLLOWUP);

    await vi.waitFor(() => expect(control.appendPendingAgentNotice).toHaveBeenCalled());

    expect(interrupted.appendPendingAgentNotice).not.toHaveBeenCalled();
  });

  it("parks rather than losing the note when the dispatch itself throws", () => {
    const appendPendingAgentNotice = vi.fn();
    const runner = {
      sessionId: "s1",
      dispatch: () => { throw new Error("runner is disposed"); },
    } as unknown as SessionRunnerInterface;

    deliverRebaseFollowup({ runner, sessionManager: { appendPendingAgentNotice } }, FOLLOWUP);

    expect(appendPendingAgentNotice).toHaveBeenCalledTimes(1);
  });
});
