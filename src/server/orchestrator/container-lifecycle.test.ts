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
  createContainer,
  destroyContainer,
  ContainerCreateCancelledError,
  prepareOverlayDirs,
  ensurePnpmStoreDir,
  selfHealWorkspaceOwnership,
  type LifecycleDeps,
  DEP_CACHE_CONTAINER_PATH,
  PNPM_STORE_CONTAINER_PATH,
  OPS_DOCKER_HOST,
} from "./container-lifecycle.js";
import type { ContainerConfig, SessionContainer } from "./session-container.js";
import type { DepDirOverlaySpec } from "./overlay-session.js";
import {
  INSTALL_MARKER_FILE,
  sessionSharedStateDir,
  sessionStateDirForWorkspace,
} from "./session-state-dir.js";
import { OVERLAY_VERIFY_FAILURE } from "./overlay-volume.js";
import type { HostMount } from "../shared/shipit-config.js";
import { TEST_CREDENTIALS_DIR } from "./credentials-test-helpers.js";

function baseConfig(overrides?: Partial<ContainerConfig>): ContainerConfig {
  return {
    sessionId: "sess-1",
    sessionDir: "/workspace/sessions/sess-1",
    workspaceDir: "/workspace/sessions/sess-1/workspace",
    sessionStateDir: "/workspace/sessions/sess-1/state",
    credentialsDir: TEST_CREDENTIALS_DIR,
    imageName: "shipit-worker:test",
    memoryLimit: 512 * 1024 * 1024,
    cpuQuota: 50_000,
    pidsLimit: 256,
    ...overrides,
  };
}

