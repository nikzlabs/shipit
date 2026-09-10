import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import { executeAgentTurn } from "./turn-executor.js";
import { postTurnCommit } from "./ws-handlers/post-turn.js";
import { AGENT_NOT_AUTHENTICATED_MESSAGE } from "./ws-handlers/agent-auth-handler.js";
import type { AgentId } from "../shared/types.js";
import { GitManager } from "../shared/git.js";

// Allow three sequential waits to fail with their diagnostic labels before Vitest times out.
vi.setConfig({ testTimeout: 90_000 });

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(onRun?: () => void): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn(() => onRun?.());
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  agent.sendUserMessage = vi.fn();
  return agent;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

async function selfWake(agent: FakeAgent, taskId = "bg-1"): Promise<void> {
  agent.emit("event", { type: "agent_self_wake", taskId, status: "completed" });
  await flush();
  await flush();
}

// Slow git polls must not exhaust the deadline before enough attempts run; measured peak: 59.
const MIN_POLLS = 200;

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let polls = 0;
  for (;;) {
    if (fn()) return;
    polls += 1;
    if (polls >= MIN_POLLS && Date.now() >= deadline) break;
    await flush();
  }
  throw new Error(
    `Timed out waiting for ${label} after ${polls} polls / ${Date.now() - startedAt}ms`,
  );
}

function makeListenerDeps(sseBroadcast = vi.fn()): SystemTurnDeps["listenerDeps"] {
  return {
    sessionManager: {
      setAgentSessionId: vi.fn(),
      setLastTurnErrored: vi.fn(),
      get: vi.fn(),
      track: vi.fn(),
      setMuted: vi.fn(),
      list: vi.fn().mockReturnValue([]),
    } as never,
    chatHistoryManager: {
      replaceInProgress: vi.fn(),
      finalizeInProgress: vi.fn(),
      append: vi.fn(),
      updateLastMessage: vi.fn().mockReturnValue(null),
      indexOfMessageId: vi.fn().mockReturnValue(-1),
    } as never,
    usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as never,
    sseBroadcast,
    broadcastLog: vi.fn(),
    getSelectedModel: () => undefined,
  };
}

const realAutoCommit = async (sessionDir: string, summary: string) => {
  const git = new GitManager(sessionDir);
  const parentHash = await git.getHeadHash();
  const r = await git.autoCommit(summary);
  return { ...r, parentHash };
};

