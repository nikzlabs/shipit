# 044 — Zustand State Management Migration: Checklist

## Phase 0: Setup

- [ ] Install `zustand` as a dependency (`npm install zustand`)
- [ ] Create `src/client/stores/` directory
- [ ] Verify `npm test && npm run typecheck && npm run build` pass with the new dependency

## Phase 1: deploy-store (7 variables, 8 callbacks)

### Store creation
- [ ] Create `src/client/stores/deploy-store.ts` with state: `showModal`, `targets`, `configStatus`, `status`, `lastUrl`, `lastError`, `history`
- [ ] Add simple actions: `openModal`, `closeModal`, `setStatus`, `setTargets`, `setConfigStatus`, `setLastUrl`, `setLastError`, `setHistory`, `reset`
- [ ] Add async actions: `fetchSetup`, `configure`, `deleteConfig`, `fetchHistory`

### Migrate callbacks from useAppCallbacks
- [ ] Move `handleDeployOpen` → `openModal` action (includes `fetchSetup` call)
- [ ] Move `handleDeployConfigure` → `configure` action
- [ ] Move `handleDeployInitiate` → keep as inline `send()` call in component (WS-only)
- [ ] Move `handleDeployCancel` → keep as inline `send()` call in component (WS-only)
- [ ] Move `handleDeployGetHistory` → `fetchHistory` action
- [ ] Move `handleDeployDeleteConfig` → `deleteConfig` action
- [ ] Move `handleDeploySendError` → orchestration fn (calls session store's `handleSend`)
- [ ] Move `handleDeployTabSelected` → `fetchSetup` action

### Update consumers
- [ ] `DeployModal` — import `useDeployStore`, remove deploy-related props
- [ ] `Settings` (deploy tab) — import `useDeployStore` for targets/config
- [ ] `App.tsx` header Deploy button — import `useDeployStore().openModal`
- [ ] `useMessageHandler` — replace `setDeployStatus`, `setLastDeployUrl`, `setLastDeployError` with `useDeployStore.getState()` calls for WS messages: `deploy_status`, `deploy_complete`, `deploy_error`

### Cleanup
- [ ] Remove 7 `useState` calls from `App.tsx`: `showDeployModal`, `deployTargets`, `deployConfigStatus`, `deployStatus`, `lastDeployUrl`, `lastDeployError`, `deployHistory`
- [ ] Remove corresponding setter params from `useAppCallbacks` param type and destructure
- [ ] Remove corresponding setter params from `useMessageHandler` param type and destructure
- [ ] Remove 8 deploy callbacks from `useAppCallbacks` return object

### Tests
- [ ] Create `src/client/stores/deploy-store.test.ts` — unit test each action and reset
- [ ] Update `DeployModal` component test (if exists) to use `useDeployStore.setState()`
- [ ] Run `npm test && npm run typecheck && npm run lint`

## Phase 2: pr-store (10 variables, 6 callbacks)

### Store creation
- [ ] Create `src/client/stores/pr-store.ts` with state: `showModal`, `currentBranch`, `remoteBranches`, `result`, `descGenerating`, `descError`, `generatedDesc`, `importSearchResults`, `status`, `queuedMessages`
- [ ] Add simple actions: `openModal`, `closeModal`, `setResult`, `setStatus`, `setImportSearchResults`, `setQueuedMessages`, `reset`
- [ ] Add async actions: `submit`, `requestBranches`, `generateDescription`, `searchRepos`, `mergePr`, `fetchStatus`

### Migrate callbacks from useAppCallbacks
- [ ] Move `handlePROpen` → `openModal` action
- [ ] Move `handlePRSubmit` → `submit` action
- [ ] Move `handlePRRequestBranches` → `requestBranches` action
- [ ] Move `handlePRGenerateDescription` → `generateDescription` action
- [ ] Move `handleMergePr` → `mergePr` action
- [ ] Move `handleImportSearch` → `searchRepos` action

### Update consumers
- [ ] `PullRequestModal` — import `usePrStore`
- [ ] `PrStatusBar` — import `usePrStore` for status + merge action
- [ ] `HomeScreen` — import `usePrStore` for `importSearchResults` and `searchRepos`
- [ ] `App.tsx` header PR button — import `usePrStore().openModal`
- [ ] `useMessageHandler` — replace PR setter calls with store actions for WS messages: `session_started` (PR load), `github_status`
- [ ] `useConnectionSync` — replace `setPrStatus` with `usePrStore.getState().fetchStatus()`

### Cleanup
- [ ] Remove 10 `useState` calls from `App.tsx`
- [ ] Remove `prDescGeneratingRef` (replaced by `getState().descGenerating`)
- [ ] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [ ] Remove 6 PR callbacks from `useAppCallbacks`

### Tests
- [ ] Create `src/client/stores/pr-store.test.ts`
- [ ] Update `PullRequestModal`, `PrStatusBar` component tests
- [ ] Run `npm test && npm run typecheck && npm run lint`

## Phase 3: terminal-store (4 variables, 5 callbacks)

### Store creation
- [ ] Create `src/client/stores/terminal-store.ts` with state: `entries`, `unreadCount`, `mode`, `shellStarted`
- [ ] Add actions: `addEntry`, `clearEntries`, `setMode`, `setShellStarted`, `incrementUnread`, `resetUnread`, `reset`

### Migrate callbacks from useAppCallbacks
- [ ] Move `handleClearLogs` → `clearEntries` action (+ inline `send({ type: "clear_logs" })`)
- [ ] Move `handleTerminalStart` → `setShellStarted(true)` + inline `send({ type: "terminal_start" })`
- [ ] Move `handleTerminalModeChange` → `setMode` action
- [ ] Move `handleTerminalInput` → keep as inline `send()` in component
- [ ] Move `handleTerminalResize` → keep as inline `send()` in component

### Update consumers
- [ ] `TerminalPanel` — import `useTerminalStore`
- [ ] `InteractiveTerminal` — import `useTerminalStore` for `shellStarted`
- [ ] `useMessageHandler` — replace terminal setter calls with store actions for: `log_entry`, `clear_logs`, `terminal_exit`

### Cleanup
- [ ] Remove 4 `useState` calls from `App.tsx`
- [ ] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`
- [ ] Remove 5 terminal callbacks from `useAppCallbacks`

### Tests
- [ ] Create `src/client/stores/terminal-store.test.ts`
- [ ] Update `TerminalPanel` component test (if exists)
- [ ] Run `npm test && npm run typecheck && npm run lint`

## Phase 4: preview-store (4 variables, 1 callback)

### Store creation
- [ ] Create `src/client/stores/preview-store.ts` with state: `status`, `selectedPort`, `configMissing`, `installStatus`
- [ ] Add actions: `setStatus`, `setSelectedPort`, `setConfigMissing`, `setInstallStatus`, `reset`

### Migrate callbacks from useAppCallbacks
- [ ] Move `handleSelectPort` → `setSelectedPort` action

### Update consumers
- [ ] `PreviewFrame` — import `usePreviewStore`
- [ ] `useMessageHandler` — replace preview setter calls with store actions for: `preview_status`, `preview_config_missing`, `preview_config_error`, `install_status`

### Cleanup
- [ ] Remove 4 `useState` calls from `App.tsx`
- [ ] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`

### Tests
- [ ] Create `src/client/stores/preview-store.test.ts`
- [ ] Update `PreviewFrame` component test (if exists)
- [ ] Run `npm test && npm run typecheck && npm run lint`

## Phase 5: thread-store (2 variables, 3 callbacks)

### Store creation
- [ ] Create `src/client/stores/thread-store.ts` with state: `threads`, `activeThreadId`
- [ ] Add actions: `setThreads`, `setActiveThreadId`, `addThread`, `updateThread`, `reset`
- [ ] Add async action: `createCheckpoint`

### Migrate callbacks from useAppCallbacks
- [ ] Move `handleCreateCheckpoint` → `createCheckpoint` action
- [ ] Move `handleForkThread` → inline `send({ type: "fork_thread", checkpointId })` in component
- [ ] Move `handleSwitchThread` → inline `send({ type: "switch_thread", threadId })` in component

### Update consumers
- [ ] `ThreadIndicator` — import `useThreadStore`
- [ ] `ThreadTimeline` — import `useThreadStore`
- [ ] `useMessageHandler` — replace thread setter calls with store actions for: `thread_list`, `thread_forked`, `thread_switched`
- [ ] `useConnectionSync` — replace `setThreads`, `setActiveThreadId` with store actions

### Cleanup
- [ ] Remove 2 `useState` calls from `App.tsx`
- [ ] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [ ] Remove 3 thread callbacks from `useAppCallbacks`

### Tests
- [ ] Create `src/client/stores/thread-store.test.ts`
- [ ] Run `npm test && npm run typecheck && npm run lint`

## Phase 6: file-store (8 variables, 6 callbacks)

### Store creation
- [ ] Create `src/client/stores/file-store.ts` with state: `tree`, `viewingFile`, `viewingFileContent`, `viewingFileBinary`, `docFiles`, `selectedDoc`, `docContent`, `changeCount`
- [ ] Add actions: `setTree`, `setViewingFile`, `closeViewer`, `setDocFiles`, `selectDoc`, `incrementChangeCount`, `resetChangeCount`, `reset`
- [ ] Add async actions: `fetchTree`, `fetchFile`, `fetchDocs`, `fetchDoc`

### Migrate callbacks from useAppCallbacks
- [ ] Move `handleFileClick` → `fetchFile` action
- [ ] Move `handleFileViewerClose` → `closeViewer` action
- [ ] Move `handleFileTreeRefresh` → `fetchTree` action
- [ ] Move `handleDocSelect` → `fetchDoc` action
- [ ] Move `handleDocRefresh` → `fetchDocs` action
- [ ] Move `handleAddFile` → moves to settings-store (`pendingFiles`)

### Update consumers
- [ ] `FileTree` — import `useFileStore`
- [ ] `FileContentViewer` — import `useFileStore`
- [ ] `DocsViewer` — import `useFileStore`
- [ ] `useMessageHandler` — replace file setter calls with store actions for: `file_tree`, `files_changed`, `template_applied`, `git_committed` (file refresh)

### Cleanup
- [ ] Remove 8 `useState` calls from `App.tsx`
- [ ] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [ ] Remove 6 file callbacks from `useAppCallbacks`

### Tests
- [ ] Create `src/client/stores/file-store.test.ts`
- [ ] Update `FileTree`, `DocsViewer` component tests (if exist)
- [ ] Run `npm test && npm run typecheck && npm run lint`

## Phase 7: settings-store (5 variables, 7 callbacks)

### Store creation
- [ ] Create `src/client/stores/settings-store.ts` with state: `hasSystemPrompt`, `systemPromptContent`, `permissionMode`, `githubStatus`, `pendingFiles`
- [ ] Add actions: `setPermissionMode`, `addPendingFile`, `removePendingFile`, `clearPendingFiles`, `setGithubStatus`, `reset`
- [ ] Add async actions: `saveInstructions`, `submitGitHubToken`, `gitHubLogout`, `submitGitIdentity`, `fetchSettings`

### Migrate callbacks from useAppCallbacks
- [ ] Move `handleInstructionsSave` → `saveInstructions` action
- [ ] Move `handleGitHubTokenSubmit` → `submitGitHubToken` action
- [ ] Move `handleGitHubLogout` → `gitHubLogout` action
- [ ] Move `handlePermissionModeChange` → `setPermissionMode` action (includes localStorage save)
- [ ] Move `handleRemoveFile` → `removePendingFile` action
- [ ] Move `handleSettingsOpen` → orchestration fn (opens modal + fetches settings)
- [ ] Move `handleGitIdentitySubmit` → `submitGitIdentity` action

### Update consumers
- [ ] `Settings` — import `useSettingsStore`
- [ ] `MessageInput` — import `useSettingsStore` for `permissionMode`, `pendingFiles`
- [ ] `HomeScreen` — import `useSettingsStore` for `permissionMode`, `pendingFiles`, `githubStatus`
- [ ] `useConnectionSync` — bootstrap populates store via `useSettingsStore.getState()`
- [ ] `useMessageHandler` — replace settings setter calls with store actions for: `global_settings`, `github_status`

### Cleanup
- [ ] Remove 5 `useState` calls from `App.tsx`
- [ ] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [ ] Remove 7 settings callbacks from `useAppCallbacks`

### Tests
- [ ] Create `src/client/stores/settings-store.test.ts`
- [ ] Update component tests that use `permissionMode`, `githubStatus`, `pendingFiles` props
- [ ] Run `npm test && npm run typecheck && npm run lint`

## Phase 8: git-store (5 variables, 5 callbacks)

### Store creation
- [ ] Create `src/client/stores/git-store.ts` with state: `commits`, `identityNeeded`, `identity`, `lastCommitPair`, `turnDiff`
- [ ] Add actions: `setCommits`, `prependCommit`, `setIdentityNeeded`, `setIdentity`, `setLastCommitPair`, `setTurnDiff`, `reset`
- [ ] Add async actions: `fetchLog`, `rollback`, `rejectFiles`

### Migrate callbacks from useAppCallbacks
- [ ] Move `handleGitRefresh` → `fetchLog` action
- [ ] Move `handleRollback` → `rollback` action
- [ ] Move `handleDiffAcceptAll` → `acceptAllDiff` action (clears diff state + switches tab)
- [ ] Move `handleDiffRejectFiles` → `rejectFiles` action
- [ ] Move `handleDiffClose` → ui-store `setRightTab("preview")`

### Update consumers
- [ ] `GitHistory` — import `useGitStore`
- [ ] `DiffPanel` — import `useGitStore`
- [ ] `GitIdentityOverlay` — import `useGitStore`
- [ ] `useMessageHandler` — replace git setter calls with store actions for: `git_log`, `git_committed`, `git_identity_required`, `turn_diff`
- [ ] `useConnectionSync` — replace `setGitCommits` with store action

### Cleanup
- [ ] Remove 5 `useState` calls from `App.tsx` (including `lastCommitPair`, `turnDiff`, `diffBadgeCount` which is coupled)
- [ ] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [ ] Remove 5 git callbacks from `useAppCallbacks`

### Tests
- [ ] Create `src/client/stores/git-store.test.ts`
- [ ] Update `GitHistory` component test (if exists)
- [ ] Run `npm test && npm run typecheck && npm run lint`

## Phase 9: ui-store (14+ variables, 6 callbacks)

### Store creation
- [ ] Create `src/client/stores/ui-store.ts` with state: `rightTab`, `mobilePanel`, `showTemplates`, `templates`, `agentList`, `activeAgentId`, `showUsageModal`, `currentSessionUsage`, `allUsageStats`, `modelInfo`, `contextTokens`, `turnTokens`, `settingsOpen`, `initialSettingsTab`, `sidebarCollapsed`, `toast`, `diffBadgeCount`, `features`
- [ ] Add actions: `setRightTab`, `setMobilePanel`, `setShowTemplates`, `setTemplates`, `setAgentList`, `setActiveAgentId`, `setToast`, `setSidebarCollapsed`, `setDiffBadgeCount`, `reset`
- [ ] Add async actions: `fetchFeatures`, `fetchUsageStats`

### Migrate callbacks from useAppCallbacks
- [ ] Move `handleTabChange` → `setRightTab` action (includes lazy-load side effects)
- [ ] Move `handleAgentChange` → `setActiveAgentId` action (includes localStorage + WS send)
- [ ] Move `handleUsageBadgeClick` → orchestration fn (opens modal + fetches stats)
- [ ] Move `handleFeatureRefresh` → `fetchFeatures` action
- [ ] Move `handleFeatureStartSession` → orchestration fn (resets session + sends message)
- [ ] Move `handleCancelQueued` → inline `send()` in component

### Update consumers
- [ ] Tab bar buttons — import `useUiStore` for `rightTab`, `setRightTab`
- [ ] `StatusBar` — import `useUiStore` for `modelInfo`, `contextTokens`, `agentList`
- [ ] `AgentPicker` — import `useUiStore` for `agentList`, `activeAgentId`
- [ ] `UsageModal` — import `useUiStore` for usage state
- [ ] `FeaturesPanel` — import `useUiStore` for `features`
- [ ] `Toast` — import `useUiStore` for `toast`
- [ ] `QueueIndicator` — import `useUiStore` or session-store for `queuedMessages`
- [ ] `SessionSidebar` — import `useUiStore` for `sidebarCollapsed`
- [ ] `useMessageHandler` — replace UI setter calls with store actions for: `usage_update`, `model_info`, `agent_list`
- [ ] `useConnectionSync` — replace `setAgentList`, `setTemplates` with store actions

### Cleanup
- [ ] Remove 14+ `useState` calls from `App.tsx`
- [ ] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [ ] Remove 6 UI callbacks from `useAppCallbacks`

### Tests
- [ ] Create `src/client/stores/ui-store.test.ts`
- [ ] Update component tests that rely on UI props
- [ ] Run `npm test && npm run typecheck && npm run lint`

## Phase 10: session-store (8 variables, 13 callbacks) — the big one

### Store creation
- [ ] Create `src/client/stores/session-store.ts` with state: `sessionId`, `messages`, `isLoading`, `activity`, `selectedRepoUrl`, `creatingRepo`, `sessions`, `authUrl`, `activeRunnerSessions`, `queuedMessages`
- [ ] Add actions: `setSessionId`, `setMessages`, `appendMessage`, `updateLastMessage`, `setIsLoading`, `setActivity`, `setSessions`, `setAuthUrl`, `setQueuedMessages`, `reset`
- [ ] Add async actions: `resumeSession`, `fetchHistory`, `archiveSession`, `renameSession`, `refreshSessions`, `createRepo`

### Create orchestration functions
- [ ] Create `src/client/stores/actions/session-actions.ts`
- [ ] Implement `resetSessionState()` — calls `.reset()` on session, git, file, thread, terminal stores
- [ ] Implement `newSession(send, navigate)` — resets + navigates + sends WS
- [ ] Implement `resumeSessionInternal(sessionId, send)` — resets + fetches history + activates via WS
- [ ] Implement `handleSessionResume(sessionId, send, navigate)` — resumes + navigates

### Migrate callbacks from useAppCallbacks
- [ ] Move `handleSend` → `sendMessage` action
- [ ] Move `handleInterrupt` → inline `send()` in component
- [ ] Move `handleEditMessage` → `editMessage` action
- [ ] Move `handleAnswerQuestion` → `answerQuestion` action
- [ ] Move `handleSessionResume` → `resumeSession` orchestration
- [ ] Move `handleSessionNew` → `newSession` orchestration
- [ ] Move `handleSessionArchive` → `archiveSession` action
- [ ] Move `handleSessionRename` → `renameSession` action
- [ ] Move `handleSessionRefresh` → `refreshSessions` action
- [ ] Move `handleHomeSendWithRepo` → `sendWithRepo` action
- [ ] Move `handleHomeCreateRepo` → `createRepo` action
- [ ] Move `handleSendErrors` → `sendErrors` action
- [ ] Move `handleFullReset` → `fullReset` action

### Update consumers
- [ ] `MessageList` — import `useSessionStore` for `messages`, `isLoading`, `activity`
- [ ] `MessageInput` — import `useSessionStore` for `isLoading`, `sendMessage`
- [ ] `SessionSidebar` — import `useSessionStore` for `sessions`, `sessionId`, `activeRunnerSessions`
- [ ] `HomeScreen` — import `useSessionStore` for `sessions`, `creatingRepo`, `selectedRepoUrl`
- [ ] `AuthOverlay` — import `useSessionStore` for `authUrl`
- [ ] `useMessageHandler` — replace session setter calls with store actions for: `claude_event`, `agent_event`, `error`, `session_started`, `session_list`, `chat_history`, `claude_interrupted`, `session_status`, `auth_required`, `auth_complete`, `full_reset_complete`, `message_queued`, `queue_updated`
- [ ] `useConnectionSync` — replace `setMessages`, `setIsLoading`, `setActivity`, `setSessions` with store actions
- [ ] `useAutoFix` — import `useSessionStore` for `isLoading`, `setMessages`, `setActivity`

### Cleanup
- [ ] Remove 8+ `useState` calls from `App.tsx`
- [ ] Remove `sessionIdRef` (replaced by store state)
- [ ] Remove `autoFixRetriesRef` (replaced by `getState()`)
- [ ] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [ ] Remove all remaining callbacks from `useAppCallbacks`

### Eliminate URL-sync duplication
- [ ] Replace the URL-change `useEffect` in `App.tsx:289-316` with a call to `resetSessionState()` / `resumeSessionInternal()`

### Tests
- [ ] Create `src/client/stores/session-store.test.ts`
- [ ] Create `src/client/stores/actions/session-actions.test.ts`
- [ ] Update `MessageList`, `MessageInput`, `SessionSidebar` component tests
- [ ] Run `npm test && npm run typecheck && npm run lint`

## Phase 11: Final cleanup

### Delete dead code
- [ ] Delete `src/client/hooks/useAppCallbacks.ts` entirely
- [ ] Verify no imports reference `useAppCallbacks`

### Simplify useMessageHandler
- [ ] Remove all setter params from `useMessageHandler` — it now imports stores directly
- [ ] Reduce to a thin `switch` dispatcher (~100-150 lines, no param object)
- [ ] Remove stale dependency arrays — the `useEffect` only depends on `lastMessage`

### Simplify useConnectionSync
- [ ] Remove all setter params — it now imports stores directly
- [ ] Reduce param object to: `status`, `send` (WS lifecycle only)

### Simplify App.tsx
- [ ] Remove all `useState` calls except `searchOpen` and `shortcutsOpen`
- [ ] Remove the massive hook call sites (useAppCallbacks, useMessageHandler params)
- [ ] App.tsx should be a layout shell: hook invocations + JSX (~300 lines)
- [ ] Remove unused type imports

### Simplify useAutoFix
- [ ] Remove setter params — import `useSessionStore`, `usePreviewStore` directly
- [ ] Reduce param object to: `send` only

### Audit
- [ ] Verify no `Dispatch<SetStateAction<...>>` types remain in hook signatures
- [ ] Verify no stale closure issues — all store access uses `getState()` or selectors
- [ ] Verify `useAppCallbacks` is fully deleted with no references
- [ ] Run `npm test && npm run typecheck && npm run lint && npm run build`
- [ ] Verify App.tsx is under 300 lines
- [ ] Verify useMessageHandler is under 150 lines
- [ ] Verify adding a new piece of state only requires 2 files (store + component)
