import { describe, it, expect } from "vitest";
import {
  TURN_SETUP_MAX_MS,
  beginTurnSetup,
  claimTakenBeforeSubmit,
  currentTurnAttempt,
  endOwnClaim,
  currentTurnPhase,
  noteCompactionTurn,
  noteSubmissionRejected,
  noteTurnReady,
  noteTurnSubmitted,
  reopenTurnSetup,
  setSteerRefused,
  steerRefused,
  turnAwaitsAgent,
  turnInSetup,
  turnTakesMessages,
} from "./turn-stop-request.js";

// docs/329-user-steers-every-turn — when a message can enter the running turn.
describe("the turn phase: ready and compaction", () => {
  function claimed(): { running: boolean } {
    const runner = { running: true };
    beginTurnSetup(runner);
    return runner;
  }

  it("takes no message while the turn sets up, and takes one when the agent has the prompt", () => {
    const runner = claimed();
    expect(turnTakesMessages(runner)).toBe(false);

    noteTurnSubmitted(runner);
    expect(turnTakesMessages(runner)).toBe(false);

    noteTurnReady(runner);
    expect(turnTakesMessages(runner)).toBe(true);
  });

  it("takes no message when no turn runs, whatever the last turn left behind", () => {
    const runner = claimed();
    noteTurnReady(runner);
    runner.running = false;

    expect(turnTakesMessages(runner)).toBe(false);
  });

  it("takes no message during a compaction turn", () => {
    const runner = claimed();
    noteCompactionTurn(runner, true);
    noteTurnReady(runner);
    expect(turnTakesMessages(runner)).toBe(false);

    noteCompactionTurn(runner, false);
    expect(turnTakesMessages(runner)).toBe(true);
  });

  it("starts each claim with a new record", () => {
    const runner = claimed();
    noteCompactionTurn(runner, true);
    noteTurnReady(runner);

    beginTurnSetup(runner);
    noteTurnReady(runner);

    expect(turnTakesMessages(runner)).toBe(true);
  });

  it("reads a runner with no record as ready", () => {
    expect(turnTakesMessages({ running: true })).toBe(true);
    expect(turnAwaitsAgent({ running: true })).toBe(false);
  });

  it("does not let an answer to an earlier attempt mark the next one", () => {
    const runner = claimed();
    const first = currentTurnAttempt(runner);

    reopenTurnSetup(runner);

    expect(noteTurnReady(runner, first)).toBe(false);
    expect(turnTakesMessages(runner)).toBe(false);
    expect(noteTurnReady(runner, currentTurnAttempt(runner))).toBe(true);
    expect(turnTakesMessages(runner)).toBe(true);
  });

  it("does not let an answer to an earlier turn mark the next one", () => {
    const runner = claimed();
    const first = currentTurnAttempt(runner);

    beginTurnSetup(runner);

    expect(noteTurnReady(runner, first)).toBe(false);
    expect(turnTakesMessages(runner)).toBe(false);
  });

  it("takes no message while a retry sets up", () => {
    const runner = claimed();
    noteTurnReady(runner);

    reopenTurnSetup(runner);

    expect(turnTakesMessages(runner)).toBe(false);
  });

  it("puts a retry back in setup, and keeps a compaction a compaction", () => {
    const runner = claimed();
    noteCompactionTurn(runner, true);
    noteTurnSubmitted(runner);
    noteTurnReady(runner);

    reopenTurnSetup(runner);

    expect(turnInSetup(runner)).toBe(true);
    noteTurnReady(runner);
    expect(turnTakesMessages(runner)).toBe(false);
  });

  it("says a claim awaits its agent until the agent has the prompt, within a bound", () => {
    const runner = claimed();
    const began = Date.now();
    expect(turnAwaitsAgent(runner, began)).toBe(true);
    expect(turnAwaitsAgent(runner, began + TURN_SETUP_MAX_MS + 1_000)).toBe(false);

    // Submitted is not enough: the worker has not recorded the start yet.
    noteTurnSubmitted(runner);
    expect(turnAwaitsAgent(runner, began)).toBe(true);

    noteTurnReady(runner);
    expect(turnAwaitsAgent(runner, began)).toBe(false);
  });

  it("does not say so once the agent refused the attempt's prompt", () => {
    const runner = claimed();
    const first = currentTurnAttempt(runner);

    noteSubmissionRejected(runner, first);
    expect(turnAwaitsAgent(runner)).toBe(false);

    // A retry is a new attempt, and a late refusal of the old one does not mark it.
    reopenTurnSetup(runner);
    expect(turnAwaitsAgent(runner)).toBe(true);
    noteSubmissionRejected(runner, first);
    expect(turnAwaitsAgent(runner)).toBe(true);
  });

  it("keeps a refused steer for the attempt only", () => {
    const runner = claimed();
    expect(steerRefused(runner)).toBe(false);

    setSteerRefused(runner, true);
    expect(steerRefused(runner)).toBe(true);

    reopenTurnSetup(runner);
    expect(steerRefused(runner)).toBe(false);

    setSteerRefused(runner, true);
    beginTurnSetup(runner);
    expect(steerRefused(runner)).toBe(false);
  });

  it("does not say so for a runner that is not running", () => {
    const runner = claimed();
    runner.running = false;

    expect(turnAwaitsAgent(runner)).toBe(false);
  });
});

// planning#703 — a turn the CLI starts during another turn's setup.
describe("claimTakenBeforeSubmit", () => {
  it("is false while the claim is in setup", () => {
    const runner = {};
    beginTurnSetup(runner);
    expect(claimTakenBeforeSubmit(runner, currentTurnPhase(runner))).toBe(false);
  });

  it("is true once a turn of the CLI's own marked the claim submitted", () => {
    const runner = {};
    beginTurnSetup(runner);
    const claim = currentTurnPhase(runner);
    noteTurnSubmitted(runner);
    expect(claimTakenBeforeSubmit(runner, claim)).toBe(true);
  });

  it("is true when another claim replaced it", () => {
    const runner = {};
    beginTurnSetup(runner);
    const claim = currentTurnPhase(runner);
    beginTurnSetup(runner);
    expect(claimTakenBeforeSubmit(runner, claim)).toBe(true);
  });

  it("is false for a runner that keeps no phase", () => {
    expect(claimTakenBeforeSubmit({}, undefined)).toBe(false);
  });

  it("lets a failed setup end its own claim only", () => {
    const runner = { running: true };
    beginTurnSetup(runner);
    const claim = currentTurnPhase(runner);
    noteTurnSubmitted(runner);
    expect(endOwnClaim(runner, claim)).toBe(false);
    expect(runner.running).toBe(true);

    beginTurnSetup(runner);
    expect(endOwnClaim(runner, currentTurnPhase(runner))).toBe(true);
    expect(runner.running).toBe(false);
  });
});
