import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ComposeCli,
  composeUpPhaseOf,
  defaultComposeRunner,
  extractActiveEndpointNetwork,
  prepareModelFreeComposeDir,
  type ComposeOutputSink,
  type ComposeRunner,
  type ComposeQuery,
} from "./compose-cli.js";
import type { ConfinedComposeApi } from "./compose-helper.js";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

const SID = "sess-1";

const START = {
  model: { snapshotFile: "/state/compose/starts/a/snapshot.yml", overrideFile: "/state/compose/starts/a/override.yml" },
};

/** A confined `up` that runs through `runner`, as `up <services>`. */
function confinedVia(runner: ComposeRunner): Pick<ConfinedComposeApi, "build" | "up"> {
  return {
    build: vi.fn(async () => undefined),
    up: (req) => runner(["compose", "up", ...req.services], "/state/compose", req.onOutput),
  };
}

interface World {
  children: string[];
  sidecars: { id: string; label: string; parent: string }[];
  state: Record<string, "running" | "paused" | "exited">;
}

function psListsIt(world: World, id: string): boolean {
  const s = world.state[id];
  return s === "running" || s === "paused";
}

function makeCli(world: World) {
  const removed: string[] = [];

  const query = vi.fn(async (args: string[]): Promise<string> => {
    const [cmd] = args;

    if (cmd === "ps") {
      const filters = args.filter((_, i) => args[i - 1] === "--filter");
      const all = args.some(a => a === "-a" || a === "-aq");

      const idFilter = filters.find(f => f.startsWith("id="));
      if (idFilter) {
        const parent = idFilter.slice("id=".length);
        const statusFilter = filters.find(f => f.startsWith("status="))?.slice("status=".length);
        if (statusFilter) return world.state[parent] === statusFilter ? parent : "";
        if (all) return world.state[parent] ? parent : "";
        return psListsIt(world, parent) ? parent : "";
      }

      const labels = filters.map(f => f.replace(/^label=/, ""));
      const tier = labels.find(l => l.startsWith(EGRESS_RESOLVER_LABEL) || l.startsWith(EGRESS_PROXY_LABEL));
      if (!tier) return world.children.join("\n");
      const [label] = tier.split("=", 1);
      return world.sidecars.filter(s => s.label === label).map(s => s.id).join("\n");
    }

    if (cmd === "inspect") {
      const id = args[3]!;
      const sc = world.sidecars.find(s => s.id === id);
      return sc ? `container:${sc.parent}` : "bridge";
    }

    if (cmd === "rm") {
      removed.push(...args.slice(2));
      return "";
    }

    if (cmd === "network") return "";
    return "";
  });

  const cli = new ComposeCli({
    sessionId: SID,
    workspaceDir: "/workspace",
    confined: confinedVia(vi.fn(async () => undefined)),
    composeQuery: query,
    composeRunner: vi.fn(async () => undefined),
  });

  return { cli, removed };
}

