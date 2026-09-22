import { describe, it, expect } from "vitest";
import { formatCommitHookNotice } from "./commit-hook-notice.js";

describe("formatCommitHookNotice", () => {
  // req 10's whole promise: whatever the hook did, the work is on the branch.
  it("says the turn was committed", () => {
    for (const kind of ["failed", "timeout"] as const) {
      expect(formatCommitHookNotice({ kind, output: "x" }, { committed: true }))
        .toContain("committed anyway");
    }
  });

  // The one case req 10 cannot deliver: the hook itself emptied the tree.
  it("does not claim a commit when there was none", () => {
    const notice = formatCommitHookNotice({ kind: "failed", output: "x" }, { committed: false });
    expect(notice).toContain("Nothing was committed");
    expect(notice).not.toContain("committed anyway");
  });

  it("quotes what the hook printed", () => {
    const notice = formatCommitHookNotice(
      { kind: "failed", output: "lint: 3 problems" },
      { committed: true },
    );
    expect(notice).toContain("lint: 3 problems");
    expect(notice).toContain("```");
  });

  it("names the bound it was killed at, in seconds", () => {
    const notice = formatCommitHookNotice(
      { kind: "timeout", output: "" },
      { committed: true, timeoutMs: 45_000 },
    );
    expect(notice).toContain("45s");
    expect(notice).toContain("printed nothing");
  });
});
