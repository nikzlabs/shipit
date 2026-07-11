/**
 * Tests for ComposeCli's pre-start stale-container sweep (`killStaleContainers`).
 *
 * The sweep removes leftovers from a previous compose stack for the session, but
 * must SPARE the long-lived Tier B/C egress sidecars (docs/172) — they carry
 * `shipit-parent-session` only so destroy-time cleanup reaps them, and killing
 * them ~1s after the agent launches would leave the session with no resolver and
 * no HTTPS.
 *
 * SHI-222: that keep-list has to be INCARNATION-aware. Both egress labels are
 * keyed on the session id, which is stable across container recreations — so a
 * label-only match also spares the sidecars of a PREVIOUS, dead agent container.
 * Those share a torn-down network namespace and are pure garbage. The test is
 * netns-parent liveness.
 */

import { describe, it, expect, vi } from "vitest";
import { ComposeCli } from "./compose-cli.js";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

const SID = "sess-1";

interface World {
  /** All containers carrying `shipit-parent-session=<SID>`. */
  children: string[];
  /** Containers carrying an egress tier label for this session. */
  sidecars: { id: string; label: string; parent: string }[];
  /**
   * Container id → running? Both "present but stopped" (`false`) and "gone from
   * the daemon" (absent) are indistinguishable to a `ps --filter status=running`
   * probe — which is fine, because both mean the same thing here: the netns is
   * dead. That's exactly why the probe is `ps` and not `inspect`.
   */
  running: Record<string, boolean>;
}

/**
 * A fake `docker` CLI over {@link World}. ComposeCli's `query` hook shells out to
 * raw `docker` (not `docker compose`) for `ps` / `inspect` / `rm`, so we dispatch
 * on the subcommand.
 */
function makeCli(world: World) {
  const removed: string[] = [];

  const query = vi.fn(async (args: string[]): Promise<string> => {
    const [cmd] = args;

    if (cmd === "ps") {
      const filters = args.filter((_, i) => args[i - 1] === "--filter");

      // Parent-liveness probe: `ps -q --no-trunc --filter id=<p> --filter status=running`.
      // Exits 0 whether or not it matches — printing the id when the parent is
      // running and nothing when it isn't. That's the whole point: "not running"
      // is a VALUE, not an exception, so it can't be confused with a daemon error.
      const idFilter = filters.find(f => f.startsWith("id="));
      if (idFilter) {
        const parent = idFilter.slice("id=".length);
        return world.running[parent] ? parent : "";
      }

      const labels = filters.map(f => f.replace(/^label=/, ""));
      const tier = labels.find(l => l.startsWith(EGRESS_RESOLVER_LABEL) || l.startsWith(EGRESS_PROXY_LABEL));
      if (!tier) return world.children.join("\n"); // parent-label query → every child
      const [label] = tier.split("=", 1);
      return world.sidecars.filter(s => s.label === label).map(s => s.id).join("\n");
    }

    if (cmd === "inspect") {
      const id = args[3]!;
      const sc = world.sidecars.find(s => s.id === id);
      return sc ? `container:${sc.parent}` : "bridge";
    }

    if (cmd === "rm") {
      removed.push(...args.slice(2)); // ["rm", "-f", ...ids]
      return "";
    }

    if (cmd === "network") return "";
    return "";
  });

  const cli = new ComposeCli({
    sessionId: SID,
    workspaceDir: "/workspace",
    composeFile: "docker-compose.yml",
    composeQuery: query,
    composeRunner: vi.fn(async () => undefined),
  });

  return { cli, removed };
}

