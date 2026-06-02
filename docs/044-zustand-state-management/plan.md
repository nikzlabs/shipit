
# 044: Zustand State Management Migration

## Problem

`App.tsx` is a god component that owns **74 `useState` calls** and delegates behavior to four custom hooks via massive parameter objects. The codebase splitting in doc 038 moved code into separate files but preserved the data flow: every setter is threaded from `App.tsx` into hooks as explicit parameters. This creates five concrete problems:

### 1. Massive parameter threading

`useAppCallbacks` accepts **~75 fields** (65 setters + state values + refs). `useMessageHandler` accepts **~60 fields**. Adding a feature means adding a `useState` to App.tsx, then threading the setter into 2-3 hook param objects — 5 touch points per new piece of state.

### 2. Heavy setter duplication across hooks

**51 setters** are passed to both `useAppCallbacks` and `useMessageHandler`. **14 setters** are shared with `useConnectionSync`. The same `setMessages`, `setIsLoading`, `setGitCommits`, `setFileTree`, etc. appear in 2-3 hook parameter lists.

### 3. Duplicated session-reset logic

The pattern of resetting ~15 state variables on session transition appears in **three places**:
- `resumeSessionInternal` in `useAppCallbacks.ts:148-168`
- `handleSessionNew` in `useAppCallbacks.ts:293-319`
- URL-change `useEffect` in `App.tsx:289-316`

Adding a new piece of session state requires updating all three.

### 4. All-or-nothing callback creation

All 62 `useCallback` wrappers in `useAppCallbacks` are created on every render, regardless of which components are mounted. A component needing only `handleSend` triggers creation of 61 unused callbacks.

### 5. Stale closure risk

`useCallback` dependency arrays in `useAppCallbacks` list 10-16 items each. Missing one causes a stale closure bug. The arrays are long enough that correctness is hard to audit.

---

## Why Zustand

| Approach | Eliminates threading | Selective re-renders | Migration effort | New concepts |
|----------|---------------------|---------------------|-----------------|--------------|
| **Session-reset helper** | No | No | Low | None |
| **useReducer** | Reduces (dispatch vs. N setters) | No | Medium | Action types |
| **React Context slices** | Yes | No (full subtree re-renders) | Medium | 8-10 providers |
| **Zustand** | Yes | Yes (selector-based) | Medium | Store + selectors |

Zustand wins on the combination of:

- **No providers** — components import the store directly, no wrapper nesting in App.tsx
- **Selector-based subscriptions** — `useDeployStore(s => s.deployStatus)` only re-renders when `deployStatus` changes, not when the other 73 state fields update
- **Actions co-located with state** — callbacks become store actions that live next to the state they modify. `useAppCallbacks` disappears entirely
- **Works outside React** — store actions can be called directly in tests without `renderHook`. WS message handler becomes a plain function calling store actions
- **Tiny bundle** — ~1KB gzipped, no additional runtime overhead
- **React 19 compatible** — works with concurrent features and the new JSX transform

### What changes

| Before | After |
|--------|-------|
| 74 `useState` in App.tsx | 0 — state lives in domain stores |
| `useAppCallbacks` (1,027 lines, 62 callbacks) | Deleted — actions live in stores |
| `useMessageHandler` (829 lines, 60+ setter params) | Thin dispatcher calling store actions |
| `useConnectionSync` (172 lines, 14 setter params) | Hook calling store actions directly |
| Components receive callbacks via props from App | Components import store hooks directly |

### What stays the same

- Component tree structure and JSX layout
- Server-side code (no changes)
- WebSocket protocol and HTTP API
- All existing test assertions (behavior unchanged)
- Hooks that don't touch global state (`useResizablePanel`, `useSearch`, `useTheme`, `useNotification`, `usePreviewErrors`, `useIsMobile`)

---

## Store Architecture

### Domain stores

```
src/client/stores/
  session-store.ts      Core session lifecycle (messages, loading, activity, agent selection)
  git-store.ts          Git state (commits, identity, diff review)
  preview-store.ts      Preview status, port selection, config, install status
  file-store.ts         File tree, file viewer, docs, file change tracking
  deploy-store.ts       Deploy targets, config, status, history, modal
  pr-store.ts           PR status, branches, result, description generation, modal
  thread-store.ts       Threads, active thread, checkpoints
  settings-store.ts     System prompt, permission mode, github auth
  terminal-store.ts     Log entries, unread count, terminal mode, shell state
  ui-store.ts           Right tab, sidebar, mobile panel, search, modals, toast, templates, usage
```

