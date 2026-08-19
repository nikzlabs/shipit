/**
 * nikzlabs/shipit#2429 — the text a session gets when its dependencies could NOT be
 * verified after ShipIt rewrote the working tree.
 *
 * These assert what the messages have to CARRY, not their wording. The reported
 * failure was a diagnosis failure, not a missing feature: the person had a
 * service reporting `running`, an unresolvable-import error that reads like a
 * code fault, and no way to connect either to the rebase that caused them. So
 * each message is checked for the three facts that close that gap — what moved
 * the tree, why the install did not answer for it, and what to run.
 */
import { describe, it, expect } from "vitest";
import {
  dependencyGapAgentPrefix,
  dependencyGapNotice,
  dependencyGapSummary,
  rewritePhrase,
  type DependencyGap,
} from "./dependency-staleness.js";

const NOT_KEYED: DependencyGap = {
  reason: "not-content-keyed",
  rewrite: "rebase",
  commands: ["npm ci && npx prisma generate"],
};

const FAILED: DependencyGap = {
  reason: "install-failed",
  rewrite: "rollback",
  commands: ["npm ci"],
};

describe("rewritePhrase", () => {
  it("renders every label `onWorkspaceRewritten` is called with", () => {
    // The labels are the caller identifiers already passed at the nine call
    // sites, so this is the list that must not degrade to the generic phrase.
    for (const label of [
      "rebase", "rebase-abort", "rollback", "rewind", "git-pull",
      "session-merge", "reset-to-base", "pre-turn-reset", "release-prepare",
    ]) {
      expect(rewritePhrase(label)).not.toBe("a working-tree rewrite");
      // Prose, not an identifier: no kebab-case label survives into the text.
      expect(rewritePhrase(label)).not.toContain("-");
    }
  });

  it("degrades an unknown label rather than leaking it into the transcript", () => {
    expect(rewritePhrase("some-new-caller")).toBe("a working-tree rewrite");
  });

  it("has a phrase for no rewrite at all", () => {
    // The watcher-driven reinstall path has no rewrite to name; the message
    // still has to read as a sentence.
    expect(rewritePhrase(undefined)).toContain("dependency files");
  });
});

describe("dependencyGapNotice", () => {
  it("names the rewrite, the reason, the symptom and the command to run", () => {
    const notice = dependencyGapNotice(NOT_KEYED);

    expect(notice).toContain("a sync onto the latest base");
    expect(notice).toContain("re-run `agent.install`");
    // The symptom is the whole point: without it the reader has no way to match
    // this notice against the failure they are actually looking at.
    expect(notice).toContain("unresolvable import");
    expect(notice).toContain("npm ci && npx prisma generate");
    // The permanent fix, not just the manual one.
    expect(notice).toContain("agent.install-inputs");
  });

  it("says the install RAN and failed when that is what happened", () => {
    const notice = dependencyGapNotice(FAILED);

    expect(notice).toContain("a rollback");
    expect(notice).toContain("failed");
    expect(notice).toContain("npm ci");
    // A failed install is not a configuration problem, so the `install-inputs`
    // advice would be noise — the install already re-runs for this session.
    expect(notice).not.toContain("agent.install-inputs");
  });

  it("renders an empty command list without producing a blank instruction", () => {
    const notice = dependencyGapNotice({ reason: "not-content-keyed", commands: [] });
    expect(notice).toContain("—");
  });

  it("instructs rather than warning about a possible future", () => {
    // "Re-run it if imports start failing" is a warning about something that has
    // not happened yet, and nobody acts on one — which leaves the notice to be
    // re-read after the failure it was meant to pre-empt.
    const notice = dependencyGapNotice(NOT_KEYED);
    expect(notice).toContain("Re-run it now");
    expect(notice).not.toContain("if imports start failing");
  });
});

describe("dependencyGapAgentPrefix", () => {
  it("says nothing at all when there is no gap", () => {
    // The composed prefix is a `.filter(Boolean)` array, so the healthy session
    // has to contribute an empty string — not a reassuring paragraph the agent
    // pays for on every turn.
    expect(dependencyGapAgentPrefix(null)).toBe("");
    expect(dependencyGapAgentPrefix(undefined)).toBe("");
  });

  it("is a `[System]` instruction that inverts the diagnosis order", () => {
    const prefix = dependencyGapAgentPrefix(NOT_KEYED);

    // The convention the other prompt prefixes use; without it the text reads as
    // part of the user's own message.
    expect(prefix.startsWith("[System] ")).toBe(true);
    expect(prefix).toContain("a sync onto the latest base");
    expect(prefix).toContain("npm ci && npx prisma generate");
    // The whole fix: run the install BEFORE concluding the code is at fault.
    // Without that ordering the agent has the fact and still starts from the
    // wrong premise.
    expect(prefix).toMatch(/before you treat[\s\S]*as a fault in the code/);
    // The dead end it must not spend the turn on.
    expect(prefix).toContain("Restarting the service does not fix it");
  });

  it("names a failed install as failed rather than as one that never ran", () => {
    const prefix = dependencyGapAgentPrefix(FAILED);

    expect(prefix).toContain("a rollback");
    expect(prefix).toContain("FAILED");
    expect(prefix).toContain("npm ci");
    // The two reasons need different remedies from the agent, so the prefix may
    // not blur them: this one already re-runs itself, so the "ShipIt cannot tell
    // which files it consumes" explanation would be a false statement about it.
    expect(prefix).not.toContain("cannot tell which");
  });

  it("stays a single prompt block for either reason", () => {
    // It is joined into the prefix array with a blank-line separator, so a
    // trailing or leading blank of its own would open a seam the next element
    // lands in the middle of.
    for (const gap of [NOT_KEYED, FAILED]) {
      expect(dependencyGapAgentPrefix(gap)).toBe(dependencyGapAgentPrefix(gap).trim());
    }
  });
});

describe("dependencyGapSummary", () => {
  it("is a complete sentence that contradicts the service row beside it", () => {
    const summary = dependencyGapSummary(NOT_KEYED);
    // It lands next to a row the agent is already reading as `running`, so it
    // has to say that the row cannot be trusted to explain the failure.
    expect(summary).toContain("a sync onto the latest base");
    expect(summary).toContain("unresolvable import");
    expect(summary).not.toContain("\n");
  });

  it("distinguishes a failed install from one that never ran", () => {
    expect(dependencyGapSummary(FAILED)).toContain("failed");
    expect(dependencyGapSummary(NOT_KEYED)).toContain("not re-run");
  });
});
