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
  ensurePnpmStoreDir,
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
    workspaceDir: "/workspace/sessions/sess-1/workspace",
    sessionStateDir: "/workspace/sessions/sess-1/state",
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
    // The clone — `<sessionDir>/workspace` — is what lands at /workspace.
    expect(result.binds).toContain("/workspace/sessions/sess-1/workspace:/workspace:rw");
    // docs/138 — the container gets its PRIVATE credentials subtree, never the
    // shared root, so a Claude session can't read Codex's creds and vice versa.
    expect(result.binds).toContain("/credentials/sessions/sess-1:/credentials:rw");
    expect(result.binds).not.toContain("/credentials:/credentials:rw");
    // docs/246 / planning#288 — every session mounts the container-visible slice of
    // its state dir; there is no "no state dir" case left to skip it for.
    expect(result.binds).toContain(
      "/workspace/sessions/sess-1/state/shared:/session-state:rw",
    );
    expect(result.mounts).toHaveLength(0);
  });

  // docs/262 — read-only, and read-only ONLY: an earlier revision added a
  // writable twin for the in-container install runner, which made req 7's
  // guarantee decorative. Install moved to its own container instead.
  it("docs/262: mounts the plugin root read-only, with no writable view", () => {
    const result = buildMounts(baseConfig(), undefined, undefined);
    expect(result.binds).toContain("/workspace/sessions/sess-1/state/plugins:/plugin-store:ro");
    expect(result.binds.some((b) => b.includes("/state/plugins:") && b.endsWith(":rw"))).toBe(false);
    // Never a per-generation mount: Docker resolves a bind source's symlinks at
    // creation, so that shape would pin one generation and make refresh
    // invisible until the container was recreated.
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

  // docs/172 Gap 6 (planning#47) — /uploads is mounted READ-ONLY. The agent only
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

  // docs/217 — /persist is the agent's persistent scratch, mounted READ-WRITE
  // (the opposite of /uploads): the agent writes throwaway-but-keep files here so
  // they survive container teardown instead of vanishing from /tmp.
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
    expect(wsMounts[0].VolumeOptions?.Subpath).toBe("sessions/sess-1/workspace");

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
    expect(wsMount!.VolumeOptions?.Subpath).toBe("sessions/sess-1/workspace");
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
  // docs/246 / planning#288 — the worker writes its install marker here, and the
  // state dir is ALWAYS mounted, so this is unconditional. It used to fall back
  // to an in-clone `${workspaceDir}/.shipit` for a session with no mountable
  // state dir (the flat layout); nothing has that shape any more, and the
  // fallback put a generated file where `git add -A` would stage it.
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

  // docs/213 — the baked Android toolchain is ambient in every session. buildEnv
  // mirrors the SDK/JDK paths at the launch boundary (like the Playwright path)
  // so any Android/Gradle repo builds with no per-repo configuration.
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

  // docs/150 Rollout — the orchestrator forwards SHIPIT_SESSION_WORKER_UID so the
  // image entrypoint chowns the mounts to the SAME uid the orchestrator-side
  // chown helpers use. Unset → not forwarded (entrypoint default + no-op chowns).
  it("docs/150: forwards SHIPIT_SESSION_WORKER_UID when set", () => {
    // The GATE reads the injected `procEnv`, but the VALUE comes from
    // `identityForTarget`, which resolves through the ambient `process.env`
    // (session-identity roots are unconfigured in unit tests, so it falls back
    // to `sessionWorkerUid()`). Both have to say 1000, or the ambient value of
    // the machine running the suite leaks into the assertion — a ShipIt session
    // container carries a per-session `SHIPIT_SESSION_WORKER_UID` of its own.
    const prev = process.env.SHIPIT_SESSION_WORKER_UID;
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    try {
      const env = buildEnv(baseConfig(), "/workspace", 9100, undefined, undefined, {
        SHIPIT_SESSION_WORKER_UID: "1000",
      } as NodeJS.ProcessEnv);
      expect(env).toContain("SHIPIT_SESSION_WORKER_UID=1000");
      // docs/270 — the PAIR is forwarded, because `gosu <uid>:<gid>` and the
      // entrypoint's chown loop can no longer assume the two are equal. The gid
      // is the shared one, which `sessionWorkerGid()` parses out of this same
      // variable — the orchestrator never reads SHIPIT_SESSION_WORKER_GID, it
      // only produces it.
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

  // planning#196 — the orchestrator resolves the worker's pinned base-image digest at
  // startup into BASE_IMAGE_DIGEST; buildEnv forwards it so the worker's
  // install-runtime runtimeKey() (the install-marker ABI gate) keys on the same
  // base digest the orchestrator's overlayRuntimeKey() scope uses.
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

  // docs/211 — a sandbox session with Docker granted reaches Docker through the
  // SAME session-scoped proxy as any ordinary docker-access session — NEVER the
  // ops read-only host socket proxy. (`opsSession` is false for a sandbox; this
  // asserts buildEnv routes it to the write-capable session proxy + a session
  // compose project, with no `OPS_DOCKER_HOST` leak.)
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
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: "/credentials",
      depCacheDir: "/workspace/dep-cache/hash",
    });
    expect(config.depCacheDir).toBe("/workspace/dep-cache/hash");
  });

  it("leaves depCacheDir undefined when not provided", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: "/credentials",
    });
    expect(config.depCacheDir).toBeUndefined();
  });

  // docs/217 — scratchDir defaults to a `scratch/` sibling of the session dir
  // (mirroring uploadsDir), so it's a sibling of `workspace/` and the disk-reclaim
  // paths (which rm workspace/ only) leave it intact.
  it("derives scratchDir as a sessionDir sibling by default", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: "/credentials",
    });
    expect(config.scratchDir).toBe("/workspace/sessions/s1/scratch");
    // Sibling of workspace/, never nested inside it.
    expect(config.scratchDir).not.toContain("/workspace/sessions/s1/workspace/");
  });

  it("passes through an explicit scratchDir", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: "/credentials",
      scratchDir: "/custom/scratch",
    });
    expect(config.scratchDir).toBe("/custom/scratch");
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
      workspaceDir: "/workspace/sessions/s1/workspace",
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
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: "/credentials",
      dockerAccess: true,
    });
    expect(config.dockerAccess).toBe(true);
  });

  // docs/246 — derived from the CLONE path via the one contract the host-side
  // writers share, so the mount and every host writer agree on where a session's
  // state lives.
  it("derives sessionStateDir as a `state/` sibling of the clone", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      workspaceDir: "/workspace/sessions/s1/workspace",
      credentialsDir: "/credentials",
    });
    expect(config.sessionStateDir).toBe("/workspace/sessions/s1/state");
  });

  // planning#288 — unlike `scratchDir`/`uploadsDir`, the state dir is NOT
  // overridable. The old `sessionStateDir?` opt was dead in production, and it
  // would now silently diverge: the container would mount `<custom>/shared`
  // while `preStampInstallMarker` (which derives from the clone path) wrote the
  // marker to `<sessionDir>/state/shared`, so the worker could not see it and a
  // valid overlay base hit would run a full `agent.install` anyway.
  it("always derives the state dir from the clone, ignoring any sibling override", () => {
    const config = buildContainerConfig(deps, {
      sessionId: "s1",
      sessionDir: "/workspace/sessions/s1",
      workspaceDir: "/workspace/sessions/s1/workspace",
      scratchDir: "/custom/scratch",
      credentialsDir: "/credentials",
    });
    // The overridable siblings still honour their overrides...
    expect(config.scratchDir).toBe("/custom/scratch");
    // ...the state dir does not have one to honour.
    expect(config.sessionStateDir).toBe("/workspace/sessions/s1/state");
  });

  // planning#288 — a pre-`workspace/` flat session (clone === session dir) is refused
  // outright. The two rejected alternatives: a bare `dirname` gives every flat
  // session on the host the SAME `<sessionsRoot>/state` (one shared install
  // marker), and the previous "no state dir" answer let ShipIt keep writing its
  // artifacts inside the user's clone. Such a row is unserviceable by decision.
  it("refuses a flat-layout session rather than sharing or in-clone placement", () => {
    expect(() =>
      buildContainerConfig(deps, {
        sessionId: "s1",
        sessionDir: "/workspace/sessions/s1",
        workspaceDir: "/workspace/sessions/s1",
        credentialsDir: "/credentials",
      }),
    ).toThrow(/<sessionDir>\/workspace/);
  });
});

