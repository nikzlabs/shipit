/**
 * Integration test for session config → container resource override flow.
 *
 * Verifies that shipit.yaml resources and capabilities are read by the
 * orchestrator and passed through to SessionContainerManager.buildConfig().
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveSessionConfig } from "./session-config.js";

describe("session config → container resource flow", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-config-int-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MAX_SESSION_MEMORY_MB;
    delete process.env.MAX_SESSION_CPU;
    delete process.env.MAX_SESSION_PIDS;
  });

  it("transforms session config into container resource parameters", () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      [
        "capabilities:",
        "  docker: true",
        "resources:",
        "  memory: 2048",
        "  cpu: 2.0",
        "  pids: 1024",
        "preview:",
        "  command: npm run dev",
      ].join("\n"),
    );

    const config = resolveSessionConfig(dir);

    // Simulate what the orchestrator runner factory does:
    const memoryLimitBytes = config.resources.memory * 1024 * 1024;
    const cpuQuotaMicros = Math.round(config.resources.cpu * 100_000);
    const pidsLimit = config.resources.pids;

    expect(memoryLimitBytes).toBe(2048 * 1024 * 1024);
    expect(cpuQuotaMicros).toBe(200_000);
    expect(pidsLimit).toBe(1024);
    expect(config.capabilities.docker).toBe(true);
  });

  it("applies deployment caps to container resources", () => {
    const dir = setup();
    process.env.MAX_SESSION_MEMORY_MB = "1024";
    process.env.MAX_SESSION_CPU = "1";
    process.env.MAX_SESSION_PIDS = "512";

    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      [
        "resources:",
        "  memory: 4096",
        "  cpu: 4.0",
        "  pids: 2048",
        "preview:",
        "  command: npm run dev",
      ].join("\n"),
    );

    const config = resolveSessionConfig(dir);

    const memoryLimitBytes = config.resources.memory * 1024 * 1024;
    const cpuQuotaMicros = Math.round(config.resources.cpu * 100_000);
    const pidsLimit = config.resources.pids;

    // Should be capped at deployment limits
    expect(memoryLimitBytes).toBe(1024 * 1024 * 1024);
    expect(cpuQuotaMicros).toBe(100_000);
    expect(pidsLimit).toBe(512);
  });

  it("uses defaults when shipit.yaml has no resources", () => {
    const dir = setup();
    // No shipit.yaml at all

    const config = resolveSessionConfig(dir);

    const memoryLimitBytes = config.resources.memory * 1024 * 1024;
    const cpuQuotaMicros = Math.round(config.resources.cpu * 100_000);

    expect(memoryLimitBytes).toBe(512 * 1024 * 1024);
    expect(cpuQuotaMicros).toBe(50_000);
    expect(config.resources.pids).toBe(256);
    expect(config.capabilities.docker).toBe(false);
  });
});
