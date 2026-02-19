---
status: planned
---

# 038: Split index.ts, App.tsx, and types.ts

## Problem

Three files have grown far beyond a manageable size:

| File | Lines | Core issue |
|------|-------|------------|
| `src/server/index.ts` | 3,095 | 50+ WebSocket handlers in one `socket.on("message")` callback |
| `src/client/App.tsx` | 2,216 | 80+ `useState` calls, 60+ message handlers, all callbacks in one component |
| `src/server/types.ts` | 1,168 | Every type for every domain in one file |

This makes it hard to navigate, review diffs, and test in isolation. The files have no circular dependency issues — they grew organically as features were added one at a time.

## Design principles

1. **Mechanical refactors only** — move code, don't rewrite it. No logic changes, no renames, no new abstractions.
2. **One file at a time** — each split is an independent commit. If any split causes a test failure, the others are unaffected.
3. **Preserve the public API** — every existing import path must continue to work. Re-export from the original file where needed.
4. **No new dependencies** — no state management libraries, no new build config.
5. **Tests stay green throughout** — run `npm test` after each file's split.

---

## Split 1: `src/server/types.ts` → domain-grouped type files

Split first because the other two files import from it, so stabilizing the type layer first avoids churn.

### New file structure

```
src/server/types/
  index.ts              Re-exports everything (preserves `import from "./types.js"`)
  claude-types.ts       ClaudeEvent, ClaudeSystemEvent, ClaudeAssistantEvent, etc.
  agent-types.ts        Re-exports from agents/agent-process.ts (already exists, just the re-export line)
  domain-types.ts       SessionInfo, GitCommitInfo, FeatureInfo, ProjectTemplate, etc.
  attachment-types.ts   ImageAttachment, FileAttachment, FileContextRef, PermissionMode
  ws-client-messages.ts All Ws*Client interfaces + WsClientMessage union
  ws-server-messages.ts All Ws*Server interfaces + WsServerMessage union
  deployment-types.ts   DeployTargetInfo, ConfigField, DeploymentRecord, deploy WS messages
  terminal-types.ts     WsTerminalStart/Input/Resize/Output/Exit, WsLogEntry
  thread-types.ts       CheckpointInfo, ThreadInfo, WsCheckpointCreated, etc.
  github-types.ts       WsGitHub* messages (both client and server)
  usage-types.ts        UsageTurn, SessionUsage, UsageStats, WsUsageUpdate, etc.
```

### Migration steps

1. Create `src/server/types/` directory.
2. Move each group of interfaces into its domain file. Each domain file imports types it depends on from sibling files (e.g., `ws-server-messages.ts` imports `SessionInfo` from `domain-types.ts`).
3. Create `src/server/types/index.ts` that re-exports everything:
   ```ts
   export * from "./claude-types.js";
   export * from "./agent-types.js";
   export * from "./domain-types.js";
   // ... etc.
   ```
4. Replace the original `src/server/types.ts` with:
   ```ts
   export * from "./types/index.js";
   ```
   This preserves all existing import paths (`import type { X } from "./types.js"`).
5. Run `npm test && npm run typecheck && npm run lint`.

### Why this grouping

The grouping mirrors the WebSocket handler domains in `index.ts` (github, deployment, threads, terminal, etc.). When we later split the handlers, each handler file only needs to import from its matching type file.

---

## Split 2: `src/server/index.ts` → handler modules

The 3,095-line file has a clear structure:

- **Lines 1–330**: Imports, utility functions (`validateImages`, `resolveFileAttachments`, `formatFileContext`), `AppDeps` interface
- **Lines 330–680**: `buildApp()` — dependency initialization, session creation helpers
- **Lines 680–1130**: WebSocket route setup, per-connection state, `runClaudeWithMessage()`
- **Lines 1130–3095**: The `socket.on("message")` callback — 50+ `if (msg.type === "...")` blocks

### New file structure

```
src/server/
  index.ts                 buildApp() — DI setup, route registration, delegates to handlers (~600 lines)
  ws-handlers/
    types.ts               HandlerContext interface (shared deps available to all handlers)
    send-message.ts        send_message + home_send_with_repo + answer_question (~450 lines)
    git-handlers.ts        get_git_log, rollback, set_git_identity (~100 lines)
    github-handlers.ts     github_set_token, github_push/pull, github_set_remote, etc. (~250 lines)
    pr-handlers.ts         github_create_pr, get_pr_status, merge_pr, generate_pr_description (~200 lines)
    session-handlers.ts    list_sessions, new_session, archive_session, rename_session, get_chat_history (~150 lines)
    worktree-handlers.ts   fork_session, list_worktrees, merge_session (~150 lines)
    template-handlers.ts   list_templates, apply_template, home_create_repo_with_template (~150 lines)
    deploy-handlers.ts     list_deploy_targets, deploy_configure, initiate_deploy, etc. (~200 lines)
    thread-handlers.ts     list_threads, create_checkpoint, fork_thread, switch_thread (~200 lines)
    file-handlers.ts       get_file_tree, get_file_content, list_docs, get_doc (~100 lines)
    terminal-handlers.ts   terminal_start/input/resize, clear_logs (~50 lines)
    settings-handlers.ts   set_api_key, clear_api_key, paste_auth_code, get/set_system_prompt, set_agent, set_agent_env, list_agents, list_features, get_usage_stats (~150 lines)
    misc-handlers.ts       preview_error, full_reset, cancel_queued_message, interrupt_claude (~100 lines)
  validation.ts            validateImages, resolveFileAttachments, formatFileContext, constants (~120 lines)
```

