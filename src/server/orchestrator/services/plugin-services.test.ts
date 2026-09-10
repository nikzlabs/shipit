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
  releaseSessionGenerationHolds(SESSION_ID);
});

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
    expect(services[0]).toMatchObject({ name: "probe", port: 4820 });
    expect(getPluginServiceFailures(SESSION_ID, "mine")).toEqual([]);
  });

  it("does NOT move a plugin around the project's ports — that pair is refused, not allocated", async () => {
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

  describe("the production layout", () => {
    const resolveInVolume = (): ReturnType<typeof resolveSessionPluginServices> =>
      resolveSessionPluginServices(SESSION_ID, workspaceDir, {
        containEgress: false,
        workspaceVolume: "shipit-workspace-vol",
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

    expect(generationHoldCount(generation())).toBe(1);
  });

  it("lets go when the session stops surfacing plugin services", async () => {
    publishTrackedGeneration();
    writeConfig(TRACKED_DECLARATION);
    await resolve();

    writeConfig("compose: docker-compose.yml\n");
    await resolve();

    expect(generationHoldCount(generation())).toBe(0);
  });

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
      expect(generationHoldCount(generation())).toBe(0);
    } finally {
      done();
    }
  });
});

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
