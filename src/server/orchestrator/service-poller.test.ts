import { describe, it, expect, vi, afterEach } from "vitest";

import {
  ServicePoller,
  MISSING_CONTAINER_GRACE_MS,
  DOCKER_UNREACHABLE_GRACE_MS,
  DOCKER_UNREACHABLE_MESSAGE,
  COMPOSE_QUERY_TIMEOUT_MS,
  monotonicNow,
  type ServicePollerOptions,
  type PollerService,
  type PollerContainer,
} from "./service-poller.js";

function buildPoller(overrides: Partial<ServicePollerOptions> = {}): ServicePoller {
  const base: ServicePollerOptions = {
    sessionId: "sess-1",
    workspaceDir: "/workspace",
    composeQuery: async () => "",
    pollIntervalMs: 0,
    composeArgs: (...extra) => ["compose", ...extra],
    getService: () => undefined,
    listServices: () => [],
    setContainerIp: () => {},
    updateServiceStatus: () => {},
    onRunning: () => {},
    onLeftRunning: () => {},
    onExitedCleanly: () => {},
    onExitedWithError: () => {},
    ...overrides,
  };
  return new ServicePoller(base);
}

describe("ServicePoller — afterPoll hook (docs/128)", () => {
  it("invokes afterPoll once at the end of a successful poll", async () => {
    const afterPoll = vi.fn(async () => {});
    await buildPoller({ afterPoll }).pollOnce();
    expect(afterPoll).toHaveBeenCalledTimes(1);
  });

  it("swallows afterPoll errors so a heal failure never breaks the poll loop", async () => {
    const afterPoll = vi.fn(async () => {
      throw new Error("network inspect failed");
    });
    await expect(buildPoller({ afterPoll }).pollOnce()).resolves.toBeUndefined();
    expect(afterPoll).toHaveBeenCalledTimes(1);
  });

  it("does not require afterPoll (optional hook)", async () => {
    await expect(buildPoller().pollOnce()).resolves.toBeUndefined();
  });

  it("skips afterPoll when the compose query itself fails (early return)", async () => {
    const afterPoll = vi.fn(async () => {});
    const poller = buildPoller({
      afterPoll,
      composeQuery: async () => {
        throw new Error("docker compose ps failed");
      },
    });
    await poller.pollOnce();
    expect(afterPoll).not.toHaveBeenCalled();
  });
});