### Store structure pattern

Each store follows the same pattern: state + actions, created with `create`:

```ts
import { create } from "zustand";

interface DeployState {
  // ── State ──
  showModal: boolean;
  targets: DeployTargetInfo[];
  configStatus: Record<string, { configured: boolean; projectName?: string }>;
  status: DeployPhase | null;
  lastUrl: string | null;
  lastError: string | null;
  history: DeploymentRecord[];

  // ── Actions ──
  openModal: () => void;
  closeModal: () => void;
  setStatus: (phase: DeployPhase | null) => void;
  setTargets: (targets: DeployTargetInfo[]) => void;
  setConfigStatus: (status: Record<string, { configured: boolean; projectName?: string }>) => void;
  setLastUrl: (url: string | null) => void;
  setLastError: (error: string | null) => void;
  setHistory: (history: DeploymentRecord[]) => void;
  reset: () => void;

  // ── Async actions (API calls) ──
  fetchSetup: (sessionId: string) => Promise<void>;
  configure: (sessionId: string, targetId: string, credentials: Record<string, string>, projectName?: string) => Promise<void>;
  deleteConfig: (sessionId: string, targetId: string) => Promise<void>;
  fetchHistory: (sessionId: string) => Promise<void>;
}

const initialState = {
  showModal: false,
  targets: [],
  configStatus: {},
  status: null,
  lastUrl: null,
  lastError: null,
  history: [],
};

export const useDeployStore = create<DeployState>((set, get) => ({
  ...initialState,

  openModal: () => set({ showModal: true, status: null, lastUrl: null, lastError: null }),
  closeModal: () => set({ showModal: false }),
  setStatus: (status) => set({ status }),
  setTargets: (targets) => set({ targets }),
  setConfigStatus: (configStatus) => set({ configStatus }),
  setLastUrl: (lastUrl) => set({ lastUrl }),
  setLastError: (lastError) => set({ lastError }),
  setHistory: (history) => set({ history }),
  reset: () => set(initialState),

  fetchSetup: async (sessionId) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/deploy/setup`);
      const data = await res.json();
      set({ targets: data.targets, configStatus: data.projectSettings });
    } catch (err) {
      console.error("[api] Failed to fetch deploy setup:", err);
    }
  },

  configure: async (sessionId, targetId, credentials, projectName) => {
    try {
      await fetch(`/api/sessions/${sessionId}/deploy/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, credentials, projectName }),
      });
      await get().fetchSetup(sessionId);
    } catch (err) {
      console.error("[api] Deploy configure failed:", err);
    }
  },

  deleteConfig: async (sessionId, targetId) => {
    try {
      await fetch(`/api/sessions/${sessionId}/deploy/config/${targetId}`, { method: "DELETE" });
      await get().fetchSetup(sessionId);
    } catch (err) {
      console.error("[api] Deploy delete config failed:", err);
    }
  },

  fetchHistory: async (sessionId) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/deploy/history`);
      const data = await res.json();
      set({ history: data.deployments });
    } catch (err) {
      console.error("[api] Failed to fetch deploy history:", err);
    }
  },
}));
```

### Cross-store dependencies

Some actions span multiple stores (e.g., `handleSessionNew` resets session, git, file, thread, and terminal state). These are handled by **orchestration functions** — plain functions that call actions on multiple stores:

```ts
// src/client/stores/actions/session-actions.ts
import { useSessionStore } from "../session-store.js";
import { useGitStore } from "../git-store.js";
import { useFileStore } from "../file-store.js";
import { useThreadStore } from "../thread-store.js";
import { useTerminalStore } from "../terminal-store.js";

export function resetSessionState() {
  useSessionStore.getState().reset();
  useGitStore.getState().reset();
  useFileStore.getState().reset();
  useThreadStore.getState().reset();
  useTerminalStore.getState().reset();
}

