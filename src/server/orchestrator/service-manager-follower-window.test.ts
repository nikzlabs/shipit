/**
 * nikzlabs/shipit#2426 — the log follower's replay window.
 *
 * `streamLogs` used to spawn `docker compose logs -f --tail 0` on every restart
 * once the durable store held the service's channel, and the callers attached it
 * only after `up` had returned AND after a network join and a status poll. Every
 * line the fresh container printed in that gap was lost for good: the ring
 * buffer is cleared at the top of `streamLogs`, the store never received the
 * lines, and `snapshotLogs` prefers the store over a fresh `docker compose logs`.
 * A service that printed diagnostics and exited was therefore completely silent,
 * which is how the reporter concluded a `docker-compose.yml` `command:` edit had
 * never been applied — it had.
 *
 * The fix stamps an anchor immediately before each `up` and follows with
 * `--since <anchor>`. These tests pin the three properties that makes it safe:
 * the window is opened (replay), it starts no earlier than the `up` (no
 * duplicated history), and it is not opened when nothing armed it.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Every `docker` argv the manager spawns, in order. */
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
    // `killChild` refuses to signal a process that never exec'd, so the
    // follower the manager replaces needs a pid to be killable.
    proc.pid = 4242;
    return proc;
  },
}));

const { ServiceManager } = await import("./service-manager.js");
const { LogStore } = await import("./log-store.js");

const MANUAL_COMPOSE =
  "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n    x-shipit-preview: manual\n";

/** The follower argv for `name` — `logs` in follow mode, newest first. */
function followerArgs(name: string): string[] | undefined {
  return [...spawnCalls].reverse().find((a) => {
    const i = a.indexOf("logs");
    return i >= 0 && a[i + 1] === "-f" && a[a.length - 1] === name;
  });
}

/** Value of `--since` in a follower argv, or null when it follows from now. */
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

  /**
   * A manager over a real clone with one manual service, a stubbed compose
   * runner, and a durable store. `order` records compose *queries* (the poller)
   * alongside the follower spawn, so a test can assert which came first.
   */
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
      // Markers land in `spawnCalls` too, so one array orders the compose
      // commands and the follower spawn against each other.
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

  /** Put a container's history in the store, as an earlier follower would have. */
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
    // The bug: `--tail 0` starts the follower at the moment it attaches, which
    // is two Docker round trips after the container began printing.
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
    // Everything above belongs to the previous container. A window that reached
    // back before this point would re-persist lines the store already holds.
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

    // A bare re-attach — the follower died but no `up` ran. Replaying from an
    // older anchor here could duplicate lines the dead follower already stored.
    mgr.streamLogs("web");

    const args = followerArgs("web")!;
    expect(sinceOf(args)).toBeNull();
    expect(args.slice(args.indexOf("--tail"), args.indexOf("--tail") + 2)).toEqual(["--tail", "0"]);

    await mgr.stop();
  });

  it("replays full history the first time, before the store is seeded", async () => {
    const { mgr } = makeManager();
    await mgr.start();
    spawnCalls.length = 0;

    await mgr.startService("web");

    const args = followerArgs("web")!;
    // Nothing persisted yet, so the `--tail 1000` seed pass still wins — the
    // anchor must not shrink a cold channel's backlog.
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
    // The poll is a Docker round trip the fresh container spends printing. With
    // the follower still behind it, those lines fell in the gap — and the
    // poll's own `onRunning` re-attach would have claimed the anchor first,
    // only to be killed and replaced by an unanchored follower.
    const pollIdx = spawnCalls.findIndex((a, i) => a[0] === "__query__" && i > upIdx);
    expect(pollIdx).toBeGreaterThan(followerIdx);

    await mgr.stop();
  });
});
