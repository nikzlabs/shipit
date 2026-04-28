---
status: planned
---
# 092 — Merge Conflicts: Rebase, Force Push, and Agent Git Identity

## Summary

When a ShipIt session's branch falls behind its base branch (e.g., `main` gets new commits while the agent is working), pushing fails and PRs can't be merged cleanly. This feature adds support for detecting divergence, rebasing onto the latest base branch, resolving conflicts (via the agent), and force-pushing the rebased branch — completing the loop so PRs stay up to date without manual intervention.

## Motivation

Today, ShipIt sessions push to feature branches and open PRs. But if the base branch moves forward:

1. **Push succeeds but PR has conflicts** — GitHub shows "This branch has conflicts that must be resolved." The user must leave ShipIt to fix this.
2. **Push fails (non-fast-forward)** — `git push` rejects because remote has diverged. The auto-push silently fails (logs error, no user-visible feedback).
3. **No rebase capability** — GitManager has `merge()` but no `rebase()`. Even if we detected conflicts, there's no way to resolve them.
4. **No git identity in containers** — Session containers don't have `user.name`/`user.email` configured, so `git rebase --continue` (which creates commits) would fail even if conflicts were resolved.

## Design

### Strategy: Rebase + Force Push

We use **rebase** (not merge) to keep feature branch history linear and clean. The flow:

```
main:    A → B → C → D        (moved forward)
feature: A → B → X → Y        (agent's work)

After rebase:
feature: A → B → C → D → X' → Y'   (clean linear history)
```

Force push (`--force-with-lease`) replaces the old feature branch on the remote. This is safe because ShipIt owns the feature branch — no other collaborators push to it.

### End-to-End Flow

```
┌─────────────────────────────────────────────────────────┐
│  Trigger: auto-push fails, or user clicks "Update branch" │
└──────────────────────┬──────────────────────────────────┘
                       ▼
              ┌─────────────────┐
              │  Fetch upstream  │   git fetch origin
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │  Check diverged? │   git merge-base --is-ancestor HEAD origin/main
              └───┬─────────┬───┘
                  │ no      │ yes (up to date)
                  ▼         └──→ done
         ┌────────────────┐
         │  Rebase onto    │   git rebase origin/{base}
         │  base branch    │
         └───┬─────────┬───┘
             │ clean   │ conflicts
             ▼         ▼
      ┌──────────┐  ┌──────────────────────┐
      │ Force    │  │ Pause: emit conflict  │
      │ push     │  │ status to client      │
      └──────────┘  └──────────┬───────────┘
                               ▼
                    ┌───────────────────────┐
                    │ Agent edits files      │  (Claude resolves conflict markers)
                    │ Orchestrator: git add  │
                    │ + rebase --continue    │
                    └──────────┬────────────┘
                               ▼
                        ┌────────────┐
                        │ Force push │   git push --force-with-lease
                        └────────────┘
```

### Phase 1: Git Identity for the Agent

