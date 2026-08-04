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
 */

import { describe, it, expect, vi } from "vitest";

import { ServicePoller, type ServicePollerOptions, type PollerService } from "./service-poller.js";

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
