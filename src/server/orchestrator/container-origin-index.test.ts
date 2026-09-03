/**
 * The container-origin IP index that `api-container-guard.ts` resolves callers
 * through — the trust boundary's source of truth, and (before this) the reason
 * every browser request paid for a `listContainers`.
 *
 * Two properties are asserted together on purpose, because a change that wins
 * one by giving up the other is the failure mode:
 *
 *   1. **Latency** — a browser/host source IP must not reach dockerd once the
 *      index is warm. That is the bug: a non-container IP is a miss by
 *      definition, so the on-miss refresh ran on EVERY browser request, took
 *      0.7–1.2 s on a loaded host against a 1 s timeout, and surfaced as
 *      "Reconnecting to server…" on every session switch.
 *   2. **The boundary** — a session container's IP must still resolve to its
 *      session (which `api-container-guard.ts` then default-denies), including
 *      when `sessionNetworkRanges` is empty, and a container that comes up
 *      inside a warm snapshot's lifetime must never be called absent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionContainerManager } from "./session-container.js";

const SESSION = "aa11bb22-cc33-dd44-ee55-ff6677889900";
const SERVICE_IP = "172.31.0.7";
const NEW_SERVICE_IP = "172.31.0.8";
const SESSION_SUBNET = "172.31.0.0/16";
const BROWSER_IP = "10.0.0.9";

interface Entry {
  Id: string;
  Labels: Record<string, string>;
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
}

function entry(id: string, sessionId: string, ip: string): Entry {
  return {
    Id: id,
    Labels: { "shipit-parent-session": sessionId },
    NetworkSettings: { Networks: { [`shipit-session-${sessionId}`]: { IPAddress: ip } } },
  };
}

function createFakeDocker(entries: Entry[]) {
  const state = {
    entries,
    /** Rejects every `listContainers` when set. */
    fail: false,
    /** Never settles the `listContainers` promise when set. */
    hang: false,
    /**
     * Network name → IPAM subnet. Keyed by NAME on purpose: a fake that answered
     * every name the same could not see a caller inspecting the wrong one, which
     * is precisely how the Docker-access bridge's truncated name went unnoticed.
     */
    networks: {} as Record<string, string>,
  };
  const listContainers = vi.fn(async (args?: { all?: boolean }) => {
    // The `all: true` form is `prepareComposeServiceStart`'s own sweep, not the
    // origin index — answer it separately so it cannot inflate the index counts
    // the latency assertions read.
    if (args?.all) return [];
    if (state.fail) throw new Error("dockerd unavailable");
    if (state.hang) await new Promise(() => { /* never settles */ });
    return state.entries;
  });
  const docker = {
    listContainers,
    getNetwork: vi.fn((name: string) => ({
      inspect: vi.fn(async () => {
        const subnet = state.networks[name];
        if (!subnet) throw new Error(`no such network: ${name}`);
        return { IPAM: { Config: [{ Subnet: subnet }] } };
      }),
      disconnect: vi.fn(async () => undefined),
    })),
  };
  return { docker, state, listContainers };
}

function createManager(docker: unknown): SessionContainerManager {
  return new SessionContainerManager({
    docker: docker as never,
    imageName: "shipit-session-worker:test",
    networkName: "shipit-test",
    skipHealthCheck: true,
  });
}

