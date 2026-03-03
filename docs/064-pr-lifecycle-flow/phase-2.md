# Phase 2: CI Failure Details + Server-Driven Auto-Fix

## Goal

When CI fails on a PR, show per-check failure summaries in the inline card. Add a "Fix CI Issues" button and an auto-fix toggle — both server-driven. The server fetches failure logs, constructs the fix prompt, and sends it to Claude via the existing message queue. If Claude is mid-turn, the fix prompt queues behind the current work and executes when the agent goes idle.

## What ships

1. **Per-check failure breakdown** in the inline card (check name + one-line summary)
2. **`POST /api/sessions/:id/pr/fix-ci`** — server fetches CI logs, constructs prompt, enqueues to Claude
3. **`POST /api/sessions/:id/pr/auto-fix`** — toggle auto-fix on/off (state stored server-side)
4. **Server-driven auto-fix loop** — poller detects CI failure, auto-enqueues fix prompt, loops up to 3 attempts
5. **GraphQL query extended** with `databaseId` on CheckRun nodes (needed for REST log fetching)

## Card rendering when CI fails

```
┌─────────────────────────────────────────────────────────┐
│  PR #42: Add PR lifecycle flow                          │
│  main ← feature/abc123    +42 -12                       │
│                                                          │
│  ✗ CI failed  3/5 passed · 2 failed                     │
│    ✗ lint — Process completed with exit code 1           │
│    ✗ test — 3 tests failed                               │
│                                                          │
│  Auto-fix ○                                              │
│  [Fix CI Issues]  [View PR]                              │
└─────────────────────────────────────────────────────────┘
```

When auto-fix is running:

```
┌─────────────────────────────────────────────────────────┐
│  PR #42: Add PR lifecycle flow                          │
│  main ← feature/abc123    +42 -12                       │
│                                                          │
│  ✗ CI failed  3/5 passed · 2 failed                     │
│  ⟳ Auto-fixing (attempt 1/3)...                         │
└─────────────────────────────────────────────────────────┘
```

When auto-fix exhausted:

```
┌─────────────────────────────────────────────────────────┐
│  PR #42: Add PR lifecycle flow                          │
│  main ← feature/abc123    +42 -12                       │
│                                                          │
│  ✗ CI failed  3/5 passed · 2 failed                     │
│    ✗ lint — exit code 1                                  │
│    ✗ test — 3 tests failed                               │
│                                                          │
│  Auto-fix exhausted (3/3 attempts)                       │
│  [Fix CI Issues]  [View PR]                              │
└─────────────────────────────────────────────────────────┘
```

## Why server-driven

Both the manual "Fix CI Issues" button and auto-fix are **server-driven**. The client never constructs prompts or fetches CI logs directly. Reasons:

1. **Works without a browser tab open.** Auto-fix runs even if the user closed their tab. The poller + session runner operate independently of WebSocket connections.
2. **Single source of truth.** Auto-fix state (enabled, attempt count, current CI run) lives on the server. No risk of stale client state triggering duplicate fixes.
3. **Reuses existing infrastructure.** The session runner's message queue already handles "send this to Claude when the agent is idle." No new queuing system needed.

## Handling agent-busy: reuse the message queue

The central design challenge: what if Claude is mid-turn when CI fails?

**Answer: enqueue the fix prompt as a regular `QueuedMessage`.** The session runner already has a message queue (max 50 items) with automatic drain-on-idle. When the current turn's `done` event fires, the runner dequeues the next message and starts a new turn. The fix prompt is just another queued message.

This works because:

- `SessionRunner.enqueue(msg)` adds to the queue regardless of agent state
- The `done` event handler in `send-message.ts` checks `runner.messageQueue`, dequeues, and calls `runClaudeWithMessage()` recursively
- If the agent is idle, we call `handleSendMessage()` directly (same as `diff_comment` and `init_preview_config` do today)
- The fix prompt appears in the chat as a user message, so the user sees what happened

**Flow:**