describe("ComposeCli.killStaleContainers — egress sidecar keep-list (planning#224)", () => {
  it("spares the CURRENT incarnation's sidecars (their netns parent is running)", async () => {
    const { cli, removed } = makeCli({
      children: ["res-new", "proxy-new", "stale-web"],
      sidecars: [
        { id: "res-new", label: EGRESS_RESOLVER_LABEL, parent: "agent-new" },
        { id: "proxy-new", label: EGRESS_PROXY_LABEL, parent: "agent-new" },
      ],
      state: { "agent-new": "running" },
    });

    await cli.killStaleContainers();

    expect(removed).toEqual(["stale-web"]);
  });

  it("SWEEPS a previous incarnation's sidecars whose parent container is gone", async () => {
    const { cli, removed } = makeCli({
      children: ["res-old", "proxy-old", "stale-web"],
      sidecars: [
        { id: "res-old", label: EGRESS_RESOLVER_LABEL, parent: "agent-old" },
        { id: "proxy-old", label: EGRESS_PROXY_LABEL, parent: "agent-old" },
      ],
      state: {},
    });

    await cli.killStaleContainers();

    expect([...removed].sort()).toEqual(["proxy-old", "res-old", "stale-web"]);
  });

  it("SWEEPS a previous incarnation's sidecars whose parent exists but has exited", async () => {
    const { cli, removed } = makeCli({
      children: ["res-old", "stale-web"],
      sidecars: [{ id: "res-old", label: EGRESS_RESOLVER_LABEL, parent: "agent-old" }],
      state: { "agent-old": "exited" },
    });

    await cli.killStaleContainers();

    expect([...removed].sort()).toEqual(["res-old", "stale-web"]);
  });

  it("keeps the live sidecars and sweeps the dead ones when BOTH generations are present", async () => {
    const { cli, removed } = makeCli({
      children: ["res-old", "proxy-old", "res-new", "proxy-new"],
      sidecars: [
        { id: "res-old", label: EGRESS_RESOLVER_LABEL, parent: "agent-old" },
        { id: "proxy-old", label: EGRESS_PROXY_LABEL, parent: "agent-old" },
        { id: "res-new", label: EGRESS_RESOLVER_LABEL, parent: "agent-new" },
        { id: "proxy-new", label: EGRESS_PROXY_LABEL, parent: "agent-new" },
      ],
      state: { "agent-old": "exited", "agent-new": "running" },
    });

    await cli.killStaleContainers();

    expect([...removed].sort()).toEqual(["proxy-old", "res-old"]);
  });

  it("SPARES sidecars whose parent is PAUSED — a paused container still owns a live netns", async () => {
    const { cli, removed } = makeCli({
      children: ["res-1", "proxy-1", "stale-web"],
      sidecars: [
        { id: "res-1", label: EGRESS_RESOLVER_LABEL, parent: "agent-1" },
        { id: "proxy-1", label: EGRESS_PROXY_LABEL, parent: "agent-1" },
      ],
      state: { "agent-1": "paused" },
    });

    await cli.killStaleContainers();

    expect(removed).toEqual(["stale-web"]);
    expect(removed).not.toContain("res-1");
    expect(removed).not.toContain("proxy-1");
  });

  it("is a no-op when the session has no stale containers at all", async () => {
    const { cli, removed } = makeCli({ children: [], sidecars: [], state: {} });

    await cli.killStaleContainers();

    expect(removed).toEqual([]);
  });

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
          return psListsIt(world, parent) ? parent : "";
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
      confined: confinedVia(vi.fn(async () => undefined)),
      composeQuery: query,
      composeRunner: vi.fn(async () => undefined),
    });
    return { cli, removed };
  }

  it("fails SAFE toward keeping when the sidecar itself can't be inspected", async () => {
    const world: World = {
      children: ["res-1", "stale-web"],
      sidecars: [{ id: "res-1", label: EGRESS_RESOLVER_LABEL, parent: "agent-1" }],
      state: { "agent-1": "running" },
    };
    const { cli, removed } = makeCliWithFailingQuery(args => args[0] === "inspect", world);

    await cli.killStaleContainers();

    expect(removed).toEqual(["stale-web"]);
  });

  it("fails SAFE toward keeping when the daemon errors while probing a LIVE parent", async () => {
    const world: World = {
      children: ["res-1", "proxy-1", "stale-web"],
      sidecars: [
        { id: "res-1", label: EGRESS_RESOLVER_LABEL, parent: "agent-1" },
        { id: "proxy-1", label: EGRESS_PROXY_LABEL, parent: "agent-1" },
      ],
      state: { "agent-1": "running" },
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

describe("ComposeCli — compose up output sink", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function makeSinkCli() {
    const calls: { args: string[]; hasSink: boolean }[] = [];
    const runner = vi.fn(
      async (args: string[], _cwd: string, onOutput?: (chunk: string) => void) => {
        calls.push({ args, hasSink: !!onOutput });
        onOutput?.("#1 [internal] load build definition\n");
        onOutput?.("#2 exporting layers ");
        onOutput?.("done\n");
      },
    );
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compose-sink-"));
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: path.join(tmp, "workspace"),
      composeStateDir: path.join(tmp, "state", "compose"),
      confined: confinedVia(runner),
      composeQuery: vi.fn(async () => ""),
      composeRunner: runner,
    });
    return { cli, calls };
  }

  it("streams a single-service `up`'s output to the sink as it arrives", async () => {
    const { cli } = makeSinkCli();
    const chunks: string[] = [];

    await cli.up(["dev"], START, (chunk) => chunks.push(chunk));

    expect(chunks.join("")).toBe(
      "#1 [internal] load build definition\n#2 exporting layers done\n",
    );
  });

  it("streams a multi-service `up`'s output to the sink", async () => {
    const { cli } = makeSinkCli();
    const chunks: string[] = [];

    await cli.up(["web", "api"], START, (chunk) => chunks.push(chunk));

    expect(chunks.length).toBe(3);
  });

  it("passes no sink for stop/down — only `up` has a silent window to fill", async () => {
    const { cli, calls } = makeSinkCli();

    await cli.stopFrom("dev", START.model);
    await cli.downModelFree({ removeVolumes: false });

    expect(calls.map(c => c.hasSink)).toEqual([false, false]);
  });

  it("still resolves when no sink is supplied", async () => {
    const { cli, calls } = makeSinkCli();

    await expect(cli.up(["dev"], START)).resolves.toBeUndefined();
    expect(calls[0]!.hasSink).toBe(true);
  });

  it("flushes the sink once when `up` ends", async () => {
    const { cli } = makeSinkCli();
    const sink: ComposeOutputSink = () => {};
    let flushed = 0;
    sink.flush = () => { flushed += 1; };

    await cli.up(["dev"], START, sink);

    expect(flushed).toBe(1);
  });
});