describe("post-turn flow for a self-woken turn", () => {
  let repoDir: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  const gitOut = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  const commitSubjects = (): string[] =>
    gitOut("log", "--format=%s").split("\n").filter(Boolean);

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "shi247-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repoDir, "file.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "initial");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function makeRealCommitTurn() {
    const gitManager = new GitManager(repoDir);
    const diffRange = vi.spyOn(gitManager, "diffRange");
    const scheduleAutoPush = vi.fn();
    const ctx = {
      createGitManager: () => gitManager,
      chatHistoryManager: {
        updateLastMessage: vi.fn().mockReturnValue(null),
        indexOfMessageId: vi.fn().mockReturnValue(-1),
        append: vi.fn(),
      },
      sessionManager: {
        get: vi.fn().mockReturnValue({ id: "s1" }),
        getPrStatus: vi.fn().mockReturnValue(undefined),
        getSecretBlock: vi.fn().mockReturnValue(undefined),
        setSecretBlock: vi.fn(),
      },
      scheduleAutoPush,
    } as unknown as Parameters<typeof postTurnCommit>[0];

    const headsSeen: (string | null | undefined)[] = [];
    const commitTurn: SystemTurnDeps["commitTurn"] = async (args) => {
      headsSeen.push(args.turnStartHeadHash);
      return postTurnCommit(ctx, {
        sessionDir: args.sessionDir,
        sessionId: args.sessionId,
        emit: args.emit,
        turnSummary: args.summary,
        turnStartHeadHash: args.turnStartHeadHash,
        runner: args.runner,
        ...(args.deferPushArm ? { deferPushArm: args.deferPushArm } : {}),
      });
    };
    return { commitTurn, gitManager, diffRange, scheduleAutoPush, headsSeen };
  }

  async function runFirstStreamingTurn(opts?: {
    onRun?: () => void;
    ensureAgentTokenFresh?: SystemTurnDeps["ensureAgentTokenFresh"];
    extraDeps?: Partial<SystemTurnDeps>;
  }) {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(opts?.onRun);
    const scheduleAutoPush = vi.fn();
    const postTurnPrFlow = vi.fn(async () => {});
    const finalizeAgentEnv = vi.fn();
    const drainNext = vi.fn(async () => {});
    const autoCommit = vi.fn(realAutoCommit);
    let settledTurns = 0;
    runner.on("idle", () => { settledTurns += 1; });
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));

    const sseBroadcast = vi.fn();
    const listenerDeps = makeListenerDeps(sseBroadcast);
    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit,
      scheduleAutoPush,
      postTurnPrFlow,
      finalizeAgentEnv,
      listenerDeps,
      ...(opts?.ensureAgentTokenFresh ? { ensureAgentTokenFresh: opts.ensureAgentTokenFresh } : {}),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
      ...(opts?.extraDeps ?? {}),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "kick off a background job",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    return {
      runner, agent, scheduleAutoPush, postTurnPrFlow, finalizeAgentEnv, drainNext, autoCommit,
      listenerDeps, sseBroadcast, messages,
      settledTurns: () => settledTurns,
    };
  }

  it("commits, pushes and runs the PR flow for a turn the agent started itself", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "turn-1 work\n"),
    });

    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Backgrounding the consult" }],
    });
    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");
    expect(h.postTurnPrFlow).toHaveBeenCalledTimes(1);
    expect(commitSubjects()).toHaveLength(2);

    await selfWake(h.agent);
    expect(h.runner.running).toBe(true);

    fs.writeFileSync(filePath, "self-woken work\n");
    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Applied the consult's fix" }],
    });
    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(() => h.postTurnPrFlow.mock.calls.length === 2, "wake turn post-turn flow ran");

    const subjects = commitSubjects();
    expect(subjects).toHaveLength(3);
    expect(subjects[0]).toBe("Applied the consult's fix");
    expect(gitOut("show", "HEAD:file.txt")).toBe("self-woken work\n");
    expect(gitOut("status", "--porcelain")).toBe("");
    expect(h.scheduleAutoPush).toHaveBeenCalledTimes(2);
    expect(h.finalizeAgentEnv).toHaveBeenCalledTimes(2);
    expect(h.runner.running).toBe(false);

    h.runner.dispose({ force: true });
  });

  it("drains a message queued during the self-woken turn", async () => {
    const h = await runFirstStreamingTurn();

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");
    expect(h.drainNext).toHaveBeenCalledTimes(1);

    await selfWake(h.agent);
    expect(h.runner.running).toBe(true);

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.drainNext.mock.calls.length === 2, "wake turn drained");

    h.runner.dispose({ force: true });
  });

  it("heals a self-woken turn's token quietly instead of demanding a sign-in", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "turn-1 work\n"),
      ensureAgentTokenFresh,
    });

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");

    await selfWake(h.agent);
    expect(h.runner.running).toBe(true);

    fs.writeFileSync(filePath, "self-woken work\n");
    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Applying the consult's fix" }],
    });
    h.agent.emit("auth_required");
    h.agent.emit("done", 0);

    await waitFor(() => !h.runner.running, "wake turn settled");

    expect(h.messages.filter((m) => m.type === "error")).toEqual([]);
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(h.agent.run).toHaveBeenCalledTimes(1);

    await waitFor(() => gitOut("status", "--porcelain") === "", "wake turn's edits committed");
    expect(gitOut("show", "HEAD:file.txt")).toBe("self-woken work\n");
    expect(commitSubjects()[0]).toBe("Applying the consult's fix");

    const replace = h.listenerDeps.chatHistoryManager.replaceInProgress as ReturnType<typeof vi.fn>;
    expect(
      replace.mock.calls.some((c) =>
        ((c[1] ?? []) as { text?: string }[]).some((r) => r.text === "Applying the consult's fix"),
      ),
    ).toBe(true);
    expect(h.listenerDeps.chatHistoryManager.finalizeInProgress).toHaveBeenCalled();

    h.runner.dispose({ force: true });
  });

  it("does not leave the killed process's background tasks behind after a quiet heal", async () => {
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);
    const h = await runFirstStreamingTurn({ ensureAgentTokenFresh });
    // Match agent-execution's setup so the auth teardown's identity guard is reached.
    h.runner.setAgent(h.agent as never);

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");

    await selfWake(h.agent);

    h.agent.emit("event", {
      type: "agent_background_tasks",
      tasks: [{ id: "bg-1", description: "npm test" }],
    });
    expect(h.runner.backgroundWorkDescriptions).toEqual(["npm test"]);

    h.agent.emit("auth_required");
    h.agent.emit("done", 0);
    await waitFor(() => !h.runner.running, "wake turn settled");

    h.runner.isStreamingActive = true;
    expect(h.runner.backgroundWorkDescriptions).toEqual([]);

    h.runner.dispose({ force: true });
  });

  it("still surfaces the sign-in card on a self-woken turn when the heal is refused", async () => {
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(false);
    const h = await runFirstStreamingTurn({
      ensureAgentTokenFresh,
      extraDeps: {
        prepareAgentEnv: async () => ({ turnRoute: { kind: "account" as const, id: "acct-a" } }),
        routeProfile: () => ({ billingMode: "sub" as const, serviceId: undefined }),
      },
    });

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");

    await selfWake(h.agent);
    expect(h.runner.running).toBe(true);

    h.agent.emit("auth_required");
    h.agent.emit("done", 0);

    await waitFor(
      () => h.messages.some((m) => m.type === "error"),
      "re-auth card surfaced",
    );
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(
      h.messages.some(
        (m) => m.type === "error" && m.message === AGENT_NOT_AUTHENTICATED_MESSAGE,
      ),
    ).toBe(true);
    expect(h.agent.run).toHaveBeenCalledTimes(1);
    await waitFor(() => !h.runner.running, "wake turn settled");
    expect(h.sseBroadcast).toHaveBeenCalledWith("session_agent_finished", { sessionId: "s1" });

    h.runner.dispose({ force: true });
  });

  it("does not re-dispatch a CLI-started turn that hits the account's quota limit", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const markSessionAccountExhausted = vi.fn();
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "turn-1 work\n"),
      extraDeps: {
        prepareAgentEnv: async () => ({ turnRoute: { kind: "account" as const, id: "acct-a" } }),
        routeProfile: () => ({ billingMode: "sub" as const, serviceId: undefined }),
        routeLabel: () => "Work account",
      },
    });
    (h.listenerDeps as { markSessionAccountExhausted?: unknown }).markSessionAccountExhausted =
      markSessionAccountExhausted;

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");
    expect(commitSubjects()).toHaveLength(2);

    await selfWake(h.agent);
    expect(h.runner.running).toBe(true);
    fs.writeFileSync(filePath, "adopted work\n");
    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "You've hit your session limit · resets 6:40pm (UTC)" }],
    });
    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(
      () => h.agent.run.mock.calls.length > 1 || h.messages.some((m) => m.type === "system_notice"),
      "the adopted turn's quota refusal was handled",
    );

    expect(h.agent.run).toHaveBeenCalledTimes(1);

    await waitFor(() => h.postTurnPrFlow.mock.calls.length === 2, "adopted turn post-turn flow ran");

    const notice = h.messages.find((m) => m.type === "system_notice");
    expect(notice?.message).toContain("Work account is out of quota");
    expect(notice?.message).toContain("send your next message");
    const append = h.listenerDeps.chatHistoryManager.append as ReturnType<typeof vi.fn>;
    expect(
      append.mock.calls.some((c) =>
        typeof (c[1] as { text?: string })?.text === "string"
        && (c[1] as { text: string }).text.includes("Work account is out of quota"),
      ),
    ).toBe(true);

    const subjects = commitSubjects();
    expect(subjects).toHaveLength(3);
    expect(subjects[0]).toBe("Agent turn");
    expect(gitOut("show", "HEAD:file.txt")).toBe("adopted work\n");
    expect(gitOut("status", "--porcelain")).toBe("");

    expect(markSessionAccountExhausted).toHaveBeenCalledWith("s1", expect.any(Number), "acct-a");

    await waitFor(() => !h.runner.running, "adopted turn settled");
    h.runner.dispose({ force: true });
  });

  it("does not promise an account move to a CLI-started turn billed to a metered key", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "turn-1 work\n"),
      extraDeps: {
        prepareAgentEnv: async () => ({ turnRoute: { kind: "string" as const, id: "key-a" } }),
        routeProfile: () => ({ billingMode: "key" as const, serviceId: "xai" }),
        routeLabel: () => "My API key",
      },
    });

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");

    await selfWake(h.agent);
    fs.writeFileSync(filePath, "adopted work\n");
    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "You've hit your session limit · resets 6:40pm (UTC)" }],
    });
    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(() => h.postTurnPrFlow.mock.calls.length === 2, "adopted turn post-turn flow ran");

    expect(h.messages.filter((m) => m.type === "system_notice")).toEqual([]);
    expect(h.agent.run).toHaveBeenCalledTimes(1);
    expect(commitSubjects()[0]).toBe("Agent turn");
    expect(gitOut("show", "HEAD:file.txt")).toBe("adopted work\n");

    await waitFor(() => !h.runner.running, "adopted turn settled");
    h.runner.dispose({ force: true });
  });

  it("still commits the adopted turn when persisting the quota notice throws", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "turn-1 work\n"),
      extraDeps: {
        prepareAgentEnv: async () => ({ turnRoute: { kind: "account" as const, id: "acct-a" } }),
        routeProfile: () => ({ billingMode: "sub" as const, serviceId: undefined }),
        routeLabel: () => "Work account",
      },
    });

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");

    const append = h.listenerDeps.chatHistoryManager.append as ReturnType<typeof vi.fn>;
    append.mockImplementation((_id: string, row: { text?: string }) => {
      if (row?.text?.includes("is out of quota")) throw new Error("sqlite is having a day");
    });

    await selfWake(h.agent);
    fs.writeFileSync(filePath, "adopted work\n");
    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "You've hit your session limit · resets 6:40pm (UTC)" }],
    });
    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(() => h.postTurnPrFlow.mock.calls.length === 2, "adopted turn post-turn flow ran");
    expect(gitOut("status", "--porcelain")).toBe("");
    expect(gitOut("show", "HEAD:file.txt")).toBe("adopted work\n");
    expect(commitSubjects()[0]).toBe("Agent turn");
    expect(h.scheduleAutoPush).toHaveBeenCalledTimes(2);

    await waitFor(() => !h.runner.running, "adopted turn settled");
    h.runner.dispose({ force: true });
  });

  it("keeps the limit notice out of the commit even when a second turn is adopted first", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "turn-1 work\n"),
      extraDeps: {
        prepareAgentEnv: async () => ({ turnRoute: { kind: "account" as const, id: "acct-a" } }),
        routeProfile: () => ({ billingMode: "sub" as const, serviceId: undefined }),
        routeLabel: () => "Work account",
      },
    });

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");

    await selfWake(h.agent);
    fs.writeFileSync(filePath, "adopted work\n");

    let releaseDrain: () => void = () => {};
    const parked = new Promise<void>((r) => { releaseDrain = r; });
    let drainEntered: () => void = () => {};
    const inDrain = new Promise<void>((r) => { drainEntered = r; });
    h.drainNext.mockImplementation(async () => { drainEntered(); await parked; });

    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "You've hit your session limit · resets 6:40pm (UTC)" }],
    });
    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await inDrain;

    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Picking up where I left off" }],
    });
    await flush();
    expect(h.runner.turnSummary).toBe("Picking up where I left off");
    releaseDrain();

    await waitFor(() => h.postTurnPrFlow.mock.calls.length === 2, "first adopted turn committed");
    expect(commitSubjects()[0]).toBe("Agent turn");
    expect(gitOut("show", "HEAD:file.txt")).toBe("adopted work\n");

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => !h.runner.running, "second adopted turn settled");
    h.runner.dispose({ force: true });
  });

  it("does not re-dispatch when the 401 lands before the re-arm has settled", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const ensureAgentTokenFresh = vi.fn().mockResolvedValue(true);

    let releasePr: () => void = () => {};
    let signalPrEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releasePr = r; });
    const prEntered = new Promise<void>((r) => { signalPrEntered = r; });
    let prCalls = 0;
    const postTurnPrFlow = vi.fn(async () => {
      prCalls += 1;
      if (prCalls === 1) {
        signalPrEntered();
        await parked;
      }
    });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      ensureAgentTokenFresh,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await prEntered;

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Reading the consult" }],
    });
    await flush();
    expect(runner.running).toBe(true);
    fs.writeFileSync(filePath, "adopted work\n");

    agent.emit("auth_required");
    agent.emit("done", 0);
    await flush();
    releasePr();

    await waitFor(() => !runner.running, "adopted turn settled");
    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(ensureAgentTokenFresh).toHaveBeenCalledTimes(1);
    expect(messages.filter((m) => m.type === "error")).toEqual([]);
    await waitFor(() => gitOut("status", "--porcelain") === "", "adopted turn's edits committed");
    expect(gitOut("show", "HEAD:file.txt")).toBe("adopted work\n");

    runner.dispose({ force: true });
  });

  it("ignores a mid-turn task notification and runs the post-turn flow exactly once", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "mid-turn work\n"),
    });

    await selfWake(h.agent);

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "post-turn flow settled");
    await flush();
    await flush();

    expect(h.postTurnPrFlow).toHaveBeenCalledTimes(1);
    expect(h.autoCommit).toHaveBeenCalledTimes(1);
    expect(h.drainNext).toHaveBeenCalledTimes(1);
    expect(commitSubjects()).toHaveLength(2);

    h.runner.dispose({ force: true });
  });

  it("still commits the wake turn when the wake lands mid post-turn flow", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));

    let releaseDrain: () => void = () => {};
    let signalDrainEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releaseDrain = r; });
    const drainEntered = new Promise<void>((r) => { signalDrainEntered = r; });
    let drainCalls = 0;
    const drainNext = vi.fn(async () => {
      drainCalls += 1;
      if (drainCalls === 1) {
        signalDrainEntered();
        await parked;
      }
    });
    const postTurnPrFlow = vi.fn(async () => {});

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "kick off a background job",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await drainEntered;

    agent.emit("event", { type: "agent_self_wake", taskId: "bg-1" });
    await flush();
    expect(runner.running).toBe(true);
    releaseDrain();
    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "turn 1 committed");
    await flush();
    await flush();

    fs.writeFileSync(filePath, "self-woken work\n");
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Wake turn edit" }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(() => postTurnPrFlow.mock.calls.length === 2, "wake turn post-turn flow ran");
    expect(commitSubjects()).toHaveLength(3);
    expect(gitOut("show", "HEAD:file.txt")).toBe("self-woken work\n");

    runner.dispose({ force: true });
  });

  it("commits a turn the CLI started on its own after acking a late live steer", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "turn-1 work\n"),
    });

    h.runner.steeredMessages = [
      { afterGroupIndex: 1, text: "rename the folder too", assembledPrompt: "rename the folder too" },
    ];
    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Both done." }],
    });
    h.agent.emit("event", { type: "agent_user_replay", text: "rename the folder too" });
    expect(h.runner.steeredMessages[0].delivered).toBe(true);

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");
    expect(commitSubjects()).toHaveLength(2);
    expect(h.runner.running).toBe(false);
    expect(h.runner.queueLength).toBe(0);

    h.agent.emit("event", { type: "agent_init", agentId: "claude", sessionId: "agent-sid" });
    await flush();
    expect(h.runner.running).toBe(false);

    fs.writeFileSync(filePath, "steered work\n");
    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renamed the folder" }],
    });
    await flush();
    await flush();
    expect(h.runner.running).toBe(true);
    expect(h.runner.chatMessageGroups.map((g) => g.text)).toEqual(["Renamed the folder"]);

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    await waitFor(() => h.postTurnPrFlow.mock.calls.length === 2, "cli-started turn post-turn flow ran");
    const subjects = commitSubjects();
    expect(subjects).toHaveLength(3);
    expect(subjects[0]).toBe("Renamed the folder");
    expect(gitOut("show", "HEAD:file.txt")).toBe("steered work\n");
    expect(gitOut("status", "--porcelain")).toBe("");
    expect(h.scheduleAutoPush).toHaveBeenCalledTimes(2);
    expect(h.runner.running).toBe(false);

    h.runner.dispose({ force: true });
  });

  it("does not adopt a bare post-result init (the set_permission_mode control response)", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "turn-1 work\n"),
    });

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "turn 1 post-turn flow settled");
    expect(h.runner.running).toBe(false);

    h.agent.emit("event", { type: "agent_init", agentId: "claude", sessionId: "agent-sid" });
    await flush();
    await flush();

    expect(h.runner.running).toBe(false);
    expect(h.postTurnPrFlow).toHaveBeenCalledTimes(1);

    h.runner.dispose({ force: true });
  });

  it("does not adopt a backend that cannot start its own turns (Codex's late final text)", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));
    const drainNext = vi.fn(async () => {});
    let settledTurns = 0;
    runner.on("idle", () => { settledTurns += 1; });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(async () => {}),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "codex" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "." }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => settledTurns === 1, "turn 1 settled");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renamed the folder" }],
      isStreamCompletion: true,
    });
    await flush();
    await flush();

    expect(runner.running).toBe(false);
    expect(settledTurns).toBe(1);
    expect(drainNext).toHaveBeenCalledTimes(1);
    expect(commitSubjects()).toHaveLength(2);

    runner.dispose({ force: true });
  });

  it("ignores mid-turn output and a backgrounded subagent's output after the result", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const h = await runFirstStreamingTurn({
      onRun: () => fs.writeFileSync(filePath, "mid-turn work\n"),
    });

    h.agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Working on it" }],
    });
    await flush();
    expect(h.runner.running).toBe(true);

    h.agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => h.settledTurns() === 1, "post-turn flow settled");

    h.agent.emit("event", {
      type: "agent_assistant",
      parentToolUseId: "task-1",
      content: [{ type: "text", text: "subagent still going" }],
    });
    await flush();
    await flush();

    expect(h.runner.running).toBe(false);
    expect(h.postTurnPrFlow).toHaveBeenCalledTimes(1);
    expect(h.autoCommit).toHaveBeenCalledTimes(1);
    expect(h.drainNext).toHaveBeenCalledTimes(1);
    expect(commitSubjects()).toHaveLength(2);

    h.runner.dispose({ force: true });
  });

  it("does not clear running or drain when a CLI-started turn was adopted mid-sequence", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));

    let releaseSync: () => void = () => {};
    let signalSyncEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releaseSync = r; });
    const syncEntered = new Promise<void>((r) => { signalSyncEntered = r; });
    const finalizeAgentEnv = vi.fn(async () => {
      signalSyncEntered();
      await parked;
    });
    const drainNext = vi.fn(async () => {});

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(async () => {}),
      finalizeAgentEnv,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await syncEntered;

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renamed the folder" }],
    });
    await flush();
    expect(runner.running).toBe(true);

    releaseSync();
    await flush();
    await flush();
    await flush();

    expect(runner.running).toBe(true);
    expect(drainNext).not.toHaveBeenCalled();

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => drainNext.mock.calls.length === 1, "adopted turn drained");
    expect(runner.running).toBe(false);

    runner.dispose({ force: true });
  });

  // Early adopted edits can enter the predecessor's commit; attribution differs, but work survives.
  it("runs the post-turn flow for an adopted turn that finishes before the re-arm settles", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));

    let releaseDrain: () => void = () => {};
    let signalDrainEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releaseDrain = r; });
    const drainEntered = new Promise<void>((r) => { signalDrainEntered = r; });
    let drainCalls = 0;
    const drainNext = vi.fn(async () => {
      drainCalls += 1;
      if (drainCalls === 1) {
        signalDrainEntered();
        await parked;
      }
    });
    let settledTurns = 0;
    runner.on("idle", () => { settledTurns += 1; });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(async () => {}),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Both done." }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await drainEntered;

    fs.writeFileSync(filePath, "steered work\n");
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renamed the folder" }],
    });
    await flush();
    expect(runner.running).toBe(true);
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flush();

    releaseDrain();

    await waitFor(() => drainCalls === 2, "adopted turn drained for itself");
    await waitFor(() => settledTurns === 2, "adopted turn settled");
    expect(runner.running).toBe(false);

    expect(commitSubjects()[0]).toBe("Both done.");
    expect(gitOut("show", "HEAD:file.txt")).toBe("steered work\n");
    expect(gitOut("status", "--porcelain")).toBe("");

    runner.dispose({ force: true });
  });

  it("commits AND finalizes an adopted turn that crashes while the re-arm is pending", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));

    let releasePr: () => void = () => {};
    let signalPrEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releasePr = r; });
    const prEntered = new Promise<void>((r) => { signalPrEntered = r; });
    let prCalls = 0;
    const postTurnPrFlow = vi.fn(async () => {
      prCalls += 1;
      if (prCalls === 1) {
        signalPrEntered();
        await parked;
      }
    });

    const listenerDeps = makeListenerDeps();
    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      listenerDeps,
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Both done." }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await prEntered;
    const finalizedBefore = (listenerDeps.chatHistoryManager.finalizeInProgress as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(gitOut("status", "--porcelain")).toBe("");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renaming the folder" }],
    });
    await flush();
    expect(runner.running).toBe(true);
    fs.writeFileSync(filePath, "steered work\n");
    agent.emit("done", 137);
    await flush();

    releasePr();

    await waitFor(() => gitOut("status", "--porcelain") === "", "adopted turn's edits committed");
    expect(gitOut("show", "HEAD:file.txt")).toBe("steered work\n");
    expect(commitSubjects()[0]).toBe("Renaming the folder");
    await waitFor(() => !runner.running, "session settled after the crash");

    const finalize = listenerDeps.chatHistoryManager.finalizeInProgress as ReturnType<typeof vi.fn>;
    expect(finalize.mock.calls.length).toBeGreaterThan(finalizedBefore);
    const replace = listenerDeps.chatHistoryManager.replaceInProgress as ReturnType<typeof vi.fn>;
    const lastRows = replace.mock.calls[replace.mock.calls.length - 1]?.[1] as { text?: string }[];
    expect(lastRows.map((r) => r.text)).toContain("Renaming the folder");

    runner.dispose({ force: true });
  });

  it("commits an adopted turn that errors while the re-arm is pending", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));

    let releasePr: () => void = () => {};
    let signalPrEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releasePr = r; });
    const prEntered = new Promise<void>((r) => { signalPrEntered = r; });
    let prCalls = 0;
    const postTurnPrFlow = vi.fn(async () => {
      prCalls += 1;
      if (prCalls === 1) {
        signalPrEntered();
        await parked;
      }
    });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Both done." }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await prEntered;
    expect(gitOut("status", "--porcelain")).toBe("");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renaming the folder" }],
    });
    await flush();
    expect(runner.running).toBe(true);
    fs.writeFileSync(filePath, "steered work\n");
    agent.emit("error", new Error("worker agent_error"));
    await flush();

    releasePr();

    await waitFor(() => gitOut("status", "--porcelain") === "", "errored adopted turn's edits committed");
    expect(gitOut("show", "HEAD:file.txt")).toBe("steered work\n");
    expect(commitSubjects()[0]).toBe("Renaming the folder");

    runner.dispose({ force: true });
  });

  it("re-checks ownership after the queued-turn commit before draining", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));
    const drainNext = vi.fn(async () => {});

    runner.enqueue({ text: "next please", execution: "interactive" });

    let releaseCommit: () => void = () => {};
    let signalCommitEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releaseCommit = r; });
    const commitEntered = new Promise<void>((r) => { signalCommitEntered = r; });
    let commits = 0;
    const autoCommit = vi.fn(async (dir: string, summary: string) => {
      commits += 1;
      if (commits === 1) {
        signalCommitEntered();
        await parked;
      }
      return realAutoCommit(dir, summary);
    });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(async () => {}),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "do the thing",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await commitEntered;

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Renamed the folder" }],
    });
    await flush();
    expect(runner.running).toBe(true);

    releaseCommit();
    await waitFor(() => commitSubjects().length === 2, "turn 1's queued-turn commit landed");
    await flush();
    await flush();

    expect(drainNext).not.toHaveBeenCalled();
    expect(runner.running).toBe(true);
    expect(runner.queueLength).toBe(1);

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => drainNext.mock.calls.length === 1, "queued turn drained after the adopted turn");

    runner.dispose({ force: true });
  });

  it("does not re-arm a non-streaming turn", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent();
    const drainNext = vi.fn(async () => {});
    const autoCommit = vi.fn(realAutoCommit);

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit,
      scheduleAutoPush: vi.fn(),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "one-shot",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: false,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => drainNext.mock.calls.length === 1, "drained at agent_result");

    await selfWake(agent);
    agent.emit("done", 0);
    await flush();
    await flush();

    expect(drainNext).toHaveBeenCalledTimes(1);
    expect(autoCommit).toHaveBeenCalledTimes(1);

    runner.dispose({ force: true });
  });

  it("clears the latched running flag when a task notification lands after a one-shot turn's result", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent();
    const sseBroadcast = vi.fn();
    let idleSignals = 0;
    runner.on("idle", () => { idleSignals += 1; });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: vi.fn(realAutoCommit),
      scheduleAutoPush: vi.fn(),
      listenerDeps: makeListenerDeps(sseBroadcast),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "one-shot",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: false,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flush();
    expect(runner.running).toBe(false);

    await selfWake(agent);
    expect(runner.running).toBe(true);

    agent.emit("done", 0);

    await waitFor(() => !runner.running, "one-shot turn settled idle");
    await waitFor(
      () => sseBroadcast.mock.calls.some(
        ([type, payload]) => type === "session_agent_finished"
          && (payload as { sessionId: string }).sessionId === "s1",
      ),
      "finished SSE broadcast",
    );
    await waitFor(() => idleSignals === 1, "idle signalled");

    runner.dispose({ force: true });
  });

  it("drains a message queued during the latched phantom turn", async () => {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent();
    const drainNext = vi.fn(async () => { runner.dequeue(); });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: vi.fn(realAutoCommit),
      scheduleAutoPush: vi.fn(),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "one-shot",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext,
      emit: () => {},
      useStreaming: false,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => drainNext.mock.calls.length === 1, "drained at agent_result");

    await selfWake(agent);
    expect(runner.running).toBe(true);
    runner.enqueue({ text: "and now do the other thing", execution: "interactive" });

    agent.emit("done", 0);

    await waitFor(() => drainNext.mock.calls.length === 2, "queued message drained after the unlatch");
    expect(runner.queueLength).toBe(0);

    runner.dispose({ force: true });
  });

  it("gives an adopted turn its own turn-start head, so a no-op wake neither re-scans nor re-pushes", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));

    const { commitTurn, gitManager, diffRange, scheduleAutoPush, headsSeen } = makeRealCommitTurn();

    let settledTurns = 0;
    runner.on("idle", () => { settledTurns += 1; });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      commitTurn,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(async () => {}),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    const headBeforeTurn1 = gitOut("rev-parse", "HEAD").trim();

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "kick off a background job",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: headBeforeTurn1,
      readTurnStartHeadHash: () => gitManager.getHeadHash(),
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Backgrounding the consult" }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => settledTurns === 1, "turn 1 post-turn flow settled");
    const headAfterTurn1 = gitOut("rev-parse", "HEAD").trim();
    expect(headAfterTurn1).not.toBe(headBeforeTurn1);
    expect(scheduleAutoPush).toHaveBeenCalledTimes(1);
    diffRange.mockClear();

    await selfWake(agent);
    expect(runner.running).toBe(true);
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "The reviewer found nothing blocking" }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => headsSeen.length === 2, "wake turn reached the commit");
    await waitFor(() => settledTurns === 2, "wake turn post-turn flow settled");

    expect(diffRange).not.toHaveBeenCalled();
    expect(scheduleAutoPush).toHaveBeenCalledTimes(1);
    expect(commitSubjects()).toHaveLength(2);
    expect(headsSeen).toEqual([headBeforeTurn1, headAfterTurn1]);

    runner.dispose({ force: true });
  });

  it("samples an adopted turn's baseline at the adoption edge, so a commit the adopted turn makes itself is still scanned and pushed", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));
    const { commitTurn, gitManager, diffRange, scheduleAutoPush, headsSeen } = makeRealCommitTurn();
    const headsRead: (string | null)[] = [];

    let releasePrFlow: () => void = () => {};
    let signalPrFlowEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releasePrFlow = r; });
    const prFlowEntered = new Promise<void>((r) => { signalPrFlowEntered = r; });
    let prFlowDone = false;
    const postTurnPrFlow = vi.fn(async () => {
      signalPrFlowEntered();
      await parked;
      prFlowDone = true;
    });

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      commitTurn,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    const headBeforeTurn1 = gitOut("rev-parse", "HEAD").trim();
    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "kick off a background job",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: headBeforeTurn1,
      readTurnStartHeadHash: async () => {
        const head = await gitManager.getHeadHash();
        headsRead.push(head);
        return head;
      },
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Backgrounding the consult" }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await prFlowEntered;
    const predecessorCommit = gitOut("rev-parse", "HEAD").trim();
    expect(predecessorCommit).not.toBe(headBeforeTurn1);

    agent.emit("event", { type: "agent_self_wake", taskId: "bg-1" });
    await flush();
    expect(runner.running).toBe(true);
    await waitFor(() => headsRead.length === 1, "baseline sampled at the adoption edge");

    fs.writeFileSync(path.join(repoDir, "fix.txt"), "the consult's fix\n");
    git("add", "-A");
    git("commit", "-qm", "Agent's own commit during the adopted turn");
    const adoptedCommit = gitOut("rev-parse", "HEAD").trim();

    releasePrFlow();
    await waitFor(() => prFlowDone, "turn 1 post-turn flow settled");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Applied and committed the consult's fix" }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => headsSeen.length === 2, "adopted turn reached the commit");
    await waitFor(() => scheduleAutoPush.mock.calls.length === 2, "adopted turn's commit pushed");

    expect(headsRead).toEqual([predecessorCommit]);
    expect(headsSeen[1]).toBe(predecessorCommit);
    expect(headsSeen[1]).not.toBe(adoptedCommit);
    expect(diffRange).toHaveBeenCalledWith(predecessorCommit, adoptedCommit);
    expect(scheduleAutoPush).toHaveBeenCalledTimes(2);

    runner.dispose({ force: true });
  });

  it("builds one re-arm for one adopted turn, however many edges announce it", async () => {
    const filePath = path.join(repoDir, "file.txt");
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent(() => fs.writeFileSync(filePath, "turn-1 work\n"));
    const { commitTurn, gitManager, headsSeen } = makeRealCommitTurn();

    let releasePrFlow: () => void = () => {};
    let signalPrFlowEntered: () => void = () => {};
    const parked = new Promise<void>((r) => { releasePrFlow = r; });
    const prFlowEntered = new Promise<void>((r) => { signalPrFlowEntered = r; });
    let prFlowDone = false;
    const postTurnPrFlow = vi.fn(async () => {
      signalPrFlowEntered();
      await parked;
      prFlowDone = true;
    });
    const readTurnStartHeadHash = vi.fn(() => gitManager.getHeadHash());

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      commitTurn,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    const headBeforeTurn1 = gitOut("rev-parse", "HEAD").trim();
    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "kick off a background job",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: headBeforeTurn1,
      readTurnStartHeadHash,
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn 1 started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await prFlowEntered;
    const predecessorCommit = gitOut("rev-parse", "HEAD").trim();

    agent.emit("event", { type: "agent_self_wake", taskId: "bg-1" });
    await flush();
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Reading the consult" }],
    });
    await flush();

    releasePrFlow();
    await waitFor(() => prFlowDone, "turn 1 post-turn flow settled");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => headsSeen.length === 2, "adopted turn reached the commit");

    expect(readTurnStartHeadHash).toHaveBeenCalledTimes(1);
    expect(headsSeen[1]).toBe(predecessorCommit);

    runner.dispose({ force: true });
  });
});
