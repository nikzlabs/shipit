import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reactToReleaseMarkers } from "./release-flow.js";
import type { ReleaseStatusPoller } from "../release-status-poller.js";
import type { SessionManager } from "../sessions.js";

const tmpDirs: string[] = [];
function makeSessionDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-flow-"));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const PROPOSE = `<!--shipit:release {"action":"propose","version":"0.3.0","tag":"v0.3.0","prerelease":false}-->`;

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

  it("propose: resolves the mechanism from shipit.yaml (docs/214)", async () => {
    const { deps, poller } = makeDeps();
    const sessionDir = makeSessionDir({
      "shipit.yaml": "release:\n  mechanism: release-branch\n  branch: stable\n",
      "package.json": `{"version":"0.2.0"}`,
    });
    await reactToReleaseMarkers({ deps, sessionId: "s1", sessionDir, turnText: PROPOSE });
    expect(poller.propose).toHaveBeenCalledWith(
      "s1",
      "https://github.com/owner/repo",
      expect.objectContaining({ version: "0.3.0", tag: "v0.3.0", mechanism: "release-branch" }),
    );
  });

  it("propose: a marker mechanism overrides shipit.yaml", async () => {
    const { deps, poller } = makeDeps();
    const sessionDir = makeSessionDir({ "shipit.yaml": "release:\n  mechanism: release-branch\n" });
    const turnText = `<!--shipit:release {"action":"propose","version":"0.3.0","tag":"v0.3.0","prerelease":false,"mechanism":"tag-triggered"}-->`;
    await reactToReleaseMarkers({ deps, sessionId: "s1", sessionDir, turnText });
    expect(poller.propose).toHaveBeenCalledWith(
      "s1",
      expect.any(String),
      expect.objectContaining({ mechanism: "tag-triggered" }),
    );
  });

  it("propose: omits the mechanism when shipit.yaml has none (card defaults to tag-triggered)", async () => {
    const { deps, poller } = makeDeps();
    const sessionDir = makeSessionDir({ "package.json": `{"version":"0.2.0"}` });
    await reactToReleaseMarkers({ deps, sessionId: "s1", sessionDir, turnText: PROPOSE });
    const arg = (poller.propose as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(arg).not.toHaveProperty("mechanism");
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
