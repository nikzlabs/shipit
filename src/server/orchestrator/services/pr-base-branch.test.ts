import { describe, it, expect, vi } from "vitest";
import type { GitManager } from "../../shared/git.js";
import { resolvePrBaseBranch } from "./git.js";

function gitWithDefault(detected: string): GitManager {
  return { getDefaultBranch: vi.fn(async () => detected) } as unknown as GitManager;
}

describe("resolvePrBaseBranch", () => {
  it("uses the remote's actual default branch", async () => {
    await expect(resolvePrBaseBranch(gitWithDefault("master"), ["master", "feature"]))
      .resolves.toBe("master");
  });

  it("handles a default branch that is neither main nor master", async () => {
    await expect(resolvePrBaseBranch(gitWithDefault("trunk"), ["trunk", "feature"]))
      .resolves.toBe("trunk");
  });

  it("prefers the real default over a legacy 'main' that also exists", async () => {
    await expect(resolvePrBaseBranch(gitWithDefault("develop"), ["main", "develop"]))
      .resolves.toBe("develop");
  });

  it("ignores a detected branch that no longer exists on the remote", async () => {
    await expect(resolvePrBaseBranch(gitWithDefault("gone"), ["main", "master"]))
      .resolves.toBe("main");
  });

  it("falls back to master when detection is unusable and there's no main", async () => {
    await expect(resolvePrBaseBranch(gitWithDefault("gone"), ["master", "feature"]))
      .resolves.toBe("master");
  });

  it("falls back to the first remote branch, then to main, for an odd remote", async () => {
    await expect(resolvePrBaseBranch(gitWithDefault("gone"), ["release/v2"]))
      .resolves.toBe("release/v2");
    await expect(resolvePrBaseBranch(gitWithDefault("gone"), []))
      .resolves.toBe("main");
  });
});
