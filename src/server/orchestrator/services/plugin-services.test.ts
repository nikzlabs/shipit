/**
 * docs/262 — the session-level resolver: a `shipit.yaml` on disk in, the compose
 * services that session surfaces out.
 *
 * Exercised through a `repo: self` declaration, which is the one shape that
 * needs no fetch and no Docker (req 27): the "checkout" is the workspace itself,
 * so the whole path runs against the integration fakes the way plan §5 asks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Docker from "dockerode";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProjectServices, resolveSessionPluginServices } from "./plugin-services.js";
import { resolveShipitConfig } from "../../shared/shipit-config.js";
import { getPluginServiceFailures } from "./plugin-activation.js";
import {
  claimGenerationDeletion,
  generationHoldCount,
  releaseSessionGenerationHolds,
} from "../plugin-leases.js";
import { SESSION_STATE_SUBDIR, SESSION_WORKSPACE_SUBDIR } from "../session-state-dir.js";

let sessionDir: string;
let workspaceDir: string;

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-services-"));
  workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  fs.mkdirSync(path.join(workspaceDir, "tools"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, SESSION_STATE_SUBDIR), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "tools", "docker-compose.yml"), `
services:
  probe:
    image: node:22-alpine
    volumes:
      - .:/app:ro
`);
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
  // Every test shares one session id, and a surfaced tracked repository leaves
  // a generation hold behind on purpose (req 15) — it is released when the
  // session is disposed, which is what this stands in for.
  releaseSessionGenerationHolds(SESSION_ID);
});

/**
 * The tracked fixture: a live generation on disk under `stateDir`, declared by
 * `owner/name` rather than `self`, so the paths that only a fetched repository
 * reaches — the runtime overlay layer and the consumer lease over it — are
 * exercised. Returns the commit it published.
 */
function publishTrackedGeneration(commit = "abc123"): string {
  const stateDir = path.join(sessionDir, SESSION_STATE_SUBDIR);
  const generation = path.join(stateDir, "plugins", "tools", "generations", commit);
  fs.mkdirSync(path.join(generation, "tools"), { recursive: true });
  fs.writeFileSync(path.join(generation, "shipit.yaml"), `
exports:
  plugins:
    probe:
      compose: tools/docker-compose.yml
`);
  fs.writeFileSync(path.join(generation, "tools", "docker-compose.yml"), `
services:
  probe:
    image: node:22-alpine
`);
  fs.writeFileSync(
    path.join(generation, ".shipit-generation.json"),
    // `source` is what proves this generation belongs to the declaration that
    // names it; a record without it reads as unverified everywhere since
    // #2225, so the fixture has to carry it to reach the runtime-layer step.
    JSON.stringify({ repoName: "tools", source: "someone/tools", commit, exports: ["probe"] }),
  );
  fs.symlinkSync(
    path.join("generations", commit),
    path.join(stateDir, "plugins", "tools", "active"),
  );
  return commit;
}

const TRACKED_DECLARATION = `
plugins:
  repos:
    - repo: someone/tools
      name: tools
  use:
    - plugin: probe
      from: tools
`;

function writeConfig(body: string): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), body);
}

const SELF_DECLARATION = `
exports:
  plugins:
    probe:
      compose: tools/docker-compose.yml
plugins:
  repos:
    - repo: self
      name: mine
  use:
    - plugin: probe
      from: mine
      overrides:
        services:
          probe:
            port: 4820
`;

const resolve = (): Promise<Awaited<ReturnType<typeof resolveSessionPluginServices>>> =>
  resolveSessionPluginServices(SESSION_ID, workspaceDir, { containEgress: false });

