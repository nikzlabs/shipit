/**
 * Unit coverage for the orchestrator half of the service-control bridge
 * (docs/238) — `ContainerSessionRunner.handleServiceRequest`.
 *
 * The regressions guarded here:
 *
 *  - start/restart used to return a HARDCODED `{ ok: true, status: "running" }`,
 *    discarding the fresh `pollOnce` they had just performed. A container that
 *    started and immediately exited 127 still reported `running`, so the agent
 *    proceeded against a dead service. The result must reflect what the manager
 *    actually holds after the mutation.
 *  - `logs` did not exist on this bridge at all, so the CLI's timeout message
 *    ("read progress with `shipit service logs`") had nothing to point at.
 *
 * `workerPost` is mocked so the callback leg is observable without a socket —
 * it is also the only place the result is visible, since `handleServiceRequest`
 * returns void and reports by POSTing to the worker.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ManagedService, ServiceManager } from "./service-manager.js";

const workerPost = vi.fn().mockResolvedValue({});
vi.mock("./worker-http.js", () => ({
  workerPost: (...args: unknown[]) => workerPost(...args),
  workerGet: vi.fn().mockResolvedValue({}),
  workerInstall: vi.fn().mockResolvedValue({}),
  workerPushAgentSecrets: vi.fn().mockResolvedValue({}),
  workerPostMessage: vi.fn().mockResolvedValue({}),
  // The runner compares its constructor URL against this sentinel and throws
  // this error when it has no reachable worker — both must exist on the mock.
  PLACEHOLDER_WORKER_URL: "http://0.0.0.0:0",
  WorkerUnavailableError: class WorkerUnavailableError extends Error {},
}));

const { ContainerSessionRunner } = await import("./container-session-runner.js");

type Runner = InstanceType<typeof ContainerSessionRunner>;

interface FakeManagerOptions {
  services: ManagedService[];
  /**
   * Fields to merge into the service row when it starts, on top of the default
   * `status: "running"` — e.g. the container IP a real poll would have
   * discovered, or an `error` for a container that exited immediately.
   */
  onStart?: (name: string) => Partial<ManagedService>;
  startError?: Error;
  logs?: string;
}

/**
 * Minimal ServiceManager stand-in. `startService` mutates the backing rows the
 * same way the real one does (mutate, then poll), which is exactly the sequence
 * the "report the real status" fix depends on.
 */
function makeManager(opts: FakeManagerOptions) {
  const rows = new Map(opts.services.map((s) => [s.name, { ...s }]));
  const calls: string[] = [];

  const mgr = {
    calls,
    getServices: (): ManagedService[] =>
      [...rows.values()].map((svc) =>
        svc.status === "running" && svc.containerIp && svc.port
          ? { ...svc, url: `http://${svc.containerIp}:${svc.port}/` }
          : { ...svc },
      ),
    getService: (name: string) => rows.get(name),
    startService: async (name: string) => {
      calls.push(`start:${name}`);
      if (opts.startError) throw opts.startError;
      const row = rows.get(name);
      if (!row) throw new Error(`Unknown service: ${name}`);
      Object.assign(row, { status: "running" }, opts.onStart?.(name) ?? {});
    },
    stopService: async (name: string) => {
      calls.push(`stop:${name}`);
      Object.assign(rows.get(name)!, { status: "stopped", containerIp: undefined });
    },
    restartService: async (name: string) => {
      calls.push(`restart:${name}`);
      Object.assign(rows.get(name)!, { status: "running" }, opts.onStart?.(name) ?? {});
    },
    snapshotLogs: async (name: string, lines?: number) => {
      calls.push(`logs:${name}:${lines}`);
      return opts.logs ?? "";
    },
  };
  return mgr;
}

function svc(name: string, over: Partial<ManagedService> = {}): ManagedService {
  return { name, preview: "manual", status: "stopped", dependsOnInstall: false, ...over };
}

/**
 * Drive one service request and return the payload the runner POSTed back to
 * the worker's `/services/_callback`.
 */
async function request(
  manager: ReturnType<typeof makeManager>,
  action: string,
  name?: string,
  lines?: number,
): Promise<{ result?: Record<string, unknown>; error?: string }> {
  const runner = new ContainerSessionRunner({
    sessionId: "s1",
    sessionDir: "/tmp/s1",
    defaultAgentId: "claude",
    workerUrl: "http://127.0.0.1:1",
  }) as Runner;

  // Assign directly rather than via setServiceManager(): that wires event
  // listeners the fake doesn't implement, and they're irrelevant here.
  (runner as unknown as { _serviceManager: unknown })._serviceManager =
    manager as unknown as ServiceManager;

  await (
    runner as unknown as {
      handleServiceRequest(id: string, action: string, name?: string, lines?: number): Promise<void>;
    }
  ).handleServiceRequest("req-1", action, name, lines);

  const payload = workerPost.mock.calls.at(-1)?.[2] as {
    result?: Record<string, unknown>;
    error?: string;
  };
  return payload ?? {};
}

beforeEach(() => workerPost.mockClear());

