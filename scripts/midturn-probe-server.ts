/**
 * TEMPORARY debugging harness (not part of the product).
 *
 * Boots the real orchestrator in test mode with a fake agent process, plus a
 * `/probe/*` control channel so a browser-driven repro can emit agent events on
 * demand. Paired with `npx vite` (which proxies /api + /ws here) to drive the
 * real client UI.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/server/orchestrator/index.js";
import { GitManager } from "../src/server/shared/git.js";
import { SessionManager } from "../src/server/orchestrator/sessions.js";
import { ChatHistoryManager } from "../src/server/orchestrator/chat-history.js";
import { DatabaseManager } from "../src/server/shared/database.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
} from "../src/server/orchestrator/integration_tests/test-helpers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midturn-probe-"));
const dbManager = new DatabaseManager(path.join(tmpDir, "probe.db"));
const sessionManager = new SessionManager(dbManager);
const chatHistoryManager = new ChatHistoryManager(dbManager);

const agents: FakeClaudeProcess[] = [];

const app = await buildApp({
  credentialStore: createTestCredentialStore(tmpDir),
  createGitManager: (dir: string) => new GitManager(dir),
  sessionManager,
  chatHistoryManager,
  authManager: new StubAuthManager() as Any,
  agentFactory: () => {
    const a = new FakeClaudeProcess();
    agents.push(a);
    return a as Any;
  },
  workspaceDir: tmpDir,
  serveStatic: false,
} as Any);

app.post("/probe/emit", async (request: Any) => {
  const { index, event } = request.body as { index?: number; event: unknown };
  const agent = index === undefined ? agents[agents.length - 1] : agents[index];
  if (!agent) return { ok: false, error: "no agent" };
  agent.emit("event", event);
  return { ok: true, agents: agents.length };
});

app.get("/probe/agents", async () => ({ count: agents.length }));

const port = Number(process.env.PROBE_PORT ?? 3100);
await app.listen({ port, host: "127.0.0.1" });
console.log(`[probe] listening on ${port}, tmp=${tmpDir}`);
