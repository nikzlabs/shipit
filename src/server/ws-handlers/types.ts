import type { WsServerMessage, WsLogEntry, ImageAttachment, FileContextRef, PermissionMode } from "../types.js";
import type { GitManager } from "../git.js";
import type { SessionManager } from "../sessions.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ThreadManager } from "../threads.js";
import type { DeploymentManager } from "../deployment-manager.js";
import type { DeploymentStore } from "../deployment-store.js";
import type { FeatureManager } from "../features.js";
import type { UsageManager } from "../usage.js";
import type { ViteManager } from "../vite-manager.js";
import type { AuthManager } from "../auth.js";
import type { FileWatcher } from "../file-watcher.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { GitIdentityStore } from "../git-identity-store.js";
import type { AgentId, AgentProcess } from "../agents/agent-process.js";
import type { TerminalProcess } from "../terminal.js";

/** Queued message waiting for the current Claude turn to finish. */
export interface QueuedMessage {
  text: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  permissionMode?: PermissionMode;
}

/**
 * Context bag passed to every extracted WebSocket handler function.
 * Provides access to per-connection state (via getters/setters) and
 * app-level managers (via direct references).
 */
export interface HandlerContext {
  // === Communication ===
  send: (msg: WsServerMessage) => void;
  broadcast: (msg: WsServerMessage) => void;
  broadcastLog: (source: WsLogEntry["source"], text: string) => void;

  // === Per-connection state accessors ===
  getActiveDir: () => string;
  getActiveGitManager: () => GitManager;
  getActiveAppSessionId: () => string | undefined;
  setActiveAppSessionId: (id: string | undefined) => void;
  getActiveSessionDir: () => string | null;
  setActiveSessionDir: (dir: string | null) => void;
  activateSession: (sessionId: string) => void;

  // Agent/claude state
  getAgent: () => AgentProcess | null;
  setAgent: (a: AgentProcess | null) => void;
  getIsClaudeRunning: () => boolean;
  setIsClaudeRunning: (v: boolean) => void;
  getWasInterrupted: () => boolean;
  setWasInterrupted: (v: boolean) => void;

  // Message queue
  getMessageQueue: () => QueuedMessage[];
  clearMessageQueue: () => void;

  // Terminal
  getTerminal: () => TerminalProcess | null;
  setTerminal: (t: TerminalProcess | null) => void;

  // Log buffer
  clearLogBuffer: () => void;

  // === App-level managers ===
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  createGitManager: (dir: string) => GitManager;
  githubAuthManager: GitHubAuthManager;
  threadManager: ThreadManager;
  deploymentManager: DeploymentManager;
  deploymentStore: DeploymentStore;
  featureManager: FeatureManager;
  usageManager: UsageManager;
  viteManager: ViteManager;
  authManager: AuthManager;
  fileWatcher: FileWatcher;
  agentRegistry: AgentRegistry;
  gitIdentityStore: GitIdentityStore;

  // === Factories ===
  createSessionDir: (title: string, opts?: { skipGitInit?: boolean }) => Promise<{ appSessionId: string; sessionDir: string }>;
  generateText: (prompt: string, cwd?: string) => Promise<string>;
  getSharedRepoDir: (repoUrl: string) => string;

  // === Config ===
  workspaceDir: string;
  sessionsRoot: string;
  defaultAgentId: AgentId;
}