```
CI failure detected by poller
        │
        ▼
Is auto-fix enabled? ──no──▶ broadcast status only (card shows failure details)
        │ yes
        ▼
attempts < 3? ──no──▶ broadcast "auto-fix exhausted", disable toggle
        │ yes
        ▼
Fetch CI logs (GitHub REST API)
        │
        ▼
Construct fix prompt
        │
        ▼
Is agent idle? ─────────────────────────┐
  │ yes                                  │ no
  ▼                                      ▼
handleSendMessage(ctx, fixMsg)    runner.enqueue(fixMsg)
  │                                      │
  ▼                                      ▼
Claude starts fixing             (drains when current turn ends)
  │
  ▼
increment attempt counter
broadcast "auto-fix running (attempt N/3)"
```

### Sending without a WebSocket connection

`handleSendMessage()` requires a `FullCtx` (handler context), which is tied to a WebSocket connection. For server-initiated sends when no tab is open, we need an alternative path.

The session runner already has an `agent` and can spawn Claude directly. The approach:

1. The `PrStatusPoller` holds a reference to the `SessionRunnerRegistry`
2. To send a fix prompt, it gets the runner via `registry.get(sessionId)`
3. If the runner exists and is idle: call a new `runner.sendSystemMessage(text)` method that spawns Claude directly (same as `runClaudeWithMessage` but without WebSocket context)
4. If the runner exists and is busy: call `runner.enqueue({ text })` — the message drains when the turn ends
5. If no runner exists (session disposed): skip — the user will see the failure when they reconnect and can manually fix

`sendSystemMessage()` is a new method on `SessionRunnerInterface`. It creates a temporary agent, attaches event forwarding (so any connected viewers still see streaming output), and runs the prompt. Events broadcast to all viewers via `runner.emitMessage()`.

## Fetching CI failure logs

### Extending the GraphQL query

Phase 1's GraphQL query for the PR status poller returns `CheckRun { name, status, conclusion }`. Phase 2 adds `databaseId` to enable REST log fetching:

```graphql
... on CheckRun {
  databaseId
  name
  status
  conclusion
  title           # one-line summary (e.g. "3 tests failed")
  detailsUrl      # link to the check run on GitHub
}
```

`databaseId` maps to the check run ID used in REST API endpoints. `title` provides the one-line summary shown in the card (e.g. "Process completed with exit code 1", "3 tests failed").

### New endpoint: `POST /api/sessions/:id/pr/fix-ci`

This is the **manual** fix trigger. Clicking "Fix CI Issues" calls this endpoint. The server handles everything — the client just sends the POST and gets back a confirmation.

**Request:** No body.

**Server logic:**

1. Look up the session's PR status from the poller's cache
2. Get the list of failed check runs (from the cached GraphQL data — `databaseId`, `name`, `conclusion`, `title`)
3. For each failed check, fetch detailed logs via GitHub REST API
4. Construct the fix prompt (see below)
5. Send to Claude via `handleSendMessage()` or `runner.enqueue()` depending on agent state
6. Return `{ status: "sent" | "queued", attemptNumber: N }`

**Response:**

```typescript
{ status: "sent" | "queued"; attemptNumber: number }
```

- `"sent"` — agent was idle, fix prompt sent immediately
- `"queued"` — agent was busy, fix prompt queued (will execute when current turn ends)

### Fetching check run logs via REST API

GitHub's REST API provides two ways to get failure details:

**Option A: Check run annotations** — `GET /repos/:owner/:repo/check-runs/:id/annotations`

Returns structured annotations with file paths, line numbers, and messages. Best for linting errors and test failures that produce annotations.

**Option B: Job logs** — `GET /repos/:owner/:repo/actions/jobs/:id/logs`

Returns the raw log text. Useful when annotations aren't available. Returns a redirect to a log file URL.

**Strategy:** Try annotations first (structured, smaller). If no annotations exist, fall back to job logs (truncated to last 100 lines per job to keep the prompt reasonable).

```typescript
async function fetchCIFailureLogs(
  githubAuth: GitHubAuthManager,
  owner: string,
  repo: string,
  failedChecks: Array<{ databaseId: number; name: string; conclusion: string; title: string }>
): Promise<CIFailureLog[]> {
  const logs: CIFailureLog[] = [];

  for (const check of failedChecks) {
    // Try annotations first
    const annotations = await githubAuth.getCheckRunAnnotations(owner, repo, check.databaseId);

    let logExcerpt = "";
    if (annotations.length === 0) {
      // Fall back to raw job logs (last 100 lines)
      logExcerpt = await githubAuth.getJobLogs(owner, repo, check.databaseId);
    }

    logs.push({
      checkName: check.name,
      conclusion: check.conclusion,
      summary: check.title,
      annotations,
      logExcerpt,
    });
  }

  return logs;
}
```