describe("container-origin index", () => {
  let manager: SessionContainerManager;

  beforeEach(() => {
    vi.stubEnv("SESSION_EGRESS_ENFORCE", "1");
  });

  afterEach(async () => {
    await manager.dispose();
    vi.unstubAllEnvs();
  });

  it("stops asking dockerd about a browser IP once the index is warm", async () => {
    // THE regression test for the latency bug. The first lookup pays for a
    // snapshot; every later one is answered from it, because a snapshot
    // enumerates every `shipit-parent-session` container and therefore proves
    // absence as well as presence.
    const { docker, listContainers } = createFakeDocker([entry("svc", SESSION, SERVICE_IP)]);
    manager = createManager(docker);

    expect(await manager.getSessionByAnyContainerIp(BROWSER_IP)).toBeUndefined();
    const afterFirst = listContainers.mock.calls.length;

    for (let i = 0; i < 25; i++) {
      expect(await manager.getSessionByAnyContainerIp(BROWSER_IP)).toBeUndefined();
    }
    expect(listContainers.mock.calls.length).toBe(afterFirst);

    // The wait is what makes this test discriminating, and it is why the test
    // costs a second. The old code short-circuited a repeated browser IP too —
    // on a ONE-SECOND negative-cache entry — so a burst of back-to-back lookups
    // passes either way. Production's cost was the lookup on the far side of
    // that window: roughly one per second, each a 0.7–1.2 s `listContainers`.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await manager.getSessionByAnyContainerIp(BROWSER_IP)).toBeUndefined();
    expect(listContainers.mock.calls.length).toBe(afterFirst);
  });

  it("still resolves a session container's IP to its session", async () => {
    const { docker } = createFakeDocker([entry("svc", SESSION, SERVICE_IP)]);
    manager = createManager(docker);

    expect(await manager.getSessionByAnyContainerIp(SERVICE_IP)).toEqual({ sessionId: SESSION });
    // …and again from the warm snapshot, which is the path the fast return takes.
    expect(await manager.getSessionByAnyContainerIp(SERVICE_IP)).toEqual({ sessionId: SESSION });
  });

  it("resolves it without any help from the session network ranges", async () => {
    // The ranges are a *deny-side* signal, never the identification. This
    // fixture has no session networks at all, so `isLikelySessionContainerIp` is
    // false for the very IP that resolves above — a fast path built on the
    // ranges as an ALLOW gate would have handed a service container the
    // browser/host trust level the moment that map was empty or stale.
    const { docker } = createFakeDocker([entry("svc", SESSION, SERVICE_IP)]);
    manager = createManager(docker);

    expect(await manager.getSessionByAnyContainerIp(SERVICE_IP)).toEqual({ sessionId: SESSION });
    expect(manager.isLikelySessionContainerIp(SERVICE_IP)).toBe(false);
  });

  it("resolves a container that comes up WHILE a topology bracket is open", async () => {
    // THE ordering property, and the one an after-the-fact announcement cannot
    // provide: `docker compose up` and `POST /containers/{id}/start` both return
    // with the container ALREADY RUNNING, so anything announced afterwards has
    // lost the race to that container's own entrypoint. Asserted mid-bracket,
    // not after it closes — closing invalidates everything anyway, so a test
    // that only checks the after state proves nothing about the window.
    const { docker, state } = createFakeDocker([entry("svc", SESSION, SERVICE_IP)]);
    manager = createManager(docker);
    await manager.getSessionByAnyContainerIp(BROWSER_IP);

    const endBracket = manager.beginContainerTopologyChange();
    try {
      // A full snapshot lands while the bracket is open, at an instant when the
      // new container genuinely does not exist yet. Stamped, it would answer
      // "absent" for the container that appears immediately after it.
      await manager.getSessionByAnyContainerIp(BROWSER_IP).catch(() => undefined);
      state.entries = [...state.entries, entry("svc-2", SESSION, NEW_SERVICE_IP)];

      expect(await manager.getSessionByAnyContainerIp(NEW_SERVICE_IP)).toEqual({ sessionId: SESSION });
    } finally {
      endBracket();
    }

    // …and still afterwards, which is the weaker claim.
    expect(await manager.getSessionByAnyContainerIp(NEW_SERVICE_IP)).toEqual({ sessionId: SESSION });
  });

  it("brackets the egress containment that gives a running service a second address", async () => {
    // `containComposeServices` runs AFTER the Compose command's own bracket has
    // closed, and it attaches an already-running service to `shipit-egress-<id>`
    // — a new address, on the route that service will then call from.
    const { docker, state } = createFakeDocker([entry("svc", SESSION, SERVICE_IP)]);
    // Enforcement off, so the method returns immediately after taking its
    // bracket: what is under test is the bracket, not the containment.
    vi.stubEnv("SESSION_EGRESS_ENFORCE", "0");
    manager = createManager(docker);
    await manager.getSessionByAnyContainerIp(BROWSER_IP);

    state.entries = [...state.entries, entry("svc-2", SESSION, NEW_SERVICE_IP)];
    await manager.containComposeServices(SESSION, ["web"]);

    expect(await manager.getSessionByAnyContainerIp(NEW_SERVICE_IP)).toEqual({ sessionId: SESSION });
  });

  it("knows the Docker-access bridge's TRUNCATED network name", async () => {
    // `container-lifecycle.ts` names that bridge `shipit-session-<first 12>`,
    // and the range refresher only ever asked for the full-id name — so an
    // agent-created child's subnet was absent from the fail-closed check by
    // construction, which is the one class of container a Docker-enabled agent
    // starts itself.
    const { docker, state } = createFakeDocker([]);
    state.networks[`shipit-session-${SESSION.slice(0, 12)}`] = SESSION_SUBNET;
    manager = createManager(docker);
    await manager.prepareComposeServiceStart(SESSION, []);

    expect(manager.isLikelySessionContainerIp(NEW_SERVICE_IP)).toBe(true);
  });

  it("does not read a miss inside a session subnet as a browser", async () => {
    // The second guarantee, which holds with no bracket and no announcement at
    // all: an address a session network can hold is not evidence of a browser,
    // so it costs a Docker call — and that call is what finds the container the
    // warm snapshot had not seen.
    const { docker, state } = createFakeDocker([entry("svc", SESSION, SERVICE_IP)]);
    state.networks[`shipit-session-${SESSION}`] = SESSION_SUBNET;
    manager = createManager(docker);
    // Populated the way production populates it: the pre-start sweep that runs
    // before Compose brings a contained session's services up.
    await manager.prepareComposeServiceStart(SESSION, []);
    expect(manager.isLikelySessionContainerIp(NEW_SERVICE_IP)).toBe(true);

    await manager.getSessionByAnyContainerIp(BROWSER_IP);
    state.entries = [...state.entries, entry("svc-2", SESSION, NEW_SERVICE_IP)];

    expect(await manager.getSessionByAnyContainerIp(NEW_SERVICE_IP)).toEqual({ sessionId: SESSION });

    // …while an address outside every session subnet is still answered free.
    const before = docker.listContainers.mock.calls.length;
    expect(await manager.getSessionByAnyContainerIp(BROWSER_IP)).toBeUndefined();
    expect(docker.listContainers.mock.calls.length).toBe(before);
  });

  it("reports the index unavailable rather than holding a request on a hung daemon", async () => {
    // A guard, not a red-before test: the old path bounded the wait too, with
    // the 1 s Docker timeout that made this query fail constantly on a loaded
    // host. The bound now lives on the REQUEST instead, so the Docker call can
    // be given room to finish without a hung daemon reaching the browser.
    const { docker, state } = createFakeDocker([]);
    state.hang = true;
    manager = createManager(docker);

    const startedAt = Date.now();
    await expect(manager.getSessionByAnyContainerIp(BROWSER_IP)).rejects.toThrow(/unavailable/);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("does not re-ask a failing daemon on every request", async () => {
    // Also a guard rather than a red-before test — the backoff predates this
    // change. It is pinned because the failure path is the one this change
    // rewrote (no awaited second Docker round-trip before throwing), and a
    // rewrite that lost the backoff would turn a failing daemon back into a
    // per-request penalty without any other test noticing.
    const { docker, state, listContainers } = createFakeDocker([]);
    state.fail = true;
    manager = createManager(docker);

    for (let i = 0; i < 5; i++) {
      await expect(manager.getSessionByAnyContainerIp(BROWSER_IP)).rejects.toThrow(/unavailable/);
    }

    expect(listContainers.mock.calls.length).toBe(1);
  });
});