describe("ServicePoller — missing-container reconciliation (planning#316)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function buildVanishPoller(
    svc: PollerService,
    present: { value: boolean },
    overrides: Partial<ServicePollerOptions> = {},
  ) {
    const updateServiceStatus = vi.fn((_name: string, status: PollerService["status"], _error?: string) => {
      svc.status = status;
    });
    const onLeftRunning = vi.fn();
    const poller = buildPoller({
      composeQuery: async (args) => {
        if (args.includes("ps")) {
          return present.value
            ? JSON.stringify({ Service: "web", ID: "c1", State: "running", ExitCode: 0 })
            : "";
        }
        if (args[0] === "inspect") {
          return JSON.stringify([
            { State: { OOMKilled: false }, NetworkSettings: { Networks: {} } },
          ]);
        }
        return "";
      },
      getService: (name) => (name === svc.name ? svc : undefined),
      listServices: () => [svc],
      updateServiceStatus,
      onLeftRunning,
      ...overrides,
    });
    return { poller, updateServiceStatus, onLeftRunning };
  }

  const stoppedCalls = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.filter((c) => c[1] === "stopped");

  it("marks a vanished container's service stopped once the grace window elapses", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const present = { value: false };
    const { poller, updateServiceStatus, onLeftRunning } = buildVanishPoller(svc, present);

    await poller.pollOnce();
    expect(stoppedCalls(updateServiceStatus)).toHaveLength(0);

    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS + 1);
    await poller.pollOnce();
    expect(updateServiceStatus).toHaveBeenCalledWith("web", "stopped");
    expect(onLeftRunning).toHaveBeenCalledWith("web");
  });

  it("rescues a service pinned at starting — the case that had no timeout at all", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "starting" };
    const { poller, updateServiceStatus } = buildVanishPoller(svc, { value: false });

    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS + 1);
    await poller.pollOnce();
    expect(updateServiceStatus).toHaveBeenCalledWith("web", "stopped");
  });

  it("does not flap a service whose container reappears inside the window", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const present = { value: false };
    const { poller, updateServiceStatus } = buildVanishPoller(svc, present);

    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS - 1_000);
    present.value = true;
    await poller.pollOnce();

    present.value = false;
    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS - 1_000);
    await poller.pollOnce();
    expect(stoppedCalls(updateServiceStatus)).toHaveLength(0);

    vi.advanceTimersByTime(2_000);
    await poller.pollOnce();
    expect(updateServiceStatus).toHaveBeenCalledWith("web", "stopped");
  });

  it("never reconciles a gated service — the install gate owns its status", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "starting" };
    const { poller, updateServiceStatus } = buildVanishPoller(
      svc,
      { value: false },
      { isGated: () => true },
    );

    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS * 4);
    await poller.pollOnce();
    expect(updateServiceStatus).not.toHaveBeenCalled();
    expect(svc.status).toBe("starting");
  });

  it("exempts a service with a compose up in flight, however long it builds", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "starting" };
    const inFlight = { value: true };
    const { poller, updateServiceStatus } = buildVanishPoller(
      svc,
      { value: false },
      { isStartInFlight: () => inFlight.value },
    );

    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS * 10);
    await poller.pollOnce();
    expect(stoppedCalls(updateServiceStatus)).toHaveLength(0);

    inFlight.value = false;
    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS - 1_000);
    await poller.pollOnce();
    expect(stoppedCalls(updateServiceStatus)).toHaveLength(0);

    vi.advanceTimersByTime(2_000);
    await poller.pollOnce();
    expect(updateServiceStatus).toHaveBeenCalledWith("web", "stopped");
  });

  it("leaves an already stopped or errored service alone", async () => {
    vi.useFakeTimers();
    for (const status of ["stopped", "error"] as const) {
      const svc: PollerService = { name: "web", preview: "auto", status };
      const { poller, updateServiceStatus, onLeftRunning } = buildVanishPoller(svc, {
        value: false,
      });
      await poller.pollOnce();
      vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS * 2);
      await poller.pollOnce();
      expect(updateServiceStatus).not.toHaveBeenCalled();
      expect(onLeftRunning).not.toHaveBeenCalled();
    }
  });

  it("does not touch a merely-exited container (`ps -a` still reports it)", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const updateServiceStatus = vi.fn((_n: string, status: PollerService["status"]) => {
      svc.status = status;
    });
    const poller = buildPoller({
      composeQuery: async (args) =>
        args.includes("ps")
          ? JSON.stringify({ Service: "web", ID: "c1", State: "exited", ExitCode: 0 })
          : JSON.stringify([{ NetworkSettings: { Networks: {} } }]),
      getService: () => svc,
      listServices: () => [svc],
      updateServiceStatus,
    });

    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS * 2);
    await poller.pollOnce();
    expect(stoppedCalls(updateServiceStatus)).toHaveLength(1);
  });

  function buildStatePoller(
    svc: PollerService,
    state: string,
    overrides: Partial<ServicePollerOptions> = {},
  ) {
    const updateServiceStatus = vi.fn((_n: string, status: PollerService["status"]) => {
      svc.status = status;
    });
    const poller = buildPoller({
      composeQuery: async (args) =>
        args.includes("ps")
          ? JSON.stringify({ Service: "web", ID: "c1", State: state, ExitCode: 0 })
          : JSON.stringify([{ NetworkSettings: { Networks: {} } }]),
      getService: () => svc,
      listServices: () => [svc],
      updateServiceStatus,
      ...overrides,
    });
    return { poller, updateServiceStatus };
  }

  it("reconciles a container stuck in `created` — a row that exists but never started", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "starting" };
    const { poller, updateServiceStatus } = buildStatePoller(svc, "created");

    await poller.pollOnce();
    expect(stoppedCalls(updateServiceStatus)).toHaveLength(0);

    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS + 1);
    await poller.pollOnce();
    expect(updateServiceStatus).toHaveBeenCalledWith("web", "stopped");
  });

  it("does not flap a container that is briefly `created` during a healthy start", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "starting" };
    const state = { value: "created" };
    const updateServiceStatus = vi.fn((_n: string, status: PollerService["status"]) => {
      svc.status = status;
    });
    const poller = buildPoller({
      composeQuery: async (args) =>
        args.includes("ps")
          ? JSON.stringify({ Service: "web", ID: "c1", State: state.value, ExitCode: 0 })
          : JSON.stringify([
              { NetworkSettings: { Networks: { "shipit-session-sess-1": { IPAddress: "172.20.0.5" } } } },
            ]),
      getService: () => svc,
      listServices: () => [svc],
      isStartInFlight: () => state.value === "created",
      updateServiceStatus,
    });

    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS * 2);
    await poller.pollOnce();
    expect(stoppedCalls(updateServiceStatus)).toHaveLength(0);

    state.value = "running";
    await poller.pollOnce();
    expect(updateServiceStatus).toHaveBeenCalledWith("web", "running");
    expect(stoppedCalls(updateServiceStatus)).toHaveLength(0);
  });

  it("reconciles a container in `removing` once it is gone", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const { poller, updateServiceStatus } = buildStatePoller(svc, "removing");

    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS + 1);
    await poller.pollOnce();
    expect(updateServiceStatus).toHaveBeenCalledWith("web", "stopped");
  });

  it("leaves a `paused` container's status alone rather than calling it stopped", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const { poller, updateServiceStatus } = buildStatePoller(svc, "paused");

    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS * 3);
    await poller.pollOnce();
    expect(updateServiceStatus).not.toHaveBeenCalled();
    expect(svc.status).toBe("running");
  });

  it("leaves an unrecognized state alone instead of reconciling it away", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const { poller, updateServiceStatus } = buildStatePoller(svc, "some-future-state");

    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS * 3);
    await poller.pollOnce();
    expect(updateServiceStatus).not.toHaveBeenCalled();
  });

  it("does not mark the stack stopped when the compose query itself fails", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const { poller, updateServiceStatus } = buildVanishPoller(
      svc,
      { value: false },
      {
        composeQuery: async () => {
          throw new Error("docker compose ps failed");
        },
      },
    );

    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS * 3);
    await poller.pollOnce();
    expect(updateServiceStatus.mock.calls.map(c => c[1])).not.toContain("stopped");
    expect(updateServiceStatus.mock.calls.map(c => c[2])).toEqual([DOCKER_UNREACHABLE_MESSAGE]);
  });

  it("restarts the window across stop() — a reconcile rebuilds the registry", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const { poller, updateServiceStatus } = buildVanishPoller(svc, { value: false });

    await poller.pollOnce();
    poller.stop();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS + 1);
    await poller.pollOnce();
    expect(stoppedCalls(updateServiceStatus)).toHaveLength(0);
  });
});