describe("ComposeCli — compose up phase timings", () => {
  function makeCliEmitting(lines: string[]) {
    const runner = vi.fn(async (_args: string[], _cwd: string, onOutput?: (c: string) => void) => {
      for (const line of lines) onOutput?.(`${line}\n`);
    });
    return new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      confined: confinedVia(runner),
      composeQuery: vi.fn(async () => ""),
    });
  }

  async function timingLines(lines: string[], run: (cli: ComposeCli) => Promise<void>) {
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      if (typeof msg === "string" && msg.startsWith("[timing]")) seen.push(msg);
    });
    try {
      await run(makeCliEmitting(lines));
    } finally {
      spy.mockRestore();
    }
    return seen;
  }

  it("reports build and create when the output shows both phases", async () => {
    const seen = await timingLines(
      [
        "#1 [internal] load build definition from Dockerfile",
        "#8 exporting to image",
        " Container shipit-abc-web-1  Creating",
        " Container shipit-abc-web-1  Started",
      ],
      cli => cli.up(["web"], START),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("compose.up for sess-1 services=web");
    expect(seen[0]).toMatch(/total=\d+ms/);
    expect(seen[0]).toMatch(/build=\d+ms/);
    expect(seen[0]).toMatch(/create=\d+ms/);
  });

  it("classifies a phase marker split across two chunks", async () => {
    const runner = vi.fn(async (_args: string[], _cwd: string, onOutput?: (c: string) => void) => {
      onOutput?.("#1 [internal] load build definition\n Contai");
      onOutput?.("ner shipit-abc-web-1  Creating\n");
    });
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      confined: confinedVia(runner),
      composeQuery: vi.fn(async () => ""),
    });
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      if (typeof msg === "string" && msg.startsWith("[timing]")) seen.push(msg);
    });

    await cli.up(["web"], START);
    spy.mockRestore();

    expect(seen[0]).toMatch(/build=\d+ms/);
    expect(seen[0]).toMatch(/create=\d+ms/);
  });

  it("classifies a final line the command never terminated", async () => {
    const runner = vi.fn(async (_args: string[], _cwd: string, onOutput?: (c: string) => void) => {
      onOutput?.(" Container shipit-abc-web-1  Creating");
    });
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      confined: confinedVia(runner),
      composeQuery: vi.fn(async () => ""),
    });
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      if (typeof msg === "string" && msg.startsWith("[timing]")) seen.push(msg);
    });

    await cli.up(["web"], START);
    spy.mockRestore();

    expect(seen[0]).toMatch(/create=\d+ms/);
  });

  it("omits build for a stack whose images are already present", async () => {
    const seen = await timingLines(
      [" Container shipit-abc-web-1  Created", " Container shipit-abc-web-1  Started"],
      cli => cli.up(["web"], START),
    );

    expect(seen[0]).not.toContain("build=");
    expect(seen[0]).toMatch(/create=\d+ms/);
  });

  it("reports the total even when the up fails", async () => {
    const runner = vi.fn(async () => { throw new Error("boom"); });
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      confined: confinedVia(runner),
      composeQuery: vi.fn(async () => ""),
    });
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      if (typeof msg === "string" && msg.startsWith("[timing]")) seen.push(msg);
    });

    await expect(cli.up(["web"], START)).rejects.toThrow("boom");
    spy.mockRestore();

    expect(seen[0]).toMatch(/compose\.up for sess-1 services=web total=\d+ms/);
  });
});

describe("composeUpPhaseOf", () => {
  it("classifies container lines as create", () => {
    expect(composeUpPhaseOf(" Container shipit-abc-web-1  Creating")).toBe("create");
    expect(composeUpPhaseOf(" Container shipit-abc-web-1  Started")).toBe("create");
    expect(composeUpPhaseOf(" Network shipit-abc_default  Created")).toBe("create");
  });

  it("classifies image acquisition — build AND pull — as build", () => {
    expect(composeUpPhaseOf("#5 [builder 2/6] RUN npm ci")).toBe("build");
    expect(composeUpPhaseOf(" => CACHED [base 1/2] FROM docker.io/library/node")).toBe("build");
    expect(composeUpPhaseOf(" web Pulling")).toBe("build");
    expect(composeUpPhaseOf(" 3f4a1b2c Downloading [====>]")).toBe("build");
  });

  it("says nothing about a line that reports neither phase", () => {
    expect(composeUpPhaseOf("")).toBe(null);
    expect(composeUpPhaseOf("time=\"2026-09-03\" level=warning msg=\"version is obsolete\"")).toBe(null);
  });
});

