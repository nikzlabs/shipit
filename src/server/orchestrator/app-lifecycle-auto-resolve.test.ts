/**
 * The auto-resolve callback builds a GitManager on the session's checkout. That
 * construction throws SYNCHRONOUSLY when the directory is absent, and the disk
 * janitor evicts an idle session's checkout as a matter of routine — so the
 * rejection has to be answered here, not by the manager's catch-all, which
 * records an "error" and spends one of only three attempts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "../shared/git.js";
import type { AutoResolveResult, RebaseAndResolveCb } from "./auto-conflict-resolve-manager.js";

const captured: { rebaseAndResolveCb?: RebaseAndResolveCb } = {};

vi.mock("./pr-status-poller.js", () => ({
  PrStatusPoller: class {
    constructor(opts: { rebaseAndResolveCb?: RebaseAndResolveCb }) {
      captured.rebaseAndResolveCb = opts.rebaseAndResolveCb;
    }
    loadPersisted(): void {}
    trackSession(): void {}
  },
}));

vi.mock("./services/rebase-driver.js", () => ({
  runAutoResolveAttempt: vi.fn(
    (): Promise<AutoResolveResult> =>
      Promise.resolve({ outcome: "success", forcePushed: true, didWork: true }),
  ),
}));

import { runAutoResolveAttempt } from "./services/rebase-driver.js";
import { createPrStatusPoller, type PrPollerDeps } from "./app-lifecycle.js";

let tmpDir: string;

function buildCb(sessionDir: string | undefined): RebaseAndResolveCb {
  delete captured.rebaseAndResolveCb;
  const runner = sessionDir === undefined ? undefined : { sessionDir };
  createPrStatusPoller({
    deps: {},
    githubAuthManager: {},
    sessionManager: { list: () => [], get: () => undefined },
    sseBroadcast: () => {},
    runnerRegistry: { get: () => runner },
    defaultAgentId: "claude",
    createRepoGit: (dir: string) => ({ dir }),
    createGitManager: (dir: string) => new GitManager(dir),
    getBareCacheDir: () => path.join(tmpDir, "cache"),
    chatHistoryManager: {},
    usageManager: {},
  } as unknown as PrPollerDeps);
  const cb = captured.rebaseAndResolveCb;
  if (!cb) throw new Error("rebaseAndResolveCb was not wired");
  return cb;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-resolve-checkout-"));
  vi.mocked(runAutoResolveAttempt).mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createPrStatusPoller: auto-resolve against an evicted checkout", () => {
  it("defers instead of spending an attempt when the checkout is gone", async () => {
    const cb = buildCb(path.join(tmpDir, "reclaimed-workspace"));

    const result = await cb("sess-evicted", "main");

    // "deferred" costs no attempt and retries after the short cooldown; "error"
    // would burn one of three and, three ticks later, exhaust the session.
    expect(result).toEqual({ outcome: "deferred", lastError: "no_checkout", didWork: false });
    expect(runAutoResolveAttempt).not.toHaveBeenCalled();
  });

  it("still runs the attempt when the checkout is on disk", async () => {
    const cb = buildCb(tmpDir);

    const result = await cb("sess-hot", "main");

    expect(result.outcome).toBe("success");
    expect(runAutoResolveAttempt).toHaveBeenCalledTimes(1);
  });

  it("defers without touching git when there is no runner at all", async () => {
    const cb = buildCb(undefined);

    expect(await cb("sess-cold", "main")).toEqual({
      outcome: "deferred", lastError: "no_runner", didWork: false,
    });
    expect(runAutoResolveAttempt).not.toHaveBeenCalled();
  });
});
