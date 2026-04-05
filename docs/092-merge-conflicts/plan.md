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
4. **Agent can't commit during rebase** — The agent inside the session container doesn't have a git identity configured, so `git rebase --continue` would fail even if conflicts were resolved.

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
                    │ Agent resolves files   │  (Claude edits conflicted files)
                    │ git add + rebase       │
                    │ --continue             │
                    └──────────┬────────────┘
                               ▼
                        ┌────────────┐
                        │ Force push │   git push --force-with-lease
                        └────────────┘
```

### Phase 1: Git Identity for the Agent

**Problem:** The agent inside session containers runs `git commit` (via Claude Code) but currently relies on the orchestrator's auto-commit. During rebase conflict resolution, the agent needs to run `git rebase --continue` which creates commits — this requires `user.name` and `user.email` to be set in the container.

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

**Fallback:** If no identity is configured, use `"ShipIt Agent" <agent@shipit.dev>` as a default so rebase never fails due to missing identity.

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

New service function in `services/git.ts`:

```typescript
/**
 * Rebase the session's branch onto the latest base branch.
 * Fetches upstream, attempts rebase, handles conflicts or force-pushes on success.
 */
export async function rebaseOntoBase(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
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
    // 5a. Rebase succeeded — force push
    const pushResult = await gitForcePush(git, githubAuthManager);
    return { status: "rebased_and_pushed", message: pushResult.message };
  }

  // 5b. Conflicts — return them for resolution
  return {
    status: "conflicts",
    conflicts: result.conflicts,
    baseBranch,
    baseRef,
  };
}
```

### Phase 5: API Endpoints

**`POST /api/sessions/:id/git/rebase`** — Trigger rebase onto base branch.

```
Request:  { baseBranch: string }
Response: { status: "up_to_date" | "rebased_and_pushed" | "conflicts",
            conflicts?: ConflictFile[], message?: string }
```

**`POST /api/sessions/:id/git/rebase/continue`** — Continue after conflict resolution.

```
Request:  { resolvedFiles: string[] }   // files that were edited and staged
Response: { status: "clean" | "conflicts", ... }
```

**`POST /api/sessions/:id/git/rebase/abort`** — Abort rebase, restore previous state.

```
Response: { status: "aborted" }
```

**`POST /api/sessions/:id/git/force-push`** — Force push current branch.

```
Response: { success: boolean, message: string, branch: string }
```

### Phase 6: Agent-Driven Conflict Resolution

When rebase hits conflicts, the orchestrator can delegate resolution to the Claude agent in the session container. The agent already has full filesystem access and can edit files.

**Flow:**

1. Orchestrator detects conflicts from `git rebase` output
2. Sends a system message to the agent with conflict context:
   ```
   The branch needs to be rebased onto {baseBranch} but there are merge conflicts
   in the following files: {conflictList}.

   The files contain standard git conflict markers (<<<<<<< HEAD, =======, >>>>>>>).
   Please resolve each conflict by editing the files to produce the correct merged result,
   then run `git add <file>` for each resolved file and `git rebase --continue`.
   ```
3. Agent edits files, removes conflict markers, stages changes, continues rebase
4. If more conflicts arise (multi-commit rebase), agent repeats
5. Once rebase completes, orchestrator force-pushes

**Advantages of agent-driven resolution:**
- Agent understands the codebase and can make intelligent merge decisions
- No new UI needed — resolution happens in the chat flow
- Works for complex conflicts (not just "take ours/theirs")

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
  continueRebase: () => Promise<void>;
  abortRebase: () => Promise<void>;
}
```

#### UI Components

1. **Push rejected banner** — Appears in the PR lifecycle card when `git_push_rejected` is received. Shows "Branch is behind {base}. Update branch?" with a rebase button.

2. **Rebase progress indicator** — Small status pill in the git status area showing rebase state (rebasing, conflicts, resolving).

3. **Conflict list** (if manual resolution is needed) — Shows conflicted files in the sidebar. Clicking a file opens the diff view with conflict markers highlighted.

In practice, Phase 6 (agent-driven resolution) means the user rarely sees conflicts directly — the agent resolves them in chat. The UI is a fallback and status indicator.

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
Rebase is a local operation and works without GitHub auth. Force push requires auth. If auth is missing, rebase locally and defer push.

### Session container restart during rebase
If the container restarts mid-rebase, `isRebaseInProgress()` detects the state on reconnect. The orchestrator can either abort (safe) or resume.

## Implementation Order

1. **Git identity propagation** (Phase 1) — prerequisite for everything
2. **GitManager rebase methods** (Phase 2) — core primitives
3. **Force push** (Phase 3) — needed after rebase
4. **Orchestrator rebase service** (Phase 4) — ties it together
5. **API endpoints** (Phase 5) — expose to client
6. **Auto-detect divergence** (Phase 7) — trigger the flow
7. **Agent-driven resolution** (Phase 6) — the smart path
8. **Client UI** (Phase 8) — status display and manual trigger

## Key Files

| File | Change |
|---|---|
| `src/server/shared/git.ts` | `rebase()`, `rebaseContinue()`, `rebaseAbort()`, `isRebaseInProgress()`, `forcePush()`, `isAncestor()`, `fetch()` |
| `src/server/shared/types/ws-server-messages.ts` | `WsGitPushRejected`, `WsRebaseStarted`, `WsRebaseConflicts`, `WsRebaseComplete`, `WsRebaseAborted` |
| `src/server/orchestrator/services/git.ts` | `rebaseOntoBase()`, `gitForcePush()` |
| `src/server/orchestrator/api-routes-git.ts` | Rebase endpoints (start, continue, abort, force-push) |
| `src/server/orchestrator/ws-handlers/post-turn.ts` | Detect non-fast-forward push failures |
| `src/server/orchestrator/git-config.ts` | Default agent identity fallback |
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