describe("ServicePoller — OOMKilled classification (docs/239)", () => {
  function pollExited137(inspectState: unknown) {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const onExitedWithError = vi.fn();
    const poller = buildPoller({
      composeQuery: async (args) => {
        if (args.includes("ps")) {
          return JSON.stringify({ Service: "web", ID: "c1", State: "exited", ExitCode: 137 });
        }
        if (args[0] === "inspect") {
          return JSON.stringify([{
            ...(inspectState === undefined ? {} : { State: inspectState }),
            NetworkSettings: { Networks: { "shipit-session-sess-1": { IPAddress: "172.20.0.5" } } },
          }]);
        }
        return "";
      },
      getService: () => svc,
      onExitedWithError,
    });
    return { poller, onExitedWithError };
  }

  it("passes oomKilled: true through when the daemon confirms the OOM", async () => {
    const { poller, onExitedWithError } = pollExited137({ OOMKilled: true });
    await poller.pollOnce();
    expect(onExitedWithError).toHaveBeenCalledWith("web", 137, true);
  });

  it("passes oomKilled: false through for a plain SIGKILL", async () => {
    const { poller, onExitedWithError } = pollExited137({ OOMKilled: false });
    await poller.pollOnce();
    expect(onExitedWithError).toHaveBeenCalledWith("web", 137, false);
  });

  it("reports undefined (not false) when the daemon omits State.OOMKilled", async () => {
    const { poller, onExitedWithError } = pollExited137(undefined);
    await poller.pollOnce();
    expect(onExitedWithError).toHaveBeenCalledWith("web", 137, undefined);
  });

  it("reports undefined when the inspect itself fails", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const onExitedWithError = vi.fn();
    const poller = buildPoller({
      composeQuery: async (args) => {
        if (args.includes("ps")) {
          return JSON.stringify({ Service: "web", ID: "c1", State: "exited", ExitCode: 137 });
        }
        throw new Error("docker inspect failed");
      },
      getService: () => svc,
      onExitedWithError,
    });
    await poller.pollOnce();
    expect(onExitedWithError).toHaveBeenCalledWith("web", 137, undefined);
  });

  it("still reports the flag when the exited container has no networks left", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const onExitedWithError = vi.fn();
    const poller = buildPoller({
      composeQuery: async (args) => {
        if (args.includes("ps")) {
          return JSON.stringify({ Service: "web", ID: "c1", State: "exited", ExitCode: 137 });
        }
        if (args[0] === "inspect") {
          return JSON.stringify([{ State: { OOMKilled: false }, NetworkSettings: { Networks: {} } }]);
        }
        return "";
      },
      getService: () => svc,
      onExitedWithError,
    });
    await poller.pollOnce();
    expect(onExitedWithError).toHaveBeenCalledWith("web", 137, false);
  });

  it("skips gated services entirely — a teardown exit is never classified", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "starting" };
    const onExitedWithError = vi.fn();
    const poller = buildPoller({
      composeQuery: async (args) => {
        if (args.includes("ps")) {
          return JSON.stringify({ Service: "web", ID: "c1", State: "exited", ExitCode: 137 });
        }
        return JSON.stringify([{ State: { OOMKilled: false }, NetworkSettings: { Networks: {} } }]);
      },
      getService: () => svc,
      isGated: () => true,
      onExitedWithError,
    });
    await poller.pollOnce();
    expect(onExitedWithError).not.toHaveBeenCalled();
  });
});

describe("ServicePoller — bounded docker queries (#2044)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a `ps` that never answers instead of hanging the poll", async () => {
    vi.useFakeTimers();
    const afterPoll = vi.fn(async () => {});
    const poller = buildPoller({
      composeQuery: () => new Promise<string>(() => { /* never settles */ }),
      afterPoll,
    });

    const poll = poller.pollOnce();
    await vi.advanceTimersByTimeAsync(COMPOSE_QUERY_TIMEOUT_MS + 1_000);

    await expect(poll).resolves.toBeUndefined();
    expect(afterPoll).not.toHaveBeenCalled();
  });

  it("does not let one hung `inspect` cost the other containers their status", async () => {
    vi.useFakeTimers();
    const services: PollerService[] = [
      { name: "slow", preview: "auto", status: "starting" },
      { name: "web", preview: "auto", status: "starting" },
    ];
    const updates: { name: string; status: string }[] = [];
    const poller = buildPoller({
      composeQuery: (args) => {
        if (args.includes("ps")) {
          return Promise.resolve([
            JSON.stringify({ Service: "slow", ID: "slow-1", State: "running", ExitCode: 0 }),
            JSON.stringify({ Service: "web", ID: "web-1", State: "running", ExitCode: 0 }),
          ].join("\n"));
        }
        if (args[0] === "inspect" && args[1] === "slow-1") {
          return new Promise<string>(() => { /* never settles */ });
        }
        return Promise.resolve(JSON.stringify([{
          NetworkSettings: { Networks: { "shipit-session-sess-1": { IPAddress: "172.16.0.4" } } },
        }]));
      },
      getService: (name) => services.find(s => s.name === name),
      listServices: () => services,
      setContainerIp: () => {},
      updateServiceStatus: (name, status) => { updates.push({ name, status }); },
    });

    const poll = poller.pollOnce();
    await vi.advanceTimersByTimeAsync(COMPOSE_QUERY_TIMEOUT_MS + 1_000);
    await poll;

    expect(updates).toEqual([
      { name: "slow", status: "running" },
      { name: "web", status: "running" },
    ]);
  });
});

