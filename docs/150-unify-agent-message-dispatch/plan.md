---
description: Send system-initiated prompts (Create PR, preview/compose errors, service logs) directly to the agent instead of prefilling the input, and funnel every server-side dispatch through the same send-or-queue primitive.
---

# 150 — Unify agent message dispatch (send direct + single queue funnel)

## Summary

Two changes that share one design:

1. **Stop prefilling the input for system-initiated prompts** the user almost never edits. "Send compose error to agent", "Send compose hint", "Send service logs", and "Create PR" should send straight to the agent. The only prefill that remains is **"Start Session" from a doc preview** — that one the user routinely edits.
2. **Funnel every server-side dispatch through one primitive.** `runner.sendSystemMessage(...)` already implements "send if idle, enqueue if running". Today it's used for two callsites (Fix CI, child-session spawn); the WS `send_message` and `send_review_message` handlers reimplement the same logic inline with their own queue push. Collapse to one path so the queue rules live in one file.

The two changes are coupled because (1) creates a third caller class (HTTP from the client) that needs (2)'s primitive to work.

## Motivation

**For users:** the prefill UX teaches the wrong lesson. The user clicks "Send to agent" on a compose-error overlay, the textarea fills with a 40-line stack trace, and now they have to press Send to actually send it. Half the time they don't realize the click was supposed to be a two-step action; the other half they edit nothing and just submit. We are charging two clicks for what the user asked for in one. The exception is "Start Session from doc" — that one is a launching pad for a turn the user shapes ("…then proceed, but skip the migration step"), and prefill is the right primitive there.

**For the codebase:** today the queueing rule lives in three places.
- `ws-handlers/send-message.ts:138` pushes to `runner.messageQueue` if `runner.running`.
- `runner.sendSystemMessage` (`session-runner.ts:555`, `container-session-runner.ts:1322`) does the same but as a method. Server-side callers today: Fix CI (`app-lifecycle.ts:610`), the `triggerCIFix` service (`services/github-ci-fix.ts:263`), and the child-session spawn (`services/child-sessions.ts:340, :531`).
- `runSystemTurn` (`session-runner.ts:200-206`) drains the queue when a turn finishes — and **it drops everything except `next.text`** when re-entering itself. So a queued WS message that carries `reviewFilePath / images / files / uploads / permissionMode` will silently lose all of those at drain time. Today this bug is invisible because nothing exercises an interleaving where it matters; the moment the new HTTP entrypoint can interleave with a queued review message, it will start mattering.

Adding a new dispatch entrypoint (the new HTTP route) means writing the rule a fourth time, or fixing this now.

This satisfies CLAUDE.md §5 ("Chat is the input surface. The agent is the actor."): the user describes intent, the agent acts. The prefill UX inserts a button → text → button dance that has the user operating the box; the direct-send UX restores the model.

## Scope

### In scope

**Client callsite changes:**

