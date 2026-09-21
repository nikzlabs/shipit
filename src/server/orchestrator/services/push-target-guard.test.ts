import { describe, it, expect } from "vitest";
import { findSharedBranchRefusal } from "./push-target-guard.js";

const git = (defaultBranch: string | Error) => ({
  getDefaultBranch: async (): Promise<string> => {
    if (defaultBranch instanceof Error) throw defaultBranch;
    return defaultBranch;
  },
});

describe("findSharedBranchRefusal", () => {
  it("refuses the repository's default branch", async () => {
    const refusal = await findSharedBranchRefusal(git("main"), "main");
    expect(refusal?.role).toBe("repository-default");
    expect(refusal?.message).toContain("'main'");
  });

  it("refuses the base this push targets, even when it is not the default", async () => {
    const refusal = await findSharedBranchRefusal(git("main"), "stable", "stable");
    expect(refusal?.role).toBe("pr-base");
  });

  it("refuses the default branch while a different base is targeted", async () => {
    expect(await findSharedBranchRefusal(git("main"), "main", "stable")).not.toBeNull();
  });

  it("allows an ordinary session branch", async () => {
    expect(await findSharedBranchRefusal(git("main"), "shipit/ab12cd", "main")).toBeNull();
  });

  it("allows a release branch whose base is the maintenance branch", async () => {
    expect(await findSharedBranchRefusal(git("main"), "release/0.3.0", "stable")).toBeNull();
  });

  // An unreadable default branch is no evidence of a shared branch, and failing
  // closed here would block PR creation on every repo whose HEAD cannot be read.
  it("falls back to the base check when the default branch cannot be read", async () => {
    expect(await findSharedBranchRefusal(git(new Error("no HEAD")), "shipit/x", "main")).toBeNull();
    expect((await findSharedBranchRefusal(git(new Error("no HEAD")), "main", "main"))?.role)
      .toBe("pr-base");
  });

  it("ignores surrounding whitespace on either name", async () => {
    expect(await findSharedBranchRefusal(git("main\n"), " main ")).not.toBeNull();
  });
});