describe("ServicePoller — statuses expire when docker stops answering (docs/121 gap D)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buildFailingPoller(
    services: PollerService[],
    overrides: Partial<ServicePollerOptions> = {},
  ) {
    let psFails = true;
    const updates: { name: string; status: string; error?: string }[] = [];
    const leftRunning: string[] = [];
    const poller = buildPoller({
      composeQuery: (args) => {
        if (args.includes("ps") && psFails) {
          return Promise.reject(new Error("Cannot connect to the Docker daemon"));
        }
        if (args.includes("ps")) {
          return Promise.resolve(
            services.map(s => JSON.stringify({
              Service: s.name, ID: `${s.name}-1`, State: "running", ExitCode: 0,
            })).join("\n"),
          );
        }
        return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      },
      getService: (name) => services.find(s => s.name === name),
      listServices: () => services,
      onLeftRunning: (name) => { leftRunning.push(name); },
      updateServiceStatus: (name, status, error) => {
        updates.push({ name, status, ...(error ? { error } : {}) });
        const svc = services.find(s => s.name === name);
        if (svc) svc.status = status;
      },
      ...overrides,
    });
    return { poller, updates, leftRunning, setPsFails: (v: boolean) => { psFails = v; } };
  }

  it("holds the last reading through a brief docker hiccup", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const services: PollerService[] = [{ name: "web", preview: "auto", status: "running" }];
    const { poller, updates } = buildFailingPoller(services);

    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS / 2);
    await poller.pollOnce();

    expect(updates).toEqual([]);
    expect(services[0].status).toBe("running");
  });

  it("withdraws a running claim once the outage outlasts the grace window", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const services: PollerService[] = [{ name: "web", preview: "auto", status: "running" }];
    const { poller, updates, leftRunning } = buildFailingPoller(services);

    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS + 1_000);
    await poller.pollOnce();

    expect(updates).toEqual([
      { name: "web", status: "error", error: DOCKER_UNREACHABLE_MESSAGE },
    ]);
    expect(updates[0].error).toContain("may still be running");
    expect(leftRunning).toEqual(["web"]);
  });

  it("does not repeat the sweep on every subsequent failed poll", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const services: PollerService[] = [{ name: "web", preview: "auto", status: "running" }];
    const { poller, updates } = buildFailingPoller(services);

    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS + 1_000);
    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS + 1_000);
    await poller.pollOnce();

    expect(updates).toHaveLength(1);
  });

  it("measures one continuous outage, not a sum of unrelated ones", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const services: PollerService[] = [{ name: "web", preview: "auto", status: "running" }];
    const { poller, updates, setPsFails } = buildFailingPoller(services);

    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS - 1_000);
    setPsFails(false);
    await poller.pollOnce();
    setPsFails(true);
    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS - 1_000);
    await poller.pollOnce();

    expect(updates.filter(u => u.status === "error")).toEqual([]);
  });

  it("restores the real status as soon as docker answers again", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const services: PollerService[] = [{ name: "web", preview: "auto", status: "running" }];
    const { poller, updates, setPsFails } = buildFailingPoller(services);

    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS + 1_000);
    await poller.pollOnce();
    expect(services[0].status).toBe("error");

    setPsFails(false);
    await poller.pollOnce();

    expect(services[0].status).toBe("running");
    expect(updates.at(-1)).toEqual({ name: "web", status: "running" });
  });

  it("leaves gated and non-running services alone", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const services: PollerService[] = [
      { name: "gated", preview: "auto", status: "running" },
      { name: "idle", preview: "manual", status: "stopped" },
      { name: "coming-up", preview: "auto", status: "starting" },
    ];
    const { poller, updates } = buildFailingPoller(services, {
      isGated: (name) => name === "gated",
    });

    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS + 1_000);
    await poller.pollOnce();

    expect(updates).toEqual([]);
  });

  it("withdraws a running claim even with a compose up in flight", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const services: PollerService[] = [{ name: "web", preview: "auto", status: "running" }];
    const { poller, updates } = buildFailingPoller(services, {
      isStartInFlight: () => true,
    });

    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS + 1_000);
    await poller.pollOnce();

    expect(updates).toEqual([
      { name: "web", status: "error", error: DOCKER_UNREACHABLE_MESSAGE },
    ]);
  });
});

describe("ServicePoller — query working directory (docs/318)", () => {
  function pollerRecordingCwds(overrides: Partial<ServicePollerOptions>) {
    const cwds: string[] = [];
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const poller = buildPoller({
      getService: (name) => (name === "web" ? svc : undefined),
      listServices: () => [svc],
      composeQuery: async (args, cwd) => {
        cwds.push(cwd);
        if (args[1] === "ps") return JSON.stringify({ Service: "web", ID: "c1", State: "running" });
        return "[]";
      },
      ...overrides,
    });
    return { poller, cwds };
  }

  it("runs its queries in the workspace by default", async () => {
    const { poller, cwds } = pollerRecordingCwds({});
    await poller.pollOnce();
    expect(cwds.length).toBeGreaterThan(1);
    expect(new Set(cwds)).toEqual(new Set(["/workspace"]));
  });

  it("runs every query in the directory it is given", async () => {
    const { poller, cwds } = pollerRecordingCwds({ queryCwd: () => "/state/compose/no-model" });
    await poller.pollOnce();
    expect(cwds.length).toBeGreaterThan(1);
    expect(new Set(cwds)).toEqual(new Set(["/state/compose/no-model"]));
  });
});

describe("ServicePoller — the listed address", () => {
  type Nets = Record<string, { IPAddress?: string }>;

  function addressPoller() {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const state = {
      rows: [{ Service: "web", ID: "c1", State: "running", ExitCode: 0 }] as object[],
      inspect: new Map<string, Nets | Error>(),
    };
    const ips = new Map<string, string | undefined>();
    const poller = buildPoller({
      composeQuery: async (args) => {
        if (args.includes("ps")) return state.rows.map((row) => JSON.stringify(row)).join("\n");
        if (args[0] === "inspect") {
          const nets = state.inspect.get(args[1]);
          if (nets instanceof Error) throw nets;
          return JSON.stringify([{ State: { OOMKilled: false }, NetworkSettings: { Networks: nets ?? {} } }]);
        }
        return "";
      },
      getService: (name) => (name === svc.name ? svc : undefined),
      listServices: () => [svc],
      setContainerIp: (name, ip) => { ips.set(name, ip); },
    });
    return { poller, state, ips };
  }

  it("never lists an address from a network the agent is not on", async () => {
    const { poller, state, ips } = addressPoller();
    state.inspect.set("c1", { "shipit-session-sess-1": { IPAddress: "172.20.0.2" } });
    await poller.pollOnce();
    expect(ips.get("web")).toBe("172.20.0.2");

    state.inspect.set("c1", { "shipit-egress-sess-1": { IPAddress: "172.30.0.5" } });
    await poller.pollOnce();
    expect([...ips]).toEqual([["web", undefined]]);
  });

  it("does not give a replacement container the address of the one it replaced", async () => {
    const { poller, state, ips } = addressPoller();
    state.inspect.set("c1", { "shipit-session-sess-1": { IPAddress: "172.20.0.2" } });
    await poller.pollOnce();

    state.rows = [{ Service: "web", ID: "c2", State: "running", ExitCode: 0 }];
    state.inspect.set("c2", new Error("No such object: c2"));
    await poller.pollOnce();
    expect([...ips]).toEqual([["web", undefined]]);
  });

  // A slow Docker must not blank a working preview for a poll.
  it("keeps the address when the same container cannot be read", async () => {
    const { poller, state, ips } = addressPoller();
    state.inspect.set("c1", { "shipit-session-sess-1": { IPAddress: "172.20.0.2" } });
    await poller.pollOnce();

    state.inspect.set("c1", new Error("docker inspect did not answer"));
    await poller.pollOnce();
    expect(ips.get("web")).toBe("172.20.0.2");
  });

  it("does not let a replica with no address yet hide the running one's", async () => {
    const { poller, state, ips } = addressPoller();
    state.rows.push({ Service: "web", ID: "c2", State: "created", ExitCode: 0 });
    state.inspect.set("c1", { "shipit-session-sess-1": { IPAddress: "172.20.0.2" } });
    state.inspect.set("c2", { "shipit-session-sess-1": { IPAddress: "" } });
    await poller.pollOnce();
    expect(ips.get("web")).toBe("172.20.0.2");
  });
});