| Callsite (file:line) | Today | After |
|---|---|---|
| `handleSendComposeErrorToAgent` (App.tsx:516) | `setPrefillText(...)` | POST `/api/sessions/:id/agent/dispatch` |
| `handleSendComposeHintToAgent` (App.tsx:523) | `setPrefillText(...)` | POST `/api/sessions/:id/agent/dispatch` |
| `handleSendServiceLogsToAgent` (App.tsx:528) | `setPrefillText(...)` | POST `/api/sessions/:id/agent/dispatch` |
| `handleCreatePr` (App.tsx:503) | WS `send_message` | POST `/api/sessions/:id/agent/dispatch` |
| `handleSendErrors` (App.tsx:482, preview error tray "Send to Agent" / per-error "Fix") | WS `send_message` | POST `/api/sessions/:id/agent/dispatch` |
| `useAutoFix.handleSendAutoFix` (`hooks/useAutoFix.ts:43`, auto-retry on preview errors) | WS `send_message` | POST `/api/sessions/:id/agent/dispatch` |
| `handleDocStartSession` (App.tsx:743) | `setPrefillText(...)` | **unchanged — stays prefill (see §"Prefill"+future-work")** |

The two error/auto-fix callsites are explicitly **included** to avoid a worse middle state: if some "system-ish" client-button sends go via WS `send_message` and others via the HTTP route, the rule for new features ("which path do I use?") is unclear. The HTTP route's body shape (below) is wide enough to carry everything they need.

**Server changes:**

- Rename `runner.sendSystemMessage(text, activity?)` to `runner.dispatch(opts: AgentDispatchOptions)`. The current name was honest when only Fix CI used it; once the WS handlers and the new HTTP route delegate to the same method, the function serves both server-internal callers (Fix CI, child-session spawn) and user-clicked buttons. `dispatch` describes the role: it's the runner's send-or-queue entrypoint, with no claim about who triggered it.
- `AgentDispatchOptions` carries every field a queued WS message can carry: `{ text, activity?, images?, files?, uploads?, permissionMode?, reviewFilePath? }`.
- Generalize `runSystemTurn` (rename to `runDispatchedTurn` for consistency) to accept the full options and thread them into `agent.run({...})`. The recursive self-call at `session-runner.ts:204` that drains the queue must read all `QueuedMessage` fields, not just `next.text`.
- Add `POST /api/sessions/:id/agent/dispatch` (new file `api-routes-agent.ts`) accepting the same `AgentDispatchOptions` body. Body validation gates non-empty text and bounded permission mode.
- Refactor WS `send_message` and `send_review_message` to delegate their "queue or start" branch to `runner.dispatch(...)`. The pre-dispatch work (resolving attachments from disk, killing stale agents, warm-session graduation, branch naming) stays in the handler — only the inline `messageQueue.push(...)` at `ws-handlers/send-message.ts:138` and the `runAgentWithMessage` call later in the handler are replaced. Structural placement: the delegation **stays above** `staleAgent.kill()` (line 162) and attachment resolution (lines 172-205) for the queue-branch path, matching today; the new-turn path runs the existing resolution and then calls `runner.dispatch(...)` with the resolved fields.

### Out of scope

- File-review send (`handleFileSendComments`, App.tsx:762), diff-review send (DiffPanel), `/review` slash command, and "Ask agent to review" button — these stay on WS `send_message` / `send_review_message`. They carry attachments / `reviewFilePath` and the WS adapter is the cheaper plumbing for streaming attachments. Internally they reach the same `runner.dispatch` primitive after this refactor, so the queueing path is unified regardless of entrypoint.
- The user-typed composer (`handleSend`) — stays WS; it's the canonical streaming user input.
- Removing the `prefillText` primitive. It's still needed for "Start Session from doc". A future doc may replace it with a dedicated "edit-then-send" modal so the next contributor doesn't reach for prefill by accident — flagged in §"Future work", not in this PR.

## Design

### Server: the funnel

Generalize the existing `sendSystemMessage` → `dispatch`:

```ts
// session-runner.ts
export interface AgentDispatchOptions {
  text: string;
  /** Spinner label shown in the chat bubble (e.g. "Creating PR…", "Auto-fixing CI…"). */
  activity?: string;
  /** Optional inline image attachments. */
  images?: ImageAttachment[];
  /** File context references resolved against the session workspace. */
  files?: FileContextRef[];
  /** Upload refs (resolved to ImageAttachment[] after resolution). */
  uploads?: UploadRef[];
  /** Per-turn permission mode override. */
  permissionMode?: PermissionMode;
  /** docs/125 — chat-native review turn marker. */
  reviewFilePath?: string;
}

dispatch(opts: AgentDispatchOptions): void
```

Behavior is unchanged in the path where it matters:

```
if (running)        → enqueue (carrying all fields, not just text)
else if (deps set)  → start a dispatched turn with all fields threaded through
else                → enqueue (next WS turn drains)
```

Three follow-on edits this forces:

- `QueuedMessage` (`session-runner.ts:70-78`) already has the right fields — no schema change.
- `SessionRunnerInterface.sendSystemMessage` (`session-runner.ts:365`) is renamed to `dispatch`; both implementations and every caller update. TypeScript catches the misses.
- `runSystemTurn` (`session-runner.ts:129`, rename to `runDispatchedTurn`) currently takes positional `text` and calls `agent.run({ prompt: text })`. Change the signature to accept `AgentDispatchOptions` so it can pass `images / files / uploads / permissionMode / reviewFilePath` into `agent.run(...)`. The recursive self-call at line 204 (`runSystemTurn(host, deps, agentId, next.text, createAgent)`) currently drops `next.activity / images / files / permissionMode / reviewFilePath` — fix that by passing the full `QueuedMessage` shape.
- Auto-commit summary at `session-runner.ts:189`: today `host.turnSummary.split("\n")[0]?.slice(0, 120) || "CI fix"`. Change to `host.turnSummary.split("\n")[0]?.slice(0, 120) || opts.activity || "agent turn"` — preserve the assistant-derived summary as the primary signal, with the activity label only as the fallback when the agent emitted no text (the case where the literal `"CI fix"` was misleading).

### Server: the HTTP route

New file `src/server/orchestrator/api-routes-agent.ts`:

```ts
// POST /api/sessions/:id/agent/dispatch
app.post<{
  Params: { id: string };
  Body: {
    text: string;
    activity?: string;
    permissionMode?: PermissionMode;
    images?: ImageAttachmentInput[];
    files?: FileContextRef[];
    uploads?: UploadRef[];
    reviewFilePath?: string;
  };
}>(
  "/api/sessions/:id/agent/dispatch",
  async (request, reply) => {
    try {
      const result = await dispatchAgentMessage(
        deps.runnerRegistry,
        deps.credentialStore,
        deps.agentRegistry,
        request.params.id,
        request.body,
      );
      reply.send(result); // { ok: true, queued: boolean }
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Dispatch failed: ${getErrorMessage(err)}` });
    }
  },
);
```

The service (`services/agent.ts::dispatchAgentMessage`) is responsible for:

1. **Input validation** — `text` is a non-empty string after trim, `permissionMode` is one of the known values. Throw `ServiceError(400, ...)` on failure.
2. **Runner resolution** — `runnerRegistry.get(sessionId)`. Throws `ServiceError(404, "Session not active")` if missing or disposed (check both `!runner` and `runner.disposed`).
3. **Auth gate** — mirror `ws-handlers/send-message.ts:23` (`ensureActiveAgentAuthenticated`). If the active agent isn't authenticated, throw `ServiceError(401, ...)` so the client can prompt re-auth. Without this, the dispatched run hangs the same way an unauthenticated WS `send_message` would.
4. **Attachment resolution** — if `files` or `uploads` are present, call `resolveFileAttachments` / `resolveUploadRefs` (already used by the WS handler) before dispatching, so the runner receives resolved paths.
5. **Dispatch** — `runner.dispatch({ text, activity, images, files: validatedFiles, uploads, permissionMode, reviewFilePath })`.
6. **Return** — `{ ok: true, queued: runner.running }` so the client can distinguish "started now" from "queued behind a running turn" (the queued case still emits `message_queued` over the WS, so this is informational, not the canonical signal).

The service exists as a function in `services/agent.ts`, not inlined in the route — same pattern as `services/github.ts`. Tests target the service directly; the route is a thin adapter.

### Server: WS handlers delegate

`ws-handlers/send-message.ts:138` (the queue branch) becomes:

```ts
// before:
runnerForQueue.messageQueue.push({ text: msg.text, images, files, uploads, permissionMode, reviewFilePath });
ctx.send({ type: "message_queued", position: runnerForQueue.messageQueue.length, text: msg.text });

