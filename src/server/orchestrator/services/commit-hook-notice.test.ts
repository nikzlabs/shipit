import { describe, it, expect } from "vitest";
import { formatCommitHookNotice } from "./commit-hook-notice.js";

describe("formatCommitHookNotice", () => {
  // req 10's whole promise: whatever the hook did, the work is on the branch.
  // A hook that left nothing to commit never reaches this notice — it throws
  // out of autoCommit and is reported as an uncommitted turn instead.
  it("says the turn was committed", () => {
    for (const kind of ["failed", "timeout"] as const) {
      expect(formatCommitHookNotice({ kind, output: "x" })).toContain("committed anyway");
    }
  });

  it("quotes what the hook printed", () => {
    const notice = formatCommitHookNotice({ kind: "failed", output: "lint: 3 problems" });
    expect(notice).toContain("lint: 3 problems");
    expect(notice).toContain("```");
  });

  it("names the bound it was killed at, in seconds", () => {
    const notice = formatCommitHookNotice({ kind: "timeout", output: "" }, { timeoutMs: 45_000 });
    expect(notice).toContain("45s");
    expect(notice).toContain("printed nothing");
  });
});