describe("resolveSessionPluginServices", () => {
  it("surfaces a self-declared plugin's services on the port the project named", async () => {
    writeConfig(SELF_DECLARATION);
    const services = await resolve();
    expect(services).toHaveLength(1);
    // One number (docs/266-plugin-service-ports req 10) — the consumer's, straight from `plugins.use`.
    expect(services[0]).toMatchObject({ name: "probe", port: 4820 });
    expect(getPluginServiceFailures(SESSION_ID, "mine")).toEqual([]);
  });

  it("does NOT move a plugin around the project's ports — that pair is refused, not allocated", async () => {
    // docs/266-plugin-service-ports req 7. This resolver reads the project's compose file
    // separately from the stack that actually runs, and those two readings
    // disagreeing is what #2325 was. So it no longer decides anything about
    // ports at all: the plugin keeps the number the consumer wrote, and
    // `ServiceManager` — which has the authoritative parse — refuses the pair.
    writeConfig(`compose: docker-compose.yml\n${SELF_DECLARATION}`);
    fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), `
services:
  web:
    image: node:20
    ports:
      - "4820:4820"
`);
    const services = await resolve();
    expect(services[0].port).toBe(4820);
  });

  /**
   * req 20 — the project's own service names are read HERE, from the compose
   * file as it is right now, and they always win. That is what makes re-running
   * this resolver the answer when the project's file changes: the collision
   * judgement itself lives in `collectPluginFragments` and needs no second
   * implementation, it just needs to be asked again with the current file.
   *
   * The REASON is not remembered here — the snapshot route recomputes it from
   * the same pure collector (`api-routes-plugin-repos.ts`), which is why a
   * re-resolution that changes the surfaced set tells viewers to refetch.
   */
  it("withholds a plugin service whose name the project's own compose file has taken", async () => {
    writeConfig(`compose: docker-compose.yml\n${SELF_DECLARATION}`);
    fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), `
services:
  probe:
    image: node:20
`);
    expect(await resolve()).toEqual([]);
  });

  it("returns nothing, and records nothing, for a project that declares no plugins", async () => {
    writeConfig("compose: docker-compose.yml\n");
    expect(await resolve()).toEqual([]);
    expect(getPluginServiceFailures(SESSION_ID, "mine")).toEqual([]);
  });

  it("drops a tracked plugin with no runtime layer and remembers why", async () => {
    // A tracked repository with a live generation on disk, and no Docker to
    // build its overlay volume from — which is the state a `repo: self` session
    // can reach only by declaring one, so it is built here directly.
    publishTrackedGeneration();
    writeConfig(TRACKED_DECLARATION);

    expect(await resolve()).toEqual([]);
    expect(getPluginServiceFailures(SESSION_ID, "tools")[0]).toContain("writable layer is not available");
  });

  it("clears a recorded failure once the declaration no longer has the problem", async () => {
    writeConfig(SELF_DECLARATION);
    await resolve();
    expect(getPluginServiceFailures(SESSION_ID, "tools")).toEqual([]);
  });

  /**
   * The wiring, which is where the production-only defect re-enters: the mount
   * builders translate correctly, and translate NOTHING if this layer stops
   * handing them the volume and the root it is anchored at. A bind of an
   * orchestrator path is invisible in dev and dogfood — the paths are real
   * there — so it has to be asserted on the SPEC, never on a filesystem effect.
   */
  describe("the production layout", () => {
    const resolveInVolume = (): ReturnType<typeof resolveSessionPluginServices> =>
      resolveSessionPluginServices(SESSION_ID, workspaceDir, {
        containEgress: false,
        workspaceVolume: "shipit-workspace-vol",
        // The orchestrator-visible root that maps onto that volume; the temp
        // session tree stands in for a session under it.
        stateRoot: path.dirname(sessionDir),
      });

    it("mounts every session path through the workspace volume, never as a bind", async () => {
      writeConfig(SELF_DECLARATION);
      const services = await resolveInVolume();
      expect(services).toHaveLength(1);

      const rel = path.basename(sessionDir);
      const volumes = services[0].definition.volumes as Record<string, unknown>[];
      for (const volume of volumes) {
        expect(volume.type).toBe("volume");
        expect(volume.volume).toMatchObject({ subpath: expect.any(String) });
      }
      expect(volumes).toContainEqual({
        type: "volume",
        source: "shipit-workspace",
        target: "/project",
        volume: { subpath: `${rel}/${SESSION_WORKSPACE_SUBDIR}` },
      });
      expect(volumes).toContainEqual({
        type: "volume",
        source: "shipit-workspace",
        target: "/plugin-state",
        volume: { subpath: `${rel}/plugin-data/probe/state` },
      });
      // The override generator declares this alias `external: true` with the
      // real volume's name, so a plugin service mounting it must ask for it.
      expect(services[0].externalVolumes).toContain("shipit-workspace");
    });

    it("drops the services with a reason when the session is outside the volume root", async () => {
      writeConfig(SELF_DECLARATION);
      const services = await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
        containEgress: false,
        workspaceVolume: "shipit-workspace-vol",
        stateRoot: "/some/other/root",
      });
      expect(services).toEqual([]);
      expect(getPluginServiceFailures(SESSION_ID, "mine")[0]).toContain("could not locate this session");
    });
  });
});