describe("ComposeCli — container-topology bracket", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function makeCli(bracketed: boolean, runner?: ComposeRunner, query?: ComposeQuery) {
    let open = 0;
    const openWhileRunning: number[] = [];
    const defaultRunner: ComposeRunner = async () => { openWhileRunning.push(open); };
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compose-bracket-"));
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: path.join(tmp, "workspace"),
      composeStateDir: path.join(tmp, "state", "compose"),
      confined: confinedVia(runner ?? defaultRunner),
      composeQuery: query ?? vi.fn(async () => ""),
      composeRunner: runner ?? defaultRunner,
      ...(bracketed ? { onTopologyChange: () => { open++; return () => { open--; }; } } : {}),
    });
    return { cli, openWhileRunning, open: () => open, observe: () => openWhileRunning.push(open) };
  }

  it("holds a bracket open across each `up`", async () => {
    const { cli, openWhileRunning, open } = makeCli(true);

    await cli.up(["web"], START);
    await cli.up(["db"], START);

    expect(openWhileRunning).toEqual([1, 1]);
    expect(open()).toBe(0);
  });

  it("does not bracket `stop` or `down`", async () => {
    const { cli, openWhileRunning } = makeCli(true);

    await cli.stopFrom("dev", START.model);
    await cli.downModelFree({ removeVolumes: false });

    expect(openWhileRunning).toEqual([0, 0]);
  });

  it("holds ONE bracket across the conflict-recovery retry", async () => {
    let attempt = 0;
    const observed: number[] = [];
    let open = 0;
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      composeQuery: vi.fn(async () => ""),
      confined: confinedVia(vi.fn(async () => {
        observed.push(open);
        attempt++;
        if (attempt === 1) {
          throw new Error('Conflict. The container name "/web" is already in use by container "abc123def456".');
        }
      })),
      onTopologyChange: () => { open++; return () => { open--; }; },
    });

    await cli.up(["web"], START);

    expect(observed).toEqual([1, 1]);
    expect(open).toBe(0);
  });

  it("closes the bracket when the command fails for good", async () => {
    let open = 0;
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      composeQuery: vi.fn(async () => { throw new Error("no recovery"); }),
      confined: confinedVia(vi.fn(async () => { throw new Error("compose exploded"); })),
      onTopologyChange: () => { open++; return () => { open--; }; },
    });

    await expect(cli.up([], START)).rejects.toThrow(/compose exploded/);
    expect(open).toBe(0);
  });

  it("runs unbracketed when no manager supplied one", async () => {
    const { cli, openWhileRunning } = makeCli(false);
    await expect(cli.up(["web"], START)).resolves.toBeUndefined();
    expect(openWhileRunning).toEqual([0]);
  });
});