describe("ComposeCli.killStaleContainers — egress sidecar keep-list (SHI-222)", () => {
  it("spares the CURRENT incarnation's sidecars (their netns parent is running)", async () => {
    const { cli, removed } = makeCli({
      children: ["res-new", "proxy-new", "stale-web"],
      sidecars: [
        { id: "res-new", label: EGRESS_RESOLVER_LABEL, parent: "agent-new" },
        { id: "proxy-new", label: EGRESS_PROXY_LABEL, parent: "agent-new" },
      ],
      running: { "agent-new": true },
    });

    await cli.killStaleContainers();

    expect(removed).toEqual(["stale-web"]);
  });

  it("SWEEPS a previous incarnation's sidecars whose parent container is gone", async () => {
    // The agent container OOM'd and was removed by name on the next create; its
    // sidecars were left behind. The label-only keep-list used to spare these.
    const { cli, removed } = makeCli({
      children: ["res-old", "proxy-old", "stale-web"],
      sidecars: [
        { id: "res-old", label: EGRESS_RESOLVER_LABEL, parent: "agent-old" },
        { id: "proxy-old", label: EGRESS_PROXY_LABEL, parent: "agent-old" },
      ],
      running: {}, // agent-old is gone from the daemon
    });

    await cli.killStaleContainers();

    expect([...removed].sort()).toEqual(["proxy-old", "res-old", "stale-web"]);
  });

  it("SWEEPS a previous incarnation's sidecars whose parent exists but has exited", async () => {
    // The crash case: `container-health` doesn't remove the dead agent container,
    // so the corpse lingers. Parent-EXISTENCE alone would wrongly spare these;
    // parent-LIVENESS catches them.
    const { cli, removed } = makeCli({
      children: ["res-old", "stale-web"],
      sidecars: [{ id: "res-old", label: EGRESS_RESOLVER_LABEL, parent: "agent-old" }],
      running: { "agent-old": false },
    });

    await cli.killStaleContainers();

    expect([...removed].sort()).toEqual(["res-old", "stale-web"]);
  });

  it("keeps the live sidecars and sweeps the dead ones when BOTH generations are present", async () => {
    // The exact mixed state a recreate leaves behind. Same session id on both
    // generations — only the netns parent tells them apart.
    const { cli, removed } = makeCli({
      children: ["res-old", "proxy-old", "res-new", "proxy-new"],
      sidecars: [
        { id: "res-old", label: EGRESS_RESOLVER_LABEL, parent: "agent-old" },
        { id: "proxy-old", label: EGRESS_PROXY_LABEL, parent: "agent-old" },
        { id: "res-new", label: EGRESS_RESOLVER_LABEL, parent: "agent-new" },
        { id: "proxy-new", label: EGRESS_PROXY_LABEL, parent: "agent-new" },
      ],
      running: { "agent-old": false, "agent-new": true },
    });

    await cli.killStaleContainers();

    expect([...removed].sort()).toEqual(["proxy-old", "res-old"]);
  });

  it("is a no-op when the session has no stale containers at all", async () => {
    const { cli, removed } = makeCli({ children: [], sidecars: [], running: {} });

    await cli.killStaleContainers();

    expect(removed).toEqual([]);
  });

  /**
   * Both fail-safe tests below pin the SAME rule from opposite sides: when the
   * Docker daemon won't give a straight answer, KEEP the sidecar. A false reap
   * costs a *running* session its DNS and HTTPS; a false keep costs one inert
   * container that the boot janitor's parent-liveness sweep collects anyway.
   */
  function makeCliWithFailingQuery(failOn: (args: string[]) => boolean, world: World) {
    const removed: string[] = [];
    const query = vi.fn(async (args: string[]): Promise<string> => {
      if (failOn(args)) throw new Error("Cannot connect to the Docker daemon");
      const [cmd] = args;
      if (cmd === "ps") {
        const filters = args.filter((_, i) => args[i - 1] === "--filter");
        const idFilter = filters.find(f => f.startsWith("id="));
        if (idFilter) {
          const parent = idFilter.slice("id=".length);
          return world.running[parent] ? parent : "";
        }
        const labels = filters.map(f => f.replace(/^label=/, ""));
        const tier = labels.find(l => l.startsWith(EGRESS_RESOLVER_LABEL) || l.startsWith(EGRESS_PROXY_LABEL));
        if (!tier) return world.children.join("\n");
        const [label] = tier.split("=", 1);
        return world.sidecars.filter(s => s.label === label).map(s => s.id).join("\n");
      }
      if (cmd === "inspect") {
        const sc = world.sidecars.find(s => s.id === args[3]);
        return sc ? `container:${sc.parent}` : "bridge";
      }
      if (cmd === "rm") { removed.push(...args.slice(2)); return ""; }
      return "";
    });
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      composeFile: "docker-compose.yml",
      composeQuery: query,
      composeRunner: vi.fn(async () => undefined),
    });
    return { cli, removed };
  }

  it("fails SAFE toward keeping when the sidecar itself can't be inspected", async () => {
    const world: World = {
      children: ["res-1", "stale-web"],
      sidecars: [{ id: "res-1", label: EGRESS_RESOLVER_LABEL, parent: "agent-1" }],
      running: { "agent-1": true },
    };
    const { cli, removed } = makeCliWithFailingQuery(args => args[0] === "inspect", world);

    await cli.killStaleContainers();

    expect(removed).toEqual(["stale-web"]);
  });

  it("fails SAFE toward keeping when the daemon errors while probing a LIVE parent", async () => {
    // The bug this guards: `docker inspect` exits non-zero BOTH when a container
    // is gone AND when the daemon is merely unhappy (500 / timeout / socket
    // error). An implementation that catches the rejection and concludes "parent
    // gone" would let a transient blip reap a live session's resolver and proxy.
    // Hence the `ps --filter status=running` probe — it exits 0 either way, so
    // "not running" is a value we read, and a throw genuinely means "don't know".
    const world: World = {
      children: ["res-1", "proxy-1", "stale-web"],
      sidecars: [
        { id: "res-1", label: EGRESS_RESOLVER_LABEL, parent: "agent-1" },
        { id: "proxy-1", label: EGRESS_PROXY_LABEL, parent: "agent-1" },
      ],
      running: { "agent-1": true }, // the parent IS alive — the daemon just won't say so
    };
    const { cli, removed } = makeCliWithFailingQuery(
      args => args[0] === "ps" && args.some(a => a.startsWith("id=")),
      world,
    );

    await cli.killStaleContainers();

    expect(removed).toEqual(["stale-web"]);
    expect(removed).not.toContain("res-1");
    expect(removed).not.toContain("proxy-1");
  });
});
