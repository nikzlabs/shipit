import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalBackgroundHarnessRunner } from "./background-harness-run.js";
import { CLEANUP_CONTAINER_SESSION_ID } from "./cleanup-container.js";
import { SUB_AGENT_HOME_SUBDIR } from "./session-credentials-scaffold.js";
import type { AgentProcess, AgentRunParams } from "../shared/types.js";

let agentsReadEnv: (() => void) | null = null;

class FakeAgent extends EventEmitter {
  readonly agentId = "claude" as const;
  lastParams: AgentRunParams | null = null;
  killed = 0;
  // Real adapters read the routed credential out of the environment here.
  run(params: AgentRunParams): void { this.lastParams = params; agentsReadEnv?.(); }
  writeStdin(): void {}
  kill(): void { this.killed += 1; setImmediate(() => this.emit("done", 0)); }
  interrupt(): void {}
}

/**
 * docs/299 — `RUNTIME_MODE=local` has no container manager at all, so a
 * harness-execution choice has no cleanup container to spawn into. Local cleanup
 * had no harness path before this, which is why it is tested rather than assumed.
 */
describe("LocalBackgroundHarnessRunner", () => {
  let credentialsDir: string;
  let agents: FakeAgent[];

  function makeRunner(): LocalBackgroundHarnessRunner {
    return new LocalBackgroundHarnessRunner({
      agentFactory: () => {
        const a = new FakeAgent();
        agents.push(a);
        return a as unknown as AgentProcess;
      },
      credentialsDir,
      sessionId: CLEANUP_CONTAINER_SESSION_ID,
    });
  }

  beforeEach(() => {
    agents = [];
    agentsReadEnv = null;
    credentialsDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-bg-harness-"));
  });

  afterEach(() => { fs.rmSync(credentialsDir, { recursive: true, force: true }); });

  it("runs the harness with tools off, outside any repository", async () => {
    const runner = makeRunner();
    const run = runner.run({ harnessId: "claude", prompt: "clean this up", model: "haiku" });
    await vi.waitFor(() => { expect(agents).toHaveLength(1); });

    expect(agents[0]!.lastParams?.toolsOff).toBe(true);
    expect(agents[0]!.lastParams?.cwd).toBe(os.tmpdir());
    expect(agents[0]!.lastParams?.model).toBe("haiku");
    expect(String(agents[0]!.lastParams?.homeDir)).toContain(SUB_AGENT_HOME_SUBDIR);

    agents[0]!.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "cleaned up" }],
    });
    agents[0]!.emit("done", 0);
    expect((await run).text).toBe("cleaned up");
  });

  // The orchestrator process has no routed credential in its own environment
  // either, so the value has to be delivered around the synchronous run().
  it("delivers the routed credential for exactly the span that reads it", async () => {
    const runner = makeRunner();
    let seen: string | undefined = "not-read";
    agentsReadEnv = () => { seen = process.env.SHIPIT_CRED_ANTHROPIC; };

    const run = runner.run({
      harnessId: "claude",
      prompt: "clean this up",
      model: "haiku",
      serviceRouting: { credentialSourceEnv: "SHIPIT_CRED_ANTHROPIC" } as never,
      credentialSecret: "sk-secret",
    });
    await vi.waitFor(() => { expect(agents).toHaveLength(1); });

    expect(seen).toBe("sk-secret");
    expect(process.env.SHIPIT_CRED_ANTHROPIC).toBeUndefined();
    agents[0]!.emit("done", 0);
    await run;
  });

  it("releases the spawn home once the run ends", async () => {
    const runner = makeRunner();
    const run = runner.run({ harnessId: "claude", prompt: "clean this up", model: "haiku" });
    await vi.waitFor(() => { expect(agents).toHaveLength(1); });
    agents[0]!.emit("done", 0);
    await run;

    const homes = path.join(credentialsDir, "sessions", CLEANUP_CONTAINER_SESSION_ID, SUB_AGENT_HOME_SUBDIR);
    expect(fs.readdirSync(homes)).toEqual([]);
  });

  it("cancels the CLI when the caller abandons the run", async () => {
    const runner = makeRunner();
    const controller = new AbortController();
    const run = runner.run({
      harnessId: "claude", prompt: "clean this up", model: "haiku", signal: controller.signal,
    });
    await vi.waitFor(() => { expect(agents).toHaveLength(1); });

    controller.abort();
    const result = await run;

    expect(result.status).toBe("cancelled");
    expect(agents[0]!.killed).toBeGreaterThan(0);
  });

  it("does not start a run that was abandoned before it began", async () => {
    const runner = makeRunner();
    const result = await runner.run({
      harnessId: "claude", prompt: "clean this up", model: "haiku", signal: AbortSignal.abort(),
    });

    expect(result.status).toBe("error");
    expect(agents).toHaveLength(0);
  });
});