describe("ComposeCli — active-endpoint network recovery", () => {
  // A real session id: the network carries the whole id, the agent container only its first 12.
  const NET_SID = "6d898efe-6c1f-4b0a-9f6e-3a2b1c0d5e7f";
  const NETWORK = `shipit-session-${NET_SID}`;
  const ORCHESTRATOR = os.hostname();
  const AGENT = `agent-${NET_SID.slice(0, 12)}`;
  const OURS = [AGENT, ORCHESTRATOR].sort();

  function activeEndpointsError(network: string): Error {
    return new Error(
      `docker compose up failed (exit 1): failed to remove network ${network}: ` +
        `Error response from daemon: error while removing network: network ${network} ` +
        `id 8f1c2d3e4a5b has active endpoints (name:"${AGENT}", name:"shipit-shipit-1")`,
    );
  }

  /**
   * Models the daemon: `network rm` fails while any endpoint remains, a removed network stops
   * existing, and only a `up` that reaches the create phase brings it back.
   */
  function makeCli(opts: {
    failWith: Error;
    attached?: string[];
    retryFails?: boolean;
    /** Stands in for the poller's heal landing between the disconnect and the removal. */
    heal?: (attached: Set<string>, healsSoFar: number) => void;
  }) {
    const attached = new Set(opts.attached ?? OURS);
    const docker: string[][] = [];
    const rejoined: number[] = [];
    let networkExists = true;
    let attempts = 0;
    let heals = 0;

    const query = vi.fn(async (args: string[]): Promise<string> => {
      docker.push(args);
      if (args[0] === "network" && args[1] === "disconnect") {
        if (!networkExists) throw new Error(`No such network: ${args[3]}`);
        const endpoint = args[4]!;
        if (!attached.delete(endpoint)) throw new Error(`is not connected to network ${args[3]}`);
        opts.heal?.(attached, heals++);
        return "";
      }
      if (args[0] === "network" && args[1] === "rm") {
        if (!networkExists) throw new Error(`No such network: ${args[2]}`);
        if (attached.size > 0) throw new Error(`network ${args[2]} has active endpoints`);
        networkExists = false;
        return "";
      }
      return "";
    });

    const cli = new ComposeCli({
      sessionId: NET_SID,
      workspaceDir: "/workspace",
      composeQuery: query,
      confined: confinedVia(vi.fn(async () => {
        attempts++;
        if (attempts === 1) throw opts.failWith;
        // A failure before the create phase leaves the network absent.
        if (opts.retryFails) throw new Error("ERROR: failed to solve: process exited 1");
        networkExists = true;
      })),
      rejoinSessionNetwork: async () => {
        rejoined.push(attempts);
        if (networkExists) for (const e of OURS) attached.add(e);
      },
    });

    return {
      cli,
      docker,
      rejoined,
      attempts: () => attempts,
      networkExists: () => networkExists,
      stillAttached: () => [...attached].sort(),
    };
  }

  function disconnected(docker: string[][]): string[] {
    const names = docker.filter(a => a[0] === "network" && a[1] === "disconnect").map(a => a[4]!);
    return [...new Set(names)].sort();
  }

  function removals(docker: string[][]): string[][] {
    return docker.filter(a => a[0] === "network" && a[1] === "rm");
  }

  it("disconnects ShipIt's own endpoints, removes the network, and retries the up", async () => {
    const { cli, docker, attempts } = makeCli({ failWith: activeEndpointsError(NETWORK) });

    await expect(cli.up(["web"], START)).resolves.toBeUndefined();

    expect(disconnected(docker)).toEqual(OURS);
    expect(removals(docker)).toEqual([["network", "rm", NETWORK]]);
    expect(attempts()).toBe(2);
  });

  it("re-attaches ShipIt's endpoints after the retry, which no caller does on every path", async () => {
    const { cli, rejoined, stillAttached } = makeCli({ failWith: activeEndpointsError(NETWORK) });

    await cli.up(["web"], START);

    expect(rejoined).toEqual([2]);
    expect(stillAttached()).toEqual(OURS);
  });

  it("hands the endpoints back even when the retried up fails for an unrelated reason", async () => {
    const { cli, rejoined, networkExists } = makeCli({
      failWith: activeEndpointsError(NETWORK),
      retryFails: true,
    });

    await expect(cli.up(["web"], START)).rejects.toThrow(/failed to solve/);

    // The build never reached the create phase, so there is no network left to re-attach to.
    expect(rejoined).toEqual([2]);
    expect(networkExists()).toBe(false);
  });

  it("recovers when only one of ShipIt's endpoints is still attached", async () => {
    const { cli, docker, attempts } = makeCli({
      failWith: activeEndpointsError(NETWORK),
      attached: [ORCHESTRATOR],
    });

    await expect(cli.up(["web"], START)).resolves.toBeUndefined();

    expect(removals(docker)).toEqual([["network", "rm", NETWORK]]);
    expect(attempts()).toBe(2);
  });

  it("recovers when the poller's heal re-attaches the agent inside the removal window", async () => {
    const { cli, docker, attempts, rejoined } = makeCli({
      failWith: activeEndpointsError(NETWORK),
      heal: (attached, healsSoFar) => {
        if (attached.size === 0 && healsSoFar < 2) attached.add(AGENT);
      },
    });

    await expect(cli.up(["web"], START)).resolves.toBeUndefined();

    expect(removals(docker)).toHaveLength(2);
    expect(attempts()).toBe(2);
    expect(rejoined).toEqual([2]);
  });

  it("gives up and restores when the heal wins every pass", async () => {
    const { cli, docker, attempts, rejoined, stillAttached } = makeCli({
      failWith: activeEndpointsError(NETWORK),
      heal: (attached) => { if (attached.size === 0) attached.add(AGENT); },
    });

    await expect(cli.up(["web"], START)).rejects.toThrow(/id 8f1c2d3e4a5b has active endpoints/);

    expect(removals(docker)).toHaveLength(2);
    expect(rejoined).toEqual([1]);
    expect(stillAttached()).toEqual(OURS);
    expect(attempts()).toBe(1);
  });

  it("leaves a user's own Compose endpoint attached and restores ours when removal fails", async () => {
    const { cli, docker, rejoined, attempts, stillAttached } = makeCli({
      failWith: activeEndpointsError(NETWORK),
      attached: [...OURS, "user-db-1"],
    });

    await expect(cli.up(["web"], START)).rejects.toThrow(/id 8f1c2d3e4a5b has active endpoints/);

    expect(disconnected(docker)).toEqual(OURS);
    expect(rejoined).toEqual([1]);
    expect(stillAttached()).toEqual([...OURS, "user-db-1"].sort());
    expect(attempts()).toBe(1);
  });

  it("does not retry when NEITHER of our endpoints held the network", async () => {
    const { cli, docker, rejoined, attempts } = makeCli({
      failWith: activeEndpointsError(NETWORK),
      attached: ["user-db-1"],
    });

    await expect(cli.up(["web"], START)).rejects.toThrow(/has active endpoints/);

    expect(removals(docker)).toEqual([]);
    expect(rejoined).toEqual([]);
    expect(attempts()).toBe(1);
  });

  it("does NOT touch a network belonging to another session", async () => {
    const { cli, docker, attempts } = makeCli({
      failWith: activeEndpointsError("shipit-session-other"),
    });

    await expect(cli.up(["web"], START)).rejects.toThrow(/has active endpoints/);

    expect(disconnected(docker)).toEqual([]);
    expect(attempts()).toBe(1);
  });

  it("does NOT act on a build step echoing a COMPLETE daemon error", async () => {
    const { cli, docker, attempts } = makeCli({
      failWith: new Error(
        "docker compose up failed (exit 1): " +
          `#8 0.4 Error response from daemon: network ${NETWORK} has active endpoints\n` +
          "ERROR: failed to solve: process exited 1",
      ),
    });

    await expect(cli.up(["web"], START)).rejects.toThrow(/failed to solve/);

    expect(disconnected(docker)).toEqual([]);
    expect(attempts()).toBe(1);
  });

  it("holds ONE topology bracket across the network-recovery retry", async () => {
    let open = 0;
    const observed: number[] = [];
    let attempts = 0;
    const cli = new ComposeCli({
      sessionId: NET_SID,
      workspaceDir: "/workspace",
      composeQuery: vi.fn(async () => ""),
      confined: confinedVia(vi.fn(async () => {
        observed.push(open);
        attempts++;
        if (attempts === 1) throw activeEndpointsError(NETWORK);
      })),
      onTopologyChange: () => { open++; return () => { open--; }; },
    });

    await cli.up(["web"], START);

    expect(observed).toEqual([1, 1]);
    expect(open).toBe(0);
  });
});

