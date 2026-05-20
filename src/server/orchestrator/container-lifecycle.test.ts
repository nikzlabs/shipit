/**
 * Unit tests for container-lifecycle functions (buildMounts, buildEnv, buildContainerConfig).
 */

import { describe, it, expect } from "vitest";
import {
  buildMounts,
  buildEnv,
  buildContainerConfig,
  DEP_CACHE_CONTAINER_PATH,
} from "./container-lifecycle.js";
import type { ContainerConfig } from "./session-container.js";

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