### HandlerContext interface

Each handler function receives a `HandlerContext` — a bag of the per-connection and per-app state that handlers need. This avoids passing 20+ individual arguments:

```ts
// src/server/ws-handlers/types.ts
export interface HandlerContext {
  // Per-connection send
  send: (msg: WsServerMessage) => void;
  broadcast: (msg: WsServerMessage) => void;
  broadcastLog: (source: string, text: string) => void;

  // Per-connection mutable state
  getActiveDir: () => string;
  getActiveGitManager: () => GitManager;
  getActiveAppSessionId: () => string | undefined;
  setActiveAppSessionId: (id: string | undefined) => void;
  getActiveSessionDir: () => string | null;
  setActiveSessionDir: (dir: string | null) => void;
  activateSession: (sessionId: string) => void;

  // App-level managers (readonly references)
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

  // Factories
  agentFactory: (agentId: AgentId) => AgentProcess;
  createSessionDir: (title: string, opts?: { skipGitInit?: boolean }) => Promise<{ appSessionId: string; sessionDir: string }>;
  generateText: (prompt: string, cwd?: string) => Promise<string>;
  getSharedRepoDir: (repoUrl: string) => string;

  // Config
  workspaceDir: string;
  sessionsRoot: string;
  defaultAgentId: AgentId;
}
```

### Handler function signature

Each handler file exports one function per message type:

```ts
// src/server/ws-handlers/git-handlers.ts
export async function handleGetGitLog(ctx: HandlerContext): Promise<void> {
  // ... body moved verbatim from index.ts
}

export async function handleRollback(ctx: HandlerContext, msg: WsRollback): Promise<void> {
  // ...
}
```

### Dispatcher in index.ts

The `socket.on("message")` callback becomes a thin dispatcher:

```ts
socket.on("message", async (raw: Buffer) => {
  let msg: WsClientMessage;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    send({ type: "error", message: "Invalid JSON" });
    return;
  }

  switch (msg.type) {
    case "get_git_log": return handleGetGitLog(ctx);
    case "rollback": return handleRollback(ctx, msg);
    case "send_message": return handleSendMessage(ctx, msg);
    // ... etc.
  }
});
```

### Migration steps

