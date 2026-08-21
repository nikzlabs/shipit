/**
 * Unit tests for `pinIssueSeededSession` (planning#322).
 *
 * The contract is narrow but load-bearing: whatever happens to the git rename,
 * the caller must come away with pins that make `graduateSession` skip AI
 * naming — that is what keeps the issue's title out of the pushed branch
 * (docs/248-declared-issue-trackers req 22). The failure modes are therefore as interesting as the
 * happy path.
 */

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

    // planning#413 — the pointer names the branch, a random suffix keeps it
    // unique, so a later session on SHI-304 cannot land on this same branch.
    expect(pins.branch).toMatch(/^shi-304-[a-z0-9_-]{1,6}$/);
    expect(renameBranch).toHaveBeenCalledWith("shipit/ab12cd", pins.branch);
    expect(setBranch).toHaveBeenCalledWith("s1", pins.branch);
    expect(pins.title).toBe("SHI-304: Acquire competitor before the board meeting");
    // The whole point: nothing from the title reached the branch.
    expect(pins.branch).not.toMatch(/acquire|competitor|board/);
  });

  it("reports the branch the session is actually on when the rename fails", async () => {
    const { deps, setBranch } = makeDeps(
      { branch: "shipit/ab12cd", workspaceDir: "/tmp/ws" },
      async () => { throw new Error("not a git repository"); },
    );

    const pins = await pinIssueSeededSession(deps, "s1", REF);

    // The row is not updated to a branch that doesn't exist…
    expect(setBranch).not.toHaveBeenCalled();
    expect(pins.branch).toBe("shipit/ab12cd");
    // …but a pin is still returned, so AI naming stays off and the random
    // branch survives instead of being rewritten from the issue's title.
    expect(pins.title).toBe("SHI-304: Acquire competitor before the board meeting");
  });

  // The guard is on the pointer STEM, not on the full seeded name: since
  // planning#413 the seed ends in a fresh random suffix, so an equality test
  // could never fire and every re-entry would rename an already-correct branch
  // to a second name — stranding the one already pushed.
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

  // …but a *different* issue's branch is renamed, so the stem test can't be
  // read as "any branch that looks issue-ish is left alone".
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
