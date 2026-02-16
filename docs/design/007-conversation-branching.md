# Design Doc 007: Conversation Branching & Checkpoints

## Status: Proposed

## Problem

When a user edits a message, the UI truncates the conversation but Claude retains full history. This creates confusion ("as I mentioned earlier" referencing invisible messages). It's the most fundamental UX problem in the app (documented in `ISSUES.md` #1).

Users also lack the ability to explore alternative approaches without losing progress. There's no way to try an approach, back up, and try another while keeping both paths.

Specific pain points:
1. **Hidden context** — Claude's context and the visible UI diverge after message edits.
2. **No undo for exploration** — if an approach fails, the user must manually undo with git rollback and lose the conversation.
3. **No comparison** — users cannot compare two approaches side-by-side.

## Goals

1. Snapshot conversation + git state as checkpoints.
2. Branch from any checkpoint with a new CLI session and replayed context.
3. Switch between branches, each with its own git state and conversation.
4. Auto-create checkpoints before message edits to prevent context divergence.

## Non-Goals

- Merging branches (git merge of conversation branches).
- Visual diff between branches.
- Concurrent Claude sessions across branches.

## Design

### Core Concept: Checkpoints

A **checkpoint** is a snapshot of:
- The conversation messages (up to that point).
- The git commit hash at that point.
- The Claude CLI session ID.

Branching from a checkpoint means:
1. Rolling back git to the checkpoint's commit.
2. Starting a new Claude CLI session.
3. Replaying the conversation prefix as system context for the new session.
4. Continuing from the checkpoint with a clean slate.

### Data Model

```typescript
interface Checkpoint {
  id: string;                    // UUID
  sessionId: string;             // Claude CLI session that created this
  messageIndex: number;          // index in the conversation
  commitHash: string;            // git state at this point
  createdAt: string;
  label?: string;                // optional user-provided label
}

interface Branch {
  id: string;                    // UUID
  parentCheckpointId?: string;   // null for the initial branch
  sessionId: string;             // Claude CLI session for this branch
  name: string;                  // "main", "Branch 1", etc.
  checkpoints: Checkpoint[];
  isActive: boolean;
}
```

### Protocol Changes

```typescript
// Client → Server
interface WsCreateCheckpoint {
  type: "create_checkpoint";
  label?: string;
}

interface WsBranchFromCheckpoint {
  type: "branch_from_checkpoint";
  checkpointId: string;
}

interface WsSwitchBranch {
  type: "switch_branch";
  branchId: string;
}

interface WsListBranches {
  type: "list_branches";
}

// Server → Client
interface WsCheckpointCreated {
  type: "checkpoint_created";
  checkpoint: Checkpoint;
}

interface WsBranchList {
  type: "branch_list";
  branches: Branch[];
  activeBranchId: string;
}

interface WsBranchSwitched {
  type: "branch_switched";
  branchId: string;
  messages: WsChatHistoryMessage[];  // conversation for this branch
}
```

### Server Changes

#### New: `BranchManager` class (`src/server/branches.ts`)

Persists branch/checkpoint state to `/workspace/.vibe-branches/`.

Key methods:
- `createCheckpoint(sessionId, messageIndex, commitHash, label?)` — snapshot the current state.
- `branchFrom(checkpointId)` — create a new branch from a checkpoint.
- `switchBranch(branchId)` — switch active branch (returns conversation + commit hash).
- `listBranches()` — return all branches with their checkpoints.

#### `index.ts` changes

- `create_checkpoint` handler: saves checkpoint with current git HEAD and message index.
- `branch_from_checkpoint` handler: git rollback to checkpoint commit, start new CLI session, replay conversation prefix as system prompt.
- `switch_branch` handler: git checkout to branch's latest commit, load branch's conversation, update active branch.
- Auto-checkpoint: automatically create a checkpoint before each edit/retry.

#### Conversation replay for new branches

When branching from a checkpoint at message index N, the server constructs a system prompt containing the conversation up to message N:

```
You are continuing a conversation. Here is the conversation so far:

User: [message 0]
Assistant: [message 1]
...
User: [message N-1]

Continue from here. The user's next message follows.
```

This gives Claude the context without the `--resume` session's hidden history problem.

### UI Changes

#### BranchIndicator component (header area)

- Shows current branch name next to the session selector.
- Dropdown to switch branches.
- "Create checkpoint" button (bookmark icon).

#### Timeline view (in GitHistory area)

- Visual branch timeline showing checkpoints as nodes.
- Click a checkpoint to branch from it.
- Color-coded branches.

#### Message-level integration

- Checkpoints appear as subtle dividers in the chat: "Checkpoint: before refactor".
- The edit/retry action auto-creates a checkpoint before branching.

### Complexity & Phasing

This is the most complex feature. Recommended sub-phases:

1. **8a: Manual checkpoints** — create/list checkpoints, no branching yet (just bookmarks for git rollback).
2. **8b: Branch from checkpoint** — full branching with conversation replay and new CLI sessions.
3. **8c: Branch switching** — switch between branches, git checkout, conversation swap.

### File Layout

| File | Change |
|------|--------|
| `src/server/branches.ts` | New — `BranchManager` class |
| `src/server/branches.test.ts` | New — unit tests (create, list, switch, persistence) |
| `src/server/types.ts` | Add checkpoint/branch message types |
| `src/server/index.ts` | Wire handlers for checkpoint/branch/switch messages |
| `src/server/integration.test.ts` | Full branch workflow: messages → checkpoint → branch → verify |
| `src/client/App.tsx` | Handle branch messages, auto-checkpoint on edit |
| `src/client/components/BranchIndicator.tsx` | New — branch selector + checkpoint button |
| `src/client/components/BranchIndicator.test.tsx` | New — component tests |

### Quality Checklist

- [ ] Input validation: Validate `checkpointId` and `branchId` exist. Validate `label` string (max 200 chars, trim whitespace). Return `{ type: "error" }` on invalid input.
- [ ] Integration tests: Full branch workflow — send messages → checkpoint → branch → verify new session gets conversation prefix → verify git state matches.
- [ ] Component tests: BranchIndicator dropdown, checkpoint dividers, timeline view.
- [ ] Edge cases: Branch from checkpoint when files have been deleted, handle concurrent branch operations, handle missing git commits (garbage collected).