1. Create `src/server/validation.ts` — move `validateImages`, `resolveFileAttachments`, `formatFileContext` and their constants out of `index.ts`.
2. Create `src/server/ws-handlers/types.ts` with the `HandlerContext` interface.
3. Extract one handler file at a time, starting with the simplest (terminal, file, settings) to validate the pattern, then tackle the complex ones (send-message, github, deploy, threads).
4. After each handler file extraction, run `npm test` to verify.
5. Once all handlers are extracted, refactor the `socket.on("message")` body to the switch dispatcher.
6. Move `AppDeps` and `getContextWindowSize` to remain exported from `index.ts` (they're part of the public API used by tests).

### What stays in index.ts

- `AppDeps` interface and `buildApp()` function (DI setup, manager initialization)
- WebSocket route registration and per-connection state initialization
- `runClaudeWithMessage()` — it's the core orchestration function used by `send_message`, `home_send_with_repo`, and `answer_question`. It stays in `index.ts` (or moves to `ws-handlers/send-message.ts` alongside those three handlers).
- Event wiring (viteManager, fileWatcher, deploymentManager, authManager events)
- `getContextWindowSize()`, `agentEventToClaudeEvent()` — small utilities used only in the message handling path
- The startup block at the bottom

### Special consideration: `runClaudeWithMessage` and `answer_question`

`runClaudeWithMessage` (~300 lines) captures per-connection closure variables (`claude`, `activeAgentId`, `turnSummary`, `accumulatedText`, `accumulatedToolUse`, `isClaudeRunning`, `messageQueue`, `wasInterrupted`). The `answer_question` handler also wires up a full `claude.on("event")` listener tree (~150 lines) that duplicates logic from `runClaudeWithMessage`.

Approach: move `runClaudeWithMessage` and the three handlers that call it (`send_message`, `home_send_with_repo`, `answer_question`) into `ws-handlers/send-message.ts`. The per-connection mutable state (`claude`, `isClaudeRunning`, etc.) is accessed via `HandlerContext` getters/setters. The duplicated event wiring in `answer_question` should be refactored to reuse `runClaudeWithMessage` — but that's a logic change, so it's deferred to a follow-up.

---

## Split 3: `src/client/App.tsx` → custom hooks

### Current structure

`App.tsx` is one 2,216-line function component containing:

- **80+ `useState` / `useRef` calls** (lines 113–214)
- **6 `useEffect` hooks** for keyboard shortcuts, connection sync, PR polling, template loading, disconnection handling, URL sync (lines 217–390)
- **1 massive `useEffect`** processing 60+ WebSocket message types (lines 393–1094)
- **30+ `useCallback` handlers** wrapping `send()` calls (lines 1110–1710)
- **JSX** for the right panel, chat panel, header, modals, overlays (lines 1710–2216)

### New file structure

```
src/client/
  App.tsx                        Main component — state declarations, layout JSX (~500 lines)
  hooks/
    useMessageHandler.ts         The big useEffect that processes lastMessage (~700 lines)
    useAppCallbacks.ts           All useCallback handlers grouped together (~600 lines)
    useKeyboardShortcuts.ts      Ctrl+F, ?, Escape handlers (~60 lines)
    useConnectionSync.ts         Reconnect, history reload, PR polling (~100 lines)
    useAutoFix.ts                Auto-fix preview errors logic (~80 lines)
  utils/
    local-storage.ts             getSaved*/save* helpers for localStorage (~60 lines)
```

### Why not useReducer or Context

Adding `useReducer` or React Context would be a logic change that alters the data flow. The goal of this split is to reduce file size while preserving exact behavior. The hooks extract code mechanically:

- `useMessageHandler` receives all the state setters as parameters and returns nothing. It's a pure extraction of the `useEffect` body.
- `useAppCallbacks` receives `send`, state, and setters, and returns the named callbacks. Same functions, just in a different file.
- `useKeyboardShortcuts` receives the state it depends on and attaches window listeners.

The refactor to useReducer/Context is valuable but belongs in a separate follow-up where we can also add tests for the state transitions.

### useMessageHandler signature

```ts
export function useMessageHandler(params: {
  lastMessage: MessageEvent | null;
  send: (msg: WsClientMessage) => void;
  // State setters — every setX used in the current useEffect
  setPreview: Dispatch<SetStateAction<PreviewStatus | null>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  // ... all other setters ...
  // Refs
  prDescGeneratingRef: MutableRefObject<boolean>;
  // Dependencies from other hooks
  rightTab: RightTab;
  viewingFile: string | null;
  notify: (msg: string) => void;
  navigate: NavigateFunction;
  handleSessionResume: (sessionId: string) => void;
}): void {
  useEffect(() => {
    // ... body moved verbatim from App.tsx lines 393-1094
  }, [params.lastMessage, params.send, /* ... */]);
}
```

### useAppCallbacks signature

```ts
export function useAppCallbacks(params: {
  send: (msg: WsClientMessage) => void;
  // State + setters needed by callbacks
  sessionIdRef: MutableRefObject<string | undefined>;
  permissionMode: PermissionMode;
  pendingFiles: FileContextRef[];
  // ... etc.
}): {
  handleSend: (text: string, images?: ImageData[]) => void;
  handleInterrupt: () => void;
  handleEditMessage: (idx: number, newText: string) => void;
  handleSessionResume: (sessionId: string) => void;
  handleSessionNew: () => void;
  // ... all other callbacks
} {
  // ... each useCallback moved verbatim
}
```

### Migration steps

1. Create `src/client/utils/local-storage.ts` — move the 6 localStorage helper functions out of `App.tsx`.
2. Create `src/client/hooks/useKeyboardShortcuts.ts` — extract the Ctrl+F, ?, and Escape `useEffect` hooks.
3. Create `src/client/hooks/useConnectionSync.ts` — extract the WebSocket reconnect, PR polling, and template loading effects.
4. Create `src/client/hooks/useAutoFix.ts` — extract the auto-fix preview error logic.
5. Create `src/client/hooks/useMessageHandler.ts` — extract the massive WebSocket message `useEffect`.
6. Create `src/client/hooks/useAppCallbacks.ts` — extract all `useCallback` handlers.
7. `App.tsx` now only has: state declarations, hook invocations, and JSX.
8. Run `npm test && npm run typecheck && npm run lint` after each step.

### What stays in App.tsx

- All `useState` / `useRef` declarations (they define the component's state shape)
- `useMemo` for `checkpointDividers`
- `rightPanel` and `chatPanel` JSX blocks
- The return JSX (layout, header, modals, overlays)
- Hook invocations for the extracted hooks

---

## Execution order

1. **types.ts** — no runtime changes, just moving type definitions. Lowest risk.
2. **index.ts** — runtime code moves, but each handler is independently testable. Integration tests catch regressions.
3. **App.tsx** — client-side hook extraction. Component tests + manual smoke test catch regressions.

Each split is one PR (or one logical commit sequence). They can be done independently but the recommended order avoids having to re-split imports.

## Verification

After all three splits:

- `npm test` — all existing tests pass
- `npm run typecheck` — no type errors
- `npm run lint` — no lint errors
- `npm run build` — client builds successfully
- No file in `src/server/` or `src/client/` exceeds ~700 lines (excluding test files)
- Every existing `import from "./types.js"` still works via re-export