describe("extractActiveEndpointNetwork", () => {
  it("reads the network name past Compose's own `failed to remove network` prefix", () => {
    expect(
      extractActiveEndpointNetwork(
        "failed to remove network shipit-session-abc: Error response from daemon: " +
          "error while removing network: network shipit-session-abc id 8f1c has active endpoints",
      ),
    ).toBe("shipit-session-abc");
  });

  it("reads the newer daemon message, which carries no network id", () => {
    expect(
      extractActiveEndpointNetwork(
        'Error response from daemon: network shipit-session-abc has active endpoints (name:"db-1")',
      ),
    ).toBe("shipit-session-abc");
  });

  it("ignores the phrase without the daemon record around it — stderr carries build output", () => {
    expect(extractActiveEndpointNetwork("network shipit-session-abc has active endpoints"))
      .toBeUndefined();
  });

  it("ignores a COMPLETE daemon error quoted by a build step", () => {
    expect(
      extractActiveEndpointNetwork(
        "#8 0.4 Error response from daemon: network shipit-session-abc has active endpoints",
      ),
    ).toBeUndefined();
    expect(
      extractActiveEndpointNetwork(
        " => ERROR response from daemon: network shipit-session-abc has active endpoints",
      ),
    ).toBeUndefined();
  });

  it("still finds the daemon record on a later line of a multi-line failure", () => {
    expect(
      extractActiveEndpointNetwork(
        "#8 building\n => CACHED [base 1/2]\n" +
          "Error response from daemon: network shipit-session-abc has active endpoints",
      ),
    ).toBe("shipit-session-abc");
  });

  it("says nothing about an unrelated failure", () => {
    expect(extractActiveEndpointNetwork("ERROR: failed to solve: process did not complete"))
      .toBeUndefined();
  });
});