describe("buildMounts", () => {
  it("returns basic session + per-session credentials bind mounts without optional dirs", () => {
    const result = buildMounts(baseConfig(), undefined, undefined);
    expect(result.binds).toContain("/workspace/sessions/sess-1/workspace:/workspace:rw");
    expect(result.binds).toContain(`${TEST_CREDENTIALS_DIR}/sessions/sess-1:/credentials:rw`);
    expect(result.binds).not.toContain(`${TEST_CREDENTIALS_DIR}:/credentials:rw`);
    expect(result.binds).toContain(
      "/workspace/sessions/sess-1/state/shared:/session-state:rw",
    );
    expect(result.mounts).toHaveLength(0);
  });

  it("docs/262: mounts the plugin root read-only, with no writable view", () => {
    const result = buildMounts(baseConfig(), undefined, undefined);
    expect(result.binds).toContain("/workspace/sessions/sess-1/state/plugins:/plugin-store:ro");
    expect(result.binds.some((b) => b.includes("/state/plugins:") && b.endsWith(":rw"))).toBe(false);
    expect(result.binds.some((b) => b.includes("/generations/"))).toBe(false);
    expect(result.binds.some((b) => b.includes("/active:"))).toBe(false);
  });

  it("docs/262: stays read-only under a volume-backed session too", () => {
    const result = buildMounts(baseConfig(), "shipit-state", undefined);
    const ro = result.mounts.find((m) => m.Target === "/plugin-store");
    expect(ro?.ReadOnly).toBe(true);
    expect(ro?.VolumeOptions?.Subpath).toBe("sessions/sess-1/state/plugins");
    expect(result.mounts.every((m) => m.Target !== "/plugin-store-rw")).toBe(true);
  });

  it("docs/138: mounts the per-session credentials subpath when credentialsVolume is set", () => {
    const result = buildMounts(baseConfig(), undefined, "shipit-credentials");
    const credMount = result.mounts.find((m) => m.Target === "/credentials");
    expect(credMount).toBeDefined();
    expect(credMount!.Source).toBe("shipit-credentials");
    expect(credMount!.VolumeOptions?.Subpath).toBe("sessions/sess-1");
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

  it("mounts pnpmStoreDir at pnpm 11's relocation target /workspace/.pnpm-store as a volume subpath", () => {
    const config = baseConfig({ pnpmStoreDir: "/workspace/pnpm-store/deadbeefcafe0001" });
    const result = buildMounts(config, "my-workspace-vol", undefined);
    const storeMount = result.mounts.find((m) => m.Target === PNPM_STORE_CONTAINER_PATH);
    expect(storeMount).toBeDefined();
    expect(PNPM_STORE_CONTAINER_PATH).toBe("/workspace/.pnpm-store");
    expect(storeMount!.Source).toBe("my-workspace-vol");
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

  it("mounts uploadsDir at /uploads read-only as a bind mount (dev mode)", () => {
    const config = baseConfig({ uploadsDir: "/workspace/sessions/sess-1/uploads" });
    const result = buildMounts(config, undefined, undefined);
    expect(result.binds).toContain("/workspace/sessions/sess-1/uploads:/uploads:ro");
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

  it("mounts scratchDir at /persist read-write as a bind mount (dev mode)", () => {
    const config = baseConfig({ scratchDir: "/workspace/sessions/sess-1/scratch" });
    const result = buildMounts(config, undefined, undefined);
    expect(result.binds).toContain("/workspace/sessions/sess-1/scratch:/persist:rw");
    expect(result.binds).not.toContain("/workspace/sessions/sess-1/scratch:/persist:ro");
  });

  it("mounts scratchDir at /persist read-write as a volume subpath (prod mode)", () => {
    const config = baseConfig({ scratchDir: "/workspace/sessions/sess-1/scratch" });
    const result = buildMounts(config, "my-workspace-vol", undefined);
    const scratchMount = result.mounts.find((m) => m.Target === "/persist");
    expect(scratchMount).toBeDefined();
    expect(scratchMount!.ReadOnly).toBe(false);
    expect(scratchMount!.Source).toBe("my-workspace-vol");
    expect(scratchMount!.VolumeOptions?.Subpath).toBe("sessions/sess-1/scratch");
  });

  it("adds no persist mount when scratchDir is undefined", () => {
    const result = buildMounts(baseConfig(), "my-workspace-vol", undefined);
    expect(result.mounts.filter((m) => m.Target === "/persist")).toHaveLength(0);
    expect(result.binds.filter((b) => b.includes(":/persist:"))).toHaveLength(0);
  });
});

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

    const wsMounts = result.mounts.filter((m) => m.Target === "/workspace");
    expect(wsMounts).toHaveLength(1);
    expect(wsMounts[0].Source).toBe("shipit-workspace");
    expect(wsMounts[0].VolumeOptions?.Subpath).toBe("sessions/sess-1/workspace");

    for (const spec of depSpecs) {
      const nested = result.mounts.find((m) => m.Target === spec.mountPath);
      expect(nested).toBeDefined();
      expect(nested!.Type).toBe("volume");
      expect(nested!.Source).toBe(spec.volumeName);
      expect(nested!.VolumeOptions?.Subpath).toBeUndefined();
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
    expect(wsMount!.VolumeOptions?.Subpath).toBe("sessions/sess-1/workspace");
    expect(result.mounts.some((m) => m.Target.startsWith("/workspace/"))).toBe(false);
  });
});

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

describe("buildEnv", () => {
  it("always points SHIPIT_SESSION_STATE_DIR at the container mount, never into the clone", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined);
    expect(env).toContain("SHIPIT_SESSION_STATE_DIR=/session-state");
    expect(env.some((e) => e.startsWith("SHIPIT_SESSION_STATE_DIR=") && e.includes(".shipit")))
      .toBe(false);
  });

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

  it("docs/150: sets HOME, AGENT_HOME, and PLAYWRIGHT_BROWSERS_PATH for the non-root worker", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {} as NodeJS.ProcessEnv);
    expect(env).toContain("HOME=/home/shipit");
    expect(env).toContain("AGENT_HOME=/home/shipit");
    expect(env).toContain("PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers");
  });

  it("docs/213: sets ANDROID_SDK_ROOT, ANDROID_HOME, and JAVA_HOME for the baked Android toolchain", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {} as NodeJS.ProcessEnv);
    expect(env).toContain("ANDROID_SDK_ROOT=/opt/android-sdk");
    expect(env).toContain("ANDROID_HOME=/opt/android-sdk");
    expect(env).toContain("JAVA_HOME=/opt/java");
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

  it("docs/150: forwards SHIPIT_SESSION_WORKER_UID when set", () => {
    // The gate reads procEnv, but identityForTarget reads process.env; set both.
    const prev = process.env.SHIPIT_SESSION_WORKER_UID;
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    try {
      const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {
        SHIPIT_SESSION_WORKER_UID: "1000",
      } as NodeJS.ProcessEnv);
      expect(env).toContain("SHIPIT_SESSION_WORKER_UID=1000");
      expect(env).toContain("SHIPIT_SESSION_WORKER_GID=1000");
    } finally {
      if (prev === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
      else process.env.SHIPIT_SESSION_WORKER_UID = prev;
    }
  });

  it("docs/150: does not forward SHIPIT_SESSION_WORKER_UID when unset", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {} as NodeJS.ProcessEnv);
    expect(env.some((e) => e.startsWith("SHIPIT_SESSION_WORKER_UID="))).toBe(false);
  });

  describe("planning#415: forwards the dep-dir prune list", () => {
    let tmpDir: string | undefined;
    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    function workspaceWith(agentBlock: string): string {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildenv-depdirs-"));
      fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), `agent:\n${agentBlock}`);
      return tmpDir;
    }

    function envFor(workspaceDir: string, procEnv: NodeJS.ProcessEnv): string[] {
      return buildEnv(baseConfig({ workspaceDir }), "/workspace", 9100, undefined, undefined, procEnv);
    }

    it("forwards the workspace's declared dep dirs, colon-separated", () => {
      const ws = workspaceWith("  dep-dirs:\n    - node_modules\n    - vendor\n");
      const env = envFor(ws, { SHIPIT_SESSION_WORKER_UID: "1000" } as NodeJS.ProcessEnv);
      expect(env).toContain("SHIPIT_DEP_DIRS=node_modules:vendor");
    });

    it("falls back to the default list when the workspace has no shipit.yaml", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildenv-depdirs-"));
      const env = envFor(tmpDir, { SHIPIT_SESSION_WORKER_UID: "1000" } as NodeJS.ProcessEnv);
      expect(env).toContain("SHIPIT_DEP_DIRS=node_modules");
    });

    it("forwards nothing for an explicitly empty dep-dir list", () => {
      const ws = workspaceWith("  dep-dirs: []\n");
      const env = envFor(ws, { SHIPIT_SESSION_WORKER_UID: "1000" } as NodeJS.ProcessEnv);
      expect(env.some((e) => e.startsWith("SHIPIT_DEP_DIRS="))).toBe(false);
    });

    it("forwards no dep dirs when the worker uid is unset", () => {
      const ws = workspaceWith("  dep-dirs:\n    - node_modules\n");
      const env = envFor(ws, {} as NodeJS.ProcessEnv);
      expect(env.some((e) => e.startsWith("SHIPIT_DEP_DIRS="))).toBe(false);
    });
  });

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

  it("planning#196: forwards BASE_IMAGE_DIGEST into the container env", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {
      BASE_IMAGE_DIGEST: "sha256:base",
    } as NodeJS.ProcessEnv);
    expect(env).toContain("BASE_IMAGE_DIGEST=sha256:base");
  });

  it("planning#196: forwards no BASE_IMAGE_DIGEST when it is unset (dev/local, flag off)", () => {
    const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {} as NodeJS.ProcessEnv);
    expect(env.some((e) => e.startsWith("BASE_IMAGE_DIGEST="))).toBe(false);
  });

  it("docs/128: points an ops session at the read-only docker-socket-proxy", () => {
    const config = baseConfig({ opsSession: true });
    const env = buildEnv(config, "/workspace", 9100, undefined, undefined);
    expect(env).toContain(`DOCKER_HOST=${OPS_DOCKER_HOST}`);
    expect(env.some((e) => e.startsWith("COMPOSE_PROJECT_NAME="))).toBe(false);
  });

  it("docs/128 SECURITY: a non-ops session never gets DOCKER_HOST from the ops branch", () => {
    const config = baseConfig({ opsSession: false });
    const env = buildEnv(config, "/workspace", 9100, undefined, undefined);
    expect(env.some((e) => e.startsWith("DOCKER_HOST="))).toBe(false);
  });

  it("docs/128: the ops branch takes precedence over dockerAccess (read-only proxy wins)", () => {
    const config = baseConfig({ dockerAccess: true, opsSession: true });
    const env = buildEnv(config, "/workspace", 9100, "docker-proxy", 2375);
    expect(env).toContain(`DOCKER_HOST=${OPS_DOCKER_HOST}`);
    expect(env).not.toContain("DOCKER_HOST=tcp://docker-proxy:2375");
    expect(env.some((e) => e.startsWith("COMPOSE_PROJECT_NAME="))).toBe(false);
  });

  it("docs/211: a sandbox (dockerAccess on, opsSession off) uses the session proxy, not OPS_DOCKER_HOST", () => {
    const config = baseConfig({ dockerAccess: true, opsSession: false });
    const env = buildEnv(config, "/workspace", 9100, "docker-proxy", 2375);
    expect(env).toContain("DOCKER_HOST=tcp://docker-proxy:2375");
    expect(env).not.toContain(`DOCKER_HOST=${OPS_DOCKER_HOST}`);
    expect(env.some((e) => e.startsWith("COMPOSE_PROJECT_NAME="))).toBe(true);
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
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: TEST_CREDENTIALS_DIR,
      depCacheDir: "/workspace/dep-cache/hash",
    });
    expect(config.depCacheDir).toBe("/workspace/dep-cache/hash");
  });

  it("leaves depCacheDir undefined when not provided", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: TEST_CREDENTIALS_DIR,
    });
    expect(config.depCacheDir).toBeUndefined();
  });

  it("derives scratchDir as a sessionDir sibling by default", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: TEST_CREDENTIALS_DIR,
    });
    expect(config.scratchDir).toBe("/workspace/sessions/s1/scratch");
    expect(config.scratchDir).not.toContain("/workspace/sessions/s1/workspace/");
  });

  it("passes through an explicit scratchDir", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: TEST_CREDENTIALS_DIR,
      scratchDir: "/custom/scratch",
    });
    expect(config.scratchDir).toBe("/custom/scratch");
  });

  it("forces dockerAccess off for an ops session even when the caller passes dockerAccess: true", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: TEST_CREDENTIALS_DIR,
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
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: TEST_CREDENTIALS_DIR,
      dockerAccess: true,
    });
    expect(config.dockerAccess).toBe(true);
  });

  it("derives sessionStateDir as a `state/` sibling of the clone", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: TEST_CREDENTIALS_DIR,
    });
    expect(config.sessionStateDir).toBe("/workspace/sessions/s1/state");
  });

  it("always derives the state dir from the clone, ignoring any sibling override", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      workspaceDir: "/workspace/sessions/s1/workspace",
      scratchDir: "/custom/scratch",
      credentialsDir: TEST_CREDENTIALS_DIR,
    });
    expect(config.scratchDir).toBe("/custom/scratch");
    expect(config.sessionStateDir).toBe("/workspace/sessions/s1/state");
  });

  it("refuses a flat-layout session rather than sharing or in-clone placement", () => {
    expect(() =>
      buildContainerConfig(deps, {
        sessionId: "s1",
        sessionDir: "/workspace/sessions/s1",
        workspaceDir: "/workspace/sessions/s1",
        credentialsDir: TEST_CREDENTIALS_DIR,
      }),
    ).toThrow(/<sessionDir>\/workspace/);
  });
});

