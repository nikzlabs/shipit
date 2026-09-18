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
    for (const label of [
      "rebase", "rebase-abort", "rollback", "rewind", "git-pull",
      "session-merge", "reset-to-base", "pre-turn-reset", "release-prepare",
    ]) {
      expect(rewritePhrase(label)).not.toBe("a working-tree rewrite");
      expect(rewritePhrase(label)).not.toContain("-");
    }
  });

  it("degrades an unknown label rather than leaking it into the transcript", () => {
    expect(rewritePhrase("some-new-caller")).toBe("a working-tree rewrite");
  });

  it("has a phrase for no rewrite at all", () => {
    expect(rewritePhrase(undefined)).toContain("dependency files");
  });
});

describe("dependencyGapNotice", () => {
  it("names the rewrite, the reason, the symptom and the command to run", () => {
    const notice = dependencyGapNotice(NOT_KEYED);

    expect(notice).toContain("a sync onto the latest base");
    expect(notice).toContain("re-run `agent.install`");
    expect(notice).toContain("unresolvable import");
    expect(notice).toContain("npm ci && npx prisma generate");
    expect(notice).toContain("agent.install-inputs");
  });

  it("says the install RAN and failed when that is what happened", () => {
    const notice = dependencyGapNotice(FAILED);

    expect(notice).toContain("a rollback");
    expect(notice).toContain("failed");
    expect(notice).toContain("npm ci");
    expect(notice).not.toContain("agent.install-inputs");
  });

  it("renders an empty command list without producing a blank instruction", () => {
    const notice = dependencyGapNotice({ reason: "not-content-keyed", commands: [] });
    expect(notice).toContain("—");
  });

  it("instructs rather than warning about a possible future", () => {
    const notice = dependencyGapNotice(NOT_KEYED);
    expect(notice).toContain("Re-run it now");
    expect(notice).not.toContain("if imports start failing");
  });
});

describe("dependencyGapAgentPrefix", () => {
  it("says nothing at all when there is no gap", () => {
    expect(dependencyGapAgentPrefix(null)).toBe("");
    expect(dependencyGapAgentPrefix(undefined)).toBe("");
  });

  it("is a `[System]` instruction that inverts the diagnosis order", () => {
    const prefix = dependencyGapAgentPrefix(NOT_KEYED);

    expect(prefix.startsWith("[System] ")).toBe(true);
    expect(prefix).toContain("a sync onto the latest base");
    expect(prefix).toContain("npm ci && npx prisma generate");
    expect(prefix).toMatch(/before you treat[\s\S]*as a fault in the code/);
    expect(prefix).toContain("Restarting the service does not fix it");
  });

  it("names a failed install as failed rather than as one that never ran", () => {
    const prefix = dependencyGapAgentPrefix(FAILED);

    expect(prefix).toContain("a rollback");
    expect(prefix).toContain("FAILED");
    expect(prefix).toContain("npm ci");
    expect(prefix).not.toContain("cannot tell which");
  });

  it("stays a single prompt block for either reason", () => {
    for (const gap of [NOT_KEYED, FAILED]) {
      expect(dependencyGapAgentPrefix(gap)).toBe(dependencyGapAgentPrefix(gap).trim());
    }
  });
});

describe("dependencyGapSummary", () => {
  it("is a complete sentence that contradicts the service row beside it", () => {
    const summary = dependencyGapSummary(NOT_KEYED);
    expect(summary).toContain("a sync onto the latest base");
    expect(summary).toContain("unresolvable import");
    expect(summary).not.toContain("\n");
  });

  it("distinguishes a failed install from one that never ran", () => {
    expect(dependencyGapSummary(FAILED)).toContain("failed");
    expect(dependencyGapSummary(NOT_KEYED)).toContain("not re-run");
  });
});
