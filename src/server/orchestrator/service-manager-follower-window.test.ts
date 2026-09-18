import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const spawnCalls: string[][] = [];

vi.mock("node:child_process", () => ({
  spawn: (_cmd: string, args: string[]) => {
    spawnCalls.push(args);
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
      pid: number;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    // killChild skips processes without a PID.
    proc.pid = 4242;
    return proc;
  },
}));

const { ServiceManager } = await import("./service-manager.js");
const { LogStore } = await import("./log-store.js");

const MANUAL_COMPOSE =
  "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n    x-shipit-preview: manual\n";

function followerArgs(name: string): string[] | undefined {
  return [...spawnCalls].reverse().find((a) => {
    const i = a.indexOf("logs");
    return i >= 0 && a[i + 1] === "-f" && a[a.length - 1] === name;
  });
}

function sinceOf(args: string[]): string | null {
  const i = args.indexOf("--since");
  return i >= 0 ? args[i + 1] : null;
}

describe("ServiceManager log-follower replay window (#2426)", () => {
  let tmpDir: string | undefined;
  let storeRoot: string | undefined;

  afterEach(() => {
    spawnCalls.length = 0;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (storeRoot) fs.rmSync(storeRoot, { recursive: true, force: true });
    tmpDir = storeRoot = undefined;
    vi.restoreAllMocks();
  });

  function makeManager(opts: { seedStore?: boolean } = {}) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-follow-"));
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svc-follow-store-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), MANUAL_COMPOSE);

    const logStore = new LogStore(storeRoot);
    const order: string[] = [];
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir,
      serviceEnvDir: path.join(tmpDir, "service-env"),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: async (args: string[]) => {
        if (args.includes("up")) { order.push("up"); spawnCalls.push(["__up__"]); }
        if (args.includes("stop")) { order.push("stop"); spawnCalls.push(["__stop__"]); }
      },
      composeQuery: async () => {
        order.push("query");
        spawnCalls.push(["__query__"]);
        return "";
      },
      pollIntervalMs: 0,
      logStore,
    });
    return { mgr, logStore, order, seed: opts.seedStore ?? false };
  }

  async function seedChannel(logStore: InstanceType<typeof LogStore>): Promise<void> {
    logStore.append("test-session", "service:web", "line from the previous container\n");
    await logStore.drain();
  }

  it("replays what the new container printed while the restart finished", async () => {
    const { mgr, logStore } = makeManager();
    await mgr.start();
    await seedChannel(logStore);
    spawnCalls.length = 0;

    const before = new Date().toISOString();
    await mgr.restartService("web");

    const args = followerArgs("web");
    expect(args).toBeDefined();
    expect(args).not.toContain("0");
    const since = sinceOf(args!);
    expect(since).not.toBeNull();
    expect(since! >= before).toBe(true);

    await mgr.stop();
  });

  it("anchors the window at the `up`, so persisted history is not replayed", async () => {
    const { mgr, logStore } = makeManager();
    await mgr.start();
    await seedChannel(logStore);
    const restartBegan = new Date().toISOString();
    spawnCalls.length = 0;

    await mgr.restartService("web");

    const since = sinceOf(followerArgs("web")!);
    expect(since).not.toBeNull();
    expect(since! >= restartBegan).toBe(true);

    await mgr.stop();
  });

  it("still follows from now when no `up` armed a window", async () => {
    const { mgr, logStore } = makeManager();
    await mgr.start();
    await seedChannel(logStore);
    spawnCalls.length = 0;

    mgr.streamLogs("web");

    const args = followerArgs("web")!;
    expect(sinceOf(args)).toBeNull();
    expect(args.slice(args.indexOf("--tail"), args.indexOf("--tail") + 2)).toEqual(["--tail", "0"]);

    await mgr.stop();
  });

  it("drops an anchor no follower claimed, so a later re-attach cannot replay it", async () => {
    const { mgr, logStore } = makeManager();
    await mgr.start();
    await seedChannel(logStore);
    spawnCalls.length = 0;

    const armed = mgr as unknown as {
      armLogFollowerSince: (n: string[]) => void;
      disarmLogFollowerSince: (n: string[]) => void;
      followerSince: Map<string, string>;
    };
    armed.armLogFollowerSince(["web"]);
    armed.disarmLogFollowerSince(["web"]);
    expect(armed.followerSince.has("web")).toBe(false);

    mgr.streamLogs("web");
    expect(sinceOf(followerArgs("web")!)).toBeNull();

    await mgr.stop();
  });

  it("keeps the anchor for the retry path, whose follower attaches at the poll", async () => {
    const { mgr, logStore } = makeManager();
    await mgr.start();
    await seedChannel(logStore);
    spawnCalls.length = 0;

    const armed = mgr as unknown as {
      armLogFollowerSince: (n: string[]) => void;
      followerSince: Map<string, string>;
    };
    armed.armLogFollowerSince(["web"]);
    mgr.streamLogs("web");

    expect(sinceOf(followerArgs("web")!)).not.toBeNull();

    await mgr.stop();
  });

  it("replays full history the first time, before the store is seeded", async () => {
    const { mgr } = makeManager();
    await mgr.start();
    spawnCalls.length = 0;

    await mgr.startService("web");

    const args = followerArgs("web")!;
    expect(sinceOf(args)).toBeNull();
    expect(args.slice(args.indexOf("--tail"), args.indexOf("--tail") + 2)).toEqual(["--tail", "1000"]);

    await mgr.stop();
  });

  it("attaches the follower between the `up` and the poll that follows it", async () => {
    const { mgr, logStore } = makeManager();
    await mgr.start();
    await seedChannel(logStore);
    spawnCalls.length = 0;

    await mgr.restartService("web");

    const idxOf = (marker: string) => spawnCalls.findIndex((a) => a[0] === marker);
    const followerIdx = spawnCalls.findIndex((a) => {
      const i = a.indexOf("logs");
      return i >= 0 && a[i + 1] === "-f";
    });
    const upIdx = idxOf("__up__");
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(followerIdx).toBeGreaterThan(upIdx);
    const pollIdx = spawnCalls.findIndex((a, i) => a[0] === "__query__" && i > upIdx);
    expect(pollIdx).toBeGreaterThan(followerIdx);

    await mgr.stop();
  });
});
