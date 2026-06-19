import { describe, it, expect, vi } from "vitest";
import { adoptReleaseBranch } from "./release-branch-adopt.js";
import type { SessionManager } from "../sessions.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { SessionInfo } from "../../shared/types.js";

/**
 * docs/214 — unit tests for the release-branch adoption helper. After
 * `shipit release prepare` opens the bump PR (head `release/<version>`), the
 * session must adopt that branch so the inline PR lifecycle card (keyed by
 * `session.branch` in the poller) discovers + broadcasts the release PR, giving
 * the user an in-ShipIt merge button (CLAUDE.md §1/§2).
 */

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Test",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    remoteUrl: "https://github.com/o/r.git",
    branch: "shipit/abc",
    ...over,
  };
}

function harness(opts: { session: SessionInfo | undefined }) {
  let current = opts.session;
  const setBranch = vi.fn((id: string, branch: string) => {
    if (current?.id === id) current = { ...current, branch };
  });
  const reArm = vi.fn();
  const forceRefreshSession = vi.fn(async () => {});
  const sseBroadcast = vi.fn();

  const sessionManager = {
    get: vi.fn(() => current),
    setBranch,
    list: vi.fn(() => (current ? [current] : [])),
  } as unknown as SessionManager;
  const prStatusPoller = {
    reArm,
    forceRefreshSession,
  } as unknown as PrStatusPoller;

  return {
    run: (releaseHeadBranch = "release/0.3.0", withPoller = true) =>
      adoptReleaseBranch({
        deps: {
          sessionManager,
          prStatusPoller: withPoller ? prStatusPoller : undefined,
          sseBroadcast,
        },
        sessionId: "s1",
        releaseHeadBranch,
      }),
    setBranch,
    reArm,
    forceRefreshSession,
    sseBroadcast,
    get current() {
      return current;
    },
  };
}

describe("adoptReleaseBranch (docs/214)", () => {
  it("repoints the session branch, re-arms the poller, and rebroadcasts the list", async () => {
    const h = harness({ session: makeSession() });
    expect(await h.run("release/0.3.0")).toBe(true);

    expect(h.setBranch).toHaveBeenCalledWith("s1", "release/0.3.0");
    expect(h.current?.branch).toBe("release/0.3.0");
    expect(h.reArm).toHaveBeenCalledWith("s1");
    expect(h.forceRefreshSession).toHaveBeenCalledWith("s1");
    expect(h.sseBroadcast).toHaveBeenCalledWith(
      "session_list",
      expect.objectContaining({ sessions: expect.any(Array) }),
    );
  });

  it("re-arms only AFTER repointing the branch (so the poll matches the new head)", async () => {
    const h = harness({ session: makeSession() });
    await h.run("release/0.3.0");

    const setBranchOrder = h.setBranch.mock.invocationCallOrder[0];
    const reArmOrder = h.reArm.mock.invocationCallOrder[0];
    const forceOrder = h.forceRefreshSession.mock.invocationCallOrder[0];
    expect(setBranchOrder).toBeLessThan(reArmOrder);
    expect(reArmOrder).toBeLessThan(forceOrder);
  });

  it("is a no-op on a re-run (session already tracks the release branch)", async () => {
    const h = harness({ session: makeSession({ branch: "release/0.3.0" }) });
    expect(await h.run("release/0.3.0")).toBe(false);

    expect(h.setBranch).not.toHaveBeenCalled();
    expect(h.reArm).not.toHaveBeenCalled();
    expect(h.forceRefreshSession).not.toHaveBeenCalled();
    expect(h.sseBroadcast).not.toHaveBeenCalled();
  });

  it("is a no-op when the session is gone", async () => {
    const h = harness({ session: undefined });
    expect(await h.run("release/0.3.0")).toBe(false);
    expect(h.setBranch).not.toHaveBeenCalled();
    expect(h.reArm).not.toHaveBeenCalled();
    expect(h.sseBroadcast).not.toHaveBeenCalled();
  });

  it("still repoints + rebroadcasts when no poller is wired (degraded setup)", async () => {
    const h = harness({ session: makeSession() });
    expect(await h.run("release/0.3.0", /* withPoller */ false)).toBe(true);

    expect(h.setBranch).toHaveBeenCalledWith("s1", "release/0.3.0");
    expect(h.reArm).not.toHaveBeenCalled();
    expect(h.forceRefreshSession).not.toHaveBeenCalled();
    expect(h.sseBroadcast).toHaveBeenCalledWith(
      "session_list",
      expect.objectContaining({ sessions: expect.any(Array) }),
    );
  });
});
