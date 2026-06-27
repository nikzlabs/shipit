/**
 * Tests for `resolveAgentDockerLimits` — the single bridge between
 * deployment-owned session limits and the cgroup limits handed to Docker.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { resolveAgentDockerLimits, applyEnvCaps } from "./session-container.js";
import { AGENT_DEFAULTS } from "../shared/shipit-config.js";

const MIB = 1024 * 1024;
const DEFAULT_MEMORY_BYTES = AGENT_DEFAULTS.memory * MIB;
const DEFAULT_CPU_QUOTA = Math.round(AGENT_DEFAULTS.cpu * 100_000);
const DEFAULT_PIDS = AGENT_DEFAULTS.pids;

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
    vi.restoreAllMocks();
  });

  it("returns deployment defaults when shipit.yaml is missing", () => {
    const dir = setup();
    const limits = resolveAgentDockerLimits(dir);
    expect(limits.memoryLimit).toBe(DEFAULT_MEMORY_BYTES);
    expect(limits.cpuQuota).toBe(DEFAULT_CPU_QUOTA);
    expect(limits.pidsLimit).toBe(DEFAULT_PIDS);
    expect(limits.dockerAccess).toBe(false);
  });

  it("uses deployment env vars for Docker resource units", () => {
    process.env.MAX_SESSION_MEMORY_MB = "3072";
    process.env.MAX_SESSION_CPU = "2";
    process.env.MAX_SESSION_PIDS = "2048";
    const dir = setup();
    const limits = resolveAgentDockerLimits(dir);
    expect(limits.memoryLimit).toBe(3072 * MIB);
    expect(limits.cpuQuota).toBe(200_000);
    expect(limits.pidsLimit).toBe(2048);
  });

  it("ignores repo-declared agent resource keys", () => {
    const dir = setup();
    write(dir, "agent:\n  memory: 3072\n  cpu: 2.0\n  pids: 2048\n");
    const limits = resolveAgentDockerLimits(dir);
    expect(limits.memoryLimit).toBe(DEFAULT_MEMORY_BYTES);
    expect(limits.cpuQuota).toBe(DEFAULT_CPU_QUOTA);
    expect(limits.pidsLimit).toBe(DEFAULT_PIDS);
  });

  it("logs compatibility warnings when repo resource keys are present", () => {
    const dir = setup();
    write(dir, "agent:\n  memory: 3072\n");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveAgentDockerLimits(dir);
    const lines = warnSpy.mock.calls.map((c) => c.join(" "));
    expect(lines.some((l) => l.includes("agent.memory") && l.includes("deprecated and ignored"))).toBe(true);
  });

  it("grants docker access only when compose.docker-socket is true", () => {
    const dir = setup();
    write(dir, "compose:\n  file: docker-compose.yml\n  docker-socket: true\n");
    expect(resolveAgentDockerLimits(dir).dockerAccess).toBe(true);
  });

  it("denies docker access when compose is a bare path", () => {
    const dir = setup();
    write(dir, "compose: docker-compose.yml\n");
    expect(resolveAgentDockerLimits(dir).dockerAccess).toBe(false);
  });

  it("falls back to defaults on YAML parse error", () => {
    const dir = setup();
    write(dir, "agent: not_a_mapping\n");
    const limits = resolveAgentDockerLimits(dir);
    expect(limits.memoryLimit).toBe(DEFAULT_MEMORY_BYTES);
    expect(limits.cpuQuota).toBe(DEFAULT_CPU_QUOTA);
    expect(limits.pidsLimit).toBe(DEFAULT_PIDS);
  });

  it("ignores old-format `resources:` block", () => {
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
});

describe("applyEnvCaps", () => {
  afterEach(() => {
    delete process.env.MAX_SESSION_MEMORY_MB;
    delete process.env.MAX_SESSION_CPU;
    delete process.env.MAX_SESSION_PIDS;
  });

  it("returns deployment defaults when env vars are unset", () => {
    const result = applyEnvCaps({
      agent: { ...AGENT_DEFAULTS, install: [] },
      hostMounts: [],
      warnings: [],
    });
    expect(result.effective).toEqual({
      memory: AGENT_DEFAULTS.memory,
      cpu: AGENT_DEFAULTS.cpu,
      pids: AGENT_DEFAULTS.pids,
      dockerAccess: false,
    });
    expect(result.warnings).toEqual([]);
  });

  it("returns deployment env var values when set", () => {
    process.env.MAX_SESSION_MEMORY_MB = "4096";
    process.env.MAX_SESSION_CPU = "1.5";
    process.env.MAX_SESSION_PIDS = "512";

    const result = applyEnvCaps({
      agent: { ...AGENT_DEFAULTS, install: [] },
      hostMounts: [],
      warnings: [],
    });
    expect(result.effective).toEqual({ memory: 4096, cpu: 1.5, pids: 512, dockerAccess: false });
    expect(result.warnings).toEqual([]);
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