describe("ServicePoller — containers left by `docker compose run`", () => {
  const SERVICE_LABELS =
    "com.docker.compose.depends_on=db:service_started:false,cache:service_started:false," +
    "com.docker.compose.oneoff=False,com.docker.compose.service=web";
  const ONE_OFF_LABELS = "com.docker.compose.oneoff=True,com.docker.compose.service=web";

  function oneOffPoller(status: PollerService["status"], rows: object[]) {
    const svc: PollerService = { name: "web", preview: "auto", status };
    const inspected: string[] = [];
    const ips = new Map<string, string | undefined>();
    const updateServiceStatus = vi.fn();
    const onLeftRunning = vi.fn();
    const onExitedWithError = vi.fn();
    const poller = buildPoller({
      composeQuery: async (args) => {
        if (args.includes("ps")) return rows.map((row) => JSON.stringify(row)).join("\n");
        inspected.push(args[1]);
        const nets = args[1] === "c1" ? { "shipit-session-sess-1": { IPAddress: "172.20.0.2" } }
          : args[1] === "run2" ? { "shipit-session-sess-1": { IPAddress: "172.20.0.7" } }
          : {};
        return JSON.stringify([{ State: { OOMKilled: false }, NetworkSettings: { Networks: nets } }]);
      },
      getService: (name) => (name === svc.name ? svc : undefined),
      listServices: () => [svc],
      setContainerIp: (name, ip) => { ips.set(name, ip); },
      updateServiceStatus,
      onLeftRunning,
      onExitedWithError,
    });
    return { poller, inspected, ips, updateServiceStatus, onLeftRunning, onExitedWithError };
  }

  it("reads a running service's status and address from its own container only", async () => {
    const { poller, inspected, ips, updateServiceStatus, onLeftRunning, onExitedWithError } = oneOffPoller("running", [
      { Service: "web", ID: "c1", State: "running", ExitCode: 0, Labels: SERVICE_LABELS },
      { Service: "web", ID: "run1", State: "exited", ExitCode: 1, Labels: ONE_OFF_LABELS },
      { Service: "web", ID: "run2", State: "running", ExitCode: 0, Labels: ONE_OFF_LABELS },
    ]);
    await poller.pollOnce();
    expect(updateServiceStatus).not.toHaveBeenCalled();
    expect(onLeftRunning).not.toHaveBeenCalled();
    expect(onExitedWithError).not.toHaveBeenCalled();
    expect([...ips]).toEqual([["web", "172.20.0.2"]]);
    expect(inspected).toEqual(["c1"]);
  });

  it("does not skip a service whose other label value contains the one-off label", async () => {
    const { poller, ips } = oneOffPoller("running", [{
      Service: "web", ID: "c1", State: "running", ExitCode: 0,
      Labels: `note=x,com.docker.compose.oneoff=True,y,${SERVICE_LABELS}`,
    }]);
    await poller.pollOnce();
    expect(ips.get("web")).toBe("172.20.0.2");
  });

  it("does not report a stopped service running because a `run` shell of it is", async () => {
    const { poller, ips, updateServiceStatus } = oneOffPoller("stopped", [
      { Service: "web", ID: "c0", State: "exited", ExitCode: 0, Labels: SERVICE_LABELS },
      { Service: "web", ID: "run2", State: "running", ExitCode: 0, Labels: ONE_OFF_LABELS },
    ]);
    await poller.pollOnce();
    expect(updateServiceStatus).not.toHaveBeenCalled();
    expect(ips.get("web")).toBeUndefined();
  });
});

