import { describe, it, expect, beforeEach, vi } from "vitest";

const workerGet = vi.fn();
const workerInstall = vi.fn();
vi.mock("./worker-http.js", () => ({
  workerGet: (...args: unknown[]) => workerGet(...args),
  workerInstall: (...args: unknown[]) => workerInstall(...args),
}));
vi.mock("../shared/shipit-config.js", () => ({
  resolveShipitConfig: () => ({ agent: { install: ["npm ci"] } }),
}));

import { createWarmPool } from "./warm-pool-manager.js";
import type { WarmPoolDeps } from "./warm-pool-manager.js";
import type { RepoStore } from "./repo-store.js";
import type { SessionContainerManager } from "./session-container.js";

const REPO = "https://github.com/acme/app.git";
const TARGET = { sessionId: "warm-1", workspaceDir: "/sessions/warm-1/workspace", repoUrl: REPO };

/**
 * The periodic sweep repairs a warm preview through `repairWarmPreview`. It must pass the same gates
 * as the warm flow: a trusted remote and a settled install (docs/288 req 2), before any compose up.
 */
describe("repairWarmPreview", () => {
  let trusted: boolean;
  let wanted: boolean;
  let preStartPreview: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    trusted = true;
    wanted = true;
    preStartPreview = vi.fn(async () => undefined);
    workerGet.mockReset();
    workerInstall.mockReset();
    workerInstall.mockResolvedValue({ skipped: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  function pool() {
    return createWarmPool({
      repoStore: { isTrusted: () => trusted } as unknown as RepoStore,
      containerManager: {
        get: () => ({ status: "running", workerUrl: "http://worker:1" }),
      } as unknown as SessionContainerManager,
      preStartPreview,
      previewWanted: () => wanted,
    } as unknown as WarmPoolDeps);
  }

  it("starts the preview once the standby's install has settled", async () => {
    workerGet.mockResolvedValue({ running: false, lastResult: { ok: true } });
    await pool().repairWarmPreview(TARGET);
    expect(workerInstall).toHaveBeenCalledTimes(1);
    expect(preStartPreview).toHaveBeenCalledWith(TARGET);
  });

  it("never starts an untrusted repository's services", async () => {
    trusted = false;
    workerGet.mockResolvedValue({ running: false, lastResult: { ok: true } });
    await pool().repairWarmPreview(TARGET);
    expect(workerInstall).not.toHaveBeenCalled();
    expect(preStartPreview).not.toHaveBeenCalled();
  });

  it("waits while the pre-install is still running", async () => {
    workerGet.mockResolvedValue({ running: true, lastResult: null });
    await pool().repairWarmPreview(TARGET);
    expect(workerInstall).not.toHaveBeenCalled();
    expect(preStartPreview).not.toHaveBeenCalled();
  });

  it("does not retry a failed pre-install unattended", async () => {
    workerGet.mockResolvedValue({ running: false, lastResult: { ok: false } });
    await pool().repairWarmPreview(TARGET);
    expect(workerInstall).not.toHaveBeenCalled();
    expect(preStartPreview).not.toHaveBeenCalled();
  });

  it("runs the pre-install first when the standby never ran one, and stops if it fails", async () => {
    workerInstall.mockResolvedValue({ started: true });
    workerGet
      .mockResolvedValueOnce({ running: false, lastResult: null })
      .mockResolvedValue({ running: false, lastResult: { ok: false } });
    vi.useFakeTimers();
    try {
      const repair = pool().repairWarmPreview(TARGET);
      await vi.advanceTimersByTimeAsync(2_500);
      await repair;
    } finally {
      vi.useRealTimers();
    }
    expect(workerInstall).toHaveBeenCalledTimes(1);
    expect(preStartPreview).not.toHaveBeenCalled();
  });

  it("asks nothing of the worker when no preview is wanted", async () => {
    wanted = false;
    await pool().repairWarmPreview(TARGET);
    expect(workerGet).not.toHaveBeenCalled();
    expect(preStartPreview).not.toHaveBeenCalled();
  });
});

/** The sweep keeps a recent repo's warm clone on the default branch (docs/288 req 13). */
describe("refreshWarmSession", () => {
  let lastUsedAt: string | undefined;
  let trusted: boolean;
  let refreshWarmClone: ReturnType<typeof vi.fn>;
  let setInstallRunning: ReturnType<typeof vi.fn>;
  let containerStatus: string;

  beforeEach(() => {
    lastUsedAt = new Date().toISOString();
    trusted = true;
    containerStatus = "running";
    refreshWarmClone = vi.fn(async () => ({ headChanged: true }));
    setInstallRunning = vi.fn(() => true);
    workerGet.mockReset();
    workerInstall.mockReset();
    workerGet.mockResolvedValue({ running: false, lastResult: { ok: true } });
    workerInstall.mockResolvedValue({ skipped: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  function pool() {
    return createWarmPool({
      repoStore: {
        isTrusted: () => trusted,
        get: () => ({ url: REPO, warmSessionId: TARGET.sessionId, lastUsedAt }),
      } as unknown as RepoStore,
      containerManager: {
        get: () => ({ status: containerStatus, workerUrl: "http://worker:1" }),
      } as unknown as SessionContainerManager,
      refreshWarmClone,
      previewGate: () => ({ setInstallRunning }),
    } as unknown as WarmPoolDeps);
  }

  async function withPolling(run: () => Promise<void>): Promise<void> {
    vi.useFakeTimers();
    try {
      const done = run();
      await vi.advanceTimersByTimeAsync(2_500);
      await done;
    } finally {
      vi.useRealTimers();
    }
  }

  it("leaves a repo nobody opened in the last 7 days alone", async () => {
    lastUsedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await pool().refreshWarmSession(TARGET);
    expect(refreshWarmClone).not.toHaveBeenCalled();
  });

  it("leaves an untrusted repository alone", async () => {
    trusted = false;
    await pool().refreshWarmSession(TARGET);
    expect(refreshWarmClone).not.toHaveBeenCalled();
  });

  it("waits while the standby is still installing", async () => {
    workerGet.mockResolvedValue({ running: true });
    await pool().refreshWarmSession(TARGET);
    expect(refreshWarmClone).not.toHaveBeenCalled();
  });

  it("asks for no install when the clone did not move", async () => {
    refreshWarmClone.mockResolvedValue({ headChanged: false });
    await pool().refreshWarmSession(TARGET);
    expect(workerInstall).not.toHaveBeenCalled();
  });

  it("keeps the running preview when the worker skips the install", async () => {
    await pool().refreshWarmSession(TARGET);
    expect(workerInstall).toHaveBeenCalledTimes(1);
    expect(setInstallRunning).not.toHaveBeenCalled();
  });

  it("holds the pre-started services for a real install, and releases them when it settles", async () => {
    workerInstall.mockResolvedValue({ started: true });
    await withPolling(() => pool().refreshWarmSession(TARGET));
    expect(setInstallRunning.mock.calls).toEqual([[true], [false, { failed: false }]]);
  });

  it("releases the hold as failed when the install fails", async () => {
    workerInstall.mockResolvedValue({ started: true });
    workerGet
      .mockResolvedValueOnce({ running: false, lastResult: { ok: true } })
      .mockResolvedValue({ running: false, lastResult: { ok: false } });
    await withPolling(() => pool().refreshWarmSession(TARGET));
    expect(setInstallRunning.mock.calls).toEqual([[true], [false, { failed: true }]]);
  });

  it("keeps holding past the poll's limit, and releases on the install's real end", async () => {
    workerInstall.mockResolvedValue({ started: true });
    let running = true;
    workerGet
      .mockResolvedValueOnce({ running: false, lastResult: { ok: true } })
      .mockImplementation(async () => ({ running, lastResult: running ? null : { ok: true } }));
    vi.useFakeTimers();
    try {
      const refresh = pool().refreshWarmSession(TARGET);
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 5_000);
      await refresh;
      expect(setInstallRunning.mock.calls).toEqual([[true]]);

      running = false;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(setInstallRunning.mock.calls).toEqual([[true], [false, { failed: false }]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("past the poll's limit, keeps holding while the worker does not answer", async () => {
    workerInstall.mockResolvedValue({ started: true });
    let answering = true;
    let running = true;
    workerGet
      .mockResolvedValueOnce({ running: false, lastResult: { ok: true } })
      .mockImplementation(async () => {
        if (!answering) throw new Error("socket hang up");
        return { running, lastResult: running ? null : { ok: true } };
      });
    vi.useFakeTimers();
    try {
      const refresh = pool().refreshWarmSession(TARGET);
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 5_000);
      await refresh;
      answering = false;
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(setInstallRunning.mock.calls).toEqual([[true]]);

      answering = true;
      running = false;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(setInstallRunning.mock.calls).toEqual([[true], [false, { failed: false }]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("past the poll's limit, releases the hold as failed once the container is gone", async () => {
    workerInstall.mockResolvedValue({ started: true });
    workerGet
      .mockResolvedValueOnce({ running: false, lastResult: { ok: true } })
      .mockResolvedValue({ running: true, lastResult: null });
    vi.useFakeTimers();
    try {
      const refresh = pool().refreshWarmSession(TARGET);
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 5_000);
      await refresh;
      containerStatus = "stopped";
      await vi.advanceTimersByTimeAsync(10_000);
      expect(setInstallRunning.mock.calls).toEqual([[true], [false, { failed: true }]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not release a hold another caller opened", async () => {
    workerInstall.mockResolvedValue({ started: true });
    setInstallRunning.mockReturnValue(false);
    await withPolling(() => pool().refreshWarmSession(TARGET));
    expect(setInstallRunning.mock.calls).toEqual([[true]]);
  });

  it("retries an install request that never reached the worker, though HEAD has not moved since", async () => {
    const warm = pool();
    workerInstall.mockRejectedValueOnce(new Error("socket hang up"));
    await warm.refreshWarmSession(TARGET);

    refreshWarmClone.mockResolvedValue({ headChanged: false });
    await warm.refreshWarmSession(TARGET);
    expect(workerInstall).toHaveBeenCalledTimes(2);

    await warm.refreshWarmSession(TARGET);
    expect(workerInstall).toHaveBeenCalledTimes(2);
  });
});