**Problem:** The agent inside session containers can run `git commit` (via Claude Code's bash tool), and the orchestrator runs `git rebase --continue` on the session directory which creates commits. Both require `user.name` and `user.email` to be configured in the container's git environment.

**Solution:** Propagate the git identity into session containers at startup.

#### Changes

**`session-worker.ts`** — Accept git identity in the worker config and set it on startup:

```typescript
// In worker startup, after receiving config
if (config.gitIdentity) {
  execFileSync("git", ["config", "--global", "user.name", config.gitIdentity.name]);
  execFileSync("git", ["config", "--global", "user.email", config.gitIdentity.email]);
}
```

**`container-session-runner.ts`** — Pass identity when starting the container worker:

```typescript
// When creating the worker, include git identity from global config
const identity = getGitIdentity();
if (identity) {
  workerConfig.gitIdentity = identity;
}
```

**No fallback identity.** If the user hasn't set a git identity, rebase is blocked and the existing `git_identity_required` flow prompts them to set one — same as auto-commit. Using a fake identity would create confusing commit authorship.

### Phase 2: Rebase Support in GitManager

Add rebase methods to `src/server/shared/git.ts`:

```typescript
/** Rebase current branch onto a target ref. */
async rebase(onto: string): Promise<RebaseResult> {
  try {
    await this.git.rebase([onto]);
    return { status: "clean" };
  } catch (err: unknown) {
    const status = await this.git.status();
    if (status.conflicted.length > 0) {
      return {
        status: "conflicts",
        conflicts: status.conflicted.map(file => ({
          path: file,
          // Read conflict markers from working tree
          content: fs.readFileSync(path.join(this.dir, file), "utf-8"),
        })),
      };
    }
    // Other rebase failure — abort and rethrow
    await this.git.rebase(["--abort"]);
    throw err;
  }
}

/** Continue a rebase after conflicts are resolved. */
async rebaseContinue(): Promise<RebaseResult> {
  try {
    await this.git.rebase(["--continue"]);
    return { status: "clean" };
  } catch (err: unknown) {
    const status = await this.git.status();
    if (status.conflicted.length > 0) {
      return {
        status: "conflicts",
        conflicts: status.conflicted.map(file => ({
          path: file,
          content: fs.readFileSync(path.join(this.dir, file), "utf-8"),
        })),
      };
    }
    throw err;
  }
}

/** Abort an in-progress rebase. */
async rebaseAbort(): Promise<void> {
  await this.git.rebase(["--abort"]);
}

/** Check if a rebase is in progress. */
async isRebaseInProgress(): Promise<boolean> {
  // git has a rebase-merge or rebase-apply dir when rebase is active
  const gitDir = await this.git.revparse(["--git-dir"]);
  return (
    fs.existsSync(path.join(gitDir, "rebase-merge")) ||
    fs.existsSync(path.join(gitDir, "rebase-apply"))
  );
}
```

#### Types

```typescript
interface RebaseConflictFile {
  path: string;
  content: string; // File content with conflict markers
}

type RebaseResult =
  | { status: "clean" }
  | { status: "conflicts"; conflicts: RebaseConflictFile[] };
```

### Phase 3: Force Push with Lease

Add force push to GitManager:

```typescript
/** Force push with lease — safe force push that fails if remote has unexpected commits. */
async forcePush(remote = "origin", branch?: string): Promise<string> {
  const currentBranch = branch || (await this.getCurrentBranch());
  await this.git.push(remote, currentBranch, ["--force-with-lease", "--set-upstream"]);
  return `Force pushed to ${remote}/${currentBranch}`;
}
```

Update the git service layer (`services/git.ts`):

```typescript
/** Git force push after rebase. */
export async function gitForcePush(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  remote?: string,
  branch?: string,
): Promise<{ success: boolean; message: string; branch: string }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const message = await git.forcePush(remote || "origin", branch);
  const currentBranch = await git.getCurrentBranch();
  return { success: true, message, branch: currentBranch };
}
```

### Phase 4: Orchestrator Rebase Flow

The orchestrator owns the rebase lifecycle. It runs `git rebase`, and if conflicts arise, delegates resolution to the agent. The agent resolves files and stages them, then the orchestrator calls `git rebase --continue`. This keeps git plumbing on the orchestrator side (consistent with how auto-commit works) while leveraging the agent's code understanding for conflict resolution.

New service function in `services/git.ts`:

```typescript
/**
 * Rebase the session's branch onto the latest base branch.
 * Fetches upstream, attempts rebase. On clean rebase, force-pushes immediately.
 * On conflicts, returns them for agent resolution (caller is responsible for
 * the resolve → continue → force-push loop).
 */
export async function rebaseOntoBase(
  git: GitManager,
  baseBranch: string,
): Promise<RebaseFlowResult> {
  // 1. Fetch latest from remote
  await git.fetch("origin");

  // 2. Resolve the base branch ref
  const baseRef = await git.resolveBaseBranchRef(baseBranch);
  if (!baseRef) throw new ServiceError(400, `Cannot resolve base branch: ${baseBranch}`);

  // 3. Check if rebase is needed
  const isAncestor = await git.isAncestor(baseRef, "HEAD");
  if (isAncestor) {
    return { status: "up_to_date" };
  }

  // 4. Attempt rebase
  const result = await git.rebase(baseRef);

  if (result.status === "clean") {
    return { status: "rebased", baseRef };
  }

  // 5. Conflicts — return them (caller will delegate to agent, then continue)
  return {
    status: "conflicts",
    conflicts: result.conflicts,
    baseRef,
  };
}
```

Force push is a separate step, called by the orchestrator after rebase completes (clean or after agent resolution):

```typescript
/** Force push after a successful rebase. Requires GitHub auth. */
export async function forcePushAfterRebase(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
): Promise<{ success: boolean; message: string; branch: string }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const message = await git.forcePush();
  const branch = await git.getCurrentBranch();
  return { success: true, message, branch };
}
```

### Phase 5: API Endpoints

**`POST /api/sessions/:id/git/rebase`** — Trigger rebase onto base branch.

```
Request:  { baseBranch: string }
Response: { status: "up_to_date" | "rebased" | "conflicts",
            conflicts?: ConflictFile[], message?: string }
```

On `"rebased"` response, the orchestrator automatically force-pushes (no separate client call needed).

**`POST /api/sessions/:id/git/rebase/abort`** — Abort rebase, restore previous state.

```
Response: { status: "aborted" }
```

Note: no `/rebase/continue` endpoint. The orchestrator manages the continue loop internally after the agent resolves conflicts (see Phase 6). The client doesn't need to drive individual rebase steps.

### Phase 6: Agent-Driven Conflict Resolution (Chat-Visible)

When rebase hits conflicts, the orchestrator delegates resolution to the agent. The resolution is **visible in chat** as a compact message group — the user can see what the agent decided, but it doesn't dominate the conversation.

**Orchestrator-driven loop:**

1. Orchestrator calls `git.rebase(baseRef)` → gets conflicts
2. Emits `rebase_started` WS event
3. Sends the agent a message with conflict context (see below)
4. Agent edits conflicted files to resolve markers
5. Orchestrator detects resolution (file watcher or agent turn completion), stages files, calls `git.rebaseContinue()`
6. If more conflicts (multi-commit rebase), repeat from step 3
7. Once rebase completes, orchestrator force-pushes and emits `rebase_complete`

**Agent prompt:**

```
Rebasing onto {baseBranch} — {n} conflict(s) to resolve:
{for each file: "- {path}"}

Each file has standard git conflict markers. Edit them to produce the correct
merged result. Don't run any git commands — just edit the files.
```

The agent edits files via its normal tools. The orchestrator handles all git plumbing (`git add`, `git rebase --continue`, `git push --force-with-lease`).

**Chat output:** The agent's resolution appears as a single compact message group:

> Rebasing onto `main` — 3 conflicts resolved
> - `src/api.ts` — kept both: new endpoint from main + your route changes
> - `src/config.ts` — took ours: your new config keys supersede the upstream defaults
> - `package.json` — merged dependency versions

**Why chat-visible:**
- Resolution is a meaningful decision about the user's code — hiding it undermines trust
- User can review and rollback if they disagree
- Consistent with how everything else the agent does is visible
- Kept compact (one message group, not a multi-turn saga) to avoid cluttering the conversation

### Phase 7: Auto-Detect Divergence

Enhance the auto-push flow in `post-turn.ts` to detect and handle divergence:

```typescript
// In scheduleAutoPush, after push fails:
try {
  await git.push(remote, branch);
} catch (err) {
  if (isNonFastForwardError(err)) {
    // Branch has diverged — emit event so client can offer rebase
    emit({
      type: "git_push_rejected",
      reason: "non_fast_forward",
      message: "Branch has diverged from remote. Rebase needed.",
    });
    return;
  }
  throw err;
}
```

### Phase 8: Client UI

#### Git Store Additions (`git-store.ts`)

```typescript
interface GitStore {
  // ... existing ...
  rebaseStatus: "idle" | "in_progress" | "conflicts" | "resolving";
  rebaseConflicts: ConflictFile[];
  pushRejected: boolean;

  startRebase: (baseBranch: string) => Promise<void>;
  abortRebase: () => Promise<void>;
  // No continueRebase — orchestrator manages the resolve loop internally
}
```

#### UI Components

1. **Push rejected banner** — Appears in the PR lifecycle card when `git_push_rejected` is received. Shows "Branch is behind {base}. Update branch?" with a rebase button.

2. **Rebase progress indicator** — Small status pill in the git status area showing rebase state (rebasing, conflicts, resolving).

3. **Conflict list** (if manual resolution is needed) — Shows conflicted files in the sidebar. Clicking a file opens the diff view with conflict markers highlighted.

The agent resolves conflicts in chat (Phase 6). These UI components show status and provide manual triggers — the user doesn't need to interact with conflicts directly unless they want to abort.

### WS Message Types

```typescript
// Server → Client
interface WsGitPushRejected {
  type: "git_push_rejected";
  reason: "non_fast_forward";
  message: string;
}

interface WsRebaseStarted {
  type: "rebase_started";
  baseBranch: string;
}

interface WsRebaseConflicts {
  type: "rebase_conflicts";
  conflicts: { path: string }[];
}

interface WsRebaseComplete {
  type: "rebase_complete";
  forcePushed: boolean;
}

interface WsRebaseAborted {
  type: "rebase_aborted";
}
```

## Edge Cases

### Rebase during active agent turn
Block rebase while the agent is running. The agent may be writing files that would conflict with rebase. Show a "Wait for agent to finish" message.

### Dirty working tree before rebase
Auto-commit (stash) uncommitted changes before rebase, restore after. Use `git stash` if auto-commit is not appropriate.

### Multi-commit rebase with multiple conflict points
Each commit in the rebase may produce conflicts. The agent loop must handle repeated conflict/resolve/continue cycles. Set a max iteration count (e.g., 10) to prevent infinite loops.

### Force push and open PR
`--force-with-lease` is safe: it only succeeds if the remote ref matches what we last fetched. If someone else pushed to the branch (shouldn't happen for ShipIt branches), the force push fails and we surface the error.

### No GitHub auth
Rebase is a local operation and works without GitHub auth. Force push requires auth. If auth is missing, the rebase still completes locally — the branch is updated — but force push is skipped. The next time auto-push runs (after auth is configured), it will use `--force-with-lease` if the local branch has been rebased.

### Session container restart during rebase
If the container restarts mid-rebase, `isRebaseInProgress()` detects the state on reconnect. The orchestrator can either abort (safe) or resume.

## Implementation Order

1. **Git identity propagation** (Phase 1) — prerequisite for agent commits
2. **GitManager rebase + force push** (Phases 2–3) — core primitives
3. **Orchestrator rebase service** (Phase 4) — orchestrates fetch → rebase → force push
4. **Agent-driven resolution** (Phase 6) — conflict resolve loop, chat-visible output
5. **API endpoints** (Phase 5) — expose rebase trigger + abort to client
6. **Auto-detect divergence** (Phase 7) — trigger rebase from failed auto-push
7. **Client UI** (Phase 8) — status display, manual trigger, abort button

## Key Files

| File | Change |
|---|---|
| `src/server/shared/git.ts` | `rebase()`, `rebaseContinue()`, `rebaseAbort()`, `isRebaseInProgress()`, `forcePush()`, `isAncestor()`, `fetch()` |
| `src/server/shared/types/ws-server-messages.ts` | `WsGitPushRejected`, `WsRebaseStarted`, `WsRebaseConflicts`, `WsRebaseComplete`, `WsRebaseAborted` |
| `src/server/orchestrator/services/git.ts` | `rebaseOntoBase()`, `forcePushAfterRebase()` |
| `src/server/orchestrator/api-routes-git.ts` | Rebase endpoints (start, abort) |
| `src/server/orchestrator/ws-handlers/` | Rebase conflict resolution loop, agent message injection |
| `src/server/orchestrator/ws-handlers/post-turn.ts` | Detect non-fast-forward push failures |
| `src/server/orchestrator/git-config.ts` | `getGitIdentity()` used to propagate identity to containers |
| `src/server/session/session-worker.ts` | Accept and apply git identity config |
| `src/server/orchestrator/container-session-runner.ts` | Pass git identity to container |
| `src/client/stores/git-store.ts` | Rebase state, conflict tracking |
| `src/client/components/` | Push rejected banner, rebase status indicator |
| `src/server/shared/git.test.ts` | Rebase unit tests |
| `src/server/orchestrator/integration_tests/` | Rebase integration tests |

## Testing

### Unit Tests (`git.test.ts` or `git-rebase.test.ts`)
1. Clean rebase onto updated base — no conflicts
2. Rebase with conflicts — returns conflict file list with markers
3. Rebase continue after resolution — completes cleanly
4. Rebase continue with more conflicts — returns next conflict set
5. Rebase abort — restores pre-rebase state
6. `isRebaseInProgress()` — true during rebase, false otherwise
7. Force push with lease — succeeds normally
8. Force push with lease — fails if remote diverged unexpectedly
9. `isAncestor()` — correct for ancestor and non-ancestor cases

### Integration Tests
1. Full rebase flow: create divergence → rebase → force push → verify linear history
2. Rebase with agent resolution: inject conflicts → agent resolves → rebase completes
3. Push rejection detection: push to diverged remote → verify `git_push_rejected` event
4. Rebase abort: start rebase → abort → verify clean state restored
5. Git identity propagation: start container → verify identity is set
