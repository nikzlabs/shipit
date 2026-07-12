/**
 * Tests for the egress sidecar orphan reaper (SHI-222).
 *
 * The invariant under test: a Tier B/C sidecar (docs/172) borrows the agent
 * container's network namespace, so it is garbage the moment its netns parent
 * stops running — whether the parent is merely `Exited` (the crash case, where
 * the dead agent container lingers until the next create removes it by name) or
 * gone from the daemon entirely.
 */

import { describe, it, expect, vi } from "vitest";
import type Docker from "dockerode";
import {
  netnsParentId,
  isOrphanedSidecar,
  reapSessionEgressSidecars,
  reapOrphanEgressSidecars,
} from "./egress-orphan-reaper.js";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

/** A container in the fake daemon. `networkMode` absent → an ordinary container. */
interface FakeContainer {
  labels?: Record<string, string>;
  networkMode?: string;
  running?: boolean;
}

function notFound(): Error & { statusCode: number } {
  return Object.assign(new Error("no such container"), { statusCode: 404 });
}

/**
 * Fake Docker over a map of id → container.
 *
 * `listContainers` honours a single `label=` filter (with or without a `=value`)
 * AND the `all` option — the latter matters more than it looks. Real
 * `listContainers` returns **running containers only** unless `all: true`, and the
 * orphans this module hunts are frequently *exited* (their `RestartPolicy` gives
 * up after 3 failed attempts to join a dead namespace). A fake that ignores `all`
 * would let someone delete `all: true` from `listEgressSidecars` and watch every
 * test stay green while the feature silently found nothing, forever.
 *
 * `removeError` injects a failure from `remove()` so the never-rejects contract
 * can actually be exercised.
 */
function fakeDocker(
  containers: Record<string, FakeContainer>,
  opts: {
    removeError?: (id: string) => (Error & { statusCode?: number }) | undefined;
    listError?: (call: number) => Error | undefined;
    inspectError?: (id: string) => (Error & { statusCode?: number }) | undefined;
  } = {},
) {
  const removed: string[] = [];
  const store = new Map(Object.entries(containers));
  let listCalls = 0;

  const docker = {
    listContainers: vi.fn(async (o: { all?: boolean; filters?: { label?: string[] } }) => {
      const listErr = opts.listError?.(++listCalls);
      if (listErr) throw listErr;
      const want = o.filters?.label?.[0] ?? "";
      const [key, value] = want.includes("=") ? want.split("=", 2) : [want, undefined];
      return [...store.entries()]
        .filter(([, c]) => {
          if (!o.all && !(c.running ?? false)) return false; // Docker's running-only default
          const actual = c.labels?.[key!];
          if (actual === undefined) return false;
          return value === undefined || actual === value;
        })
        .map(([Id]) => ({ Id }));
    }),
    getContainer: vi.fn((id: string) => ({
      inspect: vi.fn(async () => {
        const inspectErr = opts.inspectError?.(id);
        if (inspectErr) throw inspectErr;
        const c = store.get(id);
        if (!c) throw notFound();
        return {
          HostConfig: { NetworkMode: c.networkMode },
          State: { Running: c.running ?? false },
        };
      }),
      remove: vi.fn(async () => {
        const err = opts.removeError?.(id);
        if (err) throw err;
        if (!store.has(id)) throw notFound();
        removed.push(id);
        store.delete(id);
      }),
    })),
  } as unknown as Docker;

  return { docker, removed };
}

const resolver = (sid: string, parent: string, running = true): FakeContainer => ({
  labels: { [EGRESS_RESOLVER_LABEL]: sid, "shipit-parent-session": sid },
  networkMode: `container:${parent}`,
  running,
});
const proxy = (sid: string, parent: string, running = true): FakeContainer => ({
  labels: { [EGRESS_PROXY_LABEL]: sid, "shipit-parent-session": sid },
  networkMode: `container:${parent}`,
  running,
});
const agent = (running: boolean): FakeContainer => ({ networkMode: "bridge", running });

// ---------------------------------------------------------------------------

