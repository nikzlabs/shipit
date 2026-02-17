# Conversation Threads & Checkpoints

Users can create checkpoints (snapshots of conversation + git state) and fork from them to explore alternative approaches.

## Concepts

- **Checkpoint**: Captures current conversation message index and git commit hash. Stored within parent thread's data.
- **Thread**: A conversation branch with its own chat history and git state. Each thread may have a parent checkpoint.
- **Default thread**: "Main" thread created when a session starts.

## How it works

### Creating checkpoints

User clicks flag button in `ThreadIndicator`. Checkpoint captures `{ messageIndex, commitHash, label? }`.

### Forking from a checkpoint

1. Snapshot current thread data in memory (critical — see below)
2. Roll back git to checkpoint's commit via `git reset --hard`
3. Restore thread data from snapshot
4. Create new thread record with checkpoint as parent
5. Truncate chat history to checkpoint's message index
6. New thread becomes active

### Switching threads

Roll back git to target thread's parent checkpoint commit and restore corresponding chat history.

## Critical pattern: snapshot-before-rollback

Thread data files (`/workspace/.vibe-threads/{sessionId}.json`) live inside the git working tree. `git reset --hard` reverts them to committed state. The solution:

```
1. Snapshot thread data in memory
2. git reset --hard
3. ThreadManager.restore(snapshot)
4. Continue with thread creation/switch
```

Used in both `fork_thread` and `switch_thread` handlers in `index.ts`.

## Storage

- **Location**: `/workspace/.vibe-threads/{sessionId}.json`
- **Format**: JSON with `threads[]` and `activeThreadId`
- **Session ID sanitization**: Same pattern as `ChatHistoryManager`

## Key files

- `src/server/threads.ts` — `ThreadManager` class: init, listThreads, createCheckpoint, forkThread, switchThread, restore, delete
- `src/server/types.ts` — `ThreadInfo`, `CheckpointInfo` types; all thread WS messages
- `src/server/index.ts` — WS handlers with snapshot-before-rollback pattern
- `src/client/components/ThreadIndicator.tsx` — Thread dropdown, checkpoint creation, fork buttons
- `src/client/App.tsx` — Thread state management
