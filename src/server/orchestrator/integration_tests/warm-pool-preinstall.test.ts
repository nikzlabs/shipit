import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { SessionWorker } from "../../session/session-worker.js";
import { runPreInstall } from "../warm-pool-manager.js";
import type { AgentProcess, AgentProcessEvents, AgentId, AgentRunParams, PermissionMode } from "../../shared/types.js";
import { expectInvalidShipitConfig } from "../../shared/shipit-config-test-guard.js";

class FakeAgent extends EventEmitter<AgentProcessEvents> implements AgentProcess {
  readonly agentId: AgentId = "claude";
  readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: [] as PermissionMode[],
    toolNames: [] as string[],
    models: [] as string[],
    supportsReview: true,
    supportsSteering: false,
    supportsCompaction: false,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };
  readonly isStreaming = false;
  run(_params: AgentRunParams): void { /* unused */ }
  writeStdin(_data: string): void { /* unused */ }
  sendUserMessage(_text: string): void { /* unused */ }
  interrupt(): void { /* unused */ }
  kill(): void { /* unused */ }
  writeMcpConfig(): { mcpConfigPath?: string; runtimeEnv?: Record<string, string>; cleanup?: () => void } {
    return {};
  }
}

describe("warm-pool runPreInstall", () => {
  let workspaceDir: string;
  let stateDir: string;
  let worker: SessionWorker;
  let workerUrl: string;

  beforeEach(async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-preinstall-test-"));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-preinstall-state-"));
    worker = new SessionWorker({
      agentFactory: () => new FakeAgent(),
      port: 0,
      host: "127.0.0.1",
      workspaceDir,
      stateDir,
    });
    const addr = await worker.start();
    const match = /:(\d+)$/.exec(addr);
    workerUrl = `http://127.0.0.1:${match ? Number(match[1]) : 0}`;
  });

  afterEach(async () => {
    await worker.stop();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("is a no-op when shipit.yaml is absent (no install commands)", async () => {
    await expect(runPreInstall(workspaceDir, workerUrl, "test")).resolves.toEqual({ settled: true });
    expect(fs.existsSync(path.join(stateDir, ".install-done"))).toBe(false);
  });

  it("runs declared agent.install commands and writes the marker", async () => {
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      "agent:\n  install:\n    - 'true'\n",
    );

    await expect(runPreInstall(workspaceDir, workerUrl, "test")).resolves.toEqual({ settled: true });

    expect(fs.existsSync(path.join(stateDir, ".install-done"))).toBe(true);
  });

  it("doesn't throw when shipit.yaml is malformed (best-effort)", async () => {
    expectInvalidShipitConfig(() => {
      fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), "agent: [not, valid, schema\n");
    });
    await expect(runPreInstall(workspaceDir, workerUrl, "test")).resolves.toEqual({ settled: false });
  });

  it("reports an install that FAILED as unsettled", async () => {
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      "agent:\n  install:\n    - 'exit 3'\n",
    );

    await expect(runPreInstall(workspaceDir, workerUrl, "test")).resolves.toEqual({ settled: false });
    expect(fs.existsSync(path.join(stateDir, ".install-done"))).toBe(false);
  });
});
