import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { resolveAgentDockerLimits, deriveSessionMemorySizing } from "./session-container.js";
import { expectInvalidShipitConfig } from "../shared/shipit-config-test-guard.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const CPU_PERIOD = 100_000;
const PIDS_LIMIT = 8192;

const realReadFileSync = fs.readFileSync;

// Stub cgroups too, so container limits cannot override the simulated host.
function stubHost(totalMemBytes = 96 * GIB, cores = 16): void {
  vi.spyOn(os, "totalmem").mockReturnValue(totalMemBytes);
  vi.spyOn(os, "cpus").mockReturnValue(new Array(cores).fill({}) as ReturnType<typeof os.cpus>);
  vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof p === "string" && p.startsWith("/sys/fs/cgroup")) {
      throw new Error("ENOENT (stubbed: no cgroup limit)");
    }
    return (realReadFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync);
}

beforeEach(() => stubHost());
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DEFAULT_SESSION_MEMORY_MB;
  delete process.env.MAX_SESSION_MEMORY_MB;
});

describe("deriveSessionMemorySizing", () => {
  it("derives ~43 GiB/session on a 96 GB host (fraction binds, under ceiling)", () => {
    stubHost(96 * GIB);
    const s = deriveSessionMemorySizing();
    expect(s.hostMb).toBe(98304);
    expect(s.reserveMb).toBe(9830);
    expect(s.usableMb).toBe(88474);
    expect(s.effectiveMb).toBe(44237);
    expect(s.baselineSource).toBe("auto");
    expect(s.capApplied).toBe(false);
  });

  it("floors at 4 GiB on an 8 GB host (FLOOR governs)", () => {
    stubHost(8 * GIB);
    expect(deriveSessionMemorySizing().effectiveMb).toBe(4096);
  });

  it("gives half the usable budget on a 16 GB host (fraction clears the FLOOR)", () => {
    stubHost(16 * GIB);
    const s = deriveSessionMemorySizing();
    expect(s.usableMb).toBe(14336);
    expect(s.effectiveMb).toBe(7168);
  });

  it("pins to usable on a host smaller than the FLOOR (4 GB → 2 GiB usable)", () => {
    stubHost(4 * GIB);
    const s = deriveSessionMemorySizing();
    expect(s.usableMb).toBe(2048);
    expect(s.effectiveMb).toBe(2048);
  });

  it("falls back to BOOT_MIN on a host too small to honor any usable budget", () => {
    stubHost(512 * MIB);
    const s = deriveSessionMemorySizing();
    expect(s.usableMb).toBe(0);
    expect(s.effectiveMb).toBe(1536);
  });

  it("caps at the 48 GiB ceiling on a very large host", () => {
    stubHost(1024 * GIB);
    expect(deriveSessionMemorySizing().effectiveMb).toBe(49152);
  });

  it("DEFAULT_SESSION_MEMORY_MB overrides the auto baseline", () => {
    stubHost(96 * GIB);
    process.env.DEFAULT_SESSION_MEMORY_MB = "8000";
    const s = deriveSessionMemorySizing();
    expect(s.effectiveMb).toBe(8000);
    expect(s.baselineSource).toBe("DEFAULT_SESSION_MEMORY_MB");
  });

  it("MAX_SESSION_MEMORY_MB clamps the baseline down and flags capApplied", () => {
    stubHost(96 * GIB);
    process.env.MAX_SESSION_MEMORY_MB = "2000";
    const s = deriveSessionMemorySizing();
    expect(s.effectiveMb).toBe(2000);
    expect(s.capSource).toBe("MAX_SESSION_MEMORY_MB");
    expect(s.capApplied).toBe(true);
  });

  it("the host budget caps an over-large DEFAULT (can't exceed usable)", () => {
    stubHost(8 * GIB);
    process.env.DEFAULT_SESSION_MEMORY_MB = "100000";
    const s = deriveSessionMemorySizing();
    expect(s.effectiveMb).toBe(6144);
    expect(s.capApplied).toBe(true);
  });

  it("prefers a cgroup limit set below host RAM", () => {
    vi.spyOn(os, "totalmem").mockReturnValue(96 * GIB);
    vi.spyOn(os, "cpus").mockReturnValue(new Array(16).fill({}) as ReturnType<typeof os.cpus>);
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (p === "/sys/fs/cgroup/memory.max") return `${8 * GIB}`;
      if (typeof p === "string" && p.startsWith("/sys/fs/cgroup")) throw new Error("ENOENT");
      throw new Error("unexpected read");
    }) as typeof fs.readFileSync);
    const s = deriveSessionMemorySizing();
    expect(s.hostMb).toBe(8192);
    expect(s.effectiveMb).toBe(4096);
  });

  it("ignores the cgroup v2 'max' unlimited sentinel", () => {
    vi.spyOn(os, "totalmem").mockReturnValue(8 * GIB);
    vi.spyOn(os, "cpus").mockReturnValue(new Array(4).fill({}) as ReturnType<typeof os.cpus>);
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (p === "/sys/fs/cgroup/memory.max") return "max";
      if (typeof p === "string" && p.startsWith("/sys/fs/cgroup")) throw new Error("ENOENT");
      throw new Error("unexpected read");
    }) as typeof fs.readFileSync);
    expect(deriveSessionMemorySizing().hostMb).toBe(8192);
  });
});

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
  });

  it("auto-sizes memory and host-core CPU when shipit.yaml is missing", () => {
    stubHost(96 * GIB, 16);
    const dir = setup();
    const limits = resolveAgentDockerLimits(dir);
    expect(limits.memoryLimit).toBe(44237 * MIB);
    expect(limits.cpuQuota).toBe(16 * CPU_PERIOD);
    expect(limits.pidsLimit).toBe(PIDS_LIMIT);
    expect(limits.dockerAccess).toBe(false);
  });

  it("ignores removed repo resource fields — memory is host-derived, not 3072", () => {
    stubHost(96 * GIB);
    const dir = setup();
    write(dir, "agent:\n  memory: 3072\n  cpu: 2.0\n  pids: 2048\n");
    const limits = resolveAgentDockerLimits(dir);
    expect(limits.memoryLimit).toBe(44237 * MIB);
    expect(limits.pidsLimit).toBe(PIDS_LIMIT);
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

  it("auto-sizes on a YAML parse error", () => {
    stubHost(96 * GIB);
    const dir = setup();
    expectInvalidShipitConfig(() => {
      write(dir, "agent: not_a_mapping\n");
    });
    expect(resolveAgentDockerLimits(dir).memoryLimit).toBe(44237 * MIB);
  });

  it("ignores old-format `resources:` block (auto-sizes regardless)", () => {
    stubHost(96 * GIB);
    const dir = setup();
    write(dir, "resources:\n  memory: 3072\n");
    expect(resolveAgentDockerLimits(dir).memoryLimit).toBe(44237 * MIB);
  });

  it("ignores old-format `capabilities.docker: true`", () => {
    const dir = setup();
    write(dir, "capabilities:\n  docker: true\n");
    expect(resolveAgentDockerLimits(dir).dockerAccess).toBe(false);
  });
});