describe("netnsParentId", () => {
  it("extracts the parent id from a container: network mode", () => {
    expect(netnsParentId("container:abc123")).toBe("abc123");
  });

  it("returns null for a network mode that borrows no namespace", () => {
    expect(netnsParentId("bridge")).toBeNull();
    expect(netnsParentId("host")).toBeNull();
    expect(netnsParentId("shipit-session-abc")).toBeNull();
    expect(netnsParentId(undefined)).toBeNull();
    expect(netnsParentId("")).toBeNull();
  });

  it("returns null for a malformed container: mode with no id", () => {
    expect(netnsParentId("container:")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("isOrphanedSidecar", () => {
  it("is NOT orphaned while its netns parent is running", async () => {
    const { docker } = fakeDocker({ "agent-1": agent(true), "res-1": resolver("s1", "agent-1") });
    expect(await isOrphanedSidecar(docker, "res-1")).toBe(false);
  });

  it("IS orphaned when its parent exists but has exited — the crash case", async () => {
    // The die/oom path leaves the agent container in place, Exited, until the
    // next create removes it by name. Parent-existence alone would miss this.
    const { docker } = fakeDocker({ "agent-1": agent(false), "res-1": resolver("s1", "agent-1") });
    expect(await isOrphanedSidecar(docker, "res-1")).toBe(true);
  });

  it("IS orphaned when its parent is gone from the daemon entirely", async () => {
    const { docker } = fakeDocker({ "res-1": resolver("s1", "agent-gone") });
    expect(await isOrphanedSidecar(docker, "res-1")).toBe(true);
  });

  it("is NOT orphaned when it borrows no namespace at all", async () => {
    const { docker } = fakeDocker({
      "odd-1": { labels: { [EGRESS_PROXY_LABEL]: "s1" }, networkMode: "bridge", running: true },
    });
    expect(await isOrphanedSidecar(docker, "odd-1")).toBe(false);
  });

  it("fails safe (not orphaned) when the sidecar itself can't be inspected", async () => {
    const { docker } = fakeDocker({});
    expect(await isOrphanedSidecar(docker, "vanished")).toBe(false);
  });

  it("fails safe (not orphaned) when the parent inspect comes back without a State", async () => {
    // A structurally incomplete inspect is UNCERTAIN, not "stopped". Reading a
    // missing field as a reap signal turns a schema surprise into a live session
    // losing its DNS.
    const { docker } = fakeDocker({ "res-1": resolver("s1", "agent-1") });
    vi.mocked(docker.getContainer).mockImplementation(((id: string) => ({
      inspect: async () =>
        id === "res-1"
          ? { HostConfig: { NetworkMode: "container:agent-1" }, State: { Running: true } }
          : { HostConfig: {} }, // parent: no State at all
      remove: async () => undefined,
    })) as unknown as Docker["getContainer"]);

    expect(await isOrphanedSidecar(docker, "res-1")).toBe(false);
  });

  it("fails safe (not orphaned) when the parent inspect errors with a non-404", async () => {
    // A daemon hiccup must never be read as "parent gone" — a false reap costs a
    // LIVE session its DNS and HTTPS.
    const { docker } = fakeDocker({ "res-1": resolver("s1", "agent-1") });
    vi.mocked(docker.getContainer).mockImplementation(((id: string) => ({
      inspect: async () => {
        if (id === "res-1") return { HostConfig: { NetworkMode: "container:agent-1" }, State: { Running: true } };
        throw Object.assign(new Error("daemon on fire"), { statusCode: 500 });
      },
      remove: async () => undefined,
    })) as unknown as Docker["getContainer"]);

    expect(await isOrphanedSidecar(docker, "res-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("reapSessionEgressSidecars (crash-site reap)", () => {
  it("removes BOTH tiers of the dead agent container", async () => {
    const { docker, removed } = fakeDocker({
      "agent-1": agent(false),
      "res-1": resolver("s1", "agent-1"),
      "proxy-1": proxy("s1", "agent-1"),
    });

    expect(await reapSessionEgressSidecars(docker, "s1", "agent-1")).toBe(2);
    expect([...removed].sort()).toEqual(["proxy-1", "res-1"]);
  });

  it("does NOT reap when the named parent is STILL RUNNING — an `oom` event is not proof of death", async () => {
    // Docker's `oom` event fires when the cgroup OOM-killer kills *a process*, not
    // necessarily the container: if the victim wasn't PID 1, the container keeps
    // running and its namespace is alive. The id says WHICH namespace we mean;
    // liveness says whether it's actually gone. Both are required.
    const { docker, removed } = fakeDocker({
      "agent-1": agent(true), // survived the OOM
      "res-1": resolver("s1", "agent-1"),
      "proxy-1": proxy("s1", "agent-1"),
    });

    expect(await reapSessionEgressSidecars(docker, "s1", "agent-1")).toBe(0);
    expect(removed).toEqual([]);
  });

  it("SPARES the replacement incarnation's sidecars — the fire-and-forget recreate race", async () => {
    // The reap is `void`-called from the Docker event handler, so it can still be
    // in flight when the session is reactivated and a new agent container comes
    // up carrying the SAME session id. A label-only reap would come back holding
    // the replacement's sidecars and force-remove them, leaving a healthy running
    // agent with no DNS and no HTTPS. Scoping to the dead parent's id is what
    // makes the reap idempotent no matter how late it lands.
    const { docker, removed } = fakeDocker({
      "agent-old": agent(false),
      "res-old": resolver("s1", "agent-old"),
      "proxy-old": proxy("s1", "agent-old"),
      // …the replacement, already up by the time our listContainers resolves:
      "agent-new": agent(true),
      "res-new": resolver("s1", "agent-new"),
      "proxy-new": proxy("s1", "agent-new"),
    });

    expect(await reapSessionEgressSidecars(docker, "s1", "agent-old")).toBe(2);

    expect([...removed].sort()).toEqual(["proxy-old", "res-old"]);
    expect(removed).not.toContain("res-new");
    expect(removed).not.toContain("proxy-new");
  });

  it("leaves OTHER sessions' sidecars alone", async () => {
    const { docker, removed } = fakeDocker({
      "agent-1": agent(false),
      "res-1": resolver("s1", "agent-1"),
      "agent-2": agent(false),
      "res-2": resolver("s2", "agent-2"),
      "proxy-2": proxy("s2", "agent-2"),
    });

    await reapSessionEgressSidecars(docker, "s1", "agent-1");

    expect(removed).toEqual(["res-1"]);
  });

  it("does NOT touch the session's compose children — an agent OOM must not drop the user's services", async () => {
    // The whole reason this is label-scoped to the egress tiers rather than
    // reusing `cleanupSessionDockerResources`: that sweeps every
    // `shipit-parent-session` child, database volumes included.
    const { docker, removed } = fakeDocker({
      "agent-1": agent(false),
      "res-1": resolver("s1", "agent-1"),
      "db-1": { labels: { "shipit-parent-session": "s1", "shipit-service-name": "db" }, running: true },
      "web-1": { labels: { "shipit-parent-session": "s1", "shipit-service-name": "web" }, running: true },
    });

    await reapSessionEgressSidecars(docker, "s1", "agent-1");

    expect(removed).toEqual(["res-1"]);
  });

  it("reaps nothing when the dead container's id is unknown, rather than falling back to an unscoped sweep", async () => {
    const { docker, removed } = fakeDocker({
      "agent-1": agent(false),
      "res-1": resolver("s1", "agent-1"),
      "proxy-1": proxy("s1", "agent-1"),
    });

    expect(await reapSessionEgressSidecars(docker, "s1", "")).toBe(0);
    expect(removed).toEqual([]);
  });

  it("skips a sidecar it cannot inspect rather than reaping it unscoped", async () => {
    const { docker, removed } = fakeDocker({
      "res-1": { labels: { [EGRESS_RESOLVER_LABEL]: "s1" } }, // no networkMode → unreadable parent
    });

    expect(await reapSessionEgressSidecars(docker, "s1", "agent-1")).toBe(0);
    expect(removed).toEqual([]);
  });

  it("is a no-op, and does not throw, when the session has no sidecars", async () => {
    const { docker, removed } = fakeDocker({ "agent-1": agent(true) });
    expect(await reapSessionEgressSidecars(docker, "s1", "agent-1")).toBe(0);
    expect(removed).toEqual([]);
  });

  it("never rejects when Docker is unavailable — it's called fire-and-forget from an event handler", async () => {
    const docker = {
      listContainers: vi.fn(async () => { throw new Error("ECONNREFUSED"); }),
      getContainer: vi.fn(),
    } as unknown as Docker;

    await expect(
      reapSessionEgressSidecars(docker, "s1", "agent-1", { backoffMs: 0 }),
    ).resolves.toBe(0);
  });

  it("reaps an EXITED sidecar — the common orphan, and invisible without `all: true`", async () => {
    // `listContainers` returns RUNNING containers only unless `all: true`. An
    // orphaned sidecar has usually already exited: its `RestartPolicy` is
    // `on-failure`/max-3, every retry fails to join the dead namespace, and it
    // settles in `Exited`. Drop `all: true` and the reaper lists nothing, reaps
    // nothing, and leaks everything — silently. This test is the tripwire.
    const { docker, removed } = fakeDocker({
      "agent-1": agent(false),
      "res-1": resolver("s1", "agent-1", false), // gave up and exited
      "proxy-1": proxy("s1", "agent-1", false),
    });

    expect(await reapSessionEgressSidecars(docker, "s1", "agent-1")).toBe(2);
    expect([...removed].sort()).toEqual(["proxy-1", "res-1"]);
  });

  it("RETRIES a transient Docker failure — the crash path gets no second chance", async () => {
    // The map-entry delete in the die/oom handler latches the leak: after it, no
    // `destroyContainer` will ever sweep. So if a daemon blip (an OOM storm is
    // exactly when the daemon is least responsive) makes this reap's list fail, a
    // single-shot reap strands the sidecars until the next orchestrator boot —
    // which on a manually-deployed box may be months. Retrying is safe because the
    // reap is id-scoped and liveness-gated: however late an attempt lands, it can
    // only ever match the dead parent's own sidecars.
    const { docker, removed } = fakeDocker(
      {
        "agent-1": agent(false),
        "res-1": resolver("s1", "agent-1", false),
        "proxy-1": proxy("s1", "agent-1", false),
      },
      // Fail the first attempt's two tier-label queries, then recover.
      { listError: (call) => (call <= 2 ? new Error("ECONNRESET") : undefined) },
    );

    expect(await reapSessionEgressSidecars(docker, "s1", "agent-1", { backoffMs: 0 })).toBe(2);
    expect([...removed].sort()).toEqual(["proxy-1", "res-1"]);
  });

  it("gives up after the last attempt without rejecting, reaping nothing", async () => {
    const docker = {
      listContainers: vi.fn(async () => { throw new Error("ECONNREFUSED"); }),
      getContainer: vi.fn(),
    } as unknown as Docker;

    await expect(
      reapSessionEgressSidecars(docker, "s1", "agent-1", { attempts: 2, backoffMs: 0 }),
    ).resolves.toBe(0);
    // Two attempts × two tier labels, and it stopped there rather than spinning.
    expect(docker.listContainers).toHaveBeenCalledTimes(2);
  });

  it("does NOT count a 409 as a removal — a conflict is not a completion", async () => {
    // The crash reap races `destroyContainer`'s own label sweep on every routine
    // teardown (stopping the agent fires a `die`). Whoever loses sees 409 or 404.
    //
    // 404 is confirmation: the container does not exist. 409 is NOT — Docker
    // returns it for a removal *conflict* ("removal already in progress"), which
    // says someone else STARTED the job, not that they finished it. If that other
    // removal then fails, treating our 409 as success retires a sidecar that is
    // still very much there. So it counts as unconfirmed and drives a retry.
    //
    // It must still RESOLVE, never reject: this is `void`-called from a Docker
    // event handler, so a rejection is an unhandled rejection in the orchestrator.
    const { docker } = fakeDocker(
      {
        "agent-1": agent(false),
        "res-1": resolver("s1", "agent-1", false),
      },
      { removeError: () => Object.assign(new Error("removal in progress"), { statusCode: 409 }) },
    );

    await expect(
      reapSessionEgressSidecars(docker, "s1", "agent-1", { attempts: 2, backoffMs: 0 }),
    ).resolves.toBe(0);
  });

  it("counts a 404 as confirmed-gone — however it got there", async () => {
    const { docker } = fakeDocker(
      {
        "agent-1": agent(false),
        "res-1": resolver("s1", "agent-1", false),
      },
      { removeError: () => Object.assign(new Error("no such container"), { statusCode: 404 }) },
    );

    await expect(reapSessionEgressSidecars(docker, "s1", "agent-1")).resolves.toBe(1);
  });

  it("keeps reaping the other sidecars when ONE of them is unreadable", async () => {
    // An abort-on-first-error would rethrow before ever reaching the proxy — and
    // since every retry re-lists in the same order, it would hit the same wall each
    // time and remove NOTHING. One sick container must not starve its siblings.
    const { docker, removed } = fakeDocker(
      {
        "agent-1": agent(false),
        "res-1": resolver("s1", "agent-1", false),
        "proxy-1": proxy("s1", "agent-1", false),
      },
      {
        inspectError: (id) =>
          id === "res-1"
            ? Object.assign(new Error("daemon on fire"), { statusCode: 500 })
            : undefined,
      },
    );

    // Resolves (never rejects); the healthy proxy IS collected despite the sick
    // resolver, which stays unresolved and is left for the boot sweep.
    await expect(
      reapSessionEgressSidecars(docker, "s1", "agent-1", { attempts: 2, backoffMs: 0 }),
    ).resolves.toBe(1);
    expect(removed).toEqual(["proxy-1"]);
  });

  it("retries a genuinely failed removal, then gives up without rejecting", async () => {
    // A 500 from `remove()` is not "already gone" — the sidecar is still there, on
    // the one path that gets no second chance. So it drives a retry like any other
    // Docker failure, and if it never succeeds we resolve (never reject) and leave
    // it for the boot sweep.
    const { docker } = fakeDocker(
      {
        "agent-1": agent(false),
        "res-1": resolver("s1", "agent-1", false),
      },
      { removeError: () => Object.assign(new Error("daemon on fire"), { statusCode: 500 }) },
    );

    await expect(
      reapSessionEgressSidecars(docker, "s1", "agent-1", { attempts: 2, backoffMs: 0 }),
    ).resolves.toBe(0);
    expect(docker.listContainers).toHaveBeenCalledTimes(4); // 2 attempts × 2 tier labels
  });

  it("succeeds on a retry after a transient removal failure", async () => {
    let attempts = 0;
    const { docker, removed } = fakeDocker(
      {
        "agent-1": agent(false),
        "res-1": resolver("s1", "agent-1", false),
      },
      {
        removeError: () => {
          attempts++;
          return attempts === 1
            ? Object.assign(new Error("conflict"), { statusCode: 500 })
            : undefined;
        },
      },
    );

    expect(await reapSessionEgressSidecars(docker, "s1", "agent-1", { backoffMs: 0 })).toBe(1);
    expect(removed).toEqual(["res-1"]);
  });
});

// ---------------------------------------------------------------------------

describe("reapOrphanEgressSidecars (boot crash-recovery sweep)", () => {
  it("reaps orphans across sessions while sparing every live sidecar", async () => {
    const { docker, removed } = fakeDocker({
      // s1: healthy — parent running.
      "agent-1": agent(true),
      "res-1": resolver("s1", "agent-1"),
      "proxy-1": proxy("s1", "agent-1"),
      // s2: agent OOM'd, corpse still present.
      "agent-2": agent(false),
      "res-2": resolver("s2", "agent-2"),
      "proxy-2": proxy("s2", "agent-2"),
      // s3: agent removed out-of-band; sidecars stranded.
      "res-3": resolver("s3", "agent-3-gone"),
    });

    expect(await reapOrphanEgressSidecars(docker)).toBe(3);
    expect([...removed].sort()).toEqual(["proxy-2", "res-2", "res-3"]);
  });

  it("is incarnation-aware: reaps the DEAD incarnation's sidecars, spares the new one's", async () => {
    // The exact case the label-only keep-list got wrong. Same session id on both
    // generations of sidecar — only the netns parent distinguishes them.
    const { docker, removed } = fakeDocker({
      "agent-old": agent(false),
      "res-old": resolver("s1", "agent-old"),
      "proxy-old": proxy("s1", "agent-old"),
      "agent-new": agent(true),
      "res-new": resolver("s1", "agent-new"),
      "proxy-new": proxy("s1", "agent-new"),
    });

    await reapOrphanEgressSidecars(docker);

    expect([...removed].sort()).toEqual(["proxy-old", "res-old"]);
  });

  it("removes nothing when every sidecar's parent is alive", async () => {
    const { docker, removed } = fakeDocker({
      "agent-1": agent(true),
      "res-1": resolver("s1", "agent-1"),
      "proxy-1": proxy("s1", "agent-1"),
    });

    expect(await reapOrphanEgressSidecars(docker)).toBe(0);
    expect(removed).toEqual([]);
  });

  it("ignores non-sidecar containers entirely, however dead they are", async () => {
    const { docker, removed } = fakeDocker({
      "agent-1": agent(false),
      "db-1": { labels: { "shipit-parent-session": "s1" }, running: false },
    });

    expect(await reapOrphanEgressSidecars(docker)).toBe(0);
    expect(removed).toEqual([]);
  });

  it("never rejects when Docker is unavailable", async () => {
    const docker = {
      listContainers: vi.fn(async () => { throw new Error("ECONNREFUSED"); }),
      getContainer: vi.fn(),
    } as unknown as Docker;

    await expect(reapOrphanEgressSidecars(docker)).resolves.toBe(0);
  });
});
