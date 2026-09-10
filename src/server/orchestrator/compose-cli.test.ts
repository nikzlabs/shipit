import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ComposeCli,
  composeUpPhaseOf,
  type ComposeOutputSink,
  type ComposeRunner,
  type ComposeQuery,
} from "./compose-cli.js";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

const SID = "sess-1";

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
    composeFile: "docker-compose.yml",
    overrideFile: "/state/compose.override.yml",
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
      composeFile: "docker-compose.yml",
      overrideFile: "/state/compose.override.yml",
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
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      composeFile: "docker-compose.yml",
      overrideFile: "/state/compose.override.yml",
      composeQuery: vi.fn(async () => ""),
      composeRunner: runner,
    });
    return { cli, calls };
  }

  it("streams a single-service `up`'s output to the sink as it arrives", async () => {
    const { cli } = makeSinkCli();
    const chunks: string[] = [];

    await cli.upService("dev", (chunk) => chunks.push(chunk));

    expect(chunks.join("")).toBe(
      "#1 [internal] load build definition\n#2 exporting layers done\n",
    );
  });

  it("streams a multi-service `up`'s output to the sink", async () => {
    const { cli } = makeSinkCli();
    const chunks: string[] = [];

    await cli.up(["web", "api"], (chunk) => chunks.push(chunk));

    expect(chunks.length).toBe(3);
  });

  it("passes no sink for stop/down — only `up` has a silent window to fill", async () => {
    const { cli, calls } = makeSinkCli();

    await cli.stop("dev");
    await cli.down({ removeVolumes: false });

    expect(calls.map(c => c.hasSink)).toEqual([false, false]);
  });

  it("still resolves when no sink is supplied", async () => {
    const { cli, calls } = makeSinkCli();

    await expect(cli.upService("dev")).resolves.toBeUndefined();
    expect(calls[0]!.hasSink).toBe(true);
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
      composeFile: "docker-compose.yml",
      overrideFile: "/state/compose.override.yml",
      composeQuery: vi.fn(async () => ""),
      composeRunner: runner,
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
      cli => cli.up(["web"]),
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
      composeFile: "docker-compose.yml",
      overrideFile: "/state/compose.override.yml",
      composeQuery: vi.fn(async () => ""),
      composeRunner: runner,
    });
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      if (typeof msg === "string" && msg.startsWith("[timing]")) seen.push(msg);
    });

    await cli.up(["web"]);
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
      composeFile: "docker-compose.yml",
      overrideFile: "/state/compose.override.yml",
      composeQuery: vi.fn(async () => ""),
      composeRunner: runner,
    });
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      if (typeof msg === "string" && msg.startsWith("[timing]")) seen.push(msg);
    });

    await cli.up(["web"]);
    spy.mockRestore();

    expect(seen[0]).toMatch(/create=\d+ms/);
  });

  it("omits build for a stack whose images are already present", async () => {
    const seen = await timingLines(
      [" Container shipit-abc-web-1  Created", " Container shipit-abc-web-1  Started"],
      cli => cli.up(["web"]),
    );

    expect(seen[0]).not.toContain("build=");
    expect(seen[0]).toMatch(/create=\d+ms/);
  });

  it("reports the total even when the up fails", async () => {
    const runner = vi.fn(async () => { throw new Error("boom"); });
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      composeFile: "docker-compose.yml",
      overrideFile: "/state/compose.override.yml",
      composeQuery: vi.fn(async () => ""),
      composeRunner: runner,
    });
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      if (typeof msg === "string" && msg.startsWith("[timing]")) seen.push(msg);
    });

    await expect(cli.up(["web"])).rejects.toThrow("boom");
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
  function makeCli(bracketed: boolean, runner?: ComposeRunner, query?: ComposeQuery) {
    let open = 0;
    const openWhileRunning: number[] = [];
    const defaultRunner: ComposeRunner = async () => { openWhileRunning.push(open); };
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      composeFile: "docker-compose.yml",
      overrideFile: "/state/compose.override.yml",
      composeQuery: query ?? vi.fn(async () => ""),
      composeRunner: runner ?? defaultRunner,
      ...(bracketed ? { onTopologyChange: () => { open++; return () => { open--; }; } } : {}),
    });
    return { cli, openWhileRunning, open: () => open, observe: () => openWhileRunning.push(open) };
  }

  it("holds a bracket open across `up` and `upService`", async () => {
    const { cli, openWhileRunning, open } = makeCli(true);

    await cli.up(["web"]);
    await cli.upService("db");

    expect(openWhileRunning).toEqual([1, 1]);
    expect(open()).toBe(0);
  });

  it("does not bracket `stop` or `down`", async () => {
    const { cli, openWhileRunning } = makeCli(true);

    await cli.stop("dev");
    await cli.down({ removeVolumes: false });

    expect(openWhileRunning).toEqual([0, 0]);
  });

  it("holds ONE bracket across the conflict-recovery retry", async () => {
    let attempt = 0;
    const observed: number[] = [];
    let open = 0;
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      composeFile: "docker-compose.yml",
      overrideFile: "/state/compose.override.yml",
      composeQuery: vi.fn(async () => ""),
      composeRunner: vi.fn(async () => {
        observed.push(open);
        attempt++;
        if (attempt === 1) {
          throw new Error('Conflict. The container name "/web" is already in use by container "abc123def456".');
        }
      }),
      onTopologyChange: () => { open++; return () => { open--; }; },
    });

    await cli.up(["web"]);

    expect(observed).toEqual([1, 1]);
    expect(open).toBe(0);
  });

  it("closes the bracket when the command fails for good", async () => {
    let open = 0;
    const cli = new ComposeCli({
      sessionId: SID,
      workspaceDir: "/workspace",
      composeFile: "docker-compose.yml",
      overrideFile: "/state/compose.override.yml",
      composeQuery: vi.fn(async () => { throw new Error("no recovery"); }),
      composeRunner: vi.fn(async () => { throw new Error("compose exploded"); }),
      onTopologyChange: () => { open++; return () => { open--; }; },
    });

    await expect(cli.up()).rejects.toThrow(/compose exploded/);
    expect(open).toBe(0);
  });

  it("runs unbracketed when no manager supplied one", async () => {
    const { cli, openWhileRunning } = makeCli(false);
    await expect(cli.up(["web"])).resolves.toBeUndefined();
    expect(openWhileRunning).toEqual([0]);
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

  function cliUnderTest(): ComposeCli {
    return new ComposeCli({
      sessionId: SID,
      workspaceDir: os.tmpdir(),
      composeFile: "docker-compose.yml",
      overrideFile: "/state/compose.override.yml",
      composeQuery: vi.fn(async () => ""),
    });
  }

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

    await cliUnderTest().upService("dev", sink);

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

    await expect(cliUnderTest().upService("dev")).rejects.toThrow(/exit 17/);
    await expect(cliUnderTest().upService("dev")).rejects.toThrow(
      /failed to solve: process did not complete successfully/,
    );

    const err = await cliUnderTest().upService("dev").catch((e: unknown) => e);
    expect((err as Error).message.length).toBeLessThan(10_000);
  });

  it("hands the docker child a minimal environment, not the orchestrator's", async () => {
    fakeDocker(`env >&2`);
    process.env.SHIPIT_TEST_ORCHESTRATOR_SECRET = "s3cr3t";
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    try {
      const chunks: string[] = [];
      await cliUnderTest().upService("dev", (chunk: string) => { chunks.push(chunk); });
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

  it("flushes a trailing line the command never terminated with a newline", async () => {
    fakeDocker(`printf '#5 building' >&2`);
    const chunks: string[] = [];
    const sink: ComposeOutputSink = (chunk: string) => { chunks.push(chunk); };
    let flushed = 0;
    sink.flush = () => { flushed += 1; };

    await cliUnderTest().upService("dev", sink);

    expect(chunks.join("")).toBe("#5 building");
    expect(flushed).toBe(1);
  });
});