describe("ServicePoller — no cadence, one follow-up per pending condition (docs/332)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function listingPoller(
    svc: PollerService,
    containers: () => PollerContainer[],
    overrides: Partial<ServicePollerOptions> = {},
  ) {
    const updateServiceStatus = vi.fn((_n: string, status: PollerService["status"]) => {
      svc.status = status;
    });
    const inspected: string[] = [];
    const poller = buildPoller({
      listContainers: async () => containers(),
      inspectContainer: async (ref) => {
        inspected.push(ref);
        return { oomKilled: false, exitCode: 137, networks: {} };
      },
      getService: (name) => (name === svc.name ? svc : undefined),
      listServices: () => [svc],
      updateServiceStatus,
      ...overrides,
    });
    return { poller, updateServiceStatus, inspected };
  }

  const running = (): PollerContainer[] => [{
    ref: "c1",
    service: "web",
    state: "running",
    oneOff: false,
    networks: { "shipit-session-sess-1": "172.20.0.4" },
  }];

  it("leaves no timer behind for a healthy stack — the whole point of the change", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const { poller } = listingPoller(svc, running);

    await poller.pollOnce();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads a running container's address from the listing, with no inspect at all", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "starting" };
    const ips = new Map<string, string | undefined>();
    const { poller, inspected } = listingPoller(svc, running, {
      setContainerIp: (name, ip) => ips.set(name, ip),
    });

    await poller.pollOnce();

    expect(ips.get("web")).toBe("172.20.0.4");
    expect(inspected).toEqual([]);
  });

  it("still inspects an exited container, which no listing can report an exit code for", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const onExitedWithError = vi.fn();
    const { poller, inspected } = listingPoller(
      svc,
      () => [{ ref: "c1", service: "web", state: "exited", oneOff: false, networks: {} }],
      { onExitedWithError },
    );

    await poller.pollOnce();

    expect(inspected).toEqual(["c1"]);
    expect(onExitedWithError).toHaveBeenCalledWith("web", 137, false);
  });

  // A restart reuses the container ID, so a remembered exit would be charged to the wrong run.
  it("re-reads an exit rather than trusting a remembered one, since an ID outlives a run", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const { poller, inspected } = listingPoller(
      svc,
      () => [{ ref: "c1", service: "web", state: "exited", oneOff: false, networks: {} }],
    );

    await poller.pollOnce();
    await poller.pollOnce();

    expect(inspected).toEqual(["c1", "c1"]);
  });

  // Without the follow-up, nothing would ever take the second look this rule needs: a container
  // that is merely absent emits no further Docker event.
  it("resolves a vanished container on its own, with no second poll from outside", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const { poller, updateServiceStatus } = listingPoller(svc, () => []);

    await poller.pollOnce();
    expect(updateServiceStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MISSING_CONTAINER_GRACE_MS + 1_000);

    expect(updateServiceStatus).toHaveBeenCalledWith("web", "stopped");
  });

  it("withdraws an unconfirmable running claim on its own once docker stays silent", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const { poller, updateServiceStatus } = listingPoller(svc, () => {
      throw new Error("docker unreachable");
    });

    await poller.pollOnce();
    expect(updateServiceStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS + 1_000);

    expect(updateServiceStatus).toHaveBeenCalledWith("web", "error", DOCKER_UNREACHABLE_MESSAGE);
  });

  // The defect this guards: every failed listing re-armed an already-past deadline, clamped to the
  // 250 ms floor — four listings a second, per session, for as long as Docker stayed down.
  it("stops re-arming once the outage sweep has run, rather than retrying four times a second", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const attempts = { count: 0 };
    const { poller } = listingPoller(svc, () => {
      attempts.count++;
      throw new Error("docker unreachable");
    });

    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS + 1_000);
    const afterSweep = attempts.count;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(attempts.count).toBe(afterSweep);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sweeps a SECOND outage too — the first one's state must not disarm it", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    let reachable = false;
    const { poller, updateServiceStatus } = listingPoller(svc, () => {
      if (!reachable) throw new Error("docker unreachable");
      return running();
    });

    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS + 1_000);
    expect(updateServiceStatus).toHaveBeenCalledWith("web", "error", DOCKER_UNREACHABLE_MESSAGE);

    reachable = true;
    await poller.pollOnce();
    expect(svc.status).toBe("running");

    reachable = false;
    updateServiceStatus.mockClear();
    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS + 1_000);

    expect(updateServiceStatus).toHaveBeenCalledWith("web", "error", DOCKER_UNREACHABLE_MESSAGE);
  });

  // A failed listing never reconciles, so a missing-container deadline already in the past stayed
  // eligible and re-armed at the 250 ms floor on every attempt — the same spin by another route.
  it("does not spin when an outage follows a missing container", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    let reachable = true;
    const attempts = { count: 0 };
    const { poller } = listingPoller(svc, () => {
      attempts.count++;
      if (!reachable) throw new Error("docker unreachable");
      return [];
    });

    // A successful empty listing starts the missing-container clock.
    await poller.pollOnce();
    reachable = false;
    await vi.advanceTimersByTimeAsync(MISSING_CONTAINER_GRACE_MS + DOCKER_UNREACHABLE_GRACE_MS + 2_000);
    const settled = attempts.count;

    await vi.advanceTimersByTimeAsync(10_000);

    expect(attempts.count).toBe(settled);
    expect(vi.getTimerCount()).toBe(0);
  });

  // An exited container is re-read on every reconcile, deliberately. Three review rounds produced
  // four distinct defects from trying to remember its exit — a container id outlives the run that
  // produced it, so no key is sound — and the cost it saved is one socket request per exited
  // container per five minutes, with no process spawn. Correctness wins that trade.
  it("re-reads an exited container every time, rather than remembering a verdict", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const { poller, inspected } = listingPoller(
      svc,
      () => [{ ref: "c1", service: "web", state: "exited", oneOff: false, networks: {} }],
      { onExitedWithError: () => { svc.status = "error"; } },
    );

    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();

    expect(inspected).toEqual(["c1", "c1", "c1"]);
  });

  it("still reads an exit for a service the outage sweep left in error", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    let reachable = false;
    const onExitedWithError = vi.fn();
    const { poller, inspected } = listingPoller(
      svc,
      () => {
        if (!reachable) throw new Error("docker unreachable");
        return [{ ref: "c1", service: "web", state: "exited", oneOff: false, networks: {} }];
      },
      { onExitedWithError },
    );

    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS + 1_000);
    expect(svc.status).toBe("error");

    reachable = true;
    await poller.pollOnce();

    expect(inspected).toEqual(["c1"]);
    expect(onExitedWithError).toHaveBeenCalledWith("web", 137, false);
    vi.useRealTimers();
  });

  it("reads a restarted container's new exit, even though the id is the one it settled", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    let state = "exited";
    const onExitedWithError = vi.fn();
    const { poller, inspected } = listingPoller(
      svc,
      () => [{
        ref: "c1",
        service: "web",
        state,
        oneOff: false,
        networks: state === "running" ? { "shipit-session-sess-1": "172.20.0.4" } : {},
      }],
      { onExitedWithError: () => { svc.status = "error"; onExitedWithError(); } },
    );

    await poller.pollOnce();
    expect(inspected).toEqual(["c1"]);

    // The same container runs again, then exits again.
    state = "running";
    await poller.pollOnce();
    state = "exited";
    await poller.pollOnce();

    expect(inspected).toEqual(["c1", "c1"]);
    expect(onExitedWithError).toHaveBeenCalledTimes(2);
  });

  it("still inspects an exited container whose service has NOT settled — a missed exit event", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const onExitedWithError = vi.fn();
    const { poller, inspected } = listingPoller(
      svc,
      () => [{ ref: "c1", service: "web", state: "exited", oneOff: false, networks: {} }],
      { onExitedWithError, updateServiceStatus: () => { /* status never settles */ } },
    );

    await poller.pollOnce();
    await poller.pollOnce();

    expect(inspected).toEqual(["c1", "c1"]);
    expect(onExitedWithError).toHaveBeenCalledTimes(2);
  });

  it("bounds a hung network repair, which a shared backstop would otherwise wait on for ever", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "starting" };
    const poller = buildPoller({
      listContainers: async () => [
        { ref: "c1", service: "web", state: "running", oneOff: false, networks: {} },
      ],
      inspectContainer: async () => ({ networks: {} }),
      repairNetwork: () => new Promise<void>(() => { /* never settles */ }),
      getService: () => svc,
      listServices: () => [svc],
    });

    const poll = poller.pollOnce();
    await vi.advanceTimersByTimeAsync(COMPOSE_QUERY_TIMEOUT_MS + 1_000);

    await expect(poll).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  // The shared listing failed, so this session starts its outage clock without repeating it. One
  // follow-up then decides the outcome, and that one does have to look.
  it("runs the outage clock for a listing that failed elsewhere", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const listContainers = vi.fn(() => Promise.reject(new Error("docker unreachable")));
    const updateServiceStatus = vi.fn();
    const poller = buildPoller({
      listContainers,
      getService: () => svc,
      listServices: () => [svc],
      updateServiceStatus,
    });

    poller.noteListingFailed();
    expect(listContainers).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DOCKER_UNREACHABLE_GRACE_MS + 1_000);

    expect(updateServiceStatus).toHaveBeenCalledWith("web", "error", DOCKER_UNREACHABLE_MESSAGE);
    expect(listContainers).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("keeps a requested follow-up that an unrelated exit would otherwise have cleared", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const refreshes = { count: 0 };
    const { poller } = listingPoller(svc, () => {
      refreshes.count++;
      return running();
    });

    await poller.pollOnce();
    poller.requestFollowUp(60_000);
    // An ungated service exiting must not retire the gate watchdog's own deadline.
    poller.applyServiceExit("web", { exitCode: 1 });
    const before = refreshes.count;

    await vi.advanceTimersByTimeAsync(61_000);

    expect(refreshes.count).toBeGreaterThan(before);
  });

  it("drops its follow-up once the condition clears, rather than ticking on", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    let present = false;
    const { poller } = listingPoller(svc, () => (present ? running() : []));

    await poller.pollOnce();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    present = true;
    await poller.pollOnce();

    expect(vi.getTimerCount()).toBe(0);
  });

  // `ServiceManager.start()` refreshes and THEN arms the poller, so arming must not retire the
  // follow-up that refresh just armed: nothing else would ever set it again.
  it("keeps a pending follow-up across start(), which arms the interval and nothing else", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const { poller, updateServiceStatus } = listingPoller(svc, () => []);

    await poller.pollOnce();
    poller.start();

    await vi.advanceTimersByTimeAsync(MISSING_CONTAINER_GRACE_MS + 1_000);

    expect(updateServiceStatus).toHaveBeenCalledWith("web", "stopped");
  });

  it("stop() cancels a pending follow-up", async () => {
    vi.useFakeTimers();
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const { poller, updateServiceStatus } = listingPoller(svc, () => []);

    await poller.pollOnce();
    poller.stop();

    await vi.advanceTimersByTimeAsync(MISSING_CONTAINER_GRACE_MS * 2);

    expect(updateServiceStatus).not.toHaveBeenCalled();
  });

  it("reconciles a slice listed for it elsewhere without listing again itself", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "starting" };
    const listContainers = vi.fn(async () => []);
    const updateServiceStatus = vi.fn();
    const poller = buildPoller({
      listContainers,
      getService: () => svc,
      listServices: () => [svc],
      updateServiceStatus,
    });

    await poller.pollOnce(running());

    expect(listContainers).not.toHaveBeenCalled();
    expect(updateServiceStatus).toHaveBeenCalledWith("web", "running");
  });
});