// after:
runnerForQueue.dispatch({ text: msg.text, images, files: validatedFiles, uploads, permissionMode, reviewFilePath });
// dispatch() routes through the same enqueue branch and broadcasts message_queued
// via runner.emitMessage so all attached viewers (and any other HTTP-originated
// caller in the same session) see the queue update.
```

Same change in `send_review_message` (it builds a `reviewFilePath`, then today pushes inline to the queue — replace with `runner.dispatch(...)` carrying `reviewFilePath`).

**Structural placement matters.** The queue-branch short-circuit at `ws-handlers/send-message.ts:108-145` already runs **before** the `staleAgent.kill()` block (line 162-170) and the attachment-resolution block (lines 172-205). That order is correct — a queued message reuses the running agent's already-resolved environment — and the delegation preserves it. For the new-turn path (the rest of the handler after line 205), the existing resolution runs first, then the handler calls `runner.dispatch(...)` with the resolved fields instead of `runAgentWithMessage(...)`. This is the structural rule reviewers and contributors should hold: **`dispatch` is the only thing that touches `runner.running` / `messageQueue` — everything else stays put.**

**The `message_queued` ack moves into the runner.** Today the WS handler emits `{ type: "message_queued" }` on its own socket. After the change, the enqueue branch inside `runner.dispatch` calls `runner.emitMessage({ type: "message_queued", text, position })`, which broadcasts to all attached viewers. This matches how `system_user_message`, `agent_event`, and `queue_updated` already work. Effect on existing behavior: the originating tab now receives `message_queued` via the broadcast channel instead of the per-socket send — same payload, same shape. Other tabs receive it for the first time, which is the desired multi-viewer behavior (today they're inconsistent: another tab attached to the same runner sees `queue_updated` after drain but never sees the initial enqueue). Test coverage in `ws-disconnect-resilience.test.ts` and `live-steering.test.ts` already exercise multi-viewer scenarios — they need a small update to expect the broadcast.

### Client: optimistic UI and the existing dedupe

The optimistic-append flow already exists today for WS `send_message` callsites: the client appends `{ role: "user", text }` to `messages` synchronously, sends the WS frame, and then `handleMessageQueued` (`hooks/message-handlers/message-queued.ts:5-26`) removes the optimistic bubble *if* the message ended up queued — stashing it for re-insertion when the queue drains.

After this PR:

- The four converted callsites do the same optimistic append before POSTing.
- If the runner was idle, the server runs the turn immediately; the SSE `system_user_message` echo arrives. `system_user_message` is currently handled at `src/client/hooks/message-handlers/system-user-message.ts` and **today appends** (because it was only ever fired by server-initiated turns where there was no optimistic bubble to dedupe). After this PR, that handler needs to **dedupe against the tail message**: if the most recent message in `messages` is a user bubble with matching text added within the last 10s, replace it instead of appending. This handles the dedupe for the idle-path; the queued-path is already covered by `handleMessageQueued`.
- If the runner was busy, `message_queued` arrives (now via broadcast) and the existing handler removes the optimistic bubble, stashing it for drain-time re-insertion. No new code required there.

The two mechanisms (`message_queued` + the new `system_user_message` dedupe) cover the two paths exclusively — there is no case where both fire for the same dispatch. The fix is one handler, not two.

**Multi-viewer edge:** if two tabs both have an optimistic bubble for different actions and a `message_queued` for one of them arrives, the existing text-match removal handles it. The only failure mode is two simultaneous optimistic bubbles with identical text on different tabs — unlikely and not worse than today's behavior for the WS `send_message` path.

### Client: the six callsites

A shared helper centralizes the pattern:

```ts
// src/client/utils/dispatch-agent-message.ts
export function dispatchAgentMessage(opts: {
  sessionId: string;
  text: string;
  activity: string;
  apiPost: <T>(path: string, body: unknown) => Promise<T>;
}): Promise<void> {
  const { sessionId, text, activity, apiPost } = opts;
  // Optimistic append — mirrors what handleCreatePr does inline today.
  const session = useSessionStore.getState();
  session.setMessages((prev) => [...prev, { role: "user", text }]);
  session.setIsLoading(true);
  session.setActivity({ label: activity });
  return apiPost(`/api/sessions/${sessionId}/agent/dispatch`, { text, activity });
}
```

Each callsite then becomes a thin wrapper that builds the prompt + activity and calls the helper. Example for the compose-error case:

```ts
const handleSendComposeErrorToAgent = useCallback(async () => {
  const { composeError } = usePreviewStore.getState();
  if (!composeError) return;
  const sid = useSessionStore.getState().sessionId;
  if (!sid) return;
  requestPermission();
  const text = `Docker Compose failed to start:\n\n\`\`\`\n${composeError.trim()}\n\`\`\`\n\nPlease fix this error so the services can start successfully.`;
  await dispatchAgentMessage({ sessionId: sid, text, activity: "Fixing compose error…", apiPost });
}, [apiPost, requestPermission]);
```

`requestPermission()` is preserved because `handleCreatePr` and `handleSendErrors` both call it today; the new prefill-conversion callsites also gain it (today they don't call it because they only fill the input — but now they're actually dispatching). For `useAutoFix.handleSendAutoFix`, the existing path doesn't call `requestPermission` either; preserve that asymmetry (auto-fire shouldn't pop a notification permission prompt at the user out of nowhere).

**`disableAutoFix()` is *not* called from the converted send-direct callsites.** Today it's invoked only by `handleSend` (user-typed) and on session-switch effects. The intent is "stop auto-retrying when the user takes manual control"; a server-initiated retry or a user clicking "Create PR" doesn't fit that intent. Confirm by leaving the call set unchanged.

**On error.** If `apiPost` rejects (network, 404, 401, 500), the helper rolls back the optimistic bubble — pop the last message if its text matches — and surfaces a toast/error. The 401 case specifically prompts re-auth via the existing notification flow.

**Client-side double-click guard.** Compose-error overlays can flicker on/off as compose restarts; a user double-clicking during a flap is plausible. The pattern: each converted handler tracks an `inFlightRef = useRef(false)` and returns early if set; the ref is set to `true` at the start of `dispatchAgentMessage` and cleared in a `.finally(() => { inFlightRef.current = false })`. No new dependency, no new hook — just the same `useRef` pattern already used in `useAutoFix.ts:53` (`prevErrorCountRef`). For belt-and-braces, the button is also disabled while the dispatch is pending (the existing `isLoading` flag is already set by the optimistic append, so most buttons already disable themselves). A true request-id server-side dedupe is deferred unless telemetry shows duplicates leaking through.

`handleCreatePr` (App.tsx:503) drops its WS `send` call and uses the helper. `handleSendErrors` (App.tsx:482) and `useAutoFix.handleSendAutoFix` (`hooks/useAutoFix.ts:43`) likewise convert.

### Adjacent runner surfaces — don't confuse these

For the next reader: the runner has two other "send to agent" surfaces that look like `dispatch` but aren't.

| Method | Lives in | Purpose |
|---|---|---|
| `runner.dispatch(opts)` *(new)* | `session-runner.ts`, `container-session-runner.ts` | Send-or-queue entry point for a *new turn*. The one this PR is about. |
| `runner.sendAgentMessage(text)` | `container-session-runner.ts:766`, called by `proxy-agent-process.ts:103` | Live-steering injection (docs/140): inject a user message into a *currently running* streaming agent. Different lifecycle, different transport (`workerPostMessage` → CLI stdin). |
| `agent.sendUserMessage(...)` | `claude-adapter.ts` / `agent-process.ts` | Adapter-level write to the running agent's stdin. Below `runner.sendAgentMessage`. |

Nothing in this PR touches `sendAgentMessage` or `sendUserMessage`. The naming chosen for the new method (`dispatch`) is intentionally distinct so a contributor grepping for `send*Message` doesn't land on the wrong thing.

### The `system_user_message` client dedupe — implementation note

`ChatMessage` (`MessageList.tsx:68`) has no `createdAt` field, so a literal "last 10s" check needs a different signal. Two options, both small:

- **(a) Sidecar ref in `useMessageHandler`** — a `Map<text, timestamp>` cache populated by `dispatchAgentMessage` (after the optimistic append succeeds) and consumed by the `system_user_message` handler (which checks `cache.get(text)` and treats hits within the last 10s as "this is our echo — dedupe by replacing the tail bubble"). Entries auto-evict after 30s. No schema change to `ChatMessage`.
- **(b) Tag the optimistic bubble** — add `pendingDispatch?: true` to `ChatMessage` (the existing `streaming?` field shows the schema already carries optimistic-state flags). `system_user_message` checks if the tail message is `{ role: "user", text: matching, pendingDispatch: true }` and replaces it.

Picking (b): it co-locates the optimistic-state flag with the bubble that holds it (matches `streaming` precedent), survives a tab reload that wipes the sidecar cache without resending, and the check is a structural property of the message rather than a timing heuristic. Touchpoint: extend `ChatMessage` with the optional flag; `dispatchAgentMessage` sets it on the optimistic append; the `system_user_message` handler clears it on dedupe.

### Known pre-existing bug not introduced here

`handleMessageQueued` stashes the removed optimistic bubble keyed by `text` (`message-queued.ts:21`). Two rapid identical sends overwrite the first stash entry, so the drain re-inserts only one of the two user bubbles. This bug exists today on the WS `send_message` path; the broadcast change in this PR makes it observable across tabs as well. **Out of scope** to fix here — the right fix is a per-message stable ID (likely the `requestId` mentioned under Future work), and rolling it in would expand this PR's surface significantly. Note it so the next reviewer doesn't think it's a regression we introduced.

### Client: prefill for "Start Session from doc"

`handleDocStartSession` (App.tsx:743) is unchanged in this PR. The `prefillText` primitive (`useSessionStore.setPrefillText` and `MessageInput`'s consume effect at 160-173) stays alive to serve one consumer. The decision rule for new features is documented in code via a comment on `setPrefillText`: *"Use only for affordances where the user is expected to edit the prefilled text before sending. For send-direct affordances, use `dispatchAgentMessage` instead."*

See §"Future work" for the longer-term replacement.

### Activity labels

Each callsite picks a short activity string:

| Callsite | Activity |
|---|---|
| Create PR | `"Creating PR…"` |
| Compose error | `"Fixing compose error…"` |
| Compose hint | `"Setting up preview…"` |
| Service logs | `"Investigating service…"` |
| Preview errors (manual + auto-fix) | `"Fixing preview errors…"` |

Today's hardcoded `"CI fix"` default in `runSystemTurn:189` becomes a proper fallback chain: `host.turnSummary.split("\n")[0]?.slice(0, 120) || opts.activity || "agent turn"`. The assistant-derived summary stays the primary commit message; the activity label only takes over when the agent emitted no text (which is the case where `"CI fix"` was misleading anyway).

## Touchpoints

**New files:**
- `src/server/orchestrator/api-routes-agent.ts` — POST route.
- `src/server/orchestrator/services/agent.ts` — `dispatchAgentMessage()` service.
- `src/client/utils/dispatch-agent-message.ts` — client helper (POST + optimistic bubble + error rollback).
- `docs/150-unify-agent-message-dispatch/checklist.md` — remaining items.

**Modified — server:**
- `src/server/orchestrator/session-runner.ts`
  - `AgentDispatchOptions` interface (replaces the `(text, activity?)` arg shape).
  - `SessionRunnerInterface.sendSystemMessage` (line 365) → `dispatch(opts)`.
  - In-process impl `sendSystemMessage` (line 555) → `dispatch(opts)`.
  - `runSystemTurn` (line 129) → `runDispatchedTurn`, full options threaded; recursive self-call at line 204 reads all `QueuedMessage` fields.
  - Auto-commit summary fallback (line 189): `turnSummary || opts.activity || "agent turn"`.
  - Enqueue branch broadcasts `message_queued` via `host.emitMessage` (moved out of the WS handler).
- `src/server/orchestrator/container-session-runner.ts` — `dispatch` rename and signature change at line 1322; `import { runSystemTurn }` at line 31 updates to `runDispatchedTurn`; `_runSystemTurn` private method at lines 1334-1336 renamed and signature widened to match (the inline caller at line 1331 follows).
- `src/server/orchestrator/services/rebase-driver.ts:208` — comment reference to `runSystemTurn` updated so future greps find it.
- `src/server/orchestrator/ws-handlers/send-message.ts`
  - Queue branch at line 138 delegates to `runner.dispatch(...)` and drops the inline `messageQueue.push` + `ctx.send({ type: "message_queued" })`.
  - New-turn path: after the existing `resolveFileAttachments` / `resolveUploadRefs` / `staleAgent.kill()` steps, replace the eventual `runAgentWithMessage(...)` call with `runner.dispatch(...)` carrying the resolved fields. Note: `runAgentWithMessage` may still exist as the in-process turn driver — only its WS-side caller changes.
  - Same delegation for `send_review_message`.
- `src/server/orchestrator/api-routes.ts` — register `api-routes-agent.ts`.
- `src/server/orchestrator/app-di.ts` — expose `runnerRegistry`, `credentialStore`, `agentRegistry` to the new route deps.
- `src/server/orchestrator/app-lifecycle.ts:610` — `runner.sendSystemMessage(prompt, "Auto-fixing CI...")` → `runner.dispatch({ text: prompt, activity: "Auto-fixing CI…" })`.
- `src/server/orchestrator/services/github-ci-fix.ts:263` — same mechanical rename.
- `src/server/orchestrator/services/child-sessions.ts:340, :531` — same mechanical rename.

**Modified — client:**
- `src/client/App.tsx` — convert `handleCreatePr`, `handleSendComposeErrorToAgent`, `handleSendComposeHintToAgent`, `handleSendServiceLogsToAgent`, `handleSendErrors` to use the new HTTP route + helper. Each handler tracks an `inFlightRef` to swallow rapid double-clicks.
- `src/client/hooks/useAutoFix.ts:43` — `handleSendAutoFix` POSTs to the new route instead of WS `send_message`.
- `src/client/components/MessageList.tsx:68` — extend `ChatMessage` with optional `pendingDispatch?: true` flag.
- `src/client/hooks/message-handlers/system-user-message.ts` (or equivalent) — handler today appends unconditionally; the change inserts a dedupe branch in front of the append: if the tail bubble is `{ role: "user", text: matching, pendingDispatch: true }`, clear the flag in place instead of appending a duplicate.
- `src/client/stores/session-store.ts` — add a code comment on `setPrefillText` documenting the "edit-then-send only" rule.

**Tests:**
- `src/server/orchestrator/session-runner.test.ts` — extend the existing `sendSystemMessage` tests (rename) for the new options shape; assert attachments survive a queue → drain round-trip.
- New `src/server/orchestrator/integration_tests/agent-dispatch-route.test.ts` — POST → idle session starts a turn; POST → running session queues; POST to nonexistent / disposed session → 404; empty text → 400; unauthenticated agent → 401; permission mode threaded through; attachments resolved.
- `src/server/orchestrator/ws-handlers/send-message.test.ts` — assert the queue-branch delegates and the broadcast `message_queued` is emitted by the runner (not the handler).
- Tests asserting on `message_queued` likely need a multi-viewer assertion update: `integration_tests/prompt-queuing.test.ts`, `claude-message-flow.test.ts`, `live-steering.test.ts`, `persistent-runner.test.ts`, `interrupt.test.ts`, `ws-disconnect-resilience.test.ts`. Scan for `"message_queued"` and audit each.
- `src/client/hooks/message-handlers/system-user-message.test.ts` (new or extended) — dedupe behavior.
- Update any test asserting on the literal `"CI fix"` commit summary.

## Non-goals / explicit decisions

- **No new WS message type.** The HTTP route is the right shape for "this is a one-shot side-channel send, no streaming, no per-message acknowledgment beyond the SSE echo".
- **No removal of `send_message` / `send_review_message`.** Those carry attachments and review-tool authorization; the WS channel is the right transport for the user-typed surface. The point of the unification is *internal* — the queue/dispatch logic, not the network boundary.
- **No batch endpoint.** None of the callsites need multi-message atomic enqueue; future ones can add it if they show up.
- **No silent retry on POST failure.** If the HTTP call fails (network blip, 404 mid-archive, 401 unauth), the helper rolls back the optimistic bubble and surfaces the error. Auto-retry would hide session-state bugs we'd rather catch.
- **No request-id dedupe.** Client-side 1s debounce handles realistic double-clicks. A UUID-keyed server-side dedupe can be added if telemetry shows duplicates landing through the debounce.

## Risks & open questions

- **What if the runner is in registry but `disposed`?** `runnerRegistry.get(sessionId)` returns the runner reference for a brief window after dispose; the service checks both `!runner` and `runner.disposed` before dispatching. Test covers this.
- **The renamed `dispatch` will require import-site changes across `app-lifecycle.ts`, `services/github-ci-fix.ts`, `services/child-sessions.ts`, and tests.** TypeScript catches each, but the diff is wider than the conceptual change. Acceptable cost for a name that survives the funnel role.
- **The `runSystemTurn` → `runDispatchedTurn` rename.** Same logic applies. If churn becomes a concern at review time, the rename can be deferred to a follow-up PR — but the `dispatch` rename on the public method should stay, since it's what client code sees.
- **The `message_queued` broadcast change.** The originating tab's experience is unchanged (same payload via a different channel). Other tabs gain consistency they should have had all along. The only test surface is multi-viewer assertions in the integration tests listed under Touchpoints.
- **Persistence path:** `runDispatchedTurn` calls `deps.persistMessage(host.sessionId, { role: "user", text })` at `session-runner.ts:145`. The new HTTP path inherits this naturally — chat history records the user message at turn start exactly as it does today for Fix CI. No `chat-history.ts` / `replay.ts` change required.
- **Mobile feedback:** removing the prefill UX deletes the "we filled the textarea, go press send" affordance. The replacement is the immediate optimistic user bubble + the activity spinner (`AgentStatusBar` rendered on `isLoading`), both of which already work on mobile. Verified mentally; worth a quick mobile pass during implementation.
- **Telemetry:** none added in this PR. The HTTP route is just plumbing; existing structured logs from `runDispatchedTurn` (system-turn lifecycle) already cover the agent-side. If we want per-callsite analytics ("how often does the user click Create PR vs auto-fix?"), add it in a follow-up.

## Migration

Single PR. No feature flag — the conversion is observable but reversible (rollback the PR). Touched callsites are exercised every day, so regressions surface fast. The funnel refactor is the riskier piece; the six client conversions are mechanical and can be staged into separate commits within the PR for easier review. Suggested commit order:

1. **Funnel + drain fix** — rename `sendSystemMessage` → `dispatch` and `runSystemTurn` → `runDispatchedTurn`, widen both to `AgentDispatchOptions`, fix the recursive drain at `session-runner.ts:204` to carry all `QueuedMessage` fields, fix the auto-commit summary fallback chain. These are coupled — the rename + signature change forces the new shape into the recursive call, and the only way commit 1 compiles is if the drain already threads the full options. All existing server-side callers (`app-lifecycle.ts:610`, `services/github-ci-fix.ts:263`, `services/child-sessions.ts:340, :531`) update mechanically. Tests touching the literal `"CI fix"` summary update here.
2. **`message_queued` broadcast** — move the emission into `runner.dispatch`'s enqueue branch (via `runner.emitMessage`); update multi-viewer integration tests.
3. **HTTP route + service + auth gate + integration tests** — `services/agent.ts::dispatchAgentMessage`, `api-routes-agent.ts`, registration.
4. **WS handler delegation** — `send-message.ts` queue branch and new-turn path both delegate to `runner.dispatch`; same for `send_review_message`. This is the commit at which the "`runner.dispatch` is the only writer to `runner.messageQueue` / `runner.running`" invariant is fully reached — between steps 1 and 4, the WS handler still pushes inline, so reviewers should treat the invariant as aspirational until this commit lands.
5. **Client conversion** — `ChatMessage.pendingDispatch` flag, `dispatchAgentMessage` helper, `system_user_message` dedupe handler, the six callsite conversions, `setPrefillText` code comment.

## Future work

- **Replace `prefillText` with an explicit "edit-then-send" affordance** for the "Start Session from doc" case. Today, prefilling the composer textarea is the simplest way to deliver an editable prompt, but it keeps a primitive alive that future contributors will reach for incorrectly. A small inline preview ("Send: *Work on: {title}…*" with an Edit button) on the doc preview would let us delete `setPrefillText`, the consume effect in `MessageInput`, and the `prefillText` store field outright. Not blocked on this PR; the decision rule documented on `setPrefillText` is enough guardrail short-term.
- **`requestId` server-side dedupe** if telemetry shows debouncing is insufficient.
- **Migrate `handleFileSendComments` / `handleAskAgentReview` / `/review`** to the HTTP route, eliminating the WS `send_review_message` path entirely. The HTTP route signature already accepts `reviewFilePath`; the holdup is the file/diff review code path's deeper integration with the WS connection (streaming progress, review modal lifecycle). Worth its own doc.

## Success criteria

- Of the six previously prefilling-or-WS-direct-sending client buttons, all six now POST to `/api/sessions/:id/agent/dispatch`. Only `handleDocStartSession` still calls `setPrefillText`.
- `runner.messageQueue.push(...)` (and `runner.enqueue(...)`) appears in exactly one place: inside `runner.dispatch`'s enqueue branch. No WS handler pushes to the queue inline.
- `runDispatchedTurn` accepts and threads `images / files / uploads / permissionMode / reviewFilePath` so a drained queue entry doesn't lose them. Test asserts this round-trips.
- POST `/api/sessions/:id/agent/dispatch` exists with the integration coverage above (404, 400, 401, queued vs. immediate).
- Auto-commit summary uses the agent's first line of output when available, falling back to `activity`, then to `"agent turn"`. Never the literal `"CI fix"`.
- `message_queued` is emitted via `runner.emitMessage` (broadcast), not via the per-socket `ctx.send` in the WS handler.
- Existing Fix CI / child-session / WS `send_message` flows continue to work unchanged from the user's perspective.
- A 1s client-side debounce prevents double-POSTs from a double-clicked button.
