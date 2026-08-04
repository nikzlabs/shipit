/**
 * docs/211 — sandbox sessions form their own pinned sidebar group, keyed on
 * `kind === "sandbox"` and kept OUT of the `remoteUrl ?? ""` orphan bucket so
 * unrelated no-remote sessions aren't lumped in with them.
 */

import { describe, it, expect } from "vitest";
import { computeRepoGroups } from "./useSessionGrouping.js";
import type { SessionInfo, RepoInfo } from "../../../server/shared/types.js";

function session(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: "id",
    title: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    remoteUrl: "",
    ...over,
  };
}

describe("computeRepoGroups — sandbox group", () => {
  it("collects kind=sandbox sessions into a single pinned sandbox group, ahead of repos", () => {
    const repos: RepoInfo[] = [
      { url: "https://github.com/o/r.git", addedAt: "", lastUsedAt: "", status: "ready" },
    ];
    const sessions = [
      session({ id: "sb1", kind: "sandbox", capabilities: { git: true, docker: false, network: true, dangerousGitHubOps: false } }),
      session({ id: "repo1", remoteUrl: "https://github.com/o/r.git" }),
    ];
    const groups = computeRepoGroups(repos, sessions);
    const sandbox = groups.find((g) => g.kind === "sandbox");
    expect(sandbox).toBeDefined();
    expect(sandbox?.sessions.map((s) => s.id)).toEqual(["sb1"]);
    // Sandbox group is pinned first.
    expect(groups[0].kind).toBe("sandbox");
  });

  it("does NOT lump an ordinary no-remote (orphan) session into the sandbox group", () => {
    const sessions = [
      session({ id: "sb1", kind: "sandbox" }),
      // A repo-less standalone session — empty remoteUrl, but NOT a sandbox.
      session({ id: "orphan1", remoteUrl: "" }),
    ];
    const groups = computeRepoGroups([], sessions);
    const sandbox = groups.find((g) => g.kind === "sandbox");
    const orphan = groups.find((g) => g.kind === "orphan");
    expect(sandbox?.sessions.map((s) => s.id)).toEqual(["sb1"]);
    // The orphan session lands in its own "Local sessions" bucket, not sandbox.
    expect(orphan?.sessions.map((s) => s.id)).toEqual(["orphan1"]);
  });

  it("omits the sandbox group entirely when there are no sandbox sessions", () => {
    const groups = computeRepoGroups([], [session({ id: "x", remoteUrl: "" })]);
    expect(groups.some((g) => g.kind === "sandbox")).toBe(false);
  });
});
