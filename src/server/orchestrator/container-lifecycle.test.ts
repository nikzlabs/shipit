/**
 * Unit tests for container-lifecycle functions (buildMounts, buildEnv, buildContainerConfig).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import {
  buildMounts,
  buildEnv,
  buildOrchestratorCallbackEnv,
  buildContainerConfig,
  destroyContainer,
  prepareOverlayDirs,
  selfHealWorkspaceOwnership,
  type LifecycleDeps,
  DEP_CACHE_CONTAINER_PATH,
  PNPM_STORE_CONTAINER_PATH,
  OPS_DOCKER_HOST,
} from "./container-lifecycle.js";
import type { ContainerConfig, SessionContainer } from "./session-container.js";
import type { DepDirOverlaySpec } from "./overlay-session.js";
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

  // docs/198 — shared pnpm store mounts at pnpm 11's relocation target.
  it("mounts pnpmStoreDir at pnpm 11's relocation target /workspace/.pnpm-store as a volume subpath", () => {
    const config = baseConfig({ pnpmStoreDir: "/workspace/pnpm-store/deadbeefcafe0001" });
    const result = buildMounts(config, "my-workspace-vol", undefined);
    const storeMount = result.mounts.find((m) => m.Target === PNPM_STORE_CONTAINER_PATH);
    expect(storeMount).toBeDefined();
    // The target IS pnpm's relocation dir — pnpm relocates straight into the shared store.
    expect(PNPM_STORE_CONTAINER_PATH).toBe("/workspace/.pnpm-store");
    expect(storeMount!.Source).toBe("my-workspace-vol");
    // Host subpath is still the runtime-keyed store dir on the state volume.
    expect(storeMount!.VolumeOptions?.Subpath).toBe("pnpm-store/deadbeefcafe0001");
  });

  it("mounts pnpmStoreDir as a bind when no workspaceVolume (dev mode)", () => {
    const config = baseConfig({ pnpmStoreDir: "/state/pnpm-store/deadbeefcafe0001" });
    const result = buildMounts(config, undefined, undefined);
    expect(result.binds).toContain("/state/pnpm-store/deadbeefcafe0001:/workspace/.pnpm-store:rw");
  });

  it("adds no pnpm store mount when pnpmStoreDir is undefined (flag-off / non-pnpm)", () => {
    const result = buildMounts(baseConfig(), "my-workspace-vol", undefined);
    expect(result.mounts.filter((m) => m.Target === PNPM_STORE_CONTAINER_PATH)).toHaveLength(0);
    expect(result.binds.filter((b) => b.includes("/pnpm-store"))).toHaveLength(0);
  });

  // docs/172 Gap 6 (SHI-45) — /uploads is mounted READ-ONLY. The agent only
  // consumes user uploads, it never writes them, so a `:ro` mount removes the
  // ability for a prompt-injected agent to delete or tamper with them.
  it("mounts uploadsDir at /uploads read-only as a bind mount (dev mode)", () => {
    const config = baseConfig({ uploadsDir: "/workspace/sessions/sess-1/uploads" });
    const result = buildMounts(config, undefined, undefined);
    expect(result.binds).toContain("/workspace/sessions/sess-1/uploads:/uploads:ro");
    // It must NOT be writable.
    expect(result.binds).not.toContain("/workspace/sessions/sess-1/uploads:/uploads:rw");
  });

  it("mounts uploadsDir at /uploads read-only as a volume subpath (prod mode)", () => {
    const config = baseConfig({ uploadsDir: "/workspace/sessions/sess-1/uploads" });
    const result = buildMounts(config, "my-workspace-vol", undefined);
    const uploadsMount = result.mounts.find((m) => m.Target === "/uploads");
    expect(uploadsMount).toBeDefined();
    expect(uploadsMount!.ReadOnly).toBe(true);
    expect(uploadsMount!.Source).toBe("my-workspace-vol");
    expect(uploadsMount!.VolumeOptions?.Subpath).toBe("sessions/sess-1/uploads");
  });

  it("adds no uploads mount when uploadsDir is undefined", () => {
    const result = buildMounts(baseConfig(), "my-workspace-vol", undefined);
    expect(result.mounts.filter((m) => m.Target === "/uploads")).toHaveLength(0);
    expect(result.binds.filter((b) => b.includes(":/uploads:"))).toHaveLength(0);
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

  // docs/198 — point older pnpm at the shared store (pnpm 11 relocates there on its own).
  it("sets npm_config_store_dir to the relocation target when pnpmStoreDir is set", () => {
    const config = baseConfig({ pnpmStoreDir: "/workspace/pnpm-store/deadbeefcafe0001" });
    const env = buildEnv(config, "/workspace", 9100, undefined, undefined);
    expect(env).toContain("npm_config_store_dir=/workspace/.pnpm-store");
  });

  it("does not set npm_config_store_dir when pnpmStoreDir is undefined (flag-off / non-pnpm)", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined);
    expect(env.filter((e) => e.startsWith("npm_config_store_dir="))).toHaveLength(0);
  });

  it("includes standard env vars alongside cache vars", () => {
    const config = baseConfig({ depCacheDir: "/workspace/dep-cache/abc123" });
    const env = buildEnv(config, "/workspace", 9100, undefined, undefined);
    expect(env).toContain("SESSION_ID=sess-1");
    expect(env).toContain("WORKSPACE_DIR=/workspace");
    expect(env).toContain("WORKER_PORT=9100");
    expect(env).toContain("HOME=/home/shipit");
  });

  // docs/150 — the worker runs as the unprivileged `shipit` user (home
  // /home/shipit). buildEnv sets HOME + AGENT_HOME (the single source of truth
  // agentHome() resolves from) and pins the shared Playwright browser path.
  it("docs/150: sets HOME, AGENT_HOME, and PLAYWRIGHT_BROWSERS_PATH for the non-root worker", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {} as NodeJS.ProcessEnv);
    expect(env).toContain("HOME=/home/shipit");
    expect(env).toContain("AGENT_HOME=/home/shipit");
    expect(env).toContain("PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers");
  });

  it("docs/150: resolves HOME/AGENT_HOME from the orchestrator's AGENT_HOME (local mode keeps /root)", () => {
    const prev = process.env.AGENT_HOME;
    process.env.AGENT_HOME = "/root";
    try {
      const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {} as NodeJS.ProcessEnv);
      expect(env).toContain("HOME=/root");
      expect(env).toContain("AGENT_HOME=/root");
    } finally {
      if (prev === undefined) delete process.env.AGENT_HOME;
      else process.env.AGENT_HOME = prev;
    }
  });

  // docs/150 Rollout — the orchestrator forwards SHIPIT_SESSION_WORKER_UID so the
  // image entrypoint chowns the mounts to the SAME uid the orchestrator-side
  // chown helpers use. Unset → not forwarded (entrypoint default + no-op chowns).
  it("docs/150: forwards SHIPIT_SESSION_WORKER_UID when set", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {
      SHIPIT_SESSION_WORKER_UID: "1000",
    } as NodeJS.ProcessEnv);
    expect(env).toContain("SHIPIT_SESSION_WORKER_UID=1000");
  });

  it("docs/150: does not forward SHIPIT_SESSION_WORKER_UID when unset", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {} as NodeJS.ProcessEnv);
    expect(env.some((e) => e.startsWith("SHIPIT_SESSION_WORKER_UID="))).toBe(false);
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

// ---------------------------------------------------------------------------
// prepareOverlayDirs — overlay dir creation + worker-uid handoff (SHI-145)
// ---------------------------------------------------------------------------

describe("prepareOverlayDirs (SHI-145)", () => {
  let tmpDir: string;
  const prevUid = process.env.SHIPIT_SESSION_WORKER_UID;

  function makeSpec(root: string, hash: string): DepDirOverlaySpec {
    const overlayDir = path.join(root, "sessions", "sess-1", "overlay", hash);
    return {
      volumeName: `shipit-sess-1_overlay-${hash}`,
      lowerdir: `/daemon/overlay-base/${hash}/g0`,
      upperdir: `/daemon/${path.relative("/", path.join(overlayDir, "upper"))}`,
      workdir: `/daemon/${path.relative("/", path.join(overlayDir, "work"))}`,
      depDir: "node_modules",
      mountPath: "/workspace/node_modules",
      scope: { repoUrl: "https://x/y.git", runtimeKey: "rk", depDir: "node_modules" },
      scopeHash: hash,
      generation: 0,
      orchDirs: {
        lowerdir: path.join(root, "overlay-base", hash, "g0"),
        upperdir: path.join(overlayDir, "upper"),
        workdir: path.join(overlayDir, "work"),
      },
    };
  }

  afterEach(() => {
    if (prevUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
    else process.env.SHIPIT_SESSION_WORKER_UID = prevUid;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mkdirs the orchestrator-visible lower/upper/work dirs for every spec", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID; // legacy root runtime
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-dirs-"));
    const spec = makeSpec(tmpDir, "aaaa1111");
    prepareOverlayDirs([spec]);
    expect(fs.existsSync(spec.orchDirs!.lowerdir)).toBe(true);
    expect(fs.existsSync(spec.orchDirs!.upperdir)).toBe(true);
    expect(fs.existsSync(spec.orchDirs!.workdir)).toBe(true);
  });

  it("hands the per-session upper/work dirs to the worker uid", () => {
    const myUid = process.getuid?.();
    if (myUid === undefined) return; // not POSIX — skip
    process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-dirs-"));
    const spec = makeSpec(tmpDir, "bbbb2222");
    prepareOverlayDirs([spec]);
    // The dirs the worker writes through are owned by the configured uid.
    expect(fs.lstatSync(spec.orchDirs!.upperdir).uid).toBe(myUid);
    expect(fs.lstatSync(spec.orchDirs!.workdir).uid).toBe(myUid);
  });

  it("is a no-op for undefined specs and specs without orchDirs", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-dirs-"));
    expect(() => prepareOverlayDirs(undefined)).not.toThrow();
    const spec = makeSpec(tmpDir, "cccc3333");
    delete spec.orchDirs; // mock/unit configs have no orchestrator state dir
    expect(() => prepareOverlayDirs([spec])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// selfHealWorkspaceOwnership — recreate-after-idle ownership self-heal
// ---------------------------------------------------------------------------

describe("selfHealWorkspaceOwnership", () => {
  const WS_VOLUME = "shipit-workspace";
  const WS_DIR = "/workspace/sessions/sess-1/workspace";

  it("hands the workspace back to the worker uid on a volume-backed session", () => {
    const handBack = vi.fn();
    selfHealWorkspaceOwnership({ workspaceDir: WS_DIR }, WS_VOLUME, handBack);
    expect(handBack).toHaveBeenCalledTimes(1);
    expect(handBack).toHaveBeenCalledWith(WS_DIR);
  });

  it("skips entirely in dev bind-mount mode (no workspaceVolume) — never chowns the host source", () => {
    const handBack = vi.fn();
    selfHealWorkspaceOwnership({ workspaceDir: WS_DIR }, undefined, handBack);
    expect(handBack).not.toHaveBeenCalled();
  });

  it("skips when the session has no workspaceDir", () => {
    const handBack = vi.fn();
    selfHealWorkspaceOwnership({ workspaceDir: undefined }, WS_VOLUME, handBack);
    expect(handBack).not.toHaveBeenCalled();
  });
});