describe("ComposeCli — default runner (real spawn against a fake `docker`)", () => {
  let binDir: string;
  let prevPath: string | undefined;

  function fakeDocker(script: string): void {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
    const bin = path.join(binDir, "docker");
    fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    fs.chmodSync(bin, 0o755);
    prevPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  }

  afterEach(() => {
    if (prevPath !== undefined) process.env.PATH = prevPath;
    prevPath = undefined;
    if (binDir) fs.rmSync(binDir, { recursive: true, force: true });
  });

  const runStop = (sink?: ComposeOutputSink): Promise<void> =>
    defaultComposeRunner(["compose", "-p", "shipit-sess-1", "stop", "dev"], os.tmpdir(), sink);

  it("streams both stdout and stderr BEFORE the process exits", async () => {
    fakeDocker(`
echo "#4 [2/9] RUN apt-get update" >&2
echo "to stdout"
sleep 0.3
echo "#4 DONE 0.4s" >&2
`);
    const seen: { text: string; atMs: number }[] = [];
    const t0 = Date.now();
    const sink = (chunk: string) => { seen.push({ text: chunk, atMs: Date.now() - t0 }); };

    await runStop(sink);

    const joined = seen.map(s => s.text).join("");
    expect(joined).toContain("#4 [2/9] RUN apt-get update");
    expect(joined).toContain("to stdout");
    expect(joined).toContain("#4 DONE 0.4s");
    expect(seen[0]!.atMs).toBeLessThan(250);
  });

  it("caps a failing command's stderr in the rejection, keeping the tail", async () => {
    fakeDocker(`
i=0
while [ $i -lt 400 ]; do echo "#3 CACHED noise line padding padding padding padding" >&2; i=$((i+1)); done
echo "ERROR: failed to solve: process did not complete successfully" >&2
exit 17
`);

    await expect(runStop()).rejects.toThrow(/exit 17/);
    await expect(runStop()).rejects.toThrow(
      /failed to solve: process did not complete successfully/,
    );

    const err = await runStop().catch((e: unknown) => e);
    expect((err as Error).message.length).toBeLessThan(10_000);
  });

  it("hands the docker child a minimal environment, not the orchestrator's", async () => {
    fakeDocker(`env >&2`);
    process.env.SHIPIT_TEST_ORCHESTRATOR_SECRET = "s3cr3t";
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    try {
      const chunks: string[] = [];
      await runStop((chunk: string) => { chunks.push(chunk); });
      const childEnv = chunks.join("");
      expect(childEnv).not.toContain("SHIPIT_TEST_ORCHESTRATOR_SECRET");
      expect(childEnv).not.toContain("s3cr3t");
      expect(childEnv).toContain("DOCKER_HOST=unix:///var/run/docker.sock");
      expect(childEnv).toMatch(/^PATH=/m);
    } finally {
      delete process.env.SHIPIT_TEST_ORCHESTRATOR_SECRET;
      delete process.env.DOCKER_HOST;
    }
  });

  it("passes on a trailing line the command never terminated with a newline", async () => {
    fakeDocker(`printf '#5 building' >&2`);
    const chunks: string[] = [];

    await runStop((chunk: string) => { chunks.push(chunk); });

    expect(chunks.join("")).toBe("#5 building");
  });
});