/**
 * docs/262 req 15 — the service half of the consumer lease
 * (`../plugin-leases.ts`).
 *
 * A plugin service container outlives the call that created it, so its lease has
 * two parts: the container's own attachment to the generation volume, which only
 * the daemon can report, and the in-process hold taken here for the window
 * before that container exists. Only the second is testable without Docker, and
 * it is the one a prune racing a compose-up would otherwise win.
 */
describe("resolveSessionPluginServices — the consumer lease", () => {
  const generation = (generationId = "abc123") => ({
    sessionId: SESSION_ID,
    repoName: "tools",
    generationId,
  });

  it("holds the live generation of every tracked repository it resolved", async () => {
    publishTrackedGeneration();
    writeConfig(TRACKED_DECLARATION);

    await resolve();

    expect(generationHoldCount(generation())).toBe(1);
  });

  it("holds it exactly once across repeated rounds", async () => {
    publishTrackedGeneration();
    writeConfig(TRACKED_DECLARATION);

    await resolve();
    await resolve();

    // Rounds fire on session activation, on a `shipit.yaml` edit and whenever an
    // activation settles, so an accumulating hold would pin the generation for
    // the life of the session.
    expect(generationHoldCount(generation())).toBe(1);
  });

  it("lets go when the session stops surfacing plugin services", async () => {
    publishTrackedGeneration();
    writeConfig(TRACKED_DECLARATION);
    await resolve();

    // The declaration drops its plugins. Nothing calls a release here — the set
    // is replaced wholesale, which is what makes "the releasing side never runs"
    // impossible rather than merely unlikely.
    writeConfig("compose: docker-compose.yml\n");
    await resolve();

    expect(generationHoldCount(generation())).toBe(0);
  });

  /**
   * The review finding this closes: the hold used to be taken inside
   * `ensurePluginVolumes`, AFTER the Docker round-trip that resolves the
   * workspace volume's daemon-host mountpoint. A refresh could publish, claim,
   * fully delete generation A and release its claim during that await, and the
   * round would then hold a generation that no longer existed, re-create its
   * work directories and build an overlay whose lowerdir was gone.
   *
   * Asserted as an ORDERING against the first daemon call, because that is the
   * property — "no await between resolving a generation and holding it" — rather
   * than against an interleaving a test would have to manufacture.
   */
  it("holds it before the first daemon round-trip, not after", async () => {
    publishTrackedGeneration();
    writeConfig(TRACKED_DECLARATION);

    let heldAtFirstDaemonCall = -1;
    const docker = {
      getVolume: () => ({
        inspect: async () => {
          heldAtFirstDaemonCall = generationHoldCount(generation());
          return { Mountpoint: "/var/lib/docker/volumes/shipit-workspace-vol/_data" };
        },
      }),
    } as unknown as Docker;

    await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
      containEgress: false,
      docker,
      workspaceVolume: "shipit-workspace-vol",
      stateRoot: path.dirname(sessionDir),
    });

    expect(heldAtFirstDaemonCall).toBe(1);
  });

  /**
   * The "never throws, never fails a session" contract, at the one place on this
   * function's own path that talks to the daemon.
   *
   * It matters beyond tidiness: every caller resolves INSIDE the session's stack
   * queue and compares the answer against what the stack has consumed. A throw
   * leaves them holding the PREVIOUS answer, and after a project compose edit
   * that answer is a set nothing has checked against the file about to run
   * (req 20). Degrading here turns that into the visible per-repository
   * degradation req 13 asks for instead.
   */
  it("degrades with a reason when the daemon will not answer, rather than throwing", async () => {
    publishTrackedGeneration();
    writeConfig(TRACKED_DECLARATION);

    const docker = {
      getVolume: () => ({
        inspect: async () => { throw new Error("Cannot connect to the Docker daemon"); },
      }),
    } as unknown as Docker;

    const services = await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
      containEgress: false,
      docker,
      workspaceVolume: "shipit-workspace-vol",
      stateRoot: path.dirname(sessionDir),
    });

    expect(services).toEqual([]);
    expect(getPluginServiceFailures(SESSION_ID, "tools")[0]).toContain("writable layer is not available");
  });

  // planning#451 — the catch used to return `{}`, which is also the legitimate
  // "no workspace volume" answer. Under the opts-match skip that is a mismatch
  // against a live overlay translated onto daemon-host paths, so a transient
  // inspect failure would delete or recreate a volume a CLI container still
  // holds. Skip ensure entirely: the empty map is the same degradation the
  // test above already asked for.
  it("does not touch a live overlay when the workspace-volume inspect fails", async () => {
    publishTrackedGeneration();
    writeConfig(TRACKED_DECLARATION);
    const creates: string[] = [];
    const removes: string[] = [];
    const docker = {
      getVolume: (name: string) => ({
        inspect: async () => {
          if (name === "shipit-workspace-vol") {
            throw new Error("Cannot connect to the Docker daemon");
          }
          return {
            Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
            Options: { type: "overlay", o: "lowerdir=/already-correct" },
          };
        },
        remove: async () => { removes.push(name); },
      }),
      createVolume: async (spec: { Name: string }) => { creates.push(spec.Name); },
    } as unknown as Docker;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const services = await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
        containEgress: false,
        docker,
        workspaceVolume: "shipit-workspace-vol",
        stateRoot: path.dirname(sessionDir),
      });
      expect(services).toEqual([]);
      expect(getPluginServiceFailures(SESSION_ID, "tools")[0]).toContain("writable layer is not available");
      expect(creates).toEqual([]);
      expect(removes).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves out a repository whose generation is being pruned right now", async () => {
    publishTrackedGeneration();
    writeConfig(TRACKED_DECLARATION);
    const done = claimGenerationDeletion(generation())!;
    try {
      expect(await resolve()).toEqual([]);
      // Not held, so the prune that claimed it is not blocked by this round —
      // the round the newer generation settles is the one that brings the
      // services back.
      expect(generationHoldCount(generation())).toBe(0);
    } finally {
      done();
    }
  });
});