describe("ServicePoller — a listing must not overwrite a newer exit (docs/332)", () => {
  function racingPoller() {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    let releaseListing: ((rows: PollerContainer[]) => void) | undefined;
    const onRunning = vi.fn();
    const onExitedWithError = vi.fn();
    const updateServiceStatus = vi.fn((_n: string, status: PollerService["status"]) => {
      svc.status = status;
    });
    const ips = new Map<string, string | undefined>();
    const poller = buildPoller({
      listContainers: () => new Promise<PollerContainer[]>((resolve) => { releaseListing = resolve; }),
      getService: (name) => (name === svc.name ? svc : undefined),
      listServices: () => [svc],
      setContainerIp: (name, ip) => ips.set(name, ip),
      onRunning,
      onExitedWithError,
      updateServiceStatus,
    });
    const running: PollerContainer[] = [{
      ref: "c1",
      service: "web",
      state: "running",
      oneOff: false,
      networks: { "shipit-session-sess-1": "172.20.0.4" },
    }];
    return { poller, svc, running, onRunning, onExitedWithError, updateServiceStatus, ips,
      release: (rows: PollerContainer[]) => releaseListing?.(rows) };
  }

  // The defect this guards: the refresh's `onRunning` reached `clearRetryState`, cancelling the
  // recovery the exit had just scheduled, and republished a dead container as running.
  it("discards a listing taken before an exit, so recovery is not cancelled", async () => {
    const { poller, running, onRunning, onExitedWithError, updateServiceStatus, release } = racingPoller();

    const inFlight = poller.pollOnce();
    poller.applyServiceExit("web", { exitCode: 137, oomKilled: true });
    release(running);
    await inFlight;

    expect(onExitedWithError).toHaveBeenCalledWith("web", 137, true);
    expect(onRunning).not.toHaveBeenCalled();
    expect(updateServiceStatus).not.toHaveBeenCalledWith("web", "running");
  });

  it("does not restore a dead container's address from the stale listing", async () => {
    const { poller, running, ips, release } = racingPoller();

    const inFlight = poller.pollOnce();
    poller.applyServiceExit("web", { exitCode: 137, oomKilled: true });
    release(running);
    await inFlight;

    expect(ips.get("web")).toBeUndefined();
  });

  // Follow-up timers and the manager's own post-`up` refreshes call in directly, so ordering cannot
  // live in whichever caller happens to coalesce. Without it, the older listing's address wins.
  it("discards an older listing that finishes after a newer one, with no exit between them", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const ips = new Map<string, string | undefined>();
    const releases: ((rows: PollerContainer[]) => void)[] = [];
    const poller = buildPoller({
      listContainers: () => new Promise<PollerContainer[]>((resolve) => { releases.push(resolve); }),
      getService: () => svc,
      listServices: () => [svc],
      setContainerIp: (name, ip) => ips.set(name, ip),
    });
    const at = (ip: string): PollerContainer[] => [{
      ref: "c1", service: "web", state: "running", oneOff: false,
      networks: { "shipit-session-sess-1": ip },
    }];

    const older = poller.pollOnce();
    const newer = poller.pollOnce();
    // The newer listing answers first and publishes; the older one answers afterwards.
    releases[1]!(at("172.20.0.9"));
    await newer;
    releases[0]!(at("172.20.0.4"));
    await older;

    expect(ips.get("web")).toBe("172.20.0.9");
  });

  it("discards a listing overtaken by stop(), which no longer owns the stack", async () => {
    const { poller, running, onRunning, release } = racingPoller();

    const inFlight = poller.pollOnce();
    poller.stop();
    release(running);
    await inFlight;

    expect(onRunning).not.toHaveBeenCalled();
  });

  it("arms no follow-up from a listing stop() overtook", async () => {
    vi.useFakeTimers();
    const { poller, release } = racingPoller();

    const inFlight = poller.pollOnce();
    poller.stop();
    release([]);
    await inFlight;

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  // The shared backstop takes ONE listing and reconciles sessions in turn, so by the time a
  // session's slice is applied the listing may predate an exit that has since been handled. The
  // generation at entry is already too late to see that; the listing's own age is what counts.
  it("discards a shared slice older than an exit, even though it arrives afterwards", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const onRunning = vi.fn();
    const poller = buildPoller({
      getService: () => svc,
      listServices: () => [svc],
      onRunning,
    });
    const takenAt = monotonicNow();
    const running: PollerContainer[] = [{
      ref: "c1", service: "web", state: "running", oneOff: false,
      networks: { "shipit-session-sess-1": "172.20.0.4" },
    }];

    // An exit lands after that listing was taken, before its slice reaches this session.
    await new Promise((r) => setTimeout(r, 2));
    poller.applyServiceExit("web", { exitCode: 137, oomKilled: true });
    await poller.pollOnce(running, takenAt);

    expect(onRunning).not.toHaveBeenCalled();
  });

  it("applies a shared slice taken after the last exit", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "starting" };
    const onRunning = vi.fn();
    const poller = buildPoller({
      getService: () => svc,
      listServices: () => [svc],
      onRunning,
    });

    poller.applyServiceExit("web", { exitCode: 137, oomKilled: true });
    await new Promise((r) => setTimeout(r, 2));
    await poller.pollOnce([{
      ref: "c2", service: "web", state: "running", oneOff: false,
      networks: { "shipit-session-sess-1": "172.20.0.5" },
    }], monotonicNow());

    expect(onRunning).toHaveBeenCalledWith("web");
  });

  it("applies a listing that was not overtaken", async () => {
    const { poller, running, onRunning, release } = racingPoller();

    const inFlight = poller.pollOnce();
    release(running);
    await inFlight;

    expect(onRunning).toHaveBeenCalledWith("web");
  });
});

