/**
 * Unit tests for container-lifecycle functions (buildMounts, buildEnv, buildContainerConfig).
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type Docker from "dockerode";
import {
  buildMounts,
  buildEnv,
  buildOrchestratorCallbackEnv,
  buildContainerConfig,
  destroyContainer,
  type LifecycleDeps,
  DEP_CACHE_CONTAINER_PATH,
  OPS_DOCKER_HOST,
} from "./container-lifecycle.js";
import type { ContainerConfig, SessionContainer } from "./session-container.js";
import type { HostMount } from "../shared/shipit-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseConfig(overrides?: Partial<ContainerConfig>): ContainerConfig {
  return {
    sessionId: "sess-1",
    sessionDir: "/workspace/sessions/sess-1",
    credentialsDir: "/credentials",
    imageName: "shipit-worker:test",
    memoryLimit: 512 * 1024 * 1024,
    cpuQuota: 50_000,
    pidsLimit: 256,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildMounts
// ---------------------------------------------------------------------------

describe("buildMounts", () => {
  it("returns basic session + per-session credentials bind mounts without optional dirs", () => {
    const result = buildMounts(baseConfig(), undefined, undefined);
    expect(result.binds).toContain("/workspace/sessions/sess-1:/workspace:rw");
    // docs/138 — the container gets its PRIVATE credentials subtree, never the
    // shared root, so a Claude session can't read Codex's creds and vice versa.
    expect(result.binds).toContain("/credentials/sessions/sess-1:/credentials:rw");
    expect(result.binds).not.toContain("/credentials:/credentials:rw");
    expect(result.mounts).toHaveLength(0);
  });

  it("docs/138: mounts the per-session credentials subpath when credentialsVolume is set", () => {
    const result = buildMounts(baseConfig(), undefined, "shipit-credentials");
    const credMount = result.mounts.find((m) => m.Target === "/credentials");
    expect(credMount).toBeDefined();
    expect(credMount!.Source).toBe("shipit-credentials");
    expect(credMount!.VolumeOptions?.Subpath).toBe("sessions/sess-1");
    // No whole-root bind/mount leaked in.
    expect(result.binds).not.toContain("/credentials:/credentials:rw");
  });

  it("mounts depCacheDir at /dep-cache as bind mount when no volume", () => {
    const config = baseConfig({ depCacheDir: "/workspace/dep-cache/abc123" });
    const result = buildMounts(config, undefined, undefined);
    expect(result.binds).toContain(
      "/workspace/dep-cache/abc123:/dep-cache:rw",
    );
  });

  it("does not add dep cache mount when depCacheDir is undefined", () => {
    const result = buildMounts(baseConfig(), undefined, undefined);
    const depCacheBinds = result.binds.filter((b) => b.includes("/dep-cache"));
    const depCacheMounts = result.mounts.filter((m) => m.Target === DEP_CACHE_CONTAINER_PATH);
    expect(depCacheBinds).toHaveLength(0);
    expect(depCacheMounts).toHaveLength(0);
  });

  it("mounts depCacheDir as volume subpath when workspaceVolume is set", () => {
    const config = baseConfig({ depCacheDir: "/workspace/dep-cache/abc123" });
    const result = buildMounts(config, "my-workspace-vol", undefined);
    const depMount = result.mounts.find((m) => m.Target === DEP_CACHE_CONTAINER_PATH);
    expect(depMount).toBeDefined();
    expect(depMount!.Source).toBe("my-workspace-vol");
    expect(depMount!.VolumeOptions?.Subpath).toBe("dep-cache/abc123");
  });
});

// ---------------------------------------------------------------------------
// docs/183 dep-dir design — overlay sessions mount N dep-dir volumes NESTED
// under /workspace; /workspace itself stays the normal host-clone mount.
// ---------------------------------------------------------------------------

describe("buildMounts — overlay session (docs/183)", () => {
  const depSpecs = [
    {
      volumeName: "shipit-sess-1abc234_overlay-aaaaaaaa",
      lowerdir: "/data/overlay-base/h1",
      upperdir: "/data/sessions/sess-1/overlay/h1/upper",
      workdir: "/data/sessions/sess-1/overlay/h1/work",
      depDir: "node_modules",
      mountPath: "/workspace/node_modules",
      scope: { repoUrl: "r", runtimeKey: "rt", depDir: "node_modules" },
      scopeHash: "h1",
      generation: 0,
    },
    {
      volumeName: "shipit-sess-1abc234_overlay-bbbbbbbb",
      lowerdir: "/data/overlay-base/h2",
      upperdir: "/data/sessions/sess-1/overlay/h2/upper",
      workdir: "/data/sessions/sess-1/overlay/h2/work",
      depDir: "packages/app/node_modules",
      mountPath: "/workspace/packages/app/node_modules",
      scope: { repoUrl: "r", runtimeKey: "rt", depDir: "packages/app/node_modules" },
      scopeHash: "h2",
      generation: 0,
    },
  ];

  it("keeps /workspace on the state workspaceVolume and nests each dep dir's overlay volume under it", () => {
    const config = baseConfig({ uploadsDir: "/workspace/sessions/sess-1/uploads" });
    const result = buildMounts(config, "shipit-workspace", "shipit-credentials", depSpecs);

    // /workspace stays the normal host-clone subpath mount — NOT an overlay volume.
    const wsMounts = result.mounts.filter((m) => m.Target === "/workspace");
    expect(wsMounts).toHaveLength(1);
    expect(wsMounts[0].Source).toBe("shipit-workspace");
    expect(wsMounts[0].VolumeOptions?.Subpath).toBe("sessions/sess-1");

    // Each dep dir is mounted at its nested /workspace/<dep-dir> target.
    for (const spec of depSpecs) {
      const nested = result.mounts.find((m) => m.Target === spec.mountPath);
      expect(nested).toBeDefined();
      expect(nested!.Type).toBe("volume");
      expect(nested!.Source).toBe(spec.volumeName);
      expect(nested!.VolumeOptions?.Subpath).toBeUndefined(); // overlay volume mounted at its own root
    }
  });

  it("keeps /uploads and /dep-cache on the state workspaceVolume, never an overlay volume", () => {
    const config = baseConfig({
      uploadsDir: "/workspace/sessions/sess-1/uploads",
      depCacheDir: "/workspace/dep-cache/abc123",
    });
    const result = buildMounts(config, "shipit-workspace", undefined, depSpecs);
    const overlayNames = depSpecs.map((s) => s.volumeName);

    const uploads = result.mounts.find((m) => m.Target === "/uploads");
    expect(uploads!.Source).toBe("shipit-workspace");
    expect(overlayNames).not.toContain(uploads!.Source);
    expect(uploads!.VolumeOptions?.Subpath).toBe("sessions/sess-1/uploads");

    const depCache = result.mounts.find((m) => m.Target === DEP_CACHE_CONTAINER_PATH);
    expect(depCache!.Source).toBe("shipit-workspace");
    expect(overlayNames).not.toContain(depCache!.Source);
    expect(depCache!.VolumeOptions?.Subpath).toBe("dep-cache/abc123");
  });

  it("non-overlay sessions are unchanged (overlay arg omitted → no nested mounts)", () => {
    const config = baseConfig();
    const result = buildMounts(config, "shipit-workspace", undefined);
    const wsMount = result.mounts.find((m) => m.Target === "/workspace");
    expect(wsMount!.Source).toBe("shipit-workspace");
    expect(wsMount!.VolumeOptions?.Subpath).toBe("sessions/sess-1");
    // No nested /workspace/* mounts.
    expect(result.mounts.some((m) => m.Target.startsWith("/workspace/"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// docs/128 — ops session host-mount security gate
//
// The whole point of these tests: privileged read-only host binds are applied
// ONLY when the caller passes `opsSession: true`, which is derived from the
// server-authoritative `session.kind === "ops"`. A non-ops session that forged
// `x-shipit-host-mounts` in its workspace shipit.yaml must NOT get host binds —
// otherwise the agent (which can write its own workspace) could mount arbitrary
// host paths and exfiltrate the host. We use real existing/nonexistent paths so
// the `fs.existsSync` allow-check runs for real, no fs mocking.
// ---------------------------------------------------------------------------

describe("buildMounts — ops session host mounts (docs/128)", () => {
  const presentMount: HostMount = { source: "/tmp", target: "/var/log/journal", readOnly: true };
  const absentMount: HostMount = {
    source: "/nonexistent-shipit-ops-test-path-xyz",
    target: "/run/log/journal",
    readOnly: true,
  };

  it("adds daemon-validated read-only bind mounts when opsSession is true", () => {
    const config = baseConfig({ opsSession: true, hostMounts: [presentMount] });
    const result = buildMounts(config, undefined, undefined);
    expect(result.mounts).toContainEqual({
      Type: "bind",
      Source: "/tmp",
      Target: "/var/log/journal",
      ReadOnly: true,
      BindOptions: { CreateMountpoint: false },
    });
  });

  it("SECURITY: drops host mounts when opsSession is false even if hostMounts is forged", () => {
    // Simulates a non-ops session whose user-controlled shipit.yaml declared
    // host mounts. The server gate keys off kind, not the workspace file, so
    // `opsSession` is falsy here and nothing is bound.
    const config = baseConfig({ opsSession: false, hostMounts: [presentMount] });
    const result = buildMounts(config, undefined, undefined);
    expect(result.mounts.some((m) => m.Type === "bind")).toBe(false);
  });

  it("SECURITY: drops host mounts when opsSession is undefined", () => {
    const config = baseConfig({ hostMounts: [presentMount] });
    const result = buildMounts(config, undefined, undefined);
    expect(result.mounts.some((m) => m.Type === "bind")).toBe(false);
  });

  it("passes all declared ops host mounts to the Docker daemon without container-local fs preflight", () => {
    const config = baseConfig({ opsSession: true, hostMounts: [presentMount, absentMount] });
    const result = buildMounts(config, undefined, undefined);
    expect(result.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Type: "bind",
          Source: "/tmp",
          Target: "/var/log/journal",
          ReadOnly: true,
          BindOptions: { CreateMountpoint: false },
        }),
        expect.objectContaining({
          Type: "bind",
          Source: "/nonexistent-shipit-ops-test-path-xyz",
          Target: "/run/log/journal",
          ReadOnly: true,
          BindOptions: { CreateMountpoint: false },
        }),
      ]),
    );
  });

  it("produces no host binds for an ops session with no declared mounts", () => {
    const config = baseConfig({ opsSession: true });
    const result = buildMounts(config, undefined, undefined);
    expect(result.mounts.some((m) => m.Type === "bind")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildEnv
// ---------------------------------------------------------------------------

describe("buildEnv", () => {
  it("includes package manager cache env vars when depCacheDir is set", () => {
    const config = baseConfig({ depCacheDir: "/workspace/dep-cache/abc123" });
    const env = buildEnv(config, "/workspace", 9100, undefined, undefined);
    expect(env).toContain("npm_config_cache=/dep-cache/npm");
    expect(env).toContain("YARN_CACHE_FOLDER=/dep-cache/yarn");
    expect(env).toContain("PNPM_STORE_DIR=/dep-cache/pnpm");
  });

  it("does not include cache env vars when depCacheDir is undefined", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined);
    const cacheVars = env.filter((e) =>
      e.startsWith("npm_config_cache=") ||
      e.startsWith("YARN_CACHE_FOLDER=") ||
      e.startsWith("PNPM_STORE_DIR="),
    );
    expect(cacheVars).toHaveLength(0);
  });

  it("includes standard env vars alongside cache vars", () => {
    const config = baseConfig({ depCacheDir: "/workspace/dep-cache/abc123" });
    const env = buildEnv(config, "/workspace", 9100, undefined, undefined);
    expect(env).toContain("SESSION_ID=sess-1");
    expect(env).toContain("WORKSPACE_DIR=/workspace");
    expect(env).toContain("WORKER_PORT=9100");
    expect(env).toContain("HOME=/root");
  });

  // docs/183 — the orchestrator resolves the worker image id at startup into
  // SESSION_WORKER_IMAGE_ID; buildEnv forwards it so the worker's
  // install-runtime runtimeKey() shares the same ABI fingerprint and a
  // worker-image rebuild rotates the overlay base scope + the install marker.
  it("docs/183: forwards SESSION_WORKER_IMAGE_ID into the container env", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {
      SESSION_WORKER_IMAGE_ID: "sha256:abc123",
    } as NodeJS.ProcessEnv);
    expect(env).toContain("SESSION_WORKER_IMAGE_ID=sha256:abc123");
  });

  it("docs/183: falls back to IMAGE_DIGEST when SESSION_WORKER_IMAGE_ID is unset", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {
      IMAGE_DIGEST: "sha256:def456",
    } as NodeJS.ProcessEnv);
    expect(env).toContain("SESSION_WORKER_IMAGE_ID=sha256:def456");
  });

  it("docs/183: forwards nothing when neither image var is set (dev/local, flag off)", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {} as NodeJS.ProcessEnv);
    expect(env.some((e) => e.startsWith("SESSION_WORKER_IMAGE_ID="))).toBe(false);
  });

  it("docs/128: points an ops session at the read-only docker-socket-proxy", () => {
    const config = baseConfig({ opsSession: true });
    const env = buildEnv(config, "/workspace", 9100, undefined, undefined);
    expect(env).toContain(`DOCKER_HOST=${OPS_DOCKER_HOST}`);
    // Ops sessions do NOT get the read-write session compose project name.
    expect(env.some((e) => e.startsWith("COMPOSE_PROJECT_NAME="))).toBe(false);
  });

  it("docs/128 SECURITY: a non-ops session never gets DOCKER_HOST from the ops branch", () => {
    const config = baseConfig({ opsSession: false });
    const env = buildEnv(config, "/workspace", 9100, undefined, undefined);
    expect(env.some((e) => e.startsWith("DOCKER_HOST="))).toBe(false);
  });

  // docs/128 regression (live audit FAIL #1/#11) — an ops session can arrive
  // with BOTH flags set, because its shipit.yaml declares
  // `compose.docker-socket: true` (so the proxy *sibling* may mount the socket)
  // and `resolveAgentDockerLimits` derives agent `dockerAccess` from that same
  // flag. The ops gate MUST win: the agent reaches Docker only through the
  // read-only proxy, never the write-capable session proxy. (`buildContainerConfig`
  // also forces `dockerAccess: false` for ops; this asserts buildEnv is correct
  // even if a caller passes both.)
  it("docs/128: the ops branch takes precedence over dockerAccess (read-only proxy wins)", () => {
    const config = baseConfig({ dockerAccess: true, opsSession: true });
    const env = buildEnv(config, "/workspace", 9100, "docker-proxy", 2375);
    expect(env).toContain(`DOCKER_HOST=${OPS_DOCKER_HOST}`);
    // The read-write session proxy host + compose project name must NOT leak in.
    expect(env).not.toContain("DOCKER_HOST=tcp://docker-proxy:2375");
    expect(env.some((e) => e.startsWith("COMPOSE_PROJECT_NAME="))).toBe(false);
  });

  it("passes through a stable orchestrator host override for worker callbacks", async () => {
    const oldHost = process.env.SHIPIT_ORCHESTRATOR_HOST;
    const oldFallbacks = process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS;
    const oldPort = process.env.PORT;
    process.env.SHIPIT_ORCHESTRATOR_HOST = "shipit";
    process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS = "shipit";
    process.env.PORT = "4123";
    try {
      const env = await buildOrchestratorCallbackEnv("sess-1");
      expect(env).toContain("SHIPIT_SESSION_ID=sess-1");
      expect(env).toContain("SHIPIT_PORT=4123");
      expect(env).toContain("SHIPIT_HOST=shipit");
      expect(env).toContain("SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS=shipit");
    } finally {
      if (oldHost === undefined) delete process.env.SHIPIT_ORCHESTRATOR_HOST;
      else process.env.SHIPIT_ORCHESTRATOR_HOST = oldHost;
      if (oldFallbacks === undefined) delete process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS;
      else process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS = oldFallbacks;
      if (oldPort === undefined) delete process.env.PORT;
      else process.env.PORT = oldPort;
    }
  });
});

// ---------------------------------------------------------------------------
// buildContainerConfig
// ---------------------------------------------------------------------------

describe("buildContainerConfig", () => {
  const deps = {
    imageName: "shipit-worker:test",
    defaultMemoryLimit: 512 * 1024 * 1024,
    defaultCpuQuota: 50_000,
    defaultPidsLimit: 256,
  };

  it("passes through depCacheDir", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      credentialsDir: "/credentials",
      depCacheDir: "/workspace/dep-cache/hash",
    });
    expect(config.depCacheDir).toBe("/workspace/dep-cache/hash");
  });

  it("leaves depCacheDir undefined when not provided", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      credentialsDir: "/credentials",
    });
    expect(config.depCacheDir).toBeUndefined();
  });

  // docs/128 regression (live audit FAIL #1/#11) — the ops template's
  // shipit.yaml sets `compose.docker-socket: true`, which
  // `resolveAgentDockerLimits` turns into `dockerAccess: true`. That must not
  // elevate the *agent*: an ops session's container config must have
  // `dockerAccess: false` so the read-write session proxy + its network are
  // never created and buildEnv routes DOCKER_HOST to the read-only proxy.
  it("forces dockerAccess off for an ops session even when the caller passes dockerAccess: true", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      credentialsDir: "/credentials",
      dockerAccess: true,
      opsSession: true,
    });
    expect(config.dockerAccess).toBe(false);
    expect(config.opsSession).toBe(true);
  });

  it("preserves dockerAccess for an ordinary (non-ops) docker-socket session", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      credentialsDir: "/credentials",
      dockerAccess: true,
    });
    expect(config.dockerAccess).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// destroyContainer — overlay-volume teardown (docs/183 Phase 6)
// ---------------------------------------------------------------------------

describe("destroyContainer — overlay volume teardown", () => {
  /** Minimal fake Docker that records every `volume rm` by name. */
  function fakeDocker(removedVolumes: string[]): Docker {
    const noop = async (): Promise<void> => {};
    return {
      getContainer: () => ({ stop: noop, remove: noop }),
      listContainers: async () => [],
      listNetworks: async () => [],
      getNetwork: () => ({ remove: noop }),
      listVolumes: async () => ({ Volumes: [] }),
      getVolume: (name: string) => ({ remove: async () => { removedVolumes.push(name); } }),
    } as unknown as Docker;
  }

  function makeDeps(removedVolumes: string[], sc: SessionContainer): { deps: LifecycleDeps; emitter: EventEmitter } {
    const emitter = new EventEmitter();
    const deps = {
      docker: fakeDocker(removedVolumes),
      containers: new Map([[sc.sessionId, sc]]),
      standbySessionIds: new Set<string>(),
      emitter,
    } as unknown as LifecycleDeps;
    return { deps, emitter };
  }

  function makeContainer(overlayVolumeNames?: string[]): SessionContainer {
    return {
      id: "cid-1",
      sessionId: "sess-x",
      containerIp: "",
      workerUrl: "",
      status: "running",
      hostWorkspaceDir: "/workspace/sessions/sess-x/workspace",
      dockerAccess: false,
      ...(overlayVolumeNames ? { overlayVolumeNames } : {}),
    } as unknown as SessionContainer;
  }

  it("removes ALL N per-dep-dir overlay volumes on teardown", async () => {
    const names = [
      "shipit-abcdef012345_overlay-aaaa1111",
      "shipit-abcdef012345_overlay-bbbb2222",
      "shipit-abcdef012345_overlay-cccc3333",
    ];
    const removed: string[] = [];
    const { deps, emitter } = makeDeps(removed, makeContainer(names));
    let destroyed: string | undefined;
    emitter.on("container_destroyed", (id: string) => { destroyed = id; });

    await destroyContainer(deps, "sess-x");

    expect([...removed].sort()).toEqual([...names].sort());
    expect(deps.containers.has("sess-x")).toBe(false);
    expect(destroyed).toBe("sess-x");
  });

  it("removes no overlay volumes for a non-overlay session", async () => {
    const removed: string[] = [];
    const { deps } = makeDeps(removed, makeContainer(undefined));

    await destroyContainer(deps, "sess-x");

    expect(removed).toEqual([]);
    expect(deps.containers.has("sess-x")).toBe(false);
  });
});
