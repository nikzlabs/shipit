/**
 * Focused tests for two ServicePoller seams:
 *
 *   - the `afterPoll` hook the agent network-attachment self-heal rides on
 *     (docs/128). The heal itself is exercised in
 *     `session-container-network-heal.test.ts`; here we only assert the poller
 *     invokes the hook after each successful poll and never lets a hook failure
 *     propagate out of `pollOnce`.
 *   - the `State.OOMKilled` flag the poller harvests from the inspect it already
 *     runs for IP resolution, and hands to `onExitedWithError` so the manager can
 *     tell a real OOM from a plain SIGKILL (docs/239).
 *   - the missing-container reconciliation pass, which is the only thing that
 *     ever notices a service whose container was *removed* rather than exited
 *     (planning#316).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  ServicePoller,
  MISSING_CONTAINER_GRACE_MS,
  DOCKER_UNREACHABLE_GRACE_MS,
  DOCKER_UNREACHABLE_MESSAGE,
  COMPOSE_QUERY_TIMEOUT_MS,
  type ServicePollerOptions,
  type PollerService,
} from "./service-poller.js";

function buildPoller(overrides: Partial<ServicePollerOptions> = {}): ServicePoller {
  const base: ServicePollerOptions = {
    sessionId: "sess-1",
    workspaceDir: "/workspace",
    // No compose containers — pollOnce parses empty stdout and falls straight
    // through to the afterPoll hook.
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
    // Must resolve, not reject.
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

  /**
   * Poller over a single `web` service whose container presence is controlled
   * by `present.value` — flip it to `false` to simulate a *removed* container
   * (`ps -a` returns no row at all, as opposed to an `exited` row).
   *
   * `updateServiceStatus` writes through to `svc` so the poller sees the same
   * status transitions the manager's map would give it on the next poll.
   */
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

    // First poll only starts the clock — the container may just be mid-recreate.
    await poller.pollOnce();
    expect(stoppedCalls(updateServiceStatus)).toHaveLength(0);

    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS + 1);
    await poller.pollOnce();
    expect(updateServiceStatus).toHaveBeenCalledWith("web", "stopped");
    // Cancels the stable-uptime timers exactly as an observed exit would.
    expect(onLeftRunning).toHaveBeenCalledWith("web");
  });

  it("rescues a service pinned at starting — the case that had no timeout at all", async () => {
    vi.useFakeTimers();
    // `startService` sets `starting` right before `compose up`; before this
    // pass, a removed container left that value in place forever.
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

    // Absence must be measured continuously: a second gap restarts the clock
    // rather than resuming the first one.
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

    // A first-time image build has no container for minutes — far longer than
    // any grace window could tolerate, which is why this is a hard exemption.
    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS * 10);
    await poller.pollOnce();
    expect(stoppedCalls(updateServiceStatus)).toHaveLength(0);

    // Once the `up` returns, the window starts from scratch — the time spent
    // building must not count toward it.
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
    // Exactly one transition, from the forward pass — never a second one from
    // reconciliation.
    expect(stoppedCalls(updateServiceStatus)).toHaveLength(1);
  });

  /**
   * Poller over a single `web` service whose `ps` row reports `state`. Used for
   * the states the forward pass has no branch for.
   */
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

    // Same user-visible failure as a missing row: the forward pass has no
    // branch, so before this the service stayed `starting` forever.
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
      // A `compose up` is in flight — the container is `created` on its way to
      // `running`, which is why `created` must not map straight to `stopped`.
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
    // Nothing in ShipIt pauses a service container, and neither status we can
    // express is true — but the service must not drift to `stopped` either.
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
    // Only states we understand are reinterpreted as "no container". A future
    // docker state or a changed `ps` shape must not walk a healthy stack to
    // `stopped` — same conservatism as the failing-`ps` bail-out.
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

    // A broken docker CLI is not evidence about containers, so the
    // reconciliation pass must never run on its "no rows" — that is what would
    // walk a whole healthy stack to `stopped`.
    await poller.pollOnce();
    vi.advanceTimersByTime(MISSING_CONTAINER_GRACE_MS * 3);
    await poller.pollOnce();
    expect(updateServiceStatus.mock.calls.map(c => c[1])).not.toContain("stopped");
    // What DOES happen past the grace window is the docs/121 gap D withdrawal:
    // an `error` naming docker as the thing that stopped answering, which is a
    // claim about our own blindness rather than about the container. Covered in
    // full by the docs/121 suite below.
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
  /**
   * Poller over a single `web` service that `ps` reports as exited 137, with
   * `docker inspect` answering `inspectState` for `State`. Returns the
   * `onExitedWithError` spy so a test can read the `oomKilled` argument.
   */
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
    // "Unknown" must stay distinguishable from "confirmed not an OOM" — the
    // manager hedges its user-facing message on the difference.
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
    // The IP-resolution path bails early on an empty `Networks` map — an exited
    // container is exactly that, and exactly the case the flag is needed for.
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

/**
 * #2044 — the poll loop is the only thing that ever resolves `starting` or a
 * container IP, and its docker queries were unbounded. A docker CLI that never
 * exits froze the registry for the rest of the session with nothing logged.
 */
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

    // Resolves (the `ps`-failed bail-out), rather than hanging forever behind
    // the wedged CLI while setInterval stacks more polls behind it.
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

/**
 * docs/121 gap D (requirement 3) — a failing `docker compose ps` must not let a
 * `running` claim stand forever.
 *
 * The bail-out on a failed `ps` is right as far as it goes: "no rows" from a
 * broken docker CLI is not evidence that every container vanished. But it froze
 * the last reading indefinitely, so a service that crashed during a daemon
 * outage kept reporting `running` — and since `ServiceManager.getServices`
 * publishes an address for a `running` service, the preview proxy kept routing
 * at a container nothing had evidence for.
 */
describe("ServicePoller — statuses expire when docker stops answering (docs/121 gap D)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * A poller over a small live registry: `updateServiceStatus` mutates the
   * services the way `ServiceManager` does, so the sweep's self-limiting
   * behaviour (an `error` service is no longer eligible) is actually exercised
   * rather than assumed.
   */
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

    // Well inside the grace window: a daemon restart must not flap the stack.
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
    // The message must not claim the service died — docker is what broke.
    expect(updates[0].error).toContain("may still be running");
    // Stable-uptime timers must not keep accruing against an observation we
    // can no longer make.
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

    // Fail, recover, fail again: an intermittently flaky daemon must never
    // accumulate its way to a sweep.
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
      // The install gate owns this one's status (docs/137).
      { name: "gated", preview: "auto", status: "running" },
      // Claims nothing about a live container, so there is nothing to withdraw.
      { name: "idle", preview: "manual", status: "stopped" },
      // `starting` is already bounded by the manager's own watchdog, which runs
      // off its own timer and keeps working while the poll loop is blind.
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
    // `refreshSecrets` runs `up` on services that stay `running` throughout, so
    // an in-flight `up` here is not evidence the container is alive — it may be
    // what removed it. And because the status is not `starting`, the manager's
    // watchdog does not cover this service either: exempting it would let
    // `running` stand indefinitely with nothing behind it.
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