export function newSession(send: (msg: WsClientMessage) => void, navigate: NavigateFunction) {
  resetSessionState();
  useSessionStore.getState().setShowTemplates(true);
  navigate("/");
  send({ type: "new_session" });
}
```

This collapses the three duplicated reset locations into one `resetSessionState()` call.

### Session URL sync invariant

For `/session/:sessionId`, the route parameter is authoritative over
`useSessionStore.sessionId`. The URL-sync effect in `App.tsx` intentionally
depends on both `urlSessionId` and the store `sessionId`, because late async
writers such as session claims or history loads can update the store after the
user has already navigated. When this happens, the effect must re-run and call
`resumeSessionInternal(urlSessionId)` so the visible UI, sidebar selection, and
per-session WebSocket converge back to the URL.

The `/repo/:owner/:repo/new` route is the exception: it has no session ID in
the URL until a warm/claimed session is adopted, so it may temporarily use the
store `sessionId`. Entering a new-session route clears any previously selected
session once; after the claim resolves, the claimed session is allowed to remain
active while the URL stays on `/new`.

`loadSessionHistory(sessionId)` must also treat its `sessionId` argument as a
stale-response token. Before applying history, preview status, or delayed
preview retries, it verifies that `useSessionStore.sessionId` still matches the
requested session. This prevents an old HTTP response from repainting messages,
git/file state, or preview state after a session switch.

### WebSocket and send()

The `send` function (from `useWebSocket`) and `navigate` (from React Router) cannot live in Zustand stores because they're tied to React hook lifecycle. Two options:

**Option A: Pass as action parameters.** Actions that need `send` accept it as a parameter: `handleSend(send, text, images)`. Components call `const send = useWebSocket().send; store.handleSend(send, text)`.

**Option B: Register at connect time.** The WS hook registers `send` into a shared ref on connect:

```ts
// src/client/stores/ws-bridge.ts
let sendFn: ((msg: WsClientMessage) => void) | null = null;
export function registerSend(fn: (msg: WsClientMessage) => void) { sendFn = fn; }
export function getSend() { return sendFn!; }
```

Store actions call `getSend()` instead of receiving `send` as a parameter. This keeps action signatures clean but adds a module-level mutable reference.

**Recommendation:** Start with Option A (explicit parameters) for safety. Migrate to Option B later if the parameter threading becomes unwieldy.

### WS message dispatch

`useMessageHandler` becomes a thin dispatcher that routes incoming WS messages to store actions:

```ts
// src/client/hooks/useMessageHandler.ts (after migration)
export function useMessageHandler(lastMessage: MessageEvent | null) {
  useEffect(() => {
    if (!lastMessage) return;
    const data = JSON.parse(lastMessage.data) as WsServerMessage;

    switch (data.type) {
      case "preview_status":
        usePreviewStore.getState().setPreview(data);
        break;
      case "git_log":
        useGitStore.getState().setCommits(data.commits);
        break;
      case "deploy_status":
        useDeployStore.getState().setStatus(data.phase);
        break;
      case "agent_event":
        useSessionStore.getState().handleAgentEvent(data.event);
        break;
      // ... each case is 1-3 lines calling a store action
    }
  }, [lastMessage]);
}
```

No setter parameters needed. The hook imports stores directly.

---

## State Mapping: Current → Stores

### session-store.ts (8 variables)

| Current useState | Store field | Notes |
|-----------------|------------|-------|
| `messages` | `messages` | |
| `isLoading` | `isLoading` | |
| `activity` | `activity` | |
| `selectedRepoUrl` | `selectedRepoUrl` | |
| `creatingRepo` | `creatingRepo` | |
| `sessions` | `sessions` | Session list for sidebar |
| `authUrl` | `authUrl` | Auth overlay state |
| `activeRunnerSessions` | `activeRunnerSessions` | Sidebar activity indicators |

### git-store.ts (5 variables)

| Current useState | Store field | Notes |
|-----------------|------------|-------|
| `gitCommits` | `commits` | |
| `gitIdentityNeeded` | `identityNeeded` | |
| `gitIdentity` | `identity` | |
| `lastCommitPair` | `lastCommitPair` | For diff review |
| `turnDiff` | `turnDiff` | Diff panel data |

### preview-store.ts (4 variables)

| Current useState | Store field | Notes |
|-----------------|------------|-------|
| `preview` | `status` | |
| `selectedPort` | `selectedPort` | |
| `configMissing` | `configMissing` | |
| `installStatus` | `installStatus` | |

### file-store.ts (8 variables)

| Current useState | Store field | Notes |
|-----------------|------------|-------|
| `fileTree` | `tree` | |
| `viewingFile` | `viewingFile` | |
| `viewingFileContent` | `viewingFileContent` | |
| `viewingFileBinary` | `viewingFileBinary` | |
| `docFiles` | `docFiles` | |
| `selectedDoc` | `selectedDoc` | |
| `docContent` | `docContent` | |
| `fileChangeCount` | `changeCount` | Badge counter |

### deploy-store.ts (7 variables)

| Current useState | Store field | Notes |
|-----------------|------------|-------|
| `showDeployModal` | `showModal` | |
| `deployTargets` | `targets` | |
| `deployConfigStatus` | `configStatus` | |
| `deployStatus` | `status` | |
| `lastDeployUrl` | `lastUrl` | |
| `lastDeployError` | `lastError` | |
| `deployHistory` | `history` | |

### pr-store.ts (10 variables)

| Current useState | Store field | Notes |
|-----------------|------------|-------|
| `showPRModal` | `showModal` | |
| `prCurrentBranch` | `currentBranch` | |
| `prRemoteBranches` | `remoteBranches` | |
| `prResult` | `result` | |
| `prDescGenerating` | `descGenerating` | |
| `prDescError` | `descError` | |
| `prGeneratedDesc` | `generatedDesc` | |
| `importSearchResults` | `importSearchResults` | Also used by home screen |
| `prStatus` | `status` | PR status bar |
| `queuedMessages` | — | Moves to session-store |

### thread-store.ts (2 variables)

| Current useState | Store field | Notes |
|-----------------|------------|-------|
| `threads` | `threads` | |
| `activeThreadId` | `activeThreadId` | |

### settings-store.ts (5 variables)

| Current useState | Store field | Notes |
|-----------------|------------|-------|
| `hasSystemPrompt` | `hasSystemPrompt` | |
| `systemPromptContent` | `systemPromptContent` | |
| `permissionMode` | `permissionMode` | |
| `githubStatus` | `githubStatus` | |
| `pendingFiles` | `pendingFiles` | File context attachments |

### terminal-store.ts (4 variables)

| Current useState | Store field | Notes |
|-----------------|------------|-------|
| `logEntries` | `entries` | |
| `unreadLogCount` | `unreadCount` | |
| `terminalMode` | `mode` | |
| `shellStarted` | `shellStarted` | |

### ui-store.ts (14 variables)

| Current useState | Store field | Notes |
|-----------------|------------|-------|
| `rightTab` | `rightTab` | |
| `mobilePanel` | `mobilePanel` | |
| `showTemplates` | `showTemplates` | |
| `templates` | `templates` | |
| `agentList` | `agentList` | |
| `activeAgentId` | `activeAgentId` | |
| `showUsageModal` | `showUsageModal` | |
| `currentSessionUsage` | `currentSessionUsage` | |
| `allUsageStats` | `allUsageStats` | |
| `modelInfo` | `modelInfo` | |
| `contextTokens` | `contextTokens` | |
| `turnTokens` | `turnTokens` | |
| `settingsOpen` | `settingsOpen` | |
| `initialSettingsTab` | `initialSettingsTab` | |
| `sidebarCollapsed` | `sidebarCollapsed` | |
| `toast` | `toast` | |
| `diffBadgeCount` | `diffBadgeCount` | |
| `features` | `features` | |
| `searchOpen` | `searchOpen` | Stays local — `useSearch` manages |
| `shortcutsOpen` | `shortcutsOpen` | Stays local — keyboard overlay |

### Remaining in App.tsx (4 variables)

These stay as local `useState` because they're purely local to the component:

| Variable | Reason |
|----------|--------|
| `searchOpen` | Only used by App.tsx + `useKeyboardShortcuts` |
| `shortcutsOpen` | Only used by App.tsx + `useKeyboardShortcuts` |

### Remaining as refs

| Ref | Location | Notes |
|-----|----------|-------|
| `sessionIdRef` | `session-store.ts` as plain state | No longer needs ref — Zustand state is always current |
| `historyLoadedRef` | `useConnectionSync` | Stays as ref — lifecycle tracking |
| `prDescGeneratingRef` | Eliminated | `pr-store` state is always current via `getState()` |
| `autoFixRetriesRef` | Eliminated | Same — `getState()` replaces ref |
| `terminalRef` | Stays as ref | React component handle, not app state |

---

## Migration Strategy

### Guiding principles

1. **One store at a time** — each phase extracts one domain store, keeps tests green, and is independently mergeable.
2. **Coexistence** — during migration, some state lives in Zustand and some in `useState`. Components and hooks can read from both. No big-bang switchover.
3. **Tests stay green** — run `npm test && npm run typecheck && npm run lint` after each phase.
4. **No behavior changes** — the migration is purely structural. No new features, no UX changes.
5. **Delete as you go** — when a `useState` moves to a store, remove it from App.tsx and from every hook param list immediately. Don't leave dead code.

### Phase order rationale

Start with the most self-contained domains (fewest cross-store dependencies), build confidence, then tackle the interconnected ones:

```
Phase 0: Setup (install zustand, create store scaffold)
Phase 1: deploy-store       (7 vars, fully self-contained, 0 cross-store deps)
Phase 2: pr-store            (10 vars, self-contained except importSearchResults)
Phase 3: terminal-store      (4 vars, simple, no cross-store deps)
Phase 4: preview-store       (4 vars, receives WS events only)
Phase 5: thread-store        (2 vars, used by session reset)
Phase 6: file-store           (8 vars, WS-driven updates)
Phase 7: settings-store       (5 vars, bootstrap + settings modal)
Phase 8: git-store             (5 vars, WS events + session reset)
Phase 9: ui-store              (14+ vars, collects remaining UI state)
Phase 10: session-store        (8 vars, core — messages, loading, sessions)
Phase 11: Cleanup              (delete useAppCallbacks, simplify useMessageHandler, update App.tsx)
```

---

## Phase Details

### Phase 0: Setup

- Install `zustand` as a dependency
- Create `src/client/stores/` directory
- Create a minimal store (e.g., `deploy-store.ts`) to validate the pattern builds and typechecks
- Verify `npm test && npm run typecheck && npm run build` all pass with the new dependency

### Phase 1: deploy-store (7 variables)

**Extract:** `showDeployModal`, `deployTargets`, `deployConfigStatus`, `deployStatus`, `lastDeployUrl`, `lastDeployError`, `deployHistory`

**Move callbacks:** `handleDeployOpen`, `handleDeployConfigure`, `handleDeployInitiate`, `handleDeployCancel`, `handleDeployGetHistory`, `handleDeployDeleteConfig`, `handleDeploySendError`, `handleDeployTabSelected` → store actions

**Update consumers:**
- `DeployModal` imports `useDeployStore` directly instead of receiving props
- `useMessageHandler` calls `useDeployStore.getState().setStatus(...)` for WS messages `deploy_status`, `deploy_complete`, `deploy_error`
- Remove 7 `useState` calls and ~8 setter params from `useAppCallbacks` and `useMessageHandler`

**Tests:**
- Add `deploy-store.test.ts` — unit test each action
- Update integration tests if any assert on deploy WS messages
- Verify `DeployModal` component tests still pass

### Phase 2: pr-store (10 variables)

**Extract:** `showPRModal`, `prCurrentBranch`, `prRemoteBranches`, `prResult`, `prDescGenerating`, `prDescError`, `prGeneratedDesc`, `importSearchResults`, `prStatus`, plus `prDescGeneratingRef` (eliminated — use `getState()`)

**Move callbacks:** `handlePROpen`, `handlePRSubmit`, `handlePRRequestBranches`, `handlePRGenerateDescription`, `handleMergePr`, `handleImportSearch` → store actions

**Update consumers:**
- `PullRequestModal`, `PrStatusBar`, `HomeScreen` import `usePrStore`
- `useMessageHandler` calls store actions for `session_started` (PR thread load), `github_status`, etc.
- `useConnectionSync` calls `usePrStore.getState().fetchStatus(...)` instead of receiving `setPrStatus`
- Remove 10 `useState` calls, eliminate `prDescGeneratingRef`

### Phase 3: terminal-store (4 variables)

**Extract:** `logEntries`, `unreadLogCount`, `terminalMode`, `shellStarted`

**Move callbacks:** `handleClearLogs`, `handleTerminalInput`, `handleTerminalResize`, `handleTerminalStart`, `handleTerminalModeChange` → store actions

**Update consumers:**
- `TerminalPanel` and `InteractiveTerminal` import `useTerminalStore`
- `useMessageHandler` calls store actions for `log_entry`, `clear_logs`, `terminal_exit`

### Phase 4: preview-store (4 variables)

**Extract:** `preview`, `selectedPort`, `configMissing`, `installStatus`

**Move callbacks:** `handleSelectPort` → store action

**Update consumers:**
- `PreviewFrame` imports `usePreviewStore`
- `useMessageHandler` calls store actions for `preview_status`, `preview_config_missing`, `install_status`

### Phase 5: thread-store (2 variables)

**Extract:** `threads`, `activeThreadId`

**Move callbacks:** `handleCreateCheckpoint`, `handleForkThread`, `handleSwitchThread` → store actions

**Update consumers:**
- `ThreadIndicator`, `ThreadTimeline` import `useThreadStore`
- `useMessageHandler` calls store actions for `thread_list`, `thread_forked`, `thread_switched`
- Session reset orchestration calls `useThreadStore.getState().reset()`

### Phase 6: file-store (8 variables)

**Extract:** `fileTree`, `viewingFile`, `viewingFileContent`, `viewingFileBinary`, `docFiles`, `selectedDoc`, `docContent`, `fileChangeCount`

**Move callbacks:** `handleFileClick`, `handleFileViewerClose`, `handleFileTreeRefresh`, `handleDocSelect`, `handleDocRefresh`, `handleAddFile` → store actions

**Update consumers:**
- `FileTree`, `FileContentViewer`, `DocsViewer` import `useFileStore`
- `useMessageHandler` calls store actions for `file_tree`, `files_changed`
- Tab change logic (docs/files lazy-load) moves into store actions

### Phase 7: settings-store (5 variables)

**Extract:** `hasSystemPrompt`, `systemPromptContent`, `permissionMode`, `githubStatus`, `pendingFiles`

**Move callbacks:** `handleInstructionsSave`, `handleGitHubTokenSubmit`, `handleGitHubLogout`, `handlePermissionModeChange`, `handleRemoveFile`, `handleSettingsOpen`, `handleGitIdentitySubmit` → store actions

**Update consumers:**
- `Settings`, `MessageInput`, `HomeScreen` import `useSettingsStore`
- `useConnectionSync` bootstrap populates `useSettingsStore.getState()`
- `useMessageHandler` calls store actions for `global_settings`, `github_status`

### Phase 8: git-store (5 variables)

**Extract:** `gitCommits`, `gitIdentityNeeded`, `gitIdentity`, `lastCommitPair`, `turnDiff`

**Move callbacks:** `handleGitRefresh`, `handleRollback`, `handleDiffAcceptAll`, `handleDiffRejectFiles`, `handleDiffClose` → store actions

**Update consumers:**
- `GitHistory`, `DiffPanel`, `GitIdentityOverlay` import `useGitStore`
- `useMessageHandler` calls store actions for `git_log`, `git_committed`, `git_identity_required`, `turn_diff`

### Phase 9: ui-store (14+ variables)

**Extract:** `rightTab`, `mobilePanel`, `showTemplates`, `templates`, `agentList`, `activeAgentId`, `showUsageModal`, `currentSessionUsage`, `allUsageStats`, `modelInfo`, `contextTokens`, `turnTokens`, `settingsOpen`, `initialSettingsTab`, `sidebarCollapsed`, `toast`, `diffBadgeCount`, `features`

**Move callbacks:** `handleTabChange`, `handleAgentChange`, `handleUsageBadgeClick`, `handleFeatureRefresh`, `handleFeatureStartSession`, `handleCancelQueued` → store actions

**Update consumers:**
- Header buttons, tab bar, `StatusBar`, `AgentPicker`, `UsageModal`, `FeaturesPanel`, `Toast` import `useUiStore`
- `useMessageHandler` calls store actions for `usage_update`, `model_info`, `agent_list`, `session_list`

### Phase 10: session-store (8 variables)

**Extract:** `messages`, `isLoading`, `activity`, `selectedRepoUrl`, `creatingRepo`, `sessions`, `authUrl`, `activeRunnerSessions`, `queuedMessages`, plus `sessionIdRef` (becomes plain state)

**Move callbacks:** `handleSend`, `handleInterrupt`, `handleEditMessage`, `handleAnswerQuestion`, `handleSessionResume`, `handleSessionNew`, `handleSessionArchive`, `handleSessionRename`, `handleSessionRefresh`, `handleHomeSendWithRepo`, `handleHomeCreateRepo`, `handleSendErrors`, `handleFullReset` → store actions + orchestration functions

**Create orchestration:** `resetSessionState()` calls `.reset()` on session, git, file, thread, terminal stores — replaces the three duplicated reset blocks.

**Update consumers:**
- `MessageList`, `MessageInput`, `SessionSidebar`, `HomeScreen`, `AuthOverlay` import `useSessionStore`
- `useMessageHandler` calls store actions for `claude_event`, `agent_event`, `error`, `session_started`, `session_list`, `chat_history`, `claude_interrupted`, `session_status`, `auth_required`, `auth_complete`, `full_reset_complete`
- `useConnectionSync` calls store actions for bootstrap and reconnect
- `autoFixRetriesRef` eliminated — use `getState()`

### Phase 11: Cleanup

- **Delete** `src/client/hooks/useAppCallbacks.ts` (entire file — all callbacks now live in stores)
- **Simplify** `useMessageHandler` to a thin WS dispatcher (~100 lines, no params)
- **Simplify** `useConnectionSync` to import stores directly (~50 lines, minimal params)
- **Simplify** `App.tsx` to a layout shell: hook invocations + JSX (~300 lines, 2-4 local `useState` for search/shortcuts)
- Remove dead type imports across all files
- Run full test suite, typecheck, lint, build

---

## Testing Strategy

### Store unit tests

Each store gets a `*.test.ts` file testing:
- Initial state shape
- Each action mutates state correctly
- `reset()` returns to initial state
- Async actions (API calls) update state on success and handle errors

Example:

```ts
// src/client/stores/deploy-store.test.ts
import { useDeployStore } from "./deploy-store.js";

