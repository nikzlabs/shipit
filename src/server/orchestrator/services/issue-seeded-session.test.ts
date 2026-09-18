import { describe, it, expect, vi } from "vitest";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { IssueRef, SessionInfo } from "../../shared/types.js";
import { pinIssueSeededSession } from "./issue-seeded-session.js";

const REF: IssueRef = {
  tracker: "linear",
  identifier: "SHI-304",
  title: "Acquire competitor before the board meeting",
};

function makeDeps(session: Partial<SessionInfo> | undefined, renameImpl?: () => Promise<void>) {
  const setBranch = vi.fn();
  const renameBranch = vi.fn(renameImpl ?? (async () => undefined));
  const deps = {
    sessionManager: {
      get: () => (session ? ({ id: "s1", ...session } as SessionInfo) : undefined),
      setBranch,
    } as unknown as SessionManager,
    createGitManager: () => ({ renameBranch } as unknown as GitManager),
  };
  return { deps, setBranch, renameBranch };
}

describe("pinIssueSeededSession", () => {
  it("renames the throwaway branch to the pointer and pins both fields", async () => {
    const { deps, setBranch, renameBranch } = makeDeps({
      branch: "shipit/ab12cd",
      workspaceDir: "/tmp/ws",
    });

    const pins = await pinIssueSeededSession(deps, "s1", REF);

    expect(pins.branch).toMatch(/^shi-304-[a-z0-9_-]{1,6}$/);
    expect(renameBranch).toHaveBeenCalledWith("shipit/ab12cd", pins.branch);
    expect(setBranch).toHaveBeenCalledWith("s1", pins.branch);
    expect(pins.title).toBe("SHI-304: Acquire competitor before the board meeting");
    expect(pins.branch).not.toMatch(/acquire|competitor|board/);
  });

  it("reports the branch the session is actually on when the rename fails", async () => {
    const { deps, setBranch } = makeDeps(
      { branch: "shipit/ab12cd", workspaceDir: "/tmp/ws" },
      async () => { throw new Error("not a git repository"); },
    );

    const pins = await pinIssueSeededSession(deps, "s1", REF);

    expect(setBranch).not.toHaveBeenCalled();
    expect(pins.branch).toBe("shipit/ab12cd");
    expect(pins.title).toBe("SHI-304: Acquire competitor before the board meeting");
  });

  it("is a no-op when the session is already on a branch seeded from this issue", async () => {
    const { deps, setBranch, renameBranch } = makeDeps({
      branch: "shi-304-k7p2qz",
      workspaceDir: "/tmp/ws",
    });

    const pins = await pinIssueSeededSession(deps, "s1", REF);

    expect(renameBranch).not.toHaveBeenCalled();
    expect(setBranch).not.toHaveBeenCalled();
    expect(pins.branch).toBe("shi-304-k7p2qz");
  });

  it("renames when the session is on another issue's seeded branch", async () => {
    const { deps, renameBranch } = makeDeps({
      branch: "shi-99-aa11bb",
      workspaceDir: "/tmp/ws",
    });

    const pins = await pinIssueSeededSession(deps, "s1", REF);

    expect(renameBranch).toHaveBeenCalledWith("shi-99-aa11bb", pins.branch);
    expect(pins.branch).toMatch(/^shi-304-/);
  });

  it("still pins when there is no workspace to rename in", async () => {
    const { deps, renameBranch } = makeDeps({ branch: "shipit/ab12cd" });

    const pins = await pinIssueSeededSession(deps, "s1", REF);

    expect(renameBranch).not.toHaveBeenCalled();
    expect(pins).toEqual({ branch: "shipit/ab12cd", title: "SHI-304: Acquire competitor before the board meeting" });
  });

  it("falls back to the pointer branch when the session row is gone", async () => {
    const { deps } = makeDeps(undefined);
    const pins = await pinIssueSeededSession(deps, "s1", REF);
    expect(pins.branch).toMatch(/^shi-304-[a-z0-9_-]{1,6}$/);
  });
});
