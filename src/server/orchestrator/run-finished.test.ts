import { describe, it, expect } from "vitest";
import { isRunFinished, runResult, type RunFinishedInputs } from "./run-finished.js";
import type { PersistedMessage } from "./chat-history.js";

const ended = (over: Partial<RunFinishedInputs> = {}, run: RunFinishedInputs["run"] = {}): boolean =>
  isRunFinished({ starting: false, prOpen: false, statusCardOn: false, ...over, run: { lastTurnOutcome: "ok", ...run } });

describe("isRunFinished (docs/324-scheduled-sessions reqs 22, 31, 33)", () => {
  it("is finished when nothing is left for the user", () => {
    expect(ended()).toBe(true);
  });

  it("is not finished while a question waits, a PR is open, or the session is still being prepared (req 22)", () => {
    expect(ended({}, { awaitingAnswer: true })).toBe(false);
    expect(ended({ prOpen: true })).toBe(false);
    expect(ended({ starting: true })).toBe(false);
  });

  it("counts manual steps only while the status card is on", () => {
    expect(ended({ statusCardOn: true }, { manualStepCount: 1 })).toBe(false);
    expect(ended({ statusCardOn: false }, { manualStepCount: 1 })).toBe(true);
  });

  it("is not finished after a turn that ended on an error or out of quota (req 31)", () => {
    expect(ended({}, { lastTurnOutcome: "errored" })).toBe(false);
    expect(ended({}, { lastTurnOutcome: "quota-refused" })).toBe(false);
  });

  it("is finished once the user stopped it, whatever else holds (req 33)", () => {
    expect(ended({ prOpen: true }, { runStoppedAt: "2026-10-07T09:30:00.000Z", awaitingAnswer: true, lastTurnOutcome: "errored" }))
      .toBe(true);
  });
});

describe("runResult (req 24)", () => {
  const messages: PersistedMessage[] = [
    { role: "user", text: "Check current security PRs and merge them." },
    { role: "assistant", text: "## Merged two PRs\n\nDetails follow." },
    { role: "assistant", text: "Rate limit reached.", isError: true },
    { role: "assistant", text: "Restarted the container.", notice: true },
  ];

  it("takes the status card's last turn while the card is on", () => {
    const session = { sessionStatus: { status: "s", lastTurn: "Merged #3060 and #3061.\nMore." } };
    expect(runResult(session as never, true, messages)).toBe("Merged #3060 and #3061.");
    expect(runResult(session as never, false, messages)).toBe("Merged two PRs");
  });

  it("falls back to the first line of the last agent message, skipping errors and notices", () => {
    expect(runResult({}, true, messages)).toBe("Merged two PRs");
    expect(runResult({}, false, [{ role: "user", text: "only a prompt" }])).toBeUndefined();
  });

  it("keeps one short line", () => {
    const long = "x".repeat(300);
    expect(runResult({}, false, [{ role: "assistant", text: long }])).toHaveLength(200);
  });
});
