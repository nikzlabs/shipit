/**
 * Unit tests for the sub-agent spawn service (docs/144). Exercises the
 * authorization gates (setting, auth, pin, recursion, per-turn cap), the happy
 * path (spawn → usage attribution → chips), and the sign-out credential sweep,
 * using lightweight stubs so no container/worker is involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSubAgent, sweepSubAgentCredentialsOnSignOut, SUB_AGENT_PER_TURN_CAP } from "./sub-agent.js";
import { ServiceError } from "./types.js";
import type { SubAgentRunResult } from "../../shared/sub-agent-run.js";
import {
  perSessionCredentialsDir,
  provisionSubAgentCredentials,
} from "../session-credentials.js";

interface FakeSession {
  id: string;
  agentId?: string;
  agentPinned?: boolean;
}

function makeDeps(opts: {
  enableSubAgents?: boolean;
  session?: FakeSession | null;
  sessions?: FakeSession[];
  authConfigured?: boolean;
  agentKnown?: boolean;
  subAgentSpawnsThisTurn?: number;
  spawnResult?: SubAgentRunResult;
  runnerPresent?: boolean;
}) {
  const session: FakeSession | null =
    opts.session === undefined ? { id: "s1", agentId: "claude", agentPinned: true } : opts.session;
  const emitMessage = vi.fn();
  const record = vi.fn();
  const runner = {
    subAgentSpawnsThisTurn: opts.subAgentSpawnsThisTurn ?? 0,
    emitMessage,
    spawnSubAgent: vi.fn(async () =>
      opts.spawnResult ?? { status: "success", text: "2 bugs found", truncated: false, durationMs: 4200, costUsd: 0.03 },
    ),
  };
  const deps = {
    sessionManager: {
      get: vi.fn((id: string) => (session?.id === id ? session : undefined)),
      list: vi.fn(() => opts.sessions ?? []),
    } as never,
    credentialStore: { getEnableSubAgents: () => opts.enableSubAgents ?? true } as never,
    agentRegistry: {
      refreshAuth: vi.fn(),
      get: vi.fn(() => (opts.agentKnown === false ? undefined : { name: "Codex", authConfigured: opts.authConfigured ?? true })),
    } as never,
    runnerRegistry: { get: vi.fn(() => (opts.runnerPresent === false ? undefined : runner)) } as never,
    usageManager: { record } as never,
  };
  return { deps, runner, emitMessage, record };
}

async function expectServiceError(p: Promise<unknown>, status: number): Promise<ServiceError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).statusCode).toBe(status);
    return err as ServiceError;
  }
  throw new Error(`expected a ServiceError ${status}, but none was thrown`);
}

describe("runSubAgent — authorization gates", () => {
  it("rejects when the setting is off (403) and never spawns", async () => {
    const { deps, runner } = makeDeps({ enableSubAgents: false });
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }), 403);
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
  });

  it("rejects an unknown agent (400)", async () => {
    const { deps } = makeDeps({ agentKnown: false });
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }), 400);
  });

  it("rejects an unauthed agent (400)", async () => {
    const { deps } = makeDeps({ authConfigured: false });
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }), 400);
  });

  it("rejects a pre-pin session (409)", async () => {
    const { deps } = makeDeps({ session: { id: "s1", agentId: "claude", agentPinned: false } });
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }), 409);
  });

  it("rejects a non-zero depth — recursion guard (403)", async () => {
    const { deps, runner } = makeDeps({});
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 1 }), 403);
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
  });

  it("rejects past the per-turn cap (429) without spawning", async () => {
    const { deps, runner } = makeDeps({ subAgentSpawnsThisTurn: SUB_AGENT_PER_TURN_CAP });
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }), 429);
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
  });

  it("rejects an empty prompt (400)", async () => {
    const { deps } = makeDeps({});
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "   ", depth: 0 }), 400);
  });
});

describe("runSubAgent — happy path", () => {
  it("spawns, returns text, increments the per-turn counter, records usage, emits chips", async () => {
    const { deps, runner, emitMessage, record } = makeDeps({});
    const res = await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review this", depth: 0 });

    expect(res.text).toBe("2 bugs found");
    expect(res.subAgentId).toBe("codex");
    expect(runner.subAgentSpawnsThisTurn).toBe(1);
    expect(runner.spawnSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "codex", prompt: "review this", depth: 0 }),
    );
    // usage attributed to the sub-agent, not the pinned agent
    expect(record).toHaveBeenCalledWith("s1", 0.03, 4200, undefined, undefined, { subAgentId: "codex" });
    // running chip then done chip
    const phases = emitMessage.mock.calls.map((c) => (c[0] as { type: string; phase: string }));
    expect(phases[0]).toMatchObject({ type: "sub_agent_spawn", phase: "running", subAgentId: "codex" });
    expect(phases[1]).toMatchObject({ type: "sub_agent_spawn", phase: "done", status: "success" });
  });

  it("allows a same-provider spawn (no extra credentials needed)", async () => {
    // session pinned to claude, sub-agent also claude → no cross-provider window
    const { deps, runner } = makeDeps({ session: { id: "s1", agentId: "claude", agentPinned: true } });
    const res = await runSubAgent(deps, "s1", { subAgentId: "claude", prompt: "draft tests", depth: 0 });
    expect(res.status).toBe("success");
    expect(runner.spawnSubAgent).toHaveBeenCalled();
  });

  it("counts the spawn against the budget up to the cap across calls", async () => {
    const { deps, runner } = makeDeps({});
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "a", depth: 0 });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "b", depth: 0 });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "c", depth: 0 });
    expect(runner.subAgentSpawnsThisTurn).toBe(3);
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "d", depth: 0 }), 429);
  });
});

describe("sweepSubAgentCredentialsOnSignOut", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-creds-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("wipes cross-agent creds from sessions where the agent is NOT pinned, leaves pinned ones", () => {
    // Seed a fake source-of-truth .codex subtree so provisioning has something to copy.
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "auth.json"), "{}");

    // Session A is pinned to claude (codex would be a sub-agent) → provisioned codex subtree.
    provisionSubAgentCredentials(root, "sessA", "codex");
    // Session B is pinned to codex → it legitimately holds .codex; must NOT be wiped.
    provisionSubAgentCredentials(root, "sessB", "codex");

    const dirA = path.join(perSessionCredentialsDir(root, "sessA"), ".codex");
    const dirB = path.join(perSessionCredentialsDir(root, "sessB"), ".codex");
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(true);

    const sessionManager = {
      list: () => [
        { id: "sessA", agentId: "claude" },
        { id: "sessB", agentId: "codex" },
      ],
    } as never;

    sweepSubAgentCredentialsOnSignOut("codex", { sessionManager, credentialsDir: root });

    expect(fs.existsSync(dirA)).toBe(false); // swept (codex not pinned here)
    expect(fs.existsSync(dirB)).toBe(true); // preserved (codex is the pinned agent)
  });

  it("is a no-op without a credentialsDir (local mode)", () => {
    const sessionManager = { list: () => [{ id: "sessA", agentId: "claude" }] } as never;
    expect(() => sweepSubAgentCredentialsOnSignOut("codex", { sessionManager })).not.toThrow();
  });
});