describe("destroyContainer — overlay volume teardown", () => {
  function fakeDocker(
    removedVolumes: string[],
    opts: {
      children?: { Id: string; State?: string }[];
      removedContainers?: string[];
      listFilters?: unknown[];
      removeErrors?: Record<string, Error>;
      requestedContainerIds?: string[];
    } = {},
  ): Docker {
    const noop = async (): Promise<void> => {};
    return {
      getContainer: (id: string) => {
        opts.requestedContainerIds?.push(id);
        return {
          stop: noop,
          remove: async () => {
            const err = opts.removeErrors?.[id];
            if (err) throw err;
            opts.removedContainers?.push(id);
          },
        };
      },
      listContainers: async (o: { filters?: unknown }) => {
        opts.listFilters?.push(o?.filters);
        return opts.children ?? [];
      },
      listNetworks: async () => [],
      getNetwork: () => ({ remove: noop }),
      listVolumes: async () => ({ Volumes: [] }),
      getVolume: (name: string) => ({ remove: async () => { removedVolumes.push(name); } }),
    } as unknown as Docker;
  }

  function makeDeps(
    removedVolumes: string[],
    sc: SessionContainer,
    dockerOpts: Parameters<typeof fakeDocker>[1] = {},
  ): { deps: LifecycleDeps; emitter: EventEmitter } {
    const emitter = new EventEmitter();
    const deps = {
      docker: fakeDocker(removedVolumes, dockerOpts),
      containers: new Map([[sc.sessionId, sc]]),
      standbySessionIds: new Set<string>(),
      destroyEpochs: new Map<string, number>(),
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

  it("sweeps the session's child containers — egress sidecars included — before removing the agent", async () => {
    const removedContainers: string[] = [];
    const listFilters: unknown[] = [];
    const { deps } = makeDeps([], makeContainer(undefined), {
      children: [
        { Id: "egress-resolver-1", State: "running" },
        { Id: "egress-proxy-1", State: "running" },
      ],
      removedContainers,
      listFilters,
    });

    await destroyContainer(deps, "sess-x");

    expect(listFilters[0]).toEqual({ label: ["shipit-parent-session=sess-x"] });
    expect(removedContainers).toContain("egress-resolver-1");
    expect(removedContainers).toContain("egress-proxy-1");
    expect(removedContainers.at(-1)).toBe("cid-1");
  });

  it("preserves Compose child resources during an agent-only container restart", async () => {
    const removedContainers: string[] = [];
    const listFilters: unknown[] = [];
    const { deps } = makeDeps([], makeContainer(undefined), {
      children: [{ Id: "compose-preview-1", State: "running" }],
      removedContainers,
      listFilters,
    });

    await destroyContainer(deps, "sess-x", { preserveChildResources: true });

    expect(listFilters).toEqual([]);
    expect(removedContainers).toEqual(["cid-1"]);
    expect(deps.containers.has("sess-x")).toBe(false);
  });

  it("does NOT warn when a child was already removed by the crash-site reaper (404)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { deps } = makeDeps([], makeContainer(undefined), {
        children: [{ Id: "egress-resolver-1", State: "running" }],
        removedContainers: [],
        removeErrors: {
          "egress-resolver-1": Object.assign(new Error("no such container"), { statusCode: 404 }),
        },
      });

      await destroyContainer(deps, "sess-x");

      const childWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("child container"));
      expect(childWarnings).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("still warns when a child removal fails for a real reason (500)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { deps } = makeDeps([], makeContainer(undefined), {
        children: [{ Id: "egress-resolver-1", State: "running" }],
        removedContainers: [],
        removeErrors: {
          "egress-resolver-1": Object.assign(new Error("daemon on fire"), { statusCode: 500 }),
        },
      });

      await destroyContainer(deps, "sess-x");

      const childWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("child container"));
      expect(childWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  describe("archive racing container creation", () => {
    function creatingContainer(): SessionContainer {
      return { ...makeContainer(undefined), id: "", status: "starting" } as SessionContainer;
    }

    it("never dials Docker with an empty container id", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const requestedContainerIds: string[] = [];
        const { deps } = makeDeps([], creatingContainer(), { requestedContainerIds });

        await destroyContainer(deps, "sess-x");

        expect(requestedContainerIds).not.toContain("");
      } finally {
        warn.mockRestore();
      }
    });

    it("still completes the rest of the teardown", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const removedContainers: string[] = [];
        const { deps, emitter } = makeDeps([], creatingContainer(), {
          children: [{ Id: "egress-resolver-1", State: "running" }],
          removedContainers,
        });
        let destroyed: string | undefined;
        emitter.on("container_destroyed", (id: string) => { destroyed = id; });

        await destroyContainer(deps, "sess-x");

        expect(removedContainers).toContain("egress-resolver-1");
        expect(deps.containers.has("sess-x")).toBe(false);
        expect(destroyed).toBe("sess-x");
      } finally {
        warn.mockRestore();
      }
    });

    it("says so, so the skip is visible rather than silent", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { deps } = makeDeps([], creatingContainer());

        await destroyContainer(deps, "sess-x");

        const skipped = warn.mock.calls.filter((c) => String(c[0]).includes("still being created"));
        expect(skipped).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe("createContainer — overlay volume re-verification (nikzlabs/shipit#2495)", () => {
  function fakeDaemon(opts: { vanishBeforeContainerCreate?: string[] } = {}) {
    const store = new Map<string, { Options: Record<string, string> | null }>();
    const removedVolumes: string[] = [];
    const started: string[] = [];
    let containerRemoved = false;

    const docker = {
      createVolume: async (cfg: { Name: string; DriverOpts?: Record<string, string> }) => {
        if (store.has(cfg.Name)) return;
        store.set(cfg.Name, { Options: cfg.DriverOpts ?? null });
      },
      getVolume: (name: string) => ({
        inspect: async () => {
          const v = store.get(name);
          if (!v) throw Object.assign(new Error("no such volume"), { statusCode: 404 });
          return { Mountpoint: `/var/lib/docker/volumes/${name}/_data`, ...v };
        },
        remove: async () => {
          removedVolumes.push(name);
          store.delete(name);
        },
      }),
      listContainers: async () => [],
      listNetworks: async () => [],
      getNetwork: () => ({ remove: async () => {} }),
      listVolumes: async () => ({ Volumes: [] }),
      getContainer: () => ({
        inspect: async () => { throw Object.assign(new Error("no such container"), { statusCode: 404 }); },
        stop: async () => {},
        remove: async () => { containerRemoved = true; },
      }),
      createContainer: async (cfg: { HostConfig?: { Mounts?: { Type: string; Source: string }[] } }) => {
        for (const name of opts.vanishBeforeContainerCreate ?? []) store.delete(name);
        for (const m of cfg.HostConfig?.Mounts ?? []) {
          if (m.Type === "volume" && !store.has(m.Source)) store.set(m.Source, { Options: null });
        }
        return {
          id: "cid-new",
          start: async () => { started.push("cid-new"); },
          inspect: async () => ({
            Config: { Labels: {} },
            NetworkSettings: { Networks: { "shipit-net": { IPAddress: "172.20.0.9" } } },
          }),
        };
      },
    } as unknown as Docker;

    return { docker, store, removedVolumes, started, wasContainerRemoved: () => containerRemoved };
  }

  function makeDeps(docker: Docker): LifecycleDeps {
    return {
      docker,
      containers: new Map(),
      standbySessionIds: new Set<string>(),
      destroyEpochs: new Map<string, number>(),
      emitter: new EventEmitter(),
      baseLabels: () => ({ "shipit-managed": "true" }),
      networkName: "shipit-net",
      workerPort: 9100,
      imageName: "shipit-worker:test",
      skipHealthCheck: true,
    } as unknown as LifecycleDeps;
  }

  function overlaySpec(depDir: string, volumeName: string): DepDirOverlaySpec {
    return {
      depDir,
      mountPath: `/workspace/${depDir}`,
      volumeName,
      lowerdir: `/data/overlay-base/h-${depDir}/g1`,
      upperdir: `/data/sessions/s1/overlay/h-${depDir}/g1/upper`,
      workdir: `/data/sessions/s1/overlay/h-${depDir}/g1/work`,
      generation: 1,
      scopeHash: `h-${depDir}`,
    } as unknown as DepDirOverlaySpec;
  }

  const NODE_MODULES_VOL = "shipit-3f6d1497-c46_overlay-dba27c31";
  const DIST_VOL = "shipit-3f6d1497-c46_overlay-bcae0416";

  function configWithSpecs(tmp: string, specs: DepDirOverlaySpec[]): ContainerConfig {
    return baseConfig({
      sessionId: "3f6d1497-c466-4b2c-b9af-0f1800fbf759",
      sessionDir: path.join(tmp, "session"),
      workspaceDir: path.join(tmp, "session", "workspace"),
      sessionStateDir: path.join(tmp, "session", "state"),
      overlaySpecs: specs,
    });
  }

  const tmpDirs: string[] = [];
  function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-create-"));
    tmpDirs.push(d);
    fs.mkdirSync(path.join(d, "session", "workspace"), { recursive: true });
    return d;
  }
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("starts the container when every dep-dir volume is still the overlay we created", async () => {
    const daemon = fakeDaemon();
    const deps = makeDeps(daemon.docker);
    const tmp = tmpDir();

    const sc = await createContainer(deps, configWithSpecs(tmp, [
      overlaySpec("node_modules", NODE_MODULES_VOL),
      overlaySpec("dist", DIST_VOL),
    ]));

    expect(daemon.started).toEqual(["cid-new"]);
    expect(sc.workerUrl).toBe("http://172.20.0.9:9100");
    expect(daemon.removedVolumes).toEqual([]);
  });

  it("refuses to start when a dep-dir volume was auto-created by Docker mid-window", async () => {
    const daemon = fakeDaemon({ vanishBeforeContainerCreate: [NODE_MODULES_VOL] });
    const deps = makeDeps(daemon.docker);
    const tmp = tmpDir();

    await expect(createContainer(deps, configWithSpecs(tmp, [
      overlaySpec("node_modules", NODE_MODULES_VOL),
      overlaySpec("dist", DIST_VOL),
    ]))).rejects.toThrow(OVERLAY_VERIFY_FAILURE);

    expect(daemon.started).toEqual([]);
    expect(daemon.wasContainerRemoved()).toBe(true);
    expect([...daemon.removedVolumes].sort()).toEqual([DIST_VOL, NODE_MODULES_VOL].sort());
    expect(daemon.store.has(NODE_MODULES_VOL)).toBe(false);
    expect(deps.containers.has("3f6d1497-c466-4b2c-b9af-0f1800fbf759")).toBe(false);
  });

  it("leaves a non-overlay session's create path untouched", async () => {
    const daemon = fakeDaemon();
    const deps = makeDeps(daemon.docker);
    const tmp = tmpDir();

    const sc = await createContainer(deps, baseConfig({
      sessionId: "plain-session",
      sessionDir: path.join(tmp, "session"),
      workspaceDir: path.join(tmp, "session", "workspace"),
      sessionStateDir: path.join(tmp, "session", "state"),
    }));

    expect(daemon.started).toEqual(["cid-new"]);
    expect(sc.status).toBe("running");
  });
});

