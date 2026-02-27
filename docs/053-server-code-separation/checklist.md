# 053 — Server Code Separation: Checklist

## Phase 1: Split GitManager

- [x] Extract `generateBranchPrefix()` and `parseGitHubRemote()` into `src/server/orchestrator/git-utils.ts`
- [x] Create `src/server/orchestrator/repo-git.ts` with `RepoGit` class (`clone`, `fetch`, `getDefaultBranch`, `createWorktree`, `removeWorktree`, `listWorktrees`, `deleteBranch`, `isEmpty`)
- [x] Remove moved methods from `GitManager` in `src/server/shared/git.ts`
- [x] Update call sites in `ws-handlers/send-message.ts` (`createGitManager(repoDir)` → `createRepoGit(repoDir)`)
- [x] Update call sites in `services/session.ts` (forkSession, archiveSession)
- [x] Update all `generateBranchPrefix()` / `parseGitHubRemote()` imports to `git-utils.ts`
- [x] Add `createRepoGit` factory to DI chain (AppDeps, HandlerContext, ApiDeps)
- [x] `npm run typecheck` passes
- [x] `npm test` passes

## Phase 2: Create directories and move files

### Create directory structure
- [x] Create `src/server/session/`
- [x] Create `src/server/session/agents/`
- [x] Create `src/server/orchestrator/`
- [x] Create `src/server/orchestrator/ws-handlers/`
- [x] Create `src/server/orchestrator/services/`
- [x] Create `src/server/orchestrator/deploy-targets/`
- [x] Create `src/server/shared/`
- [x] Create `src/server/shared/types/`

### Move session files
- [x] `claude.ts` → `session/`
- [x] `terminal.ts` → `session/`
- [x] `preview-manager.ts` → `session/`
- [x] `preview-config.ts` → `session/`
- [x] `file-watcher.ts` → `session/`
- [x] `port-scanner.ts` → `session/`
- [x] `install-runner.ts` → `session/`
- [x] `vite-error-plugin.ts` → `session/`
- [x] `session-worker.ts` → `session/`
- [x] `agents/agent-process.ts` → `session/agents/`
- [x] `agents/agent-registry.ts` → `session/agents/`
- [x] `agents/claude-adapter.ts` → `session/agents/`
- [x] `agents/codex-adapter.ts` → `session/agents/`

### Move orchestrator files
- [x] `index.ts` → `orchestrator/`
- [x] `api-routes.ts` → `orchestrator/`
- [x] `repo-git.ts` → `orchestrator/`
- [x] `git-utils.ts` → `orchestrator/`
- [x] `git-config.ts` → `orchestrator/`
- [x] `sessions.ts` → `orchestrator/`
- [x] `session-runner.ts` → `orchestrator/`
- [x] `container-session-runner.ts` → `orchestrator/`
- [x] `session-container.ts` → `orchestrator/`
- [x] `preview-proxy.ts` → `orchestrator/`
- [x] `auth.ts` → `orchestrator/`
- [x] `github-auth.ts` → `orchestrator/`
- [x] `credential-store.ts` → `orchestrator/`
- [x] `deployment-manager.ts` → `orchestrator/`
- [x] `deployment-store.ts` → `orchestrator/`
- [x] `features.ts` → `orchestrator/`
- [x] `session-namer.ts` → `orchestrator/`
- [x] `chat-history.ts` → `orchestrator/`
- [x] `threads.ts` → `orchestrator/`
- [x] `usage.ts` → `orchestrator/`
- [x] `templates.ts` → `orchestrator/`
- [x] `markdown.ts` → `orchestrator/`
- [x] `validation.ts` → `orchestrator/`
- [x] `ws-handlers/*.ts` → `orchestrator/ws-handlers/`
- [x] `services/*.ts` → `orchestrator/services/`
- [x] `deploy-targets/*.ts` → `orchestrator/deploy-targets/`

### Move shared files
- [x] `types/*.ts` → `shared/types/`
- [x] `git.ts` → `shared/`
- [x] `file-tree.ts` → `shared/`

### Update imports
- [x] Update imports in all moved session files
- [x] Update imports in all moved orchestrator files
- [x] Update imports in all moved shared files
- [x] Update imports in test files (`*.test.ts`)
- [x] Update imports in integration tests (`integration_tests/*.test.ts`)
- [x] Update `vitest.config.ts` test project paths if needed

## Phase 3: Barrel exports (skipped)

Skipped — not needed at this time.

## Phase 4: Verify

- [x] `npm run typecheck` passes
- [x] `npm test` passes (1713 tests)
- [x] `npm run lint` passes
- [x] `npm run build` passes

## Phase 5: Documentation

- [x] Update CLAUDE.md project structure section
- [x] Update CLAUDE.md path references (services, integration tests, ws-handlers, types, deploy-targets)
- [x] Update plan.md status to `done`
- [x] Mark all checklist items complete