describe("ComposeCli — model-free commands (docs/318)", () => {
  const PROJECT = "shipit-sess-1";
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function modelFreeCli(volumes = "") {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compose-model-free-"));
    const composeStateDir = path.join(tmp, "sessions", SID, "state", "compose");
    const runs: { args: string[]; cwd: string }[] = [];
    const queries: string[][] = [];
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: path.join(tmp, "sessions", SID, "workspace"),
      confined: confinedVia(vi.fn(async () => undefined)),
      composeStateDir,
      composeRunner: vi.fn(async (args: string[], cwd: string) => { runs.push({ args, cwd }); }),
      composeQuery: vi.fn(async (args: string[]) => {
        queries.push(args);
        return args[1] === "ls" ? volumes : "";
      }),
    });
    return { cli, runs, queries, composeStateDir };
  }

  it("names the project and no model file, in an empty ShipIt directory", () => {
    const { cli, composeStateDir } = modelFreeCli();
    expect(cli.modelFreeArgs("ps", "--format", "json", "-a"))
      .toEqual(["compose", "-p", PROJECT, "ps", "--format", "json", "-a"]);
    const dir = cli.modelFreeDir();
    expect(path.dirname(dir)).toBe(composeStateDir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a directory Compose would find a project file above", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compose-model-free-"));
    fs.writeFileSync(path.join(tmp, "compose.yaml"), "services: {}\n");
    expect(() => prepareModelFreeComposeDir(path.join(tmp, "state", "compose")))
      .toThrow(/would load .*compose\.yaml/);
  });

  it("stops a service from the model it was started from", async () => {
    const { cli, runs, composeStateDir } = modelFreeCli();
    const model = { snapshotFile: path.join(composeStateDir, "s1.yml"), overrideFile: path.join(composeStateDir, "o1.yml") };
    await cli.stopFrom("web", model);
    expect(runs).toEqual([{
      args: ["compose", "-f", model.snapshotFile, "-f", model.overrideFile, "-p", PROJECT, "stop", "web"],
      cwd: composeStateDir,
    }]);
  });

  it("stops without a model, in the empty directory, when the start's files are gone", async () => {
    const { cli, runs } = modelFreeCli();
    await cli.stopFrom("web", null);
    expect(runs).toEqual([{ args: ["compose", "-p", PROJECT, "stop", "web"], cwd: cli.modelFreeDir() }]);
  });

  it("keeps --volumes on the final down, then removes the project's labelled volumes by name", async () => {
    const { cli, runs, queries } = modelFreeCli("shipit-sess-1_data\nshipit-sess-1_shipit-persist\n");
    await cli.downModelFree({ removeVolumes: true });
    expect(runs).toEqual([{
      args: ["compose", "-p", PROJECT, "down", "--remove-orphans", "--volumes"],
      cwd: cli.modelFreeDir(),
    }]);
    expect(queries).toEqual([
      ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${PROJECT}`],
      ["volume", "rm", "shipit-sess-1_data"],
      ["volume", "rm", "shipit-sess-1_shipit-persist"],
    ]);
  });

  it("leaves volumes alone when the down keeps them", async () => {
    const { cli, runs, queries } = modelFreeCli("shipit-sess-1_data\n");
    await cli.downModelFree({ removeVolumes: false });
    expect(runs[0]!.args).toEqual(["compose", "-p", PROJECT, "down", "--remove-orphans"]);
    expect(queries).toEqual([]);
  });

  it("stops a plugin-only start from its override alone", async () => {
    const { cli, runs, composeStateDir } = modelFreeCli();
    const overrideFile = path.join(composeStateDir, "o1.yml");
    await cli.stopFrom("probe", { overrideFile });
    expect(runs[0]!.args).toEqual(["compose", "-f", overrideFile, "-p", PROJECT, "stop", "probe"]);
  });
});

describe("ComposeCli — confined build and up (docs/318)", () => {
  function cliWith(confined: Pick<ConfinedComposeApi, "build" | "up">, query: ComposeQuery = vi.fn(async () => "")) {
    return new ComposeCli({ sessionId: SID, workspaceDir: "/workspace", confined, composeQuery: query });
  }

  it("builds the listed services from the build model, and skips a start with nothing to build", async () => {
    const build = vi.fn(async () => undefined);
    const cli = cliWith({ build, up: vi.fn(async () => undefined) });
    await cli.build(undefined);
    await cli.build({ model: "services: {}\n", services: [] });
    expect(build).not.toHaveBeenCalled();
    await cli.build({ model: "services:\n  web: {build: .}\n", services: ["web"] });
    expect(build).toHaveBeenCalledWith({ buildModel: "services:\n  web: {build: .}\n", services: ["web"] });
  });

  it("runs `up` from the start's files, with its service-env directory", async () => {
    const up = vi.fn(async () => undefined);
    const cli = cliWith({ build: vi.fn(async () => undefined), up });
    await cli.up(["web"], { ...START, serviceEnvDir: "/state/service-env/sess-1" });
    expect(up).toHaveBeenCalledWith(expect.objectContaining({
      snapshotFile: START.model.snapshotFile,
      overrideFile: START.model.overrideFile,
      services: ["web"],
      serviceEnvDir: "/state/service-env/sess-1",
    }));
    await cli.up(["probe"], { model: { overrideFile: START.model.overrideFile } });
    expect(up).toHaveBeenLastCalledWith(expect.not.objectContaining({ snapshotFile: expect.anything() }));
  });
});

describe("ComposeCli — this project's containers (docs/318)", () => {
  const PROJECT_FILTER = "label=com.docker.compose.project=shipit-sess-1";

  function cliAnswering(answer: (args: string[]) => string) {
    const queries: string[][] = [];
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      confined: confinedVia(vi.fn(async () => undefined)),
      composeQuery: vi.fn(async (args: string[]) => {
        queries.push(args);
        return answer(args);
      }),
    });
    return { cli, queries };
  }

  it("tells whether a service has a container, by project and service label", async () => {
    const { cli, queries } = cliAnswering((args) => (args.includes("label=com.docker.compose.service=web") ? "abc\n" : ""));
    expect(await cli.hasContainer("web")).toBe(true);
    expect(await cli.hasContainer("db")).toBe(false);
    expect(queries[0]).toEqual([
      "ps", "-aq", "--filter", PROJECT_FILTER, "--filter", "label=com.docker.compose.service=web",
    ]);
  });

  it("lists running services, ignoring lines that are not service names", async () => {
    const { cli, queries } = cliAnswering(() => "web\nweb\n{\"Service\":\"x\"}\n\ndb\n");
    expect(await cli.runningServices()).toEqual(["web", "db"]);
    expect(queries[0]).toContain("status=running");
  });

  it("removes containers of services it is not told to keep, by name, and keeps one-off runs", async () => {
    const listing = [
      "shipit-sess-1-web-1\tweb\t",
      "shipit-sess-1-old-1\told\t",
      "shipit-sess-1-web-run-1\tweb-debug\tTrue",
      "shipit-sess-1-probe-1\tprobe\t",
    ].join("\n");
    const { cli, queries } = cliAnswering((args) => (args[0] === "ps" ? listing : ""));
    expect(await cli.removeOrphanContainers(new Set(["web", "probe"]))).toEqual(["shipit-sess-1-old-1"]);
    expect(queries[0]!.slice(0, 4)).toEqual(["ps", "-a", "--filter", PROJECT_FILTER]);
    expect(queries[1]).toEqual(["rm", "-f", "shipit-sess-1-old-1"]);
  });

  it("removes nothing when every container belongs to a kept service", async () => {
    const { cli, queries } = cliAnswering((args) => (args[0] === "ps" ? "shipit-sess-1-web-1\tweb\t\n" : ""));
    expect(await cli.removeOrphanContainers(new Set(["web"]))).toEqual([]);
    expect(queries).toHaveLength(1);
  });
});
