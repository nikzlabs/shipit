

import { describe, it, expect } from "vitest";
import { computeRepoGroups as computeWith } from "./useSessionGrouping.js";
import { doneSessionTest } from "../../../server/shared/session-resolution.js";
import type { SessionInfo, RepoInfo } from "../../../server/shared/types.js";

const computeRepoGroups = (repos: RepoInfo[], sessions: SessionInfo[]) =>
  computeWith(repos, sessions, doneSessionTest(sessions));

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

    expect(groups[0].kind).toBe("sandbox");
  });

  it("does NOT lump an ordinary no-remote (orphan) session into the sandbox group", () => {
    const sessions = [
      session({ id: "sb1", kind: "sandbox" }),

      session({ id: "orphan1", remoteUrl: "" }),
    ];
    const groups = computeRepoGroups([], sessions);
    const sandbox = groups.find((g) => g.kind === "sandbox");
    const orphan = groups.find((g) => g.kind === "orphan");
    expect(sandbox?.sessions.map((s) => s.id)).toEqual(["sb1"]);

    expect(orphan?.sessions.map((s) => s.id)).toEqual(["orphan1"]);
  });

  it("omits the sandbox group entirely when there are no sandbox sessions", () => {
    const groups = computeRepoGroups([], [session({ id: "x", remoteUrl: "" })]);
    expect(groups.some((g) => g.kind === "sandbox")).toBe(false);
  });

  it("docs/324: sinks finished runs to the bottom, newest finish first, and keeps the rest in order", () => {
    const run = (id: string, runFinishedAt?: string) =>
      session({ id, kind: "sandbox", scheduleId: "sched-1", ...(runFinishedAt ? { runFinishedAt } : {}) });
    const groups = computeRepoGroups([], [
      run("old-done", "2026-01-02T00:00:00.000Z"),
      run("live-b"),
      run("new-done", "2026-01-05T00:00:00.000Z"),
      run("live-a"),
    ]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["live-b", "live-a", "new-done", "old-done"]);
  });
});

describe("computeRepoGroups — resolved demotion", () => {
  const REPO = "https://github.com/o/r.git";
  const repos: RepoInfo[] = [{ url: REPO, addedAt: "", lastUsedAt: "", status: "ready" }];
  const merged = (over: Partial<SessionInfo>) => session({
    remoteUrl: REPO,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-02T00:00:00.000Z",
    mergedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  });

  it("sinks a merged session below an active one", () => {
    const groups = computeRepoGroups(repos, [
      merged({ id: "resolved" }),
      session({ id: "active", remoteUrl: REPO, createdAt: "2025-12-01T00:00:00.000Z" }),
    ]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["active", "resolved"]);
  });

  it("docs/324: orders finished runs by their finish, not by their PR", () => {
    const groups = computeRepoGroups(repos, [
      merged({ id: "merged-late", scheduleId: "s", mergedAt: "2026-01-09T00:00:00.000Z", runFinishedAt: "2026-01-03T00:00:00.000Z" }),
      merged({ id: "finished-late", scheduleId: "s", runFinishedAt: "2026-01-04T00:00:00.000Z" }),
    ]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["finished-late", "merged-late"]);
  });

  it("docs/324: orders a run's finish and a spawned session's SQLite-format merge by time, not by text", () => {
    const groups = computeRepoGroups(repos, [
      merged({ id: "run", scheduleId: "s", runFinishedAt: "2026-10-07T10:00:00.000Z" }),
      merged({ id: "kid", mergedAt: "2026-10-07 16:00:00", lastUsedAt: "2026-10-07 15:00:00" }),
    ]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["kid", "run"]);
  });

  it("keeps a merged session with a blocked workspace above an older active one (docs/298)", () => {
    const groups = computeRepoGroups(repos, [
      session({ id: "active", remoteUrl: REPO, createdAt: "2025-12-01T00:00:00.000Z" }),
      merged({ id: "blocked", workspaceBlock: "conflict" }),
    ]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["blocked", "active"]);
  });
});