### `CIFailureLog` type

```typescript
interface CIFailureLog {
  checkName: string;
  conclusion: string;         // "failure", "cancelled", "timed_out"
  summary: string;            // one-line from CheckRun.title
  annotations: Array<{
    path: string;
    startLine: number;
    endLine: number;
    message: string;
    annotationLevel: "failure" | "warning" | "notice";
  }>;
  logExcerpt: string;         // last 100 lines of raw log (fallback)
}
```

Added to `src/server/shared/types/github-types.ts`.

## Fix prompt construction

The server constructs the prompt — the client never sees it. This keeps prompt engineering centralized and updatable without client deploys.

```
CI checks failed on PR #{number}. Here are the failures:

## {checkName}
{summary}

### Annotations
{annotations as file:line — message, grouped by file}

### Log output
```
{logExcerpt}
```

---

Please fix these CI failures. After fixing, the changes will be automatically committed and pushed to the PR branch.
```

The prompt is sent as a regular user message. It appears in the chat history so the user can see what Claude was asked to fix.

## Auto-fix state management

### Where state lives

On the `PrStatusPoller`, keyed by session ID:

```typescript
interface AutoFixState {
  enabled: boolean;
  attemptCount: number;       // resets when head SHA changes
  lastHeadSha: string;        // tracks which commit's CI we're fixing
  status: "idle" | "running" | "exhausted";
}
```

The poller maintains a `Map<string, AutoFixState>` (session ID → state).

### Toggle endpoint: `POST /api/sessions/:id/pr/auto-fix`

**Request:**

```typescript
{ enabled: boolean }
```

**Server logic:**

1. Update `AutoFixState.enabled` for this session
2. If enabling and CI is currently failed: immediately trigger a fix (fetch logs + send prompt)
3. Broadcast updated card state via SSE so all connected clients see the toggle change

**Response:**

```typescript
{ enabled: boolean; attemptCount: number; status: "idle" | "running" | "exhausted" }
```

### Attempt tracking

- `attemptCount` increments each time the server sends a fix prompt
- Resets to 0 when the poller sees a new `headSha` on the PR (meaning new code was pushed — either by the auto-fix or manually by the user)
- Max 3 attempts per head SHA. After 3 failures on the same SHA, `status` becomes `"exhausted"` and auto-fix stops
- If the user pushes new code manually (new SHA), attempts reset and auto-fix re-engages if still enabled

### Auto-fix loop (server-side)

Runs inside the `PrStatusPoller`'s tick handler:

```
poller tick → CI status changed for session X?
  │
  ├─ CI now "failure" + auto-fix enabled + not exhausted
  │    → fetchCIFailureLogs()
  │    → construct fix prompt
  │    → get runner from registry
  │    → runner idle? handleSendMessage() : runner.enqueue()
  │    → increment attemptCount
  │    → broadcast { autoFix: { status: "running", attempt: N } }
  │
  ├─ CI now "success" + auto-fix was running
  │    → broadcast { autoFix: { status: "idle" } }
  │    → (if auto-merge is enabled, phase 3 handles merge)
  │
  ├─ CI now "pending" (new SHA detected)
  │    → reset attemptCount if SHA changed
  │    → broadcast updated status
  │
  └─ no change → skip
```

### SSE broadcast shape

The existing `pr_status` SSE event is extended with auto-fix state:

```typescript
interface PrStatusSummary {
  // ... existing fields from phase 1 ...
  checks: {
    state: "pending" | "success" | "failure" | "none";
    total: number;
    passed: number;
    failed: number;
    pending: number;
    failedChecks: Array<{ name: string; summary: string }>;  // NEW
  };
  autoFix: {                                                   // NEW
    enabled: boolean;
    status: "idle" | "running" | "exhausted";
    attemptCount: number;
    maxAttempts: number;       // always 3
  };
}
```

`failedChecks` comes from the GraphQL query's `CheckRun` nodes where `conclusion` is not `"success"`. The `name` and `title` (mapped to `summary`) fields are already in the query from the phase 2 extension.

## Client changes

### `PrLifecycleCard` updates