describe("prepareOverlayDirs (planning#147)", () => {
  let tmpDir: string;
  const prevUid = process.env.SHIPIT_SESSION_WORKER_UID;

  function makeSpec(root: string, hash: string, generation = 0): DepDirOverlaySpec {
    const scopeDir = path.join(root, "sessions", "sess-1", "overlay", hash);
    const genDir = path.join(scopeDir, `g${generation}`);
    return {
      volumeName: `shipit-sess-1_overlay-${hash}`,
      lowerdir: `/daemon/overlay-base/${hash}/g${generation}`,
      upperdir: `/daemon/${path.relative("/", path.join(genDir, "upper"))}`,
      workdir: `/daemon/${path.relative("/", path.join(genDir, "work"))}`,
      depDir: "node_modules",
      mountPath: "/workspace/node_modules",
      scope: { repoUrl: "https://x/y.git", runtimeKey: "rk", depDir: "node_modules" },
      scopeHash: hash,
      generation,
      orchDirs: {
        lowerdir: path.join(root, "overlay-base", hash, `g${generation}`),
        upperdir: path.join(genDir, "upper"),
        workdir: path.join(genDir, "work"),
        sessionScopeDir: scopeDir,
      },
    };
  }

  function makeWorkspaceWithMarker(root: string): { workspaceDir: string; markerFile: string } {
    const workspaceDir = path.join(root, "sessions", "sess-1", "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const markerFile = path.join(
      sessionSharedStateDir(sessionStateDirForWorkspace(workspaceDir)),
      INSTALL_MARKER_FILE,
    );
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, "{}");
    return { workspaceDir, markerFile };
  }

  afterEach(() => {
    if (prevUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
    else process.env.SHIPIT_SESSION_WORKER_UID = prevUid;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mkdirs the orchestrator-visible lower/upper/work dirs for every spec", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-dirs-"));
    const spec = makeSpec(tmpDir, "aaaa1111");
    prepareOverlayDirs([spec]);
    expect(fs.existsSync(spec.orchDirs!.lowerdir)).toBe(true);
    expect(fs.existsSync(spec.orchDirs!.upperdir)).toBe(true);
    expect(fs.existsSync(spec.orchDirs!.workdir)).toBe(true);
  });

  it("hands the per-session upper/work dirs to the worker uid", () => {
    const myUid = process.getuid?.();
    if (myUid === undefined) return;
    process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-dirs-"));
    const spec = makeSpec(tmpDir, "bbbb2222");
    prepareOverlayDirs([spec]);
    expect(fs.lstatSync(spec.orchDirs!.upperdir).uid).toBe(myUid);
    expect(fs.lstatSync(spec.orchDirs!.workdir).uid).toBe(myUid);
  });

  it("is a no-op for undefined specs and specs without orchDirs", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-dirs-"));
    expect(() => prepareOverlayDirs(undefined)).not.toThrow();
    const spec = makeSpec(tmpDir, "cccc3333");
    delete spec.orchDirs;
    expect(() => prepareOverlayDirs([spec])).not.toThrow();
  });

  it("reaps the superseded generation's upper/work when the base generation rotated", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-rot-"));
    const hash = "dddd4444";

    const old = makeSpec(tmpDir, hash, 262);
    prepareOverlayDirs([old]);
    const staleFile = path.join(old.orchDirs!.upperdir, ".package-lock.json");
    fs.writeFileSync(staleFile, "{}");

    const next = makeSpec(tmpDir, hash, 265);
    prepareOverlayDirs([next]);

    expect(fs.existsSync(path.dirname(old.orchDirs!.upperdir))).toBe(false);
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.readdirSync(next.orchDirs!.upperdir)).toEqual([]);
    expect(fs.existsSync(next.orchDirs!.workdir)).toBe(true);
    expect(fs.readdirSync(next.orchDirs!.sessionScopeDir)).toEqual(["g265"]);
  });

  it("drops the install marker on rotation, so agent.install re-validates over the new base", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-rot-"));
    const hash = "eeee5555";
    const { workspaceDir, markerFile } = makeWorkspaceWithMarker(tmpDir);

    prepareOverlayDirs([makeSpec(tmpDir, hash, 1)], { workspaceDir });
    expect(fs.existsSync(markerFile)).toBe(true);

    prepareOverlayDirs([makeSpec(tmpDir, hash, 2)], { workspaceDir });
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  it("keeps the marker when a second dep dir rotates nothing", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-rot-"));
    const { workspaceDir, markerFile } = makeWorkspaceWithMarker(tmpDir);
    prepareOverlayDirs([makeSpec(tmpDir, "1111aaaa", 3), makeSpec(tmpDir, "2222bbbb", 0)], {
      workspaceDir,
    });
    expect(fs.existsSync(markerFile)).toBe(true);
    prepareOverlayDirs([makeSpec(tmpDir, "1111aaaa", 3), makeSpec(tmpDir, "2222bbbb", 0)], {
      workspaceDir,
    });
    expect(fs.existsSync(markerFile)).toBe(true);
  });

  it("leaves a freshly created upperdir group-writable", () => {
    const myUid = process.getuid?.();
    if (myUid === undefined) return;
    process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-rot-"));
    const spec = makeSpec(tmpDir, "6666ffff", 9);
    prepareOverlayDirs([spec]);
    expect(fs.statSync(spec.orchDirs!.upperdir).mode & 0o020).toBe(0o020);
  });

  it("reaps only the rotating dep dir's superseded upper, not its sibling's", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-rot-"));
    const rootNm = makeSpec(tmpDir, "3333cccc", 7);
    const vendor = makeSpec(tmpDir, "4444dddd", 2);
    prepareOverlayDirs([rootNm, vendor]);
    fs.writeFileSync(path.join(vendor.orchDirs!.upperdir, "keep"), "x");

    prepareOverlayDirs([makeSpec(tmpDir, "3333cccc", 8), vendor]);
    expect(fs.readdirSync(rootNm.orchDirs!.sessionScopeDir)).toEqual(["g8"]);
    expect(fs.existsSync(path.join(vendor.orchDirs!.upperdir, "keep"))).toBe(true);
  });
});

