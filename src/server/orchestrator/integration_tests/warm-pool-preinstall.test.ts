/**
 * Focused integration test for the warm-pool `runPreInstall` helper.
 *
 * The warm pool boots a standby container per ready repo. With pre-install
 * wired in (this branch), it then fires `agent.install` on the standby's
 * worker so the user doesn't pay install latency on activation. This test
 * exercises the helper against a real Fastify worker — the same code path
 * production hits — without needing Docker or the full warm-pool stack.
 *
 * Companion test: `session-worker.test.ts > joins an in-flight install
 * instead of failing the second caller` covers the worker side of the
 * race where the user claims a standby mid pre-install.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { SessionWorker } from "../../session/session-worker.js";
import { runPreInstall } from "../warm-pool-manager.js";
import type { AgentProcess, AgentProcessEvents, AgentId, AgentRunParams, PermissionMode } from "../../shared/types.js";

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
  let worker: SessionWorker;
  let workerUrl: string;

  beforeEach(async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-preinstall-test-"));
    worker = new SessionWorker({
      agentFactory: () => new FakeAgent(),
      port: 0,
      host: "127.0.0.1",
      workspaceDir,
    });
    const addr = await worker.start();
    const match = /:(\d+)$/.exec(addr);
    workerUrl = `http://127.0.0.1:${match ? Number(match[1]) : 0}`;
  });

  afterEach(async () => {
    await worker.stop();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("is a no-op when shipit.yaml is absent (no install commands)", async () => {
    await runPreInstall(workspaceDir, workerUrl, "test");
    // No marker should have been written.
    expect(fs.existsSync(path.join(workspaceDir, ".shipit", ".install-done"))).toBe(false);
  });

  it("runs declared agent.install commands and writes the marker", async () => {
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      "agent:\n  install:\n    - 'true'\n",
    );

    await runPreInstall(workspaceDir, workerUrl, "test");

    // Marker means the worker ran the command(s) to completion. The
    // on-activation `runner.runInstall()` will hit this same workspace
    // (it's bind-mounted from the host), see the marker, and short-circuit
    // with `{ skipped: true }` — that's the user-visible "instant" path.
    expect(fs.existsSync(path.join(workspaceDir, ".shipit", ".install-done"))).toBe(true);
  });

  it("doesn't throw when shipit.yaml is malformed (best-effort)", async () => {
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), "agent: [not, valid, schema\n");
    // The helper must swallow the parse error — a broken shipit.yaml in the
    // warm path must NOT bring down the warming flow. The on-activation
    // path will surface it via the standard `compose_error` channel.
    await expect(runPreInstall(workspaceDir, workerUrl, "test")).resolves.toBeUndefined();
  });
});