The card component gains two new visual states within the `open` phase:

**CI failure with per-check details:**
- Render `failedChecks` array as a list under the CI status line
- Each entry: `✗ {name} — {summary}`
- Truncate to 5 entries with "and N more..." if many checks fail

**Auto-fix controls:**
- Toggle switch for auto-fix (calls `POST .../pr/auto-fix`)
- When `autoFix.status === "running"`: show `⟳ Auto-fixing (attempt N/3)...` and hide the toggle
- When `autoFix.status === "exhausted"`: show `Auto-fix exhausted (3/3 attempts)`, toggle disabled
- "Fix CI Issues" button: visible when auto-fix is off or exhausted. Calls `POST .../pr/fix-ci`

### `pr-store` updates

Add to the Zustand store:

```typescript
interface PrStoreActions {
  // ... existing ...
  fixCI: (sessionId: string) => Promise<void>;          // POST /api/sessions/:id/pr/fix-ci
  toggleAutoFix: (sessionId: string, enabled: boolean) => Promise<void>;  // POST /api/sessions/:id/pr/auto-fix
}
```

Both are thin wrappers around `apiPost()`. The store state updates come from SSE, not from the POST response.

## Files changed

### New files

| File | Description |
|---|---|
| `src/server/orchestrator/integration_tests/pr-ci-fix.test.ts` | Integration tests for fix-ci and auto-fix endpoints |

### Modified files

| File | Change |
|---|---|
| `src/server/shared/types/github-types.ts` | Add `CIFailureLog` type, extend `PrStatusSummary` with `failedChecks` and `autoFix` |
| `src/server/orchestrator/github-auth.ts` | Add `getCheckRunAnnotations()`, `getJobLogs()` methods |
| `src/server/orchestrator/pr-status-poller.ts` | Extend GraphQL query with `databaseId`/`title`, add auto-fix state map, trigger fix on CI failure |
| `src/server/orchestrator/api-routes.ts` | Add `POST .../pr/fix-ci`, `POST .../pr/auto-fix` |
| `src/server/orchestrator/services/github.ts` | Add `fetchCIFailureLogs()`, `triggerCIFix()` |
| `src/server/orchestrator/session-runner.ts` | Add `sendSystemMessage()` method for server-initiated prompts without WebSocket context |
| `src/client/components/PrLifecycleCard.tsx` | Per-check failure list, auto-fix toggle, "Fix CI Issues" button |
| `src/client/components/PrLifecycleCard.test.tsx` | Tests for new card states |
| `src/client/stores/pr-store.ts` | Add `fixCI()`, `toggleAutoFix()` actions |

## Testing

### Integration tests (`pr-ci-fix.test.ts`)

- `POST .../pr/fix-ci` — happy path: fetches logs, sends fix prompt to Claude, returns `{ status: "sent" }`
- `POST .../pr/fix-ci` — agent busy: returns `{ status: "queued" }`, fix prompt sent after turn ends
- `POST .../pr/fix-ci` — no failed checks: returns 400
- `POST .../pr/fix-ci` — no GitHub auth: returns 401
- `POST .../pr/auto-fix` — toggle on: updates state, triggers fix if CI currently failed
- `POST .../pr/auto-fix` — toggle off: clears state, no fix sent
- Auto-fix loop: poller detects failure → fix sent → new SHA appears → attempts reset
- Auto-fix exhaustion: 3 failures on same SHA → status becomes "exhausted", no more fixes sent
- Auto-fix with agent busy: fix prompt queued, sent after turn completes

### Component tests (`PrLifecycleCard.test.tsx` additions)

- Renders per-check failure list when CI failed
- Truncates failure list to 5 entries with "and N more..."
- "Fix CI Issues" button calls `fixCI()`
- Auto-fix toggle calls `toggleAutoFix()`
- Shows "Auto-fixing (attempt N/3)" when auto-fix is running
- Shows "Auto-fix exhausted" when attempts are used up
- "Fix CI Issues" button visible when auto-fix is off or exhausted
- Toggle hidden when auto-fix is running

## What this phase does NOT include

- Auto-merge toggle (phase 3)
- Merge button / merge method dropdown (phase 3)
- Post-merge "Start Next Task" flow (phase 3)
- Conditional auto-push (phase 4 — but auto-push after PR exists is assumed)