describe("ensurePnpmStoreDir (planning#2286)", () => {
  let tmpDir: string;
  const prevUid = process.env.SHIPIT_SESSION_WORKER_UID;

  // Use our GID for permitted chgrp calls; it need not equal our UID.
  const selfUid = process.getuid?.();
  const selfGid = process.getgid?.();

  afterEach(() => {
    if (prevUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
    else process.env.SHIPIT_SESSION_WORKER_UID = prevUid;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the store dir and its parents", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    const storeDir = path.join(tmpDir, "pnpm-store", "deadbeefcafe0001");
    expect(ensurePnpmStoreDir(storeDir)).toBe(true);
    expect(fs.existsSync(storeDir)).toBe(true);
  });

  it("hands the store dir to the shared worker gid", () => {
    if (selfUid === undefined || selfGid === undefined) return;
    process.env.SHIPIT_SESSION_WORKER_UID = String(selfGid);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    const storeDir = path.join(tmpDir, "pnpm-store", "deadbeefcafe0002");
    const spy = vi.spyOn(fs, "lchownSync");
    expect(ensurePnpmStoreDir(storeDir)).toBe(true);
    expect(spy).toHaveBeenCalledWith(storeDir, selfUid, selfGid);
    spy.mockRestore();
  });

  it("re-chowns an existing store dir (repairs one left root-owned by an earlier build)", () => {
    if (selfUid === undefined || selfGid === undefined) return;
    process.env.SHIPIT_SESSION_WORKER_UID = String(selfGid);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    const storeDir = path.join(tmpDir, "pnpm-store", "deadbeefcafe0003");
    fs.mkdirSync(storeDir, { recursive: true });
    const spy = vi.spyOn(fs, "lchownSync");
    expect(ensurePnpmStoreDir(storeDir)).toBe(true);
    expect(spy).toHaveBeenCalledWith(storeDir, selfUid, selfGid);
    spy.mockRestore();
  });

  it("walks the store contents ONCE, then skips on every later create", () => {
    if (selfGid === undefined) return;
    process.env.SHIPIT_SESSION_WORKER_UID = String(selfGid);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    const storeDir = path.join(tmpDir, "pnpm-store", "deadbeefcafe0004");
    fs.mkdirSync(path.join(storeDir, "files", "00"), { recursive: true });
    fs.writeFileSync(path.join(storeDir, "files", "00", "abc"), "x");

    const first = vi.spyOn(fs, "lchownSync");
    ensurePnpmStoreDir(storeDir);
    expect(first.mock.calls.length).toBeGreaterThan(1);
    first.mockRestore();

    const second = vi.spyOn(fs, "lchownSync");
    ensurePnpmStoreDir(storeDir);
    expect(second).not.toHaveBeenCalled();
    second.mockRestore();
  });

  it("chowns nothing when SHIPIT_SESSION_WORKER_UID is unset (legacy root runtime)", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    const storeDir = path.join(tmpDir, "pnpm-store", "deadbeefcafe0005");
    const spy = vi.spyOn(fs, "lchownSync");
    expect(ensurePnpmStoreDir(storeDir)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("reports false when the handoff did not take (mount must be dropped)", () => {
    const myUid = process.getuid?.();
    if (myUid === undefined) return;
    process.env.SHIPIT_SESSION_WORKER_UID = String(myUid + 1);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    const storeDir = path.join(tmpDir, "pnpm-store", "deadbeefcafe0006");
    const spy = vi.spyOn(fs, "lchownSync").mockImplementation(() => {});
    expect(ensurePnpmStoreDir(storeDir)).toBe(false);
    spy.mockRestore();
  });

  it("reports false when the store dir cannot be created", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    const blocker = path.join(tmpDir, "pnpm-store");
    fs.writeFileSync(blocker, "not a dir");
    expect(ensurePnpmStoreDir(path.join(blocker, "deadbeefcafe0007"))).toBe(false);
  });
});

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

  it("reconciles the workspace dep dirs on a non-overlay session", () => {
    const handBack = vi.fn();
    const reconcile = vi.fn();
    selfHealWorkspaceOwnership({ workspaceDir: WS_DIR }, WS_VOLUME, handBack, reconcile);
    expect(reconcile).toHaveBeenCalledWith(`${WS_DIR}/node_modules`);
  });

  it("reconciles each overlay upperdir (not the workspace dep dir) on an overlay session", () => {
    const handBack = vi.fn();
    const reconcile = vi.fn();
    const overlaySpecs = [
      { orchDirs: { lowerdir: "/o/lower", upperdir: "/o/upper", workdir: "/o/work" } },
    ] as unknown as ContainerConfig["overlaySpecs"];
    selfHealWorkspaceOwnership({ workspaceDir: WS_DIR, overlaySpecs }, WS_VOLUME, handBack, reconcile);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith("/o/upper");
    expect(reconcile).not.toHaveBeenCalledWith(`${WS_DIR}/node_modules`);
  });

  it("does not reconcile dep dirs in dev bind-mount mode (no workspaceVolume)", () => {
    const handBack = vi.fn();
    const reconcile = vi.fn();
    selfHealWorkspaceOwnership({ workspaceDir: WS_DIR }, undefined, handBack, reconcile);
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("createContainer — cancelled by a concurrent destroy", () => {
  const SESSION = "3f6d1497-c466-4b2c-b9af-0f1800fbf759";

  function pausableDaemon() {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let reachedCreate!: () => void;
    const atCreate = new Promise<void>((resolve) => { reachedCreate = resolve; });
    const started: string[] = [];
    const removed: string[] = [];

    const docker = {
      listContainers: async () => [],
      listNetworks: async () => [],
      listVolumes: async () => ({ Volumes: [] }),
      getNetwork: () => ({ remove: async () => {} }),
      getVolume: () => ({ remove: async () => {} }),
      getContainer: (id: string) => ({
        inspect: async () => { throw Object.assign(new Error("no such container"), { statusCode: 404 }); },
        stop: async () => {},
        remove: async () => { removed.push(id); },
      }),
      createContainer: async () => {
        reachedCreate();
        await paused;
        return {
          id: "cid-new",
          start: async () => { started.push("cid-new"); },
          inspect: async () => ({
            Config: { Labels: {} },
            NetworkSettings: { Networks: { "shipit-net": { IPAddress: "172.20.0.9" } } },
          }),
        };
      },
    } as unknown as Docker;

    return { docker, release, atCreate, started, removed };
  }

  function raceDeps(docker: Docker): LifecycleDeps {
    return {
      docker,
      containers: new Map(),
      standbySessionIds: new Set<string>(),
      destroyEpochs: new Map<string, number>(),
      emitter: new EventEmitter(),
      baseLabels: () => ({ "shipit-managed": "true" }),
      networkName: "shipit-net",
      workerPort: 9100,
      imageName: "shipit-worker:test",
      skipHealthCheck: true,
    } as unknown as LifecycleDeps;
  }

  const raceTmpDirs: string[] = [];
  function raceTmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-race-"));
    raceTmpDirs.push(d);
    fs.mkdirSync(path.join(d, "session", "workspace"), { recursive: true });
    return d;
  }
  afterEach(() => {
    for (const d of raceTmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function archiveMidCreate() {
    const daemon = pausableDaemon();
    const deps = raceDeps(daemon.docker);
    const tmp = raceTmpDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const creating = createContainer(deps, baseConfig({
      sessionId: SESSION,
      sessionDir: path.join(tmp, "session"),
      workspaceDir: path.join(tmp, "session", "workspace"),
      sessionStateDir: path.join(tmp, "session", "state"),
    }));
    const settled: Promise<unknown> = (async () => {
      try { await creating; return null; } catch (e) { return e; }
    })();

    await daemon.atCreate;
    expect(deps.containers.get(SESSION)?.id).toBe("");

    await destroyContainer(deps, SESSION);
    daemon.release();

    const outcome = await settled;
    warn.mockRestore();
    return { deps, daemon, outcome };
  }

  it("aborts the creation instead of completing it", async () => {
    const { outcome } = await archiveMidCreate();
    expect(outcome).toBeInstanceOf(ContainerCreateCancelledError);
  });

  it("never starts the container it had already built", async () => {
    const { daemon } = await archiveMidCreate();
    expect(daemon.started).toEqual([]);
  });

  it("removes the container it built, and leaves nothing tracked", async () => {
    const { daemon, deps } = await archiveMidCreate();
    expect(daemon.removed).toContain("cid-new");
    expect(deps.containers.has(SESSION)).toBe(false);
  });

  it("does not cancel a create that STARTED after the destroy", async () => {
    const daemon = pausableDaemon();
    const deps = raceDeps(daemon.docker);
    const tmp = raceTmpDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await destroyContainer(deps, SESSION);

      daemon.release();
      const sc = await createContainer(deps, baseConfig({
        sessionId: SESSION,
        sessionDir: path.join(tmp, "session"),
        workspaceDir: path.join(tmp, "session", "workspace"),
        sessionStateDir: path.join(tmp, "session", "state"),
      }));

      expect(sc.status).toBe("running");
      expect(daemon.started).toEqual(["cid-new"]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createContainer — cleanup after a newer incarnation took over", () => {
  const SESSION = "3f6d1497-c466-4b2c-b9af-0f1800fbf759";
  const OVERLAY_VOL = "shipit-3f6d1497-c46_overlay-dba27c31";

  it("skips the session-wide sweep when another container owns the session", async () => {
    const sweeps: string[] = [];
    const removedVolumes: string[] = [];
    const removedContainers: string[] = [];
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let reachedCreate!: () => void;
    const atCreate = new Promise<void>((resolve) => { reachedCreate = resolve; });

    const docker = {
      listContainers: async (o: { filters?: { label?: string[] } }) => {
        sweeps.push(JSON.stringify(o?.filters ?? {}));
        return [];
      },
      listNetworks: async () => [],
      listVolumes: async () => ({ Volumes: [] }),
      getNetwork: () => ({ remove: async () => {} }),
      getVolume: (name: string) => ({ remove: async () => { removedVolumes.push(name); } }),
      getContainer: (id: string) => ({
        inspect: async () => { throw Object.assign(new Error("no such container"), { statusCode: 404 }); },
        stop: async () => {},
        remove: async () => { removedContainers.push(id); },
      }),
      createContainer: async () => {
        reachedCreate();
        await paused;
        return {
          id: "cid-old",
          start: async () => {},
          inspect: async () => ({
            Config: { Labels: {} },
            NetworkSettings: { Networks: { "shipit-net": { IPAddress: "172.20.0.9" } } },
          }),
        };
      },
    } as unknown as Docker;

    const containers = new Map<string, SessionContainer>();
    const deps = {
      docker,
      containers,
      standbySessionIds: new Set<string>(),
      destroyEpochs: new Map<string, number>(),
      emitter: new EventEmitter(),
      baseLabels: () => ({ "shipit-managed": "true" }),
      networkName: "shipit-net",
      workerPort: 9100,
      imageName: "shipit-worker:test",
      skipHealthCheck: true,
    } as unknown as LifecycleDeps;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-supersede-"));
    fs.mkdirSync(path.join(tmp, "session", "workspace"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const replacement = {
        id: "cid-new", sessionId: SESSION, workerUrl: "http://172.20.0.9:9100",
        overlayVolumeNames: [OVERLAY_VOL],
      } as unknown as SessionContainer;

      const failing = createContainer(deps, baseConfig({
        sessionId: SESSION,
        sessionDir: path.join(tmp, "session"),
        workspaceDir: path.join(tmp, "session", "workspace"),
        sessionStateDir: path.join(tmp, "session", "state"),
      }));
      await atCreate;
      containers.set(SESSION, replacement);
      deps.destroyEpochs.set(SESSION, 1);
      release();

      await expect(failing).rejects.toBeInstanceOf(ContainerCreateCancelledError);

      expect(removedContainers).not.toContain("cid-new");
      expect(removedVolumes).not.toContain(OVERLAY_VOL);
      expect(sweeps).toEqual([]);
      expect(containers.get(SESSION)).toBe(replacement);
    } finally {
      warn.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("destroyContainer — previewsStopped flag on container_destroyed", () => {
  function fakeDocker(): Docker {
    const noop = async (): Promise<void> => {};
    return {
      getContainer: () => ({ stop: noop, remove: noop }),
      listContainers: async () => [],
      listNetworks: async () => [],
      getNetwork: () => ({ remove: noop }),
      listVolumes: async () => ({ Volumes: [] }),
      getVolume: () => ({ remove: noop }),
    } as unknown as Docker;
  }

  function setup(): { deps: LifecycleDeps; events: { sessionId: string; previewsStopped: unknown }[] } {
    const emitter = new EventEmitter();
    const events: { sessionId: string; previewsStopped: unknown }[] = [];
    emitter.on("container_destroyed", (sessionId: string, previewsStopped: unknown) => {
      events.push({ sessionId, previewsStopped });
    });
    const sc = {
      id: "cid-1",
      sessionId: "sess-x",
      containerIp: "",
      workerUrl: "",
      status: "running",
      hostWorkspaceDir: "/workspace/sessions/sess-x/workspace",
      dockerAccess: false,
    } as unknown as SessionContainer;
    const deps = {
      docker: fakeDocker(),
      containers: new Map([[sc.sessionId, sc]]),
      standbySessionIds: new Set<string>(),
      destroyEpochs: new Map<string, number>(),
      emitter,
    } as unknown as LifecycleDeps;
    return { deps, events };
  }

  it("reports previews stopped for a full teardown, which sweeps the Compose stack", async () => {
    const { deps, events } = setup();

    await destroyContainer(deps, "sess-x");

    expect(events).toEqual([{ sessionId: "sess-x", previewsStopped: true }]);
  });

  it("reports previews STILL RUNNING when a replacement teardown will rebuild them", async () => {
    const { deps, events } = setup();

    await destroyContainer(deps, "sess-x", { replacementFollows: true });

    expect(events).toEqual([{ sessionId: "sess-x", previewsStopped: false }]);
  });

  it("reports previews STILL RUNNING when child resources are preserved", async () => {
    const { deps, events } = setup();

    await destroyContainer(deps, "sess-x", { preserveChildResources: true });

    expect(events).toEqual([{ sessionId: "sess-x", previewsStopped: false }]);
  });
});
