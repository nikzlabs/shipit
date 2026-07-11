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
  /** Container id → running?  Absent from the map means "not in the daemon". */
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
      const labels = args.filter((_, i) => args[i - 1] === "--filter").map(f => f.replace(/^label=/, ""));
      const tier = labels.find(l => l.startsWith(EGRESS_RESOLVER_LABEL) || l.startsWith(EGRESS_PROXY_LABEL));
      if (!tier) return world.children.join("\n"); // parent-label query → every child
      const [label] = tier.split("=", 1);
      return world.sidecars.filter(s => s.label === label).map(s => s.id).join("\n");
    }

    if (cmd === "inspect") {
      const fmt = args[2];
      const id = args[3]!;
      if (fmt === "{{.HostConfig.NetworkMode}}") {
        const sc = world.sidecars.find(s => s.id === id);
        return sc ? `container:${sc.parent}` : "bridge";
      }
      if (fmt === "{{.State.Running}}") {
        if (!(id in world.running)) throw new Error(`Error: No such object: ${id}`);
        return String(world.running[id]);
      }
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

  it("fails SAFE toward keeping when the sidecar itself can't be inspected", async () => {
    // A false reap costs a running session its DNS and HTTPS; a false keep costs
    // one stale container the boot janitor reaps anyway. So an unreadable sidecar
    // is kept, preserving the pre-SHI-222 behavior.
    const world: World = {
      children: ["res-1", "stale-web"],
      sidecars: [{ id: "res-1", label: EGRESS_RESOLVER_LABEL, parent: "agent-1" }],
      running: { "agent-1": true },
    };
    const removed: string[] = [];
    const query = vi.fn(async (args: string[]): Promise<string> => {
      const [cmd] = args;
      if (cmd === "inspect") throw new Error("daemon on fire");
      if (cmd === "ps") {
        const hasTier = args.some(a => a.includes(EGRESS_RESOLVER_LABEL) || a.includes(EGRESS_PROXY_LABEL));
        if (!hasTier) return world.children.join("\n");
        const isResolver = args.some(a => a.includes(EGRESS_RESOLVER_LABEL));
        return isResolver ? "res-1" : "";
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

    await cli.killStaleContainers();

    expect(removed).toEqual(["stale-web"]);
  });
});
