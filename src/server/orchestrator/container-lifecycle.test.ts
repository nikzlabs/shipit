/**
 * Unit tests for container-lifecycle functions (buildMounts, buildEnv, buildContainerConfig).
 */

import { describe, it, expect } from "vitest";
import {
  buildMounts,
  buildEnv,
  buildOrchestratorCallbackEnv,
  buildContainerConfig,
  DEP_CACHE_CONTAINER_PATH,
  OPS_DOCKER_HOST,
} from "./container-lifecycle.js";
import type { ContainerConfig } from "./session-container.js";
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
  // `/tmp` exists on every test host; the bogus path does not. The gate only
  // binds sources that actually exist, so these two stand in for "journal
  // present" vs "journal absent".
  const presentMount: HostMount = { source: "/tmp", target: "/var/log/journal", readOnly: true };
  const absentMount: HostMount = {
    source: "/nonexistent-shipit-ops-test-path-xyz",
    target: "/run/log/journal",
    readOnly: true,
  };

  it("binds existing host paths read-only when opsSession is true", () => {
    const config = baseConfig({ opsSession: true, hostMounts: [presentMount] });
    const result = buildMounts(config, undefined, undefined);
    expect(result.hostBinds).toContain("/tmp:/var/log/journal:ro");
  });

  it("SECURITY: drops host mounts when opsSession is false even if hostMounts is forged", () => {
    // Simulates a non-ops session whose user-controlled shipit.yaml declared
    // host mounts. The server gate keys off kind, not the workspace file, so
    // `opsSession` is falsy here and nothing is bound.
    const config = baseConfig({ opsSession: false, hostMounts: [presentMount] });
    const result = buildMounts(config, undefined, undefined);
    expect(result.hostBinds).toHaveLength(0);
  });

  it("SECURITY: drops host mounts when opsSession is undefined", () => {
    const config = baseConfig({ hostMounts: [presentMount] });
    const result = buildMounts(config, undefined, undefined);
    expect(result.hostBinds).toHaveLength(0);
  });

  it("skips a declared host mount whose source path does not exist", () => {
    const config = baseConfig({ opsSession: true, hostMounts: [presentMount, absentMount] });
    const result = buildMounts(config, undefined, undefined);
    expect(result.hostBinds).toContain("/tmp:/var/log/journal:ro");
    expect(result.hostBinds.some((b) => b.includes("nonexistent"))).toBe(false);
  });

  it("produces no host binds for an ops session with no declared mounts", () => {
    const config = baseConfig({ opsSession: true });
    const result = buildMounts(config, undefined, undefined);
    expect(result.hostBinds).toHaveLength(0);
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

  it("docs/128: dockerAccess (read-write proxy) takes precedence over the ops branch", () => {
    // A session can't be both, but if both flags were set the read-write proxy
    // path wins and the ops read-only host must not be applied.
    const config = baseConfig({ dockerAccess: true, opsSession: true });
    const env = buildEnv(config, "/workspace", 9100, "docker-proxy", 2375);
    expect(env).toContain("DOCKER_HOST=tcp://docker-proxy:2375");
    expect(env).not.toContain(`DOCKER_HOST=${OPS_DOCKER_HOST}`);
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
});
