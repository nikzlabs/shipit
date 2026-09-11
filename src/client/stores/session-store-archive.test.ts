/**
 * Archiving deletes the session's checkout — except when its commits are on no
 * remote, where the server keeps it. That retention has to reach the user: the
 * session leaves the sidebar either way, so without a toast it silently keeps
 * using disk with nothing on screen to explain why.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useSessionStore } from "./session-store.js";
import { useUiStore } from "./ui-store.js";
import type { SessionInfo } from "../../server/shared/types.js";

const session = { id: "s1", title: "S1" } as unknown as SessionInfo;

function mockArchiveResponse(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => body,
  }) as unknown as Response));
}

beforeEach(() => {
  useSessionStore.setState({ sessions: [session], allSessions: [session], turnUsage: {} } as never);
  useUiStore.getState().setToast(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("archiveSession: retained checkout", () => {
  it("shows the server's explanation and keeps the row at the light tier", async () => {
    mockArchiveResponse({
      sessions: [],
      checkoutRetained: { sessionId: "s1", message: "Session archived, but its files were kept" },
    });

    await useSessionStore.getState().archiveSession("s1");

    expect(useUiStore.getState().toast?.message).toContain("its files were kept");
    expect(useSessionStore.getState().allSessions[0].diskTier).toBe("light");
  });

  it("says nothing, and marks the row evicted, when the checkout was removed", async () => {
    mockArchiveResponse({ sessions: [] });

    await useSessionStore.getState().archiveSession("s1");

    expect(useUiStore.getState().toast).toBeNull();
    expect(useSessionStore.getState().allSessions[0].diskTier).toBe("evicted");
  });
});