/**
 * planning#377 — the project's own name domain, and WHY it is unknowable when
 * it is.
 *
 * The flag alone collapsed two different events into one, and the caller that
 * must fail closed on it (`plugin-preflight.ts`) could then only say "could not
 * read this file". For a contained session that was wrong in the way that costs
 * the most: docs/263 refuses a STOCK compose file for a missing `user:`, so the
 * first thing a user saw was a card blaming a file that is perfectly valid.
 */
describe("readProjectServices carries why the name domain is unknown", () => {
  const read = (containEgress: boolean): ReturnType<typeof readProjectServices> =>
    readProjectServices(workspaceDir, resolveShipitConfig(workspaceDir), containEgress);

  function declareStack(body: string): void {
    writeConfig("compose: docker-compose.yml\n");
    fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), body);
  }

  it("reports a file it cannot parse as malformed, with where the parse gave up", () => {
    declareStack("services: [oh: : no\n");
    const project = read(false);

    expect(project.unknown).toBe(true);
    expect(project.failure?.kind).toBe("malformed");
    expect(project.failure?.message).toContain("not valid YAML");
  });

  it("reports a file the containment rules refuse as refused, naming the fix", () => {
    // Valid YAML the containment rules decline on a rule: a declared ROOT user.
    // It was an absent `user:` until docs/271 stopped refusing that one.
    declareStack(`
services:
  web:
    image: node:22-alpine
    user: "0"
`);
    const project = read(true);

    expect(project.unknown).toBe(true);
    expect(project.failure?.kind).toBe("refused");
    expect(project.failure?.message).toContain("`user:`");
    // The SAME file on an Open session is not refused at all, which is the
    // whole reason "could not read it" misled: the file never changed.
    const open = read(false);
    expect(open).toMatchObject({ names: ["web"], unknown: false });
    expect(open.failure).toBeUndefined();
  });

  it("says nothing when the project's stack reads cleanly", () => {
    declareStack(`
services:
  web:
    image: node:22-alpine
    ports:
      - "3000:3000"
`);
    const project = read(false);

    expect(project).toMatchObject({ names: ["web"], unknown: false });
    expect(project.failure).toBeUndefined();
  });
});