describe("ServicePoller — exits reported by a Docker event (docs/332)", () => {
  function exitPoller(status: PollerService["status"] = "running") {
    const svc: PollerService = { name: "web", preview: "auto", status };
    const onExitedWithError = vi.fn();
    const onExitedCleanly = vi.fn();
    const onLeftRunning = vi.fn();
    const updateServiceStatus = vi.fn();
    const poller = buildPoller({
      getService: (name) => (name === svc.name ? svc : undefined),
      listServices: () => [svc],
      onExitedWithError,
      onExitedCleanly,
      onLeftRunning,
      updateServiceStatus,
    });
    return { poller, svc, onExitedWithError, onExitedCleanly, onLeftRunning, updateServiceStatus };
  }

  it("carries the OOM verdict the event knows and a listing cannot", () => {
    const { poller, onExitedWithError, onLeftRunning } = exitPoller();

    poller.applyServiceExit("web", { exitCode: 137, oomKilled: true });

    expect(onLeftRunning).toHaveBeenCalledWith("web");
    expect(onExitedWithError).toHaveBeenCalledWith("web", 137, true);
  });

  it("treats a clean exit as stopped, not as a crash", () => {
    const { poller, onExitedCleanly, onExitedWithError, updateServiceStatus } = exitPoller();

    poller.applyServiceExit("web", { exitCode: 0 });

    expect(onExitedCleanly).toHaveBeenCalledWith("web");
    expect(onExitedWithError).not.toHaveBeenCalled();
    expect(updateServiceStatus).toHaveBeenCalledWith("web", "stopped");
  });

  it("never classifies a gated service's exit — the install gate owns its status", () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "starting" };
    const onExitedWithError = vi.fn();
    const poller = buildPoller({
      getService: () => svc,
      isGated: () => true,
      onExitedWithError,
    });

    poller.applyServiceExit("web", { exitCode: 137, oomKilled: true });

    expect(onExitedWithError).not.toHaveBeenCalled();
  });

  it("applies an exit whatever container reported it — the refresh that follows settles the truth", async () => {
    const svc: PollerService = { name: "web", preview: "auto", status: "running" };
    const onExitedWithError = vi.fn();
    const poller = buildPoller({
      getService: () => svc,
      listServices: () => [svc],
      onExitedWithError,
    });

    poller.applyServiceExit("web", { exitCode: 137, oomKilled: true });

    expect(onExitedWithError).toHaveBeenCalledWith("web", 137, true);
  });

  it("ignores an exit for a service the stack no longer defines", () => {
    const onExitedWithError = vi.fn();
    const poller = buildPoller({ getService: () => undefined, onExitedWithError });

    poller.applyServiceExit("gone", { exitCode: 1 });

    expect(onExitedWithError).not.toHaveBeenCalled();
  });
});