// ---------------------------------------------------------------------------
// destroyContainer — overlay-volume teardown (docs/183 Phase 6)
// ---------------------------------------------------------------------------

describe("destroyContainer — overlay volume teardown", () => {
  /**
   * Minimal fake Docker that records every `volume rm` by name, plus every
   * child container removed by the `shipit-parent-session` sweep.
   *
   * `children` seeds `listContainers` — planning#224: it used to return `[]`
   * unconditionally, so the sweep in `cleanupSessionDockerResources` (the thing
   * that reaps a session's egress sidecars on teardown) was never actually
   * asserted by any test.
   */
  function fakeDocker(
    removedVolumes: string[],
    opts: {
      children?: { Id: string; State?: string }[];
      removedContainers?: string[];
      listFilters?: unknown[];
      /** id → error its `remove()` throws (models the reaper-vs-sweep race). */
      removeErrors?: Record<string, Error>;
    } = {},
  ): Docker {
    const noop = async (): Promise<void> => {};
    return {
      getContainer: (id: string) => ({
        stop: noop,
        remove: async () => {
          const err = opts.removeErrors?.[id];
          if (err) throw err;
          opts.removedContainers?.push(id);
        },
      }),
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

  // planning#224 — the parent-label sweep is what reaps a session's Tier B/C egress
  // sidecars (docs/172) on teardown. It was previously untested here (the fake's
  // `listContainers` returned `[]`), which is how the crash-path leak went
  // unnoticed for so long: nothing pinned the behavior either way.
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
    // …and the agent container (the netns parent) is removed LAST, after its
    // sidecars — the ordering that keeps us from orphaning them.
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

  // Round 5 (planning#224) — with the crash-site reaper live, the die-triggered reap
  // races this sweep for the same two sidecars on EVERY healthy destroy, so a 404
  // on child remove is the routine "the reaper got there first" outcome. Warning
  // on it would spam every clean shutdown. Mutation-verified: revert the
  // 404-ignore in cleanupSessionDockerResources and this goes red.
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
});

// ---------------------------------------------------------------------------
// prepareOverlayDirs — overlay dir creation + worker-uid handoff (planning#147)
// ---------------------------------------------------------------------------

describe("prepareOverlayDirs (planning#147)", () => {
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
// ensurePnpmStoreDir (planning#2286)
// ---------------------------------------------------------------------------

describe("ensurePnpmStoreDir (planning#2286)", () => {
  let tmpDir: string;
  const prevUid = process.env.SHIPIT_SESSION_WORKER_UID;

  // docs/270 — the store is handed over by GROUP, not by owner, and the shared
  // gid is what `sessionWorkerGid()` parses out of SHIPIT_SESSION_WORKER_UID
  // (the orchestrator has exactly one input variable; SHIPIT_SESSION_WORKER_GID
  // is an output it forwards to the entrypoint and never reads back).
  //
  // So these tests configure that variable to a gid the test process can
  // actually `chgrp` to — its OWN primary gid — and assert the resulting
  // (owner, group) pair explicitly. Setting it to the process's *uid* only
  // worked because CI runs uid 1000 / gid 1000: on a machine where they differ
  // (a ShipIt session container allocates a per-session uid like 2000006 while
  // the group stays the shared 1000) the real chgrp EPERMs, is swallowed by
  // design, and the handoff verification correctly reports false. That
  // uid == gid assumption was the harness's, never the product's.
  const selfUid = process.getuid?.();
  const selfGid = process.getgid?.();

  afterEach(() => {
    if (prevUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
    else process.env.SHIPIT_SESSION_WORKER_UID = prevUid;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the store dir and its parents", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID; // legacy root runtime
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    const storeDir = path.join(tmpDir, "pnpm-store", "deadbeefcafe0001");
    expect(ensurePnpmStoreDir(storeDir)).toBe(true);
    expect(fs.existsSync(storeDir)).toBe(true);
  });

  // The whole point: the entrypoint's chown loop does not revisit this mount once
  // the workspace sentinel exists (the store is nested under /workspace and the
  // walk is gated on the workspace), so the orchestrator must hand it over itself
  // or the non-root agent EACCESes on `pnpm install`. Asserted on the chown CALL,
  // not on the resulting uid: a dir the test process just created already carries
  // its own uid, so a uid assertion would pass with no chown at all.
  it("hands the store dir to the shared worker gid", () => {
    if (selfUid === undefined || selfGid === undefined) return; // not POSIX — skip
    process.env.SHIPIT_SESSION_WORKER_UID = String(selfGid);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    const storeDir = path.join(tmpDir, "pnpm-store", "deadbeefcafe0002");
    const spy = vi.spyOn(fs, "lchownSync");
    expect(ensurePnpmStoreDir(storeDir)).toBe(true);
    // The OWNER is left alone (chowning the shared store to one session's uid
    // would take it from every other session) and only the group is set.
    expect(spy).toHaveBeenCalledWith(storeDir, selfUid, selfGid);
    spy.mockRestore();
  });

  // The store is SHARED, so most creations find the dir already there — a
  // create-only chown would leave every store that predates this fix root-owned.
  it("re-chowns an existing store dir (repairs one left root-owned by an earlier build)", () => {
    if (selfUid === undefined || selfGid === undefined) return; // not POSIX — skip
    process.env.SHIPIT_SESSION_WORKER_UID = String(selfGid);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    const storeDir = path.join(tmpDir, "pnpm-store", "deadbeefcafe0003");
    fs.mkdirSync(storeDir, { recursive: true });
    const spy = vi.spyOn(fs, "lchownSync");
    expect(ensurePnpmStoreDir(storeDir)).toBe(true);
    expect(spy).toHaveBeenCalledWith(storeDir, selfUid, selfGid);
    spy.mockRestore();
  });

  // Non-recursive by design — this runs on the container-create hot path, and
  // root-owned contents can only come from a root worker, which the entrypoint's
  // sentinel rotation already repairs on the first boot after the UID flips.
  it("walks the store contents ONCE, then skips on every later create", () => {
    // This test used to assert the opposite ("does not walk the store
    // contents"), and that assertion was the defect rather than the guard.
    // The non-recursive handoff was justified by the entrypoint's
    // `chown -R /workspace` walking the nested store — which docs/270 stopped
    // being true when it added `-path "$d/.pnpm-store" -prune`. Nothing was left
    // repairing a store POPULATED under a previous identity, so an upgraded
    // deployment handed every new session a store it could read and not write.
    //
    // The walk is what makes req 9 hold; the marker is what keeps it off the
    // container-create hot path. Both halves are asserted, because either one
    // alone is a bug: no walk is the original defect, and an ungated walk is the
    // multi-gigabyte cost the original was avoiding.
    if (selfGid === undefined) return; // not POSIX — skip
    process.env.SHIPIT_SESSION_WORKER_UID = String(selfGid);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    const storeDir = path.join(tmpDir, "pnpm-store", "deadbeefcafe0004");
    fs.mkdirSync(path.join(storeDir, "files", "00"), { recursive: true });
    fs.writeFileSync(path.join(storeDir, "files", "00", "abc"), "x");

    const first = vi.spyOn(fs, "lchownSync");
    ensurePnpmStoreDir(storeDir);
    // root + files/ + files/00/ + the file itself, i.e. the contents really are
    // reached — the old behaviour was exactly 1 (the root alone).
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

  // `chownToSessionWorker` logs and swallows — right for the writers it was built
  // for, fatal here, because a silently-failed handoff is exactly the root-owned
  // mount the agent cannot recover from. So the result is VERIFIED, and a failed
  // handoff reports false rather than "probably fine".
  it("reports false when the handoff did not take (mount must be dropped)", () => {
    const myUid = process.getuid?.();
    if (myUid === undefined) return; // not POSIX — skip
    process.env.SHIPIT_SESSION_WORKER_UID = String(myUid + 1);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    const storeDir = path.join(tmpDir, "pnpm-store", "deadbeefcafe0006");
    // Stand in for the swallowed EPERM — deterministic whether or not the test
    // process happens to be privileged enough for the real chown to succeed.
    const spy = vi.spyOn(fs, "lchownSync").mockImplementation(() => {});
    expect(ensurePnpmStoreDir(storeDir)).toBe(false);
    spy.mockRestore();
  });

  it("reports false when the store dir cannot be created", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-"));
    // A regular file where the store dir's parent must be — mkdir -p fails ENOTDIR.
    const blocker = path.join(tmpDir, "pnpm-store");
    fs.writeFileSync(blocker, "not a dir");
    expect(ensurePnpmStoreDir(path.join(blocker, "deadbeefcafe0007"))).toBe(false);
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

  // #1666 — also reconcile root-owned tool caches inside dep dirs, which the
  // worktree handback excludes.
  it("reconciles the workspace dep dirs on a non-overlay session", () => {
    const handBack = vi.fn();
    const reconcile = vi.fn();
    selfHealWorkspaceOwnership({ workspaceDir: WS_DIR }, WS_VOLUME, handBack, reconcile);
    // No shipit.yaml at WS_DIR → falls back to DEFAULT_DEP_DIRS (["node_modules"]).
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
    // The plain workspace dep dir is NOT reconciled in overlay mode.
    expect(reconcile).not.toHaveBeenCalledWith(`${WS_DIR}/node_modules`);
  });

  it("does not reconcile dep dirs in dev bind-mount mode (no workspaceVolume)", () => {
    const handBack = vi.fn();
    const reconcile = vi.fn();
    selfHealWorkspaceOwnership({ workspaceDir: WS_DIR }, undefined, handBack, reconcile);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
