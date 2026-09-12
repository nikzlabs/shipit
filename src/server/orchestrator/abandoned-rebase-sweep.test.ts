import { describe, it, expect, vi } from "vitest";
import type { GitManager } from "../shared/git.js";
import type { SessionInfo } from "../shared/types.js";
import type { SessionManager } from "./sessions.js";
import {
  reportAbandonedRebases,
  buildAbandonedRebaseNotice,
  ABANDONED_REBASE_NOTICE_PREFIX,
} from "./abandoned-rebase-sweep.js";

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

function deps(sessions: SessionInfo[], rebasing: (dir: string) => boolean) {
  const notices = new Map<string, string>();
  return {
    notices,
    sessionManager: {
      list: () => sessions,
      setPendingAgentNotice: (id: string, notice: string) => { notices.set(id, notice); },
    } as unknown as SessionManager,
    createGitManager: (dir: string) => ({
      isRebaseInProgress: () => Promise.resolve(rebasing(dir)),
    }) as unknown as GitManager,
  };
}

describe("abandoned-rebase startup sweep", () => {
  it("tells the next turn to recover a checkout left mid-rebase", async () => {
    const d = deps([session({ id: "stuck" }), session({ id: "fine" })], (dir) => dir.endsWith("stuck"));

    expect(await reportAbandonedRebases(d)).toEqual(["stuck"]);
    expect(d.notices.get("stuck")).toBe(buildAbandonedRebaseNotice());
    expect(d.notices.has("fine")).toBe(false);
  });

  it("does not repeat the notice while the earlier one is still unconsumed", async () => {
    // A stuck session survives many restarts; it must not collect one notice per boot.
    const d = deps(
      [session({ id: "stuck", pendingAgentNotice: buildAbandonedRebaseNotice() })],
      () => true,
    );

    expect(await reportAbandonedRebases(d)).toEqual(["stuck"]);
    expect(d.notices.size).toBe(0);
  });

  it("re-reports once the agent consumed the notice and the rebase is still stuck", async () => {
    const d = deps(
      [session({ id: "stuck", pendingAgentNotice: "[System] something else entirely" })],
      () => true,
    );

    await reportAbandonedRebases(d);
    expect(d.notices.get("stuck")).toContain(ABANDONED_REBASE_NOTICE_PREFIX);
  });

  it("skips archived sessions and evicted checkouts, which have nothing to recover in place", async () => {
    const d = deps([
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
    expect(d.notices.get("stuck")).toContain(ABANDONED_REBASE_NOTICE_PREFIX);
  });
});
