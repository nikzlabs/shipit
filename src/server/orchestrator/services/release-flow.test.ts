import { describe, it, expect, vi } from "vitest";
import { reactToReleaseMarkers } from "./release-flow.js";
import type { ReleaseStatusPoller } from "../release-status-poller.js";
import type { SessionManager } from "../sessions.js";

/**
 * docs/171 + docs/214 — release-flow maps the agent's turn-text markers onto the
 * poller. The primary docs/214 driver is the prepare route calling the poller
 * directly, but the `pr-opened` marker path stays supported.
 */
function makeDeps() {
  const poller = {
    propose: vi.fn(),
    markPrOpened: vi.fn(),
    markTagged: vi.fn(),
    markAlreadyReleased: vi.fn(),
    cancel: vi.fn(),
  } as unknown as ReleaseStatusPoller;
  const sessionManager = {
    get: () => ({ remoteUrl: "https://github.com/owner/repo" }),
  } as unknown as SessionManager;
  return { deps: { releaseStatusPoller: poller, sessionManager }, poller };
}

describe("reactToReleaseMarkers", () => {
  it("drives markPrOpened from a pr-opened marker", async () => {
    const { deps, poller } = makeDeps();
    await reactToReleaseMarkers({
      deps,
      sessionId: "s1",
      sessionDir: "/tmp/none",
      turnText: `<!--shipit:release {"action":"pr-opened","version":"0.3.0","tag":"v0.3.0","prNumber":7,"prUrl":"https://github.com/owner/repo/pull/7","releaseBranch":"stable"}-->`,
    });
    expect(poller.markPrOpened).toHaveBeenCalledWith(
      "s1",
      "https://github.com/owner/repo",
      expect.objectContaining({ version: "0.3.0", tag: "v0.3.0", prNumber: 7, releaseBranch: "stable" }),
    );
  });

  it("no-ops without a GitHub remote", async () => {
    const { poller } = makeDeps();
    const sessionManager = { get: () => ({ remoteUrl: undefined }) } as unknown as SessionManager;
    await reactToReleaseMarkers({
      deps: { releaseStatusPoller: poller, sessionManager },
      sessionId: "s1",
      sessionDir: "/tmp/none",
      turnText: `<!--shipit:release {"action":"pr-opened","version":"0.3.0","tag":"v0.3.0","prNumber":7,"prUrl":"https://github.com/owner/repo/pull/7","releaseBranch":"stable"}-->`,
    });
    expect(poller.markPrOpened).not.toHaveBeenCalled();
  });
});
