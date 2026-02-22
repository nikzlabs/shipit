# 044 — Zustand State Management Migration: Checklist

## Phase 0: Setup

- [x] Install `zustand` as a dependency (`npm install zustand`)
- [x] Create `src/client/stores/` directory
- [x] Verify `npm test && npm run typecheck && npm run build` pass with the new dependency

## Phase 1: deploy-store (7 variables, 8 callbacks)

### Store creation
- [x] Create `src/client/stores/deploy-store.ts` with state: `showModal`, `targets`, `configStatus`, `status`, `lastUrl`, `lastError`, `history`
- [x] Add simple actions: `openModal`, `closeModal`, `setStatus`, `setTargets`, `setConfigStatus`, `setLastUrl`, `setLastError`, `setHistory`, `reset`
- [x] Add async actions: `fetchSetup`, `configure`, `deleteConfig`, `fetchHistory`

### Migrate callbacks from useAppCallbacks
- [x] Move `handleDeployOpen` → `openModal` action (includes `fetchSetup` call)
- [x] Move `handleDeployConfigure` → `configure` action
- [x] Move `handleDeployInitiate` → keep as inline `send()` call in component (WS-only)
- [x] Move `handleDeployCancel` → keep as inline `send()` call in component (WS-only)
- [x] Move `handleDeployGetHistory` → `fetchHistory` action
- [x] Move `handleDeployDeleteConfig` → `deleteConfig` action
- [x] Move `handleDeploySendError` → orchestration fn (calls session store's `handleSend`)
- [x] Move `handleDeployTabSelected` → `fetchSetup` action

### Update consumers
- [x] `DeployModal` — import `useDeployStore`, remove deploy-related props
- [x] `Settings` (deploy tab) — import `useDeployStore` for targets/config
- [x] `App.tsx` header Deploy button — import `useDeployStore().openModal`
- [x] `useMessageHandler` — replace `setDeployStatus`, `setLastDeployUrl`, `setLastDeployError` with `useDeployStore.getState()` calls for WS messages: `deploy_status`, `deploy_complete`, `deploy_error`

### Cleanup
- [x] Remove 7 `useState` calls from `App.tsx`: `showDeployModal`, `deployTargets`, `deployConfigStatus`, `deployStatus`, `lastDeployUrl`, `lastDeployError`, `deployHistory`
- [x] Remove corresponding setter params from `useAppCallbacks` param type and destructure
- [x] Remove corresponding setter params from `useMessageHandler` param type and destructure
- [x] Remove 8 deploy callbacks from `useAppCallbacks` return object

### Tests
- [x] Verify existing tests pass with new store architecture
- [x] Run `npm test && npm run typecheck && npm run lint`

## Phase 2: pr-store (10 variables, 6 callbacks)

### Store creation
- [x] Create `src/client/stores/pr-store.ts` with state: `showModal`, `currentBranch`, `remoteBranches`, `result`, `descGenerating`, `descError`, `generatedDesc`, `importSearchResults`, `status`
- [x] Add simple actions: `openModal`, `closeModal`, `setResult`, `setStatus`, `setImportSearchResults`, `reset`
- [x] Add async actions: `submit`, `requestBranches`, `generateDescription`, `searchRepos`, `mergePr`, `fetchStatus`

### Migrate callbacks from useAppCallbacks
- [x] Move `handlePROpen` → `openModal` action
- [x] Move `handlePRSubmit` → `submit` action
- [x] Move `handlePRRequestBranches` → `requestBranches` action
- [x] Move `handlePRGenerateDescription` → `generateDescription` action
- [x] Move `handleMergePr` → `mergePr` action
- [x] Move `handleImportSearch` → `searchRepos` action

### Update consumers
- [x] `PullRequestModal` — import `usePrStore`
- [x] `PrStatusBar` — import `usePrStore` for status + merge action
- [x] `HomeScreen` — import `usePrStore` for `importSearchResults` and `searchRepos`
- [x] `App.tsx` header PR button — import `usePrStore().openModal`
- [x] `useMessageHandler` — replace PR setter calls with store actions for WS messages
- [x] `useConnectionSync` — replace `setPrStatus` with `usePrStore.getState().fetchStatus()`

### Cleanup
- [x] Remove 10 `useState` calls from `App.tsx`
- [x] Remove `prDescGeneratingRef` (replaced by `getState().descGenerating`)
- [x] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [x] Remove 6 PR callbacks from `useAppCallbacks`

### Tests
- [x] Verify existing tests pass with new store architecture
- [x] Run `npm test && npm run typecheck && npm run lint`

## Phase 3: terminal-store (4 variables, 5 callbacks)

### Store creation
- [x] Create `src/client/stores/terminal-store.ts` with state: `entries`, `unreadCount`, `mode`, `shellStarted`
- [x] Add actions: `addEntry`, `clearEntries`, `setMode`, `setShellStarted`, `incrementUnread`, `resetUnread`, `reset`

### Migrate callbacks from useAppCallbacks
- [x] Move `handleClearLogs` → `clearEntries` action (+ inline `send({ type: "clear_logs" })`)
- [x] Move `handleTerminalStart` → `setShellStarted(true)` + inline `send({ type: "terminal_start" })`
- [x] Move `handleTerminalModeChange` → `setMode` action
- [x] Move `handleTerminalInput` → keep as inline `send()` in component
- [x] Move `handleTerminalResize` → keep as inline `send()` in component

### Update consumers
- [x] `TerminalPanel` — import `useTerminalStore`
- [x] `InteractiveTerminal` — import `useTerminalStore` for `shellStarted`
- [x] `useMessageHandler` — replace terminal setter calls with store actions for: `log_entry`, `clear_logs`, `terminal_exit`

### Cleanup
- [x] Remove 4 `useState` calls from `App.tsx`
- [x] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`
- [x] Remove 5 terminal callbacks from `useAppCallbacks`

### Tests
- [x] Verify existing tests pass with new store architecture
- [x] Run `npm test && npm run typecheck && npm run lint`

## Phase 4: preview-store (4 variables, 1 callback)

### Store creation
- [x] Create `src/client/stores/preview-store.ts` with state: `status`, `selectedPort`, `configMissing`, `installStatus`
- [x] Add actions: `setStatus`, `setSelectedPort`, `setConfigMissing`, `setInstallStatus`, `reset`

### Migrate callbacks from useAppCallbacks
- [x] Move `handleSelectPort` → `setSelectedPort` action

### Update consumers
- [x] `PreviewFrame` — import `usePreviewStore`
- [x] `useMessageHandler` — replace preview setter calls with store actions for: `preview_status`, `preview_config_missing`, `preview_config_error`, `install_status`

### Cleanup
- [x] Remove 4 `useState` calls from `App.tsx`
- [x] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`

### Tests
- [x] Verify existing tests pass with new store architecture
- [x] Run `npm test && npm run typecheck && npm run lint`

## Phase 5: thread-store (2 variables, 3 callbacks)

### Store creation
- [x] Create `src/client/stores/thread-store.ts` with state: `threads`, `activeThreadId`
- [x] Add actions: `setThreads`, `setActiveThreadId`, `addThread`, `updateThread`, `reset`
- [x] Add async action: `createCheckpoint`

### Migrate callbacks from useAppCallbacks
- [x] Move `handleCreateCheckpoint` → `createCheckpoint` action
- [x] Move `handleForkThread` → inline `send({ type: "fork_thread", checkpointId })` in component
- [x] Move `handleSwitchThread` → inline `send({ type: "switch_thread", threadId })` in component

### Update consumers
- [x] `ThreadIndicator` — import `useThreadStore`
- [x] `ThreadTimeline` — import `useThreadStore`
- [x] `useMessageHandler` — replace thread setter calls with store actions for: `thread_list`, `thread_forked`, `thread_switched`
- [x] `useConnectionSync` — replace `setThreads`, `setActiveThreadId` with store actions

### Cleanup
- [x] Remove 2 `useState` calls from `App.tsx`
- [x] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [x] Remove 3 thread callbacks from `useAppCallbacks`

### Tests
- [x] Verify existing tests pass with new store architecture
- [x] Run `npm test && npm run typecheck && npm run lint`

## Phase 6: file-store (8 variables, 6 callbacks)

### Store creation
- [x] Create `src/client/stores/file-store.ts` with state: `tree`, `viewingFile`, `viewingFileContent`, `viewingFileBinary`, `docFiles`, `selectedDoc`, `docContent`, `changeCount`
- [x] Add actions: `setTree`, `setViewingFile`, `closeViewer`, `setDocFiles`, `selectDoc`, `incrementChangeCount`, `resetChangeCount`, `reset`
- [x] Add async actions: `fetchTree`, `fetchFile`, `fetchDocs`, `fetchDoc`

### Migrate callbacks from useAppCallbacks
- [x] Move `handleFileClick` → `fetchFile` action
- [x] Move `handleFileViewerClose` → `closeViewer` action
- [x] Move `handleFileTreeRefresh` → `fetchTree` action
- [x] Move `handleDocSelect` → `fetchDoc` action
- [x] Move `handleDocRefresh` → `fetchDocs` action
- [x] Move `handleAddFile` → moves to settings-store (`pendingFiles`)

### Update consumers
- [x] `FileTree` — import `useFileStore`
- [x] `FileContentViewer` — import `useFileStore`
- [x] `DocsViewer` — import `useFileStore`
- [x] `useMessageHandler` — replace file setter calls with store actions for: `file_tree`, `files_changed`, `template_applied`, `git_committed` (file refresh)

### Cleanup
- [x] Remove 8 `useState` calls from `App.tsx`
- [x] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [x] Remove 6 file callbacks from `useAppCallbacks`

### Tests
- [x] Verify existing tests pass with new store architecture
- [x] Run `npm test && npm run typecheck && npm run lint`

## Phase 7: settings-store (5 variables, 7 callbacks)

### Store creation
- [x] Create `src/client/stores/settings-store.ts` with state: `hasSystemPrompt`, `systemPromptContent`, `permissionMode`, `githubStatus`, `pendingFiles`
- [x] Add actions: `setPermissionMode`, `addPendingFile`, `removePendingFile`, `clearPendingFiles`, `setGithubStatus`, `reset`
- [x] Add async actions: `saveInstructions`, `submitGitHubToken`, `gitHubLogout`

### Migrate callbacks from useAppCallbacks
- [x] Move `handleInstructionsSave` → `saveInstructions` action
- [x] Move `handleGitHubTokenSubmit` → `submitGitHubToken` action
- [x] Move `handleGitHubLogout` → `gitHubLogout` action
- [x] Move `handlePermissionModeChange` → `setPermissionMode` action (includes localStorage save)
- [x] Move `handleRemoveFile` → `removePendingFile` action
- [x] Move `handleSettingsOpen` → orchestration fn (opens modal + fetches settings)
- [x] Move `handleGitIdentitySubmit` → git-store `submitGitIdentity` action

### Update consumers
- [x] `Settings` — import `useSettingsStore`
- [x] `MessageInput` — import `useSettingsStore` for `permissionMode`, `pendingFiles`
- [x] `HomeScreen` — import `useSettingsStore` for `permissionMode`, `pendingFiles`, `githubStatus`
- [x] `useConnectionSync` — bootstrap populates store via `useSettingsStore.getState()`
- [x] `useMessageHandler` — replace settings setter calls with store actions for: `global_settings`, `github_status`

### Cleanup
- [x] Remove 5 `useState` calls from `App.tsx`
- [x] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [x] Remove 7 settings callbacks from `useAppCallbacks`

### Tests
- [x] Verify existing tests pass with new store architecture
- [x] Run `npm test && npm run typecheck && npm run lint`

## Phase 8: git-store (5 variables, 5 callbacks)

### Store creation
- [x] Create `src/client/stores/git-store.ts` with state: `commits`, `identityNeeded`, `identity`, `lastCommitPair`, `turnDiff`
- [x] Add actions: `setCommits`, `prependCommit`, `setIdentityNeeded`, `setIdentity`, `setLastCommitPair`, `setTurnDiff`, `reset`
- [x] Add async actions: `fetchLog`, `rollback`, `rejectFiles`, `submitGitIdentity`

### Migrate callbacks from useAppCallbacks
- [x] Move `handleGitRefresh` → `fetchLog` action
- [x] Move `handleRollback` → `rollback` action
- [x] Move `handleDiffAcceptAll` → inline callback in App.tsx (clears diff state + switches tab)
- [x] Move `handleDiffRejectFiles` → `rejectFiles` action
- [x] Move `handleDiffClose` → ui-store `setRightTab("preview")`

### Update consumers
- [x] `GitHistory` — import `useGitStore`
- [x] `DiffPanel` — import `useGitStore`
- [x] `GitIdentityOverlay` — import `useGitStore`
- [x] `useMessageHandler` — replace git setter calls with store actions for: `git_log`, `git_committed`, `git_identity_required`, `turn_diff`
- [x] `useConnectionSync` — replace `setGitCommits` with store action

### Cleanup
- [x] Remove 5 `useState` calls from `App.tsx`
- [x] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [x] Remove 5 git callbacks from `useAppCallbacks`

### Tests
- [x] Verify existing tests pass with new store architecture
- [x] Run `npm test && npm run typecheck && npm run lint`

## Phase 9: ui-store (14+ variables, 6 callbacks)

### Store creation
- [x] Create `src/client/stores/ui-store.ts` with state: `rightTab`, `mobilePanel`, `showTemplates`, `templates`, `agentList`, `activeAgentId`, `showUsageModal`, `currentSessionUsage`, `allUsageStats`, `modelInfo`, `contextTokens`, `turnTokens`, `settingsOpen`, `initialSettingsTab`, `sidebarCollapsed`, `toast`, `diffBadgeCount`, `features`
- [x] Add actions: `setRightTab`, `setMobilePanel`, `setShowTemplates`, `setTemplates`, `setAgentList`, `setActiveAgentId`, `setToast`, `setSidebarCollapsed`, `setDiffBadgeCount`, `reset`
- [x] Add async actions: `fetchFeatures`, `fetchUsageStats`

### Migrate callbacks from useAppCallbacks
- [x] Move `handleTabChange` → inline callback in App.tsx (includes lazy-load side effects)
- [x] Move `handleAgentChange` → inline callback in App.tsx (includes localStorage + WS send)
- [x] Move `handleUsageBadgeClick` → inline callback in App.tsx (opens modal + fetches stats)
- [x] Move `handleFeatureRefresh` → `fetchFeatures` action
- [x] Move `handleFeatureStartSession` → inline callback in App.tsx (resets session + sends message)
- [x] Move `handleCancelQueued` → inline `send()` in component

### Update consumers
- [x] Tab bar buttons — import `useUiStore` for `rightTab`, `setRightTab`
- [x] `StatusBar` — import `useUiStore` for `modelInfo`, `contextTokens`, `agentList`
- [x] `AgentPicker` — import `useUiStore` for `agentList`, `activeAgentId`
- [x] `UsageModal` — import `useUiStore` for usage state
- [x] `FeaturesPanel` — import `useUiStore` for `features`
- [x] `Toast` — import `useUiStore` for `toast`
- [x] `QueueIndicator` — import session-store for `queuedMessages`
- [x] `SessionSidebar` — import `useUiStore` for `sidebarCollapsed`
- [x] `useMessageHandler` — replace UI setter calls with store actions for: `usage_update`, `model_info`, `agent_list`
- [x] `useConnectionSync` — replace `setAgentList`, `setTemplates` with store actions

### Cleanup
- [x] Remove 14+ `useState` calls from `App.tsx`
- [x] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [x] Remove 6 UI callbacks from `useAppCallbacks`

### Tests
- [x] Verify existing tests pass with new store architecture
- [x] Run `npm test && npm run typecheck && npm run lint`

## Phase 10: session-store (8 variables, 13 callbacks) — the big one

### Store creation
- [x] Create `src/client/stores/session-store.ts` with state: `sessionId`, `messages`, `isLoading`, `activity`, `selectedRepoUrl`, `creatingRepo`, `sessions`, `authUrl`, `activeRunnerSessions`, `queuedMessages`
- [x] Add actions: `setSessionId`, `setMessages`, `appendMessage`, `updateLastMessage`, `setIsLoading`, `setActivity`, `setSessions`, `setAuthUrl`, `setQueuedMessages`, `reset`
- [x] Add async actions: `archiveSession`, `renameSession`, `refreshSessions`

### Create orchestration functions
- [x] Create `src/client/stores/actions/session-actions.ts`
- [x] Implement `resetSessionState()` — calls `.reset()` on session, git, file, thread, terminal stores
- [x] Implement `newSession(send, navigate)` — resets + navigates + sends WS
- [x] Implement `resumeSessionInternal(sessionId, send)` — resets + fetches history + activates via WS
- [x] Implement `handleSessionResume(sessionId, send, navigate)` — resumes + navigates

### Migrate callbacks from useAppCallbacks
- [x] Move `handleSend` → inline callback in App.tsx using store actions
- [x] Move `handleInterrupt` → inline `send()` in component
- [x] Move `handleEditMessage` → inline callback in App.tsx using store actions
- [x] Move `handleAnswerQuestion` → inline callback in App.tsx using store actions
- [x] Move `handleSessionResume` → `resumeSessionInternal` orchestration
- [x] Move `handleSessionNew` → `newSession` orchestration
- [x] Move `handleSessionArchive` → `archiveSession` store action
- [x] Move `handleSessionRename` → `renameSession` store action
- [x] Move `handleSessionRefresh` → `refreshSessions` store action
- [x] Move `handleHomeSendWithRepo` → inline callback in App.tsx using store actions
- [x] Move `handleHomeCreateRepo` → inline callback in App.tsx using store actions
- [x] Move `handleSendErrors` → inline callback in App.tsx using store actions
- [x] Move `handleFullReset` → inline in Settings component

### Update consumers
- [x] `MessageList` — import `useSessionStore` for `messages`, `isLoading`, `activity`
- [x] `MessageInput` — import `useSessionStore` for `isLoading`
- [x] `SessionSidebar` — import `useSessionStore` for `sessions`, `sessionId`, `activeRunnerSessions`
- [x] `HomeScreen` — import `useSessionStore` for `sessions`, `creatingRepo`, `selectedRepoUrl`
- [x] `AuthOverlay` — import `useSessionStore` for `authUrl`
- [x] `useMessageHandler` — replace session setter calls with store actions
- [x] `useConnectionSync` — replace session setters with store actions
- [x] `useAutoFix` — import `useSessionStore` for `isLoading`, `setMessages`, `setActivity`

### Cleanup
- [x] Remove 8+ `useState` calls from `App.tsx`
- [x] Remove `sessionIdRef` (replaced by store state)
- [x] Remove corresponding setter params from `useAppCallbacks`, `useMessageHandler`, `useConnectionSync`
- [x] Remove all remaining callbacks from `useAppCallbacks`

### Eliminate URL-sync duplication
- [x] Replace the URL-change `useEffect` in `App.tsx` with a call to `resetSessionState()` / `resumeSessionInternal()`

### Tests
- [x] Verify existing tests pass with new store architecture
- [x] Run `npm test && npm run typecheck && npm run lint`

## Phase 11: Final cleanup

### Delete dead code
- [x] Delete `src/client/hooks/useAppCallbacks.ts` entirely
- [x] Verify no imports reference `useAppCallbacks`

### Simplify useMessageHandler
- [x] Remove all setter params from `useMessageHandler` — it now imports stores directly
- [x] Reduce to a thin `switch` dispatcher (no param object beyond `lastMessage`, `send`, `terminalRef`, `notify`, `navigate`)
- [x] Remove stale dependency arrays — the `useEffect` only depends on `lastMessage`

### Simplify useConnectionSync
- [x] Remove all setter params — it now imports stores directly
- [x] Reduce param object to: `status`, `send` (WS lifecycle only)

### Simplify App.tsx
- [x] Remove all `useState` calls except `searchOpen` and `shortcutsOpen`
- [x] Remove the massive hook call sites (useAppCallbacks, useMessageHandler params)
- [x] App.tsx is a layout shell with store selectors (~660 lines including JSX)
- [x] Remove unused type imports

### Simplify useAutoFix
- [x] Remove setter params — import `useSessionStore` directly
- [x] Reduce param object to: `previewErrors`, `isLoading`, `status`, `send`

### Audit
- [x] Verify no `Dispatch<SetStateAction<...>>` types remain in hook signatures
- [x] Verify no stale closure issues — all store access uses `getState()` or selectors
- [x] Verify `useAppCallbacks` is fully deleted with no references
- [x] Run `npm test && npm run typecheck && npm run lint && npm run build` — all pass
