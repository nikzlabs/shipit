# 053 — Server Code Separation: Checklist

## Phase 1: Split GitManager

- [ ] Extract `generateBranchPrefix()` and `parseGitHubRemote()` into `src/server/git-utils.ts`
- [ ] Create `src/server/repo-git.ts` with `RepoGit` class (`clone`, `fetch`, `getDefaultBranch`, `createWorktree`, `removeWorktree`, `listWorktrees`, `deleteBranch`, `isEmpty`)
- [ ] Remove moved methods from `GitManager` in `src/server/git.ts`
- [ ] Update call sites in `ws-handlers/send-message.ts` (`createGitManager(repoDir)` → `new RepoGit(repoDir)`)
- [ ] Update call sites in `services/session.ts` (forkSession, archiveSession)
- [ ] Update all `generateBranchPrefix()` / `parseGitHubRemote()` imports to `git-utils.ts`
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

## Phase 2: Create directories and move files

### Create directory structure
- [ ] Create `src/server/session/`
- [ ] Create `src/server/session/agents/`
- [ ] Create `src/server/orchestrator/`
- [ ] Create `src/server/orchestrator/ws-handlers/`
- [ ] Create `src/server/orchestrator/services/`
- [ ] Create `src/server/orchestrator/deploy-targets/`
- [ ] Create `src/server/shared/`
- [ ] Create `src/server/shared/types/`

### Move session files
- [ ] `claude.ts` → `session/`
- [ ] `terminal.ts` → `session/`
- [ ] `preview-manager.ts` → `session/`
- [ ] `preview-config.ts` → `session/`
- [ ] `file-watcher.ts` → `session/`
- [ ] `port-scanner.ts` → `session/`
- [ ] `install-runner.ts` → `session/`
- [ ] `vite-error-plugin.ts` → `session/`
- [ ] `session-worker.ts` → `session/`
- [ ] `agents/agent-process.ts` → `session/agents/`
- [ ] `agents/agent-registry.ts` → `session/agents/`
- [ ] `agents/claude-adapter.ts` → `session/agents/`
- [ ] `agents/codex-adapter.ts` → `session/agents/`

### Move orchestrator files
- [ ] `index.ts` → `orchestrator/`
- [ ] `api-routes.ts` → `orchestrator/`
- [ ] `repo-git.ts` → `orchestrator/`
- [ ] `git-utils.ts` → `orchestrator/`
- [ ] `git-config.ts` → `orchestrator/`
- [ ] `sessions.ts` → `orchestrator/`
- [ ] `session-runner.ts` → `orchestrator/`
- [ ] `container-session-runner.ts` → `orchestrator/`
- [ ] `session-container.ts` → `orchestrator/`
- [ ] `preview-proxy.ts` → `orchestrator/`
- [ ] `auth.ts` → `orchestrator/`
- [ ] `github-auth.ts` → `orchestrator/`
- [ ] `credential-store.ts` → `orchestrator/`
- [ ] `deployment-manager.ts` → `orchestrator/`
- [ ] `deployment-store.ts` → `orchestrator/`
- [ ] `features.ts` → `orchestrator/`
- [ ] `session-namer.ts` → `orchestrator/`
- [ ] `chat-history.ts` → `orchestrator/`
- [ ] `threads.ts` → `orchestrator/`
- [ ] `usage.ts` → `orchestrator/`
- [ ] `templates.ts` → `orchestrator/`
- [ ] `markdown.ts` → `orchestrator/`
- [ ] `validation.ts` → `orchestrator/`
- [ ] `ws-handlers/*.ts` → `orchestrator/ws-handlers/`
- [ ] `services/*.ts` → `orchestrator/services/`
- [ ] `deploy-targets/*.ts` → `orchestrator/deploy-targets/`

### Move shared files
- [ ] `types/*.ts` → `shared/types/`
- [ ] `git.ts` → `shared/`
- [ ] `file-tree.ts` → `shared/`

### Update imports
- [ ] Update imports in all moved session files
- [ ] Update imports in all moved orchestrator files
- [ ] Update imports in all moved shared files
- [ ] Update imports in test files (`*.test.ts`)
- [ ] Update imports in integration tests (`integration_tests/*.test.ts`)
- [ ] Update `vitest.config.ts` test project paths if needed

## Phase 3: Barrel exports (optional)

- [ ] Add `src/server/session/index.ts` barrel
- [ ] Add `src/server/orchestrator/index.ts` barrel

## Phase 4: Verify

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] `npm run build` passes
