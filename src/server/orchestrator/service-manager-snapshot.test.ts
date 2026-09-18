import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
    // Earlier -f flags select Compose files, not log follow mode.
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

const { ServiceManager } = await import("./service-manager.js");
const { LogStore } = await import("./log-store.js");

describe("ServiceManager.snapshotLogs", () => {
  let tmpDir: string;

  afterEach(() => {
    spawnCalls.length = 0;
    snapshotStdout = "";
    snapshotShouldError = false;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeManager(logStore?: InstanceType<typeof LogStore>): InstanceType<typeof ServiceManager> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-snap-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "docker-compose.yml"),
      "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n",
    );
    const mgr = new ServiceManager({
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

  it("falls back to `docker logs` before the store is seeded", async () => {
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svc-snap-empty-"));
    try {
      const mgr = makeManager(new LogStore(storeRoot));
      snapshotStdout = "from docker\n";
      const out = await mgr.snapshotLogs("web");
      expect(out).toBe("from docker\n");
      expect(spawnCalls.find((a) => a.includes("logs"))).toBeDefined();
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
});
