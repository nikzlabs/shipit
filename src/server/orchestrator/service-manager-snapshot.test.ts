import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ServiceManager } from "./service-manager.js";
import { composeProjectName } from "./compose-stack-reaper.js";

const spawnCalls: string[][] = [];
let snapshotStdout = "";
let snapshotShouldError = false;

vi.mock("node:child_process", () => ({
  spawn: (_cmd: string, args: string[]) => {
    spawnCalls.push(args);
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    const logsIdx = args.indexOf("logs");
    const isFollow = logsIdx >= 0 && args[logsIdx + 1] === "-f";
    if (logsIdx >= 0 && !isFollow) {
      queueMicrotask(() => {
        if (snapshotShouldError) {
          proc.emit("error", new Error("docker missing"));
          return;
        }
        if (snapshotStdout) proc.stdout.emit("data", Buffer.from(snapshotStdout));
        proc.emit("close", 0);
      });
    }
    return proc;
  },
}));

const { LogStore } = await import("./log-store.js");
const { testServiceManager } = await import("./compose-test-helpers.js");

describe("ServiceManager.snapshotLogs", () => {
  let tmpDir: string;

  afterEach(() => {
    spawnCalls.length = 0;
    snapshotStdout = "";
    snapshotShouldError = false;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeManager(logStore?: InstanceType<typeof LogStore>): ServiceManager {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-snap-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "docker-compose.yml"),
      "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n",
    );
    const mgr = testServiceManager({
      sessionId: "test-session",
      workspaceDir,
      serviceEnvDir: path.join(tmpDir, "service-env"),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: () => Promise.resolve(),
      pollIntervalMs: 0,
      ...(logStore ? { logStore } : {}),
    });
    (mgr as unknown as { services: Map<string, { name: string }> }).services.set("web", { name: "web" });
    return mgr;
  }

  it("returns a fresh `logs --tail` snapshot, not the in-memory buffer", async () => {
    const mgr = makeManager();
    (mgr as unknown as { logBuffers: Map<string, string> }).logBuffers.set("web", "STALE\n");

    snapshotStdout = "line one\nline two\nline three\n";
    const out = await mgr.snapshotLogs("web", 500);

    expect(out).toBe(snapshotStdout);
    const snapArgs = spawnCalls.find((a) => a.includes("logs"));
    expect(snapArgs).toBeDefined();
    expect(snapArgs).toContain("--tail");
    expect(snapArgs).toContain("500");
    const logsIdx = snapArgs!.indexOf("logs");
    expect(snapArgs![logsIdx + 1]).not.toBe("-f");
    expect(snapArgs!.slice(0, logsIdx)).toEqual(["compose", "-p", composeProjectName("test-session")]);
  });

  it("prefers the durable LogStore as the source of truth (docs/192), without spawning docker", async () => {
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svc-snap-store-"));
    try {
      const logStore = new LogStore(storeRoot);
      const mgr = makeManager(logStore);
      snapshotStdout = "DOCKER STALE\n";
      logStore.append("test-session", "service:web", "durable line one\ndurable line two\n");
      await logStore.drain();

      const out = await mgr.snapshotLogs("web");
      expect(out).toBe("durable line one\ndurable line two\n");
      expect(spawnCalls.find((a) => a.includes("logs"))).toBeUndefined();
    } finally {
      fs.rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  async function seededManager(storeRoot: string, lineCount: number): Promise<ServiceManager> {
    const logStore = new LogStore(storeRoot);
    const mgr = makeManager(logStore);
    const stored = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}\n`).join("");
    logStore.append("test-session", "service:web", stored);
    await logStore.drain();
    return mgr;
  }

  it("returns only the last `lines` lines of the LogStore snapshot", async () => {
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svc-snap-tail-"));
    try {
      const mgr = await seededManager(storeRoot, 10);

      expect(await mgr.snapshotLogs("web", 3)).toBe("line 8\nline 9\nline 10\n");
      expect(await mgr.snapshotLogs("web", 50)).toBe(
        Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join(""),
      );
      expect(spawnCalls.find((a) => a.includes("logs"))).toBeUndefined();
    } finally {
      fs.rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  it("applies no line limit to the LogStore snapshot when `lines` is not given", async () => {
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svc-snap-default-"));
    try {
      const mgr = await seededManager(storeRoot, 2500);

      const out = await mgr.snapshotLogs("web");
      expect(out.split("\n").filter(Boolean)).toHaveLength(2500);
      expect(out.startsWith("line 1\n")).toBe(true);
    } finally {
      fs.rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  it("falls back to `docker logs` before the store is seeded", async () => {
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svc-snap-empty-"));
    try {
      const mgr = makeManager(new LogStore(storeRoot));
      snapshotStdout = "from docker\n";
      const out = await mgr.snapshotLogs("web");
      expect(out).toBe("from docker\n");
      const snapArgs = spawnCalls.find((a) => a.includes("logs"));
      expect(snapArgs).toBeDefined();
      expect(snapArgs![snapArgs!.indexOf("--tail") + 1]).toBe("2000");
    } finally {
      fs.rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  it("returns empty string for an unknown service without spawning docker", async () => {
    const mgr = makeManager();
    const out = await mgr.snapshotLogs("nope");
    expect(out).toBe("");
    expect(spawnCalls).toHaveLength(0);
  });

  it("falls back to the in-memory ring buffer when the snapshot command errors", async () => {
    const mgr = makeManager();
    (mgr as unknown as { logBuffers: Map<string, string> }).logBuffers.set("web", "buffered fallback\n");

    snapshotShouldError = true;
    await expect(mgr.snapshotLogs("web")).resolves.toBe("buffered fallback\n");
  });

  it.each([
    ["errors", true],
    ["prints nothing", false],
  ])("applies `lines` to the in-memory fallback when the snapshot command %s", async (_case, shouldError) => {
    const mgr = makeManager();
    (mgr as unknown as { logBuffers: Map<string, string> }).logBuffers.set("web", "one\ntwo\nthree\n");

    snapshotShouldError = shouldError;
    await expect(mgr.snapshotLogs("web", 1)).resolves.toBe("three\n");
  });
});