describe("handleServiceRequest — list", () => {
  it("includes the agent-reachable url alongside status and port", async () => {
    const mgr = makeManager({
      services: [
        svc("web", { status: "running", preview: "auto", port: 5173, containerIp: "172.20.0.3" }),
        svc("db", { port: 5432 }),
      ],
    });
    const { result } = await request(mgr, "list");
    const services = result!.services as Record<string, unknown>[];

    expect(services).toHaveLength(2);
    expect(services[0]).toMatchObject({
      name: "web",
      status: "running",
      port: 5173,
      url: "http://172.20.0.3:5173/",
    });
    expect(services[1]).toMatchObject({ name: "db", status: "stopped" });
  });

  it("carries a per-service error through", async () => {
    const mgr = makeManager({ services: [svc("web", { status: "error", error: "exit 127" })] });
    const { result } = await request(mgr, "list");
    expect((result!.services as Record<string, unknown>[])[0].error).toBe("exit 127");
  });
});

describe("handleServiceRequest — start", () => {
  it("reports the POLLED status and url, not a hardcoded 'running'", async () => {
    const mgr = makeManager({
      services: [svc("db", { port: 5432 })],
      onStart: () => ({ containerIp: "172.20.0.4" }),
    });
    const { result } = await request(mgr, "start", "db");

    expect(mgr.calls).toContain("start:db");
    expect(result).toMatchObject({
      ok: true,
      name: "db",
      status: "running",
      url: "http://172.20.0.4:5432/",
    });
  });

  it("reports ok:false with the reason when the service comes up in error", async () => {
    // The pre-238 bug: the container exits immediately, the poll marks it
    // `error`, and the bridge nonetheless answered "running".
    const mgr = makeManager({
      services: [svc("web", { preview: "auto", port: 5173 })],
      onStart: () => ({ status: "error", error: "exit 127" }),
    });
    const { result } = await request(mgr, "start", "web");

    expect(result).toMatchObject({ ok: false, name: "web", status: "error", error: "exit 127" });
    expect(result!.url).toBeUndefined();
  });

  it("treats an already-running service as a no-op instead of re-upping it", async () => {
    const mgr = makeManager({
      services: [svc("web", { status: "running", port: 5173, containerIp: "172.20.0.3" })],
    });
    const { result } = await request(mgr, "start", "web");

    expect(result).toMatchObject({ alreadyRunning: true, status: "running" });
    expect(mgr.calls).not.toContain("start:web");
  });

  it("reports a thrown start as an error", async () => {
    const mgr = makeManager({
      services: [svc("db")],
      startError: new Error("no such image"),
    });
    const { error } = await request(mgr, "start", "db");
    expect(error).toBe("no such image");
  });

  it("requires a service name", async () => {
    const { error } = await request(makeManager({ services: [] }), "start");
    expect(error).toMatch(/name is required/i);
  });
});

describe("handleServiceRequest — stop and restart", () => {
  it("stop reports the post-stop status", async () => {
    const mgr = makeManager({
      services: [svc("db", { status: "running", port: 5432, containerIp: "172.20.0.4" })],
    });
    const { result } = await request(mgr, "stop", "db");
    expect(result).toMatchObject({ name: "db", status: "stopped" });
    expect(result!.url).toBeUndefined();
  });

  it("restart reports the post-restart status", async () => {
    const mgr = makeManager({
      services: [svc("web", { status: "running", port: 5173 })],
      onStart: () => ({ containerIp: "172.20.0.5" }),
    });
    const { result } = await request(mgr, "restart", "web");
    expect(mgr.calls).toContain("restart:web");
    expect(result).toMatchObject({ status: "running", url: "http://172.20.0.5:5173/" });
  });
});

describe("handleServiceRequest — logs", () => {
  it("returns an ANSI-stripped snapshot at the requested tail length", async () => {
    const mgr = makeManager({
      services: [svc("web")],
      logs: "[32mready[0m in 300ms",
    });
    const { result } = await request(mgr, "logs", "web", 50);

    expect(mgr.calls).toContain("logs:web:50");
    expect(result).toEqual({ name: "web", logs: "ready in 300ms" });
  });

  it("defaults the tail length when none is given", async () => {
    const mgr = makeManager({ services: [svc("web")], logs: "x" });
    await request(mgr, "logs", "web");
    expect(mgr.calls).toContain("logs:web:2000");
  });

  it("rejects an unknown service rather than returning empty logs", async () => {
    const mgr = makeManager({ services: [svc("web")] });
    const { error } = await request(mgr, "logs", "nope");
    expect(error).toBe("Unknown service: nope");
  });
});

describe("handleServiceRequest — failure modes", () => {
  it("reports a missing compose stack", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude",
      workerUrl: "http://127.0.0.1:1",
    }) as Runner;
    await (
      runner as unknown as { handleServiceRequest(id: string, a: string): Promise<void> }
    ).handleServiceRequest("req-1", "list");

    const payload = workerPost.mock.calls.at(-1)?.[2] as { error?: string };
    expect(payload.error).toMatch(/No compose stack/);
  });

  it("reports an unknown action", async () => {
    const { error } = await request(makeManager({ services: [] }), "frobnicate");
    expect(error).toMatch(/Unknown service action/);
  });
});
