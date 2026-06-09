import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Capture every `docker` invocation and let each test drive what the snapshot
// (`logs --tail`, no `-f`) call writes to stdout.
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
    // composeArgs always carries `-f <file>` flags, so follow mode is detected
    // by `-f` appearing immediately after the `logs` subcommand, not anywhere.
    const logsIdx = args.indexOf("logs");
    const isFollow = logsIdx >= 0 && args[logsIdx + 1] === "-f";
    // Snapshot reads (logs, not following) emit canned output then close.
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

describe("ServiceManager.snapshotLogs", () => {
  let tmpDir: string;

  afterEach(() => {
    spawnCalls.length = 0;
    snapshotStdout = "";
    snapshotShouldError = false;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build a manager and white-box-register a service (no docker start). */
  function makeManager(): InstanceType<typeof ServiceManager> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-snap-"));
    fs.writeFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n",
    );
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: tmpDir,
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: () => Promise.resolve(),
      pollIntervalMs: 0,
    });
    // Register `web` without going through start() (which spawns docker).
    (mgr as unknown as { services: Map<string, { name: string }> }).services.set("web", { name: "web" });
    return mgr;
  }

  it("returns a fresh `logs --tail` snapshot, not the in-memory buffer", async () => {
    const mgr = makeManager();
    // Seed the stale ring buffer with different content to prove it's not used.
    (mgr as unknown as { logBuffers: Map<string, string> }).logBuffers.set("web", "STALE\n");

    snapshotStdout = "line one\nline two\nline three\n";
    const out = await mgr.snapshotLogs("web", 500);

    expect(out).toBe(snapshotStdout);
    const snapArgs = spawnCalls.find((a) => a.includes("logs"));
    expect(snapArgs).toBeDefined();
    expect(snapArgs).toContain("--tail");
    expect(snapArgs).toContain("500");
    // One-shot read: no follow flag immediately after the `logs` subcommand
    // (the `-f` that is present belongs to the `-f <compose-file>` flags).
    const logsIdx = snapArgs!.indexOf("logs");
    expect(snapArgs![logsIdx + 1]).not.toBe("-f");
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
