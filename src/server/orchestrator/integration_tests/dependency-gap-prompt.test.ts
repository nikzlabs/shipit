import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import type { DependencyGap } from "../dependency-staleness.js";
import type { FastifyInstance } from "fastify";
import type { CredentialStore } from "../credential-store.js";

/**
 * nikzlabs/shipit#2429 — the unverified-dependency gap has to reach the AGENT'S PROMPT,
 * not just a card and a service-list field.
 *
 * `dependency-staleness.test.ts` proves the text is right and
 * `container-session-runner.test.ts` proves the runner exposes the gap. Neither
 * can fail on the thing that actually broke for the user: nobody wiring the two
 * together. A prefix built into the wrong array, dropped by a `.filter`, or
 * never imported passes both of those suites while the agent stays exactly as
 * uninformed as it was before the fix. So this asserts on the prompt string the
 * agent was really handed.
 */
describe("Integration: the dependency gap reaches the agent's prompt", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let sessionId: string;
  let agents: FakeClaudeProcess[];

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-gap-prompt-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    agents = [];

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        const agent = new FakeClaudeProcess();
        agents.push(agent);
        return agent as unknown as never;
      },
      credentialStore,
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  /**
   * Stand in for a rewrite the orchestrator performed. The real setter is
   * `recordDependencyGap`, which lives on the container runner and needs Docker;
   * the prompt path reads the public `dependencyGap` either way, so setting it
   * directly exercises the same join without a container.
   */
  function setGap(gap: DependencyGap | null): void {
    const runner = (app as unknown as {
      runnerRegistry: { get(id: string): { dependencyGap?: DependencyGap | null } | undefined };
    }).runnerRegistry.get(sessionId);
    if (!runner) throw new Error("no runner for the test session");
    runner.dependencyGap = gap;
  }

  it("prefixes the turn with a `[System]` instruction naming the install commands", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    setGap({
      reason: "not-content-keyed",
      rewrite: "rebase",
      commands: ["npm ci", "npm run build"],
    });

    const prompt = await sendUserTurn(client, () => agents, "The preview is 500ing");

    expect(prompt).toContain("[System]");
    expect(prompt).toContain("a sync onto the latest base");
    // The commands, verbatim — the agent is told what to run rather than left to
    // infer it from the repo.
    expect(prompt).toContain("npm ci");
    expect(prompt).toContain("npm run build");
    // The ordering rule is the fix. Without it the agent has the fact and still
    // starts from the wrong premise.
    expect(prompt).toMatch(/before you treat[\s\S]*as a fault in the code/);
    // The prefix rides in FRONT; the user's own words stay last.
    expect(prompt.endsWith("The preview is 500ing")).toBe(true);

    client.close();
  });

  it("repeats on every turn until an install clears the gap", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    setGap({ reason: "install-failed", rewrite: "git-pull", commands: ["npm ci"] });

    // Read live off the runner rather than consumed from a slot, so it is still
    // there on the second turn — the property that removes any need for new
    // persistence or episode-dedup state.
    const first = await sendUserTurn(client, () => agents, "one");
    const second = await sendUserTurn(client, () => agents, "two");
    expect(first).toContain("[System]");
    expect(second).toContain("[System]");
    expect(second).toContain("FAILED");

    // An install clearing the gap is what stops it — and it stops immediately.
    setGap(null);
    const third = await sendUserTurn(client, () => agents, "three");
    expect(third).toBe("three");

    client.close();
  });

  it("says nothing at all to a healthy session", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    // The overwhelmingly common case, and it must not pay a paragraph of prompt
    // for a problem it does not have.
    const prompt = await sendUserTurn(client, () => agents, "Add a button");
    expect(prompt).toBe("Add a button");

    client.close();
  });

  it("holds the instruction back on /compact, and still delivers it after", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    setGap({ reason: "not-content-keyed", rewrite: "rollback", commands: ["./build.sh"] });

    // A compaction is ShipIt asking for a summary, not a turn that touches the
    // tree — an install instruction there is noise at best, and something the
    // turn tries to act on at worst.
    const compact = await sendUserTurn(client, () => agents, "/compact");
    expect(compact).not.toContain("[System]");
    expect(compact).not.toContain("./build.sh");

    // Nothing is lost by waiting: unlike the consume-once notices this one is
    // re-derived from live state, so the next real turn carries it unchanged.
    const next = await sendUserTurn(client, () => agents, "Now what?");
    expect(next).toContain("[System]");
    expect(next).toContain("./build.sh");

    client.close();
  });
});

/**
 * Send a user message and return the prompt the agent actually received — the
 * only place the fix can be observed, since a gap the agent is not told about is
 * precisely the defect.
 */
async function sendUserTurn(
  client: TestClient,
  getAgents: () => FakeClaudeProcess[],
  text: string,
  timeoutMs = 5000,
): Promise<string> {
  const before = getAgents().length;
  client.send({ type: "send_message", text });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const spawned = getAgents()[before];
    if (spawned?.runCalled) {
      // End the turn so the next `sendUserTurn` starts a fresh agent instead of
      // queueing behind this one.
      spawned.emit("done", 0);
      await new Promise((r) => setTimeout(r, 50));
      return spawned.lastPrompt;
    }
    if (Date.now() > deadline) {
      throw new Error(`no agent spawned for user turn ${JSON.stringify(text)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
