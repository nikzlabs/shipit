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
