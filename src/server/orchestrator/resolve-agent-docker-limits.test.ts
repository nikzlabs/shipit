/**
 * Tests for `resolveAgentDockerLimits` — the single bridge between
 * `shipit.yaml`'s `agent` block and the cgroup limits handed to Docker.
 *
 * Covers the env-var clamp (MAX_SESSION_*), the new-format happy path, the
 * graceful fallback when shipit.yaml is missing or malformed, and the
 * silent-default behaviour for old-format yaml (`resources:` /
 * `capabilities:`) which the new parser no longer extracts values from.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { resolveAgentDockerLimits, applyEnvCaps } from "./session-container.js";
import { AGENT_DEFAULTS } from "../shared/shipit-config.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_MEMORY_BYTES = 1536 * MIB; // shipit-config.ts AGENT_DEFAULTS.memory
const DEFAULT_CPU_QUOTA = Math.round(0.5 * 100_000);
const DEFAULT_PIDS = 4096;

// Pin host detection so the host-relative default ceilings (used whenever a
// MAX_SESSION_* env var is unset) are deterministic regardless of the CI
// runner's actual RAM / core count. Individual tests re-stub for the cases
// that specifically exercise host-derived defaults.
function stubHost(totalMemBytes = 64 * GIB, cores = 16): void {
  vi.spyOn(os, "totalmem").mockReturnValue(totalMemBytes);
  vi.spyOn(os, "cpus").mockReturnValue(
    new Array(cores).fill({}) as ReturnType<typeof os.cpus>,
  );
}

beforeEach(() => stubHost());
afterEach(() => vi.restoreAllMocks());

describe("resolveAgentDockerLimits", () => {
  let tmpDir: string;

  function setup(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-docker-limits-"));
    return tmpDir;
  }

  function write(dir: string, yaml: string): void {
    fs.writeFileSync(path.join(dir, "shipit.yaml"), yaml);
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MAX_SESSION_MEMORY_MB;
    delete process.env.MAX_SESSION_CPU;
    delete process.env.MAX_SESSION_PIDS;
  });

  it("returns library defaults when shipit.yaml is missing", () => {
    const dir = setup();
    const limits = resolveAgentDockerLimits(dir);
    expect(limits.memoryLimit).toBe(DEFAULT_MEMORY_BYTES);
    expect(limits.cpuQuota).toBe(DEFAULT_CPU_QUOTA);
    expect(limits.pidsLimit).toBe(DEFAULT_PIDS);
    expect(limits.dockerAccess).toBe(false);
  });

  it("maps agent block to Docker units", () => {
    const dir = setup();
    write(dir, "agent:\n  memory: 3072\n  cpu: 2.0\n  pids: 2048\n");
    const limits = resolveAgentDockerLimits(dir);
    expect(limits.memoryLimit).toBe(3072 * MIB);
    expect(limits.cpuQuota).toBe(200_000);
    expect(limits.pidsLimit).toBe(2048);
  });

  it("grants docker access only when compose.docker-socket is true", () => {
    const dir = setup();
    write(dir, "agent:\n  memory: 1024\ncompose:\n  file: docker-compose.yml\n  docker-socket: true\n");
    expect(resolveAgentDockerLimits(dir).dockerAccess).toBe(true);
  });

  it("denies docker access when compose is a bare path", () => {
    const dir = setup();
    write(dir, "agent:\n  memory: 1024\ncompose: docker-compose.yml\n");
    expect(resolveAgentDockerLimits(dir).dockerAccess).toBe(false);
  });

  it("clamps memory to MAX_SESSION_MEMORY_MB", () => {
    process.env.MAX_SESSION_MEMORY_MB = "1024";
    const dir = setup();
    write(dir, "agent:\n  memory: 4096\n  cpu: 0.5\n  pids: 256\n");
    expect(resolveAgentDockerLimits(dir).memoryLimit).toBe(1024 * MIB);
  });

  it("clamps cpu and pids", () => {
    process.env.MAX_SESSION_CPU = "1";
    process.env.MAX_SESSION_PIDS = "512";
    const dir = setup();
    write(dir, "agent:\n  memory: 1024\n  cpu: 4.0\n  pids: 4096\n");
    const limits = resolveAgentDockerLimits(dir);
    expect(limits.cpuQuota).toBe(100_000);
    expect(limits.pidsLimit).toBe(512);
  });

  it("ignores requests already under the cap", () => {
    process.env.MAX_SESSION_MEMORY_MB = "8192";
    const dir = setup();
    write(dir, "agent:\n  memory: 2048\n");
    expect(resolveAgentDockerLimits(dir).memoryLimit).toBe(2048 * MIB);
  });

  it("falls back to defaults on YAML parse error", () => {
    const dir = setup();
    write(dir, "agent: not_a_mapping\n");
    const limits = resolveAgentDockerLimits(dir);
    expect(limits.memoryLimit).toBe(DEFAULT_MEMORY_BYTES);
    expect(limits.cpuQuota).toBe(DEFAULT_CPU_QUOTA);
    expect(limits.pidsLimit).toBe(DEFAULT_PIDS);
  });

  it("ignores old-format `resources:` block (regression — see ShipIt issue: silent 1 GiB OOMs)", () => {
    // The old parser used to read `resources.agent.memory`. Files that wrote
    // memory directly under `resources:` (no `.agent` nesting) silently
    // dropped to the 1 GiB default — `npm install` then OOM-killed under
    // the shipit-in-shipit dogfood. With the legacy parser removed,
    // `resources:` is a no-op key that emits a warning and the container
    // still boots on safe defaults rather than a fictitious 3072 limit.
    const dir = setup();
    write(dir, "resources:\n  memory: 3072\n  cpu: 2.0\n  pids: 2048\n");
    const limits = resolveAgentDockerLimits(dir);
    expect(limits.memoryLimit).toBe(DEFAULT_MEMORY_BYTES);
  });

  it("ignores old-format `capabilities.docker: true`", () => {
    const dir = setup();
    write(dir, "capabilities:\n  docker: true\n");
    expect(resolveAgentDockerLimits(dir).dockerAccess).toBe(false);
  });

  it("logs a warning to journalctl when an env cap actually shrinks a declared value", () => {
    // Silent clamping is what hid the production bug — the operator set
    // MAX_SESSION_MEMORY_MB lower than the repo's declaration, the cap
    // won quietly, the container OOM'd. Make sure the log line appears.
    process.env.MAX_SESSION_MEMORY_MB = "1024";
    const dir = setup();
    write(dir, "agent:\n  memory: 3072\n");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      resolveAgentDockerLimits(dir);
      const lines = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(lines.some((l) => l.includes("MAX_SESSION_MEMORY_MB") && l.includes("3072") && l.includes("1024"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not log when no cap is actually exceeded", () => {
    process.env.MAX_SESSION_MEMORY_MB = "8192";
    const dir = setup();
    write(dir, "agent:\n  memory: 2048\n");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      resolveAgentDockerLimits(dir);
      expect(warnSpy.mock.calls.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("host-relative default ceilings (no MAX_SESSION_* env set)", () => {
  let tmpDir: string;
  function setup(yaml: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-docker-host-"));
    fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), yaml);
    return tmpDir;
  }
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("honors a declaration within host capacity (the 6144-on-a-big-box case)", () => {
    stubHost(16 * GIB); // ceiling = 75% of 16 GiB = 12288 MiB
    const dir = setup("agent:\n  memory: 6144\n");
    // No flat 4096 ceiling: the legitimate 6144 declaration boots as-is.
    expect(resolveAgentDockerLimits(dir).memoryLimit).toBe(6144 * MIB);
  });

  it("defaults the memory ceiling to 75% of host RAM and clamps above it", () => {
    stubHost(8 * GIB); // ceiling = 75% of 8 GiB = 6144 MiB
    const dir = setup("agent:\n  memory: 7000\n");
    expect(resolveAgentDockerLimits(dir).memoryLimit).toBe(6144 * MIB);
  });

  it("floors the memory ceiling at the library default on a tiny host", () => {
    stubHost(512 * MIB); // 75% = 384 MiB, below AGENT_DEFAULTS.memory (1536)
    const dir = setup("agent:\n  memory: 2048\n");
    expect(resolveAgentDockerLimits(dir).memoryLimit).toBe(AGENT_DEFAULTS.memory * MIB);
  });

  it("defaults the CPU ceiling to the host core count and clamps above it", () => {
    stubHost(64 * GIB, 4); // 4 cores
    const dir = setup("agent:\n  memory: 1024\n  cpu: 8\n");
    expect(resolveAgentDockerLimits(dir).cpuQuota).toBe(4 * 100_000);
  });

  it("defaults the PID ceiling to a generous fork-bomb guard and clamps above it", () => {
    const dir = setup("agent:\n  memory: 1024\n  pids: 100000\n");
    expect(resolveAgentDockerLimits(dir).pidsLimit).toBe(8192);
  });

  it("clamp warning names the host, not the env var, when no env cap is set", () => {
    stubHost(4 * GIB); // ceiling = 3072 MiB
    const result = applyEnvCaps({
      agent: { ...AGENT_DEFAULTS, memory: 6000, install: [] },
      hostMounts: [],
      warnings: [],
    });
    expect(result.effective.memory).toBe(3072);
    expect(result.warnings[0]).toMatch(/available host memory/);
    expect(result.warnings[0]).not.toMatch(/MAX_SESSION_MEMORY_MB/);
  });
});

describe("applyEnvCaps", () => {
  afterEach(() => {
    delete process.env.MAX_SESSION_MEMORY_MB;
    delete process.env.MAX_SESSION_CPU;
    delete process.env.MAX_SESSION_PIDS;
  });

  function cfg(memory = 1024, cpu = 0.5, pids = 256) {
    return {
      agent: { ...AGENT_DEFAULTS, memory, cpu, pids, install: [] },
      hostMounts: [],
      warnings: [],
    };
  }

  it("returns declared values when no caps are exceeded", () => {
    process.env.MAX_SESSION_MEMORY_MB = "4096";
    const result = applyEnvCaps(cfg(3072, 2.0, 2048));
    expect(result.effective).toEqual({ memory: 3072, cpu: 2.0, pids: 2048, dockerAccess: false });
    expect(result.warnings).toEqual([]);
  });

  it("emits one warning per metric that was clamped", () => {
    process.env.MAX_SESSION_MEMORY_MB = "1024";
    process.env.MAX_SESSION_CPU = "1";
    process.env.MAX_SESSION_PIDS = "512";

    const result = applyEnvCaps(cfg(3072, 4.0, 4096));
    expect(result.effective).toEqual({ memory: 1024, cpu: 1, pids: 512, dockerAccess: false });
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toMatch(/agent\.memory 3072 MiB clamped to 1024 MiB by MAX_SESSION_MEMORY_MB/);
    expect(result.warnings[1]).toMatch(/MAX_SESSION_CPU/);
    expect(result.warnings[2]).toMatch(/MAX_SESSION_PIDS/);
  });

  it("propagates compose.docker-socket as dockerAccess", () => {
    const result = applyEnvCaps({
      agent: { ...AGENT_DEFAULTS, install: [] },
      compose: { file: "docker-compose.yml", dockerSocket: true },
      hostMounts: [],
      warnings: [],
    });
    expect(result.effective.dockerAccess).toBe(true);
  });
});
