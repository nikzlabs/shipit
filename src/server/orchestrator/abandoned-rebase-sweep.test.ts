import { describe, it, expect, vi } from "vitest";
import type { GitManager } from "../shared/git.js";
import type { SessionInfo } from "../shared/types.js";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";
import { reportAbandonedRebases, buildAbandonedRebaseNotice } from "./abandoned-rebase-sweep.js";

vi.mock("./checkout-durability.js", () => ({
  // Every fixture session's workspaceDir is a stand-in, never a real checkout.
  pathState: () => Promise.resolve("present" as const),
}));

function session(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    title: "s", createdAt: "", lastUsedAt: "", remoteUrl: "",
    workspaceDir: `/tmp/${over.id}`,
    ...over,
  } as SessionInfo;
}

function deps(
  sessions: SessionInfo[],
  rebasing: (dir: string) => boolean,
  busy: ReadonlySet<string> = new Set(),
) {
  // Models appendPendingAgentNotice's real contract: append, and dedupe on the stored text.
  const notices = new Map<string, string>();
  for (const s of sessions) if (s.pendingAgentNotice) notices.set(s.id, s.pendingAgentNotice);
  return {
    notices,
    sessionManager: {
      allIds: () => sessions.map((s) => s.id),
      get: (id: string) => sessions.find((s) => s.id === id),
      appendPendingAgentNotice: (id: string, notice: string) => {
        const existing = notices.get(id) ?? "";
        if (existing.includes(notice)) return;
        notices.set(id, existing ? `${existing}\n\n${notice}` : notice);
      },
      // Present so a regression to the overwriting setter fails on the assertion,
      // not on a missing method.
      setPendingAgentNotice: (id: string, notice: string) => { notices.set(id, notice); },
    } as unknown as SessionManager,
    runnerRegistry: {
      get: (id: string) => (busy.has(id) ? { agentBusy: true } as SessionRunnerInterface : undefined),
    } as unknown as SessionRunnerRegistry,
    createGitManager: (dir: string) => ({
      isRebaseInProgress: () => Promise.resolve(rebasing(dir)),
    }) as unknown as GitManager,
  };
}

describe("abandoned-rebase startup sweep", () => {
  it("tells the next turn to check a checkout left mid-rebase", async () => {
    const d = deps([session({ id: "stuck" }), session({ id: "fine" })], (dir) => dir.endsWith("stuck"));

    expect(await reportAbandonedRebases(d)).toEqual(["stuck"]);
    expect(d.notices.get("stuck")).toBe(buildAbandonedRebaseNotice());
    expect(d.notices.has("fine")).toBe(false);
  });

  it("keeps an unrelated pending notice instead of replacing it", async () => {
    const d = deps([session({ id: "stuck", pendingAgentNotice: "[System] LFS restore failed." })], () => true);

    await reportAbandonedRebases(d);

    const notice = d.notices.get("stuck") ?? "";
    expect(notice).toContain("[System] LFS restore failed.");
    expect(notice).toContain("part-way through a rebase");
  });

  it("does not repeat itself while the earlier notice is still unconsumed", async () => {
    // A stuck session survives many restarts; it must not collect one notice per boot.
    const d = deps([session({ id: "stuck", pendingAgentNotice: buildAbandonedRebaseNotice() })], () => true);

    expect(await reportAbandonedRebases(d)).toEqual(["stuck"]);
    expect(d.notices.get("stuck")).toBe(buildAbandonedRebaseNotice());
  });

  it("leaves a rebase alone while a turn is still driving it", async () => {
    // Turn adoption runs before this sweep, so a surviving turn's rebase is not abandoned.
    const d = deps([session({ id: "adopted" })], () => true, new Set(["adopted"]));

    expect(await reportAbandonedRebases(d)).toEqual([]);
    expect(d.notices.size).toBe(0);
  });

  it("skips warm, archived and evicted sessions, which have nothing to recover in place", async () => {
    const d = deps([
      session({ id: "warm", warm: true }),
      session({ id: "archived", userArchived: true }),
      session({ id: "evicted", diskTier: "evicted" }),
      session({ id: "no-workspace", workspaceDir: undefined }),
    ], () => true);

    expect(await reportAbandonedRebases(d)).toEqual([]);
    expect(d.notices.size).toBe(0);
  });

  it("keeps sweeping after a session whose git cannot be inspected", async () => {
    const d = deps([session({ id: "broken" }), session({ id: "stuck" })], (dir) => dir.endsWith("stuck"));
    const createGitManager = (dir: string): GitManager => {
      if (dir.endsWith("broken")) throw new Error("not a git repository");
      return d.createGitManager(dir);
    };

    expect(await reportAbandonedRebases({ ...d, createGitManager })).toEqual(["stuck"]);
    expect(d.notices.get("stuck")).toBe(buildAbandonedRebaseNotice());
  });
});