beforeEach(() => {
  useDeployStore.getState().reset();
});

test("openModal resets status and opens modal", () => {
  useDeployStore.setState({ status: "building", lastError: "old error" });
  useDeployStore.getState().openModal();

  const state = useDeployStore.getState();
  expect(state.showModal).toBe(true);
  expect(state.status).toBeNull();
  expect(state.lastError).toBeNull();
});
```

### Component tests

Existing component tests that use `render(<Component prop={...} />)` will need minor updates:
- Replace prop-based setup with `useXxxStore.setState(...)` before rendering
- Replace `onCallback` prop assertions with store action spying

### Integration tests

Server-side integration tests are unaffected (they test WS/HTTP, not React). Client-side integration tests (if any) may need store reset in `beforeEach`.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Coexistence bugs during partial migration (some state in stores, some in useState) | Each phase is self-contained. A domain either fully lives in a store or fully in useState. No split domains. |
| Store actions calling stale `send()` | Option A (pass as parameter) avoids stale references entirely |
| Cross-store ordering issues | Orchestration functions make the order explicit. Zustand updates are synchronous — no batching surprises. |
| Component tests break from prop removal | Update tests alongside component changes in the same phase. No separate "fix tests" phase. |
| Bundle size increase | Zustand is ~1KB gzipped. The deleted `useAppCallbacks` code offsets this. Net bundle size may decrease. |
| Re-render performance regression | Zustand with selectors is strictly better than useState (fewer re-renders). Monitor with React DevTools Profiler if concerned. |

---

## Success Criteria

After all phases are complete:

- `App.tsx` is under 300 lines (layout shell only)
- `useAppCallbacks.ts` is deleted
- `useMessageHandler.ts` is under 150 lines (thin dispatcher)
- Zero setter parameters are threaded between hooks
- Adding a new piece of state requires touching exactly 2 files: the store and the component
- Session-reset logic exists in exactly one place (`resetSessionState()`)
- All existing tests pass, no new test failures
- `npm test && npm run typecheck && npm run lint && npm run build` all green
