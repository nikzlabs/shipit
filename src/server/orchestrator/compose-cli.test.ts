/**
 * Tests for ComposeCli's pre-start stale-container sweep (`killStaleContainers`).
 *
 * The sweep removes leftovers from a previous compose stack for the session, but
 * must SPARE the long-lived Tier B/C egress sidecars (docs/172) — they carry
 * `shipit-parent-session` only so destroy-time cleanup reaps them, and killing
 * them ~1s after the agent launches would leave the session with no resolver and
 * no HTTPS.
 *
 * planning#224: that keep-list has to be INCARNATION-aware. Both egress labels are
 * keyed on the session id, which is stable across container recreations — so a
 * label-only match also spares the sidecars of a PREVIOUS, dead agent container.
 * Those share a torn-down network namespace and are pure garbage. The test is
 * netns-parent liveness.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ComposeCli, type ComposeOutputSink } from "./compose-cli.js";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

const SID = "sess-1";

interface World {
  /** All containers carrying `shipit-parent-session=<SID>`. */
  children: string[];
  /** Containers carrying an egress tier label for this session. */
  sidecars: { id: string; label: string; parent: string }[];
  /**
   * Container id → its Docker list state.
   *
   * `"running"` and `"paused"` are BOTH listed by a bare `docker ps` (a paused
   * container shows as `Up (Paused)`), because both still own a live network
   * namespace. `"exited"` and absent-from-the-map ("gone from the daemon") are
   * both invisible to `ps` — and both mean the same thing here: the netns is
   * dead. That collapse is exactly why the probe is `ps` and not `inspect`.
   */
  state: Record<string, "running" | "paused" | "exited">;
}

/** What a bare `docker ps -q --filter id=<x>` would print for `x`. */
function psListsIt(world: World, id: string): boolean {
  const s = world.state[id];
  return s === "running" || s === "paused";
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
      // `-a` / `-aq` includes STOPPED containers. The liveness probe must NOT pass
      // it — an exited parent corpse lingers until the next create removes it by
      // name, so `ps -a` would list it and the probe would call a dead namespace
      // alive, sparing the very garbage it exists to collect. The fake models this
      // so that regression is caught: swap the probe to `-aq` (a natural
      // copy-paste from the sweep query below, which legitimately uses it) and the
      // exited-parent test goes red.
      const all = args.some(a => a === "-a" || a === "-aq");

      // Parent-liveness probe: bare `ps -q --no-trunc --filter id=<p>` (NO status
      // filter, NO -a). Exits 0 whether or not it matches — printing the id when
      // the parent's namespace is alive (running OR paused) and nothing when it
      // isn't. That's the point: "not up" is a VALUE, not an exception, so it
      // can't be confused with a daemon error.
      const idFilter = filters.find(f => f.startsWith("id="));
      if (idFilter) {
        const parent = idFilter.slice("id=".length);
        // Honour a `status=` filter if one is passed. The production code passes
        // NONE — but the fake must model what Docker would do if it did, or the
        // paused-parent test would pass for the wrong reason (it would go green
        // even against a `--filter status=running` implementation, which is the
        // very bug it exists to catch).
        const statusFilter = filters.find(f => f.startsWith("status="))?.slice("status=".length);
        if (statusFilter) return world.state[parent] === statusFilter ? parent : "";
        if (all) return world.state[parent] ? parent : ""; // -a also lists the exited corpse
        return psListsIt(world, parent) ? parent : "";
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
    // The agent container OOM'd and was removed by name on the next create; its
    // sidecars were left behind. The label-only keep-list used to spare these.
    const { cli, removed } = makeCli({
      children: ["res-old", "proxy-old", "stale-web"],
      sidecars: [
        { id: "res-old", label: EGRESS_RESOLVER_LABEL, parent: "agent-old" },
        { id: "proxy-old", label: EGRESS_PROXY_LABEL, parent: "agent-old" },
      ],
      state: {}, // agent-old is gone from the daemon
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
      state: { "agent-old": "exited" },
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
      state: { "agent-old": "exited", "agent-new": "running" },
    });

    await cli.killStaleContainers();

    expect([...removed].sort()).toEqual(["proxy-old", "res-old"]);
  });

  it("SPARES sidecars whose parent is PAUSED — a paused container still owns a live netns", async () => {
    // `docker pause` leaves `State.Running=true, State.Paused=true`, and the
    // container still holds its network namespace — but its *list status* is
    // `paused`, not `running`. A `--filter status=running` probe would therefore
    // report the parent as dead and reap a perfectly good resolver and proxy,
    // leaving the session with no DNS and no HTTPS on unpause. A bare `docker ps`
    // lists paused containers, which is exactly the question we mean to ask:
    // "is this namespace alive?", not "is this process scheduled?"
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
      state: { "agent-1": "running" }, // the parent IS alive — the daemon just won't say so
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

/**
 * A `docker compose up --build` can run for minutes with nothing else to show
 * for itself. Until the sink existed, that output went into a local string the
 * runner discarded on success — so the whole build window was silent.
 */
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
    expect(calls[0]!.hasSink).toBe(false);
  });
});

/**
 * The DEFAULT runner, exercised for real.
 *
 * The tests above inject a runner, so they prove the plumbing and nothing about
 * the code that actually runs in production: whether output streams before the
 * process exits, whether stdout is drained, whether a huge failure message is
 * capped. `ComposeCli` shells out to `docker` by name, so a fake `docker` on
 * PATH is enough to drive the real thing.
 */
describe("ComposeCli — default runner (real spawn against a fake `docker`)", () => {
  let binDir: string;
  let prevPath: string | undefined;

  /** Install a fake `docker` on PATH whose body is `script`. */
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
      // No composeRunner — this is the point of the suite.
    });
  }

  it("streams both stdout and stderr BEFORE the process exits", async () => {
    // The `sleep` is what makes this a streaming assertion rather than a
    // buffered one: the sink must have both lines while `docker` is still alive.
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
    // The first chunk landed well before the process exited ~300ms in.
    expect(seen[0]!.atMs).toBeLessThan(250);
  });

  it("caps a failing command's stderr in the rejection, keeping the tail", async () => {
    // 40k of noise, then the line that actually says what went wrong.
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
