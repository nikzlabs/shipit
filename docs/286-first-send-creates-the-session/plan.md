---
title: First send creates the session — design
description: The Send transaction, its delivery and acceptance contract, and how a claim survives a lost response.
---

# First send creates the session — design

Implements [requirements.md](./requirements.md). Consumer:
[docs/285-network-mode-at-session-creation](../285-network-mode-at-session-creation/plan.md).

**Two open questions in `requirements.md` block implementation code.** The recovery scope and
the editing-during-send semantics change what the transaction record has to be, so the
sections below describe the shape and stop short of committing to those two answers.

## Why `/new` claims late

Today `/new` claims on arrival (`useSessionActivation.ts` ~96), which sets a session id, which
opens the WebSocket (`App.tsx` ~186), which materializes a runner
(`route-registry.ts` ~1263 → `services/materialize-runner.ts` → `getOrCreate`) — and
`getOrCreate` returns that runner forever after without re-evaluating anything
(`session-runner.ts` ~2269). So anything a user chooses on that page after arriving lands on
a session that is already live. Claiming at Send is what makes creation-time choices possible
at all; docs/285 is the first to need it.

## The Send transaction

One **single-flight** operation per new-session generation:

1. **Claim**, carrying the creation-time settings, with an **opaque, globally unique
   draft-claim key** (not an in-memory counter — that collides across tabs) and
   `skipReuse: true` so two tabs cannot alias onto one ungraduated session
   (`claim-session.ts` ~340).
2. **Drain uploads** into the claimed session. `useFileUpload` buffers raw `File`s and
   uploads them in an effect on `sessionId` change (~124), while `MessageInput` captures
   `uploadRefs` *before* calling Send (~640), so without an awaitable
   `drainDeferredUploads(sessionId)` the first frame leaves without attachments.
3. **Connect that session's socket, send the frame, and wait for acceptance.**
4. **Clear the draft** — text, dictation, chips, pending files, issue seed, settings — and
   only then.

`onSend` is synchronous today and the composer clears immediately (`MessageInput.tsx` ~640,
with `App.tsx` ~696 clearing pending files unconditionally), so this is an ownership handoff,
not just making a callback `async`.

### Delivery belongs to the claimed session

A frame sent before the socket is open is stashed in **one global `pendingWsMessage`**
(`App.tsx` ~658) with no owning session (`session-store.ts` ~117), and flushed onto whichever
session is active — rewriting its `sessionId` (`useConnectionSync.ts` ~165). Today that is a
narrow race; here it is the normal path. So the stash is **keyed by its claimed session,
flushed only by that session's socket, and its id is never rewritten**.

That fixes mis-delivery, not non-delivery: `useSessionWebSocket` owns exactly one connection
derived from the current session id (~13), so navigating to B tears down A's socket and
nothing can flush A. The transaction navigates to the claimed session as part of itself,
which is the normal path; a user who deliberately goes elsewhere first leaves the message
**queued against its own session**, delivered when that session next connects, and never
delivered to the session they switched to.

> Whether "delivered when it next connects" must survive a **reload** — and therefore whether
> the transaction record is durable and where the raw `File` objects live, since a component
> ref (`useFileUpload.ts` ~124) cannot survive one — is the first open question.

### Acceptance is a correlated echo

`send()` resolving means only that bytes reached an apparently-open socket; its own contract
asks for a `requestId`-keyed acknowledgement (`useWebSocket.ts` ~8), and `sendUserMessage`
treats wire-or-stash as success (`send-user-message.ts` ~61). The real signal exists: after
persistence the server emits `system_user_message` carrying `clientRequestId`
(`turn-executor.ts` ~493).

- That echo **is** acceptance, matched on a stable request id the transaction retains across
  retries.
- **Rejections must be correlated too.** Today the outer catch correlates only
  `AgentTurnAdmissionError` (`route-registry.ts` ~1971) and the early validation failures emit
  generic errors — images (`ws-handlers/send-message.ts` ~87), uploads (~423), missing
  workspace (~556) — so a failure cannot be tied to the send it belongs to.
- **`(sessionId, clientRequestId)` needs atomic semantics**, because `persistUserMessageOnce`
  dedups only within one dispatch invocation (`turn-executor.ts` ~486): a concurrent duplicate
  while the original is being admitted; a duplicate after acceptance (replay the acceptance,
  do not dispatch); the same id with different content (reject); and whether a correlated
  rejection permits retry with the same id.

### A claim that survives a lost response

Retaining the claimed id is not idempotency: if the response is lost there is no id to
retain. The **draft-claim key → session** mapping is the server's, atomic, and returns the
same session for the same key through a lost response, a reload, or concurrent retries.

Its lifetime cannot be "until the session graduates": graduation happens in the send handler
(`ws-handlers/send-message.ts` ~482) **before** the acceptance echo is emitted
(`turn-executor.ts` ~493), so retiring it there retires it exactly in the window it exists to
cover. And every `warm = 1` session — explicitly including claimed-but-never-graduated
drafts — is deleted on orchestrator restart (`startup-tasks.ts` ~288), before container
init (`bootstrap-managers.ts` ~149), so a durable mapping can point at a session that no
longer exists.

> The mapping's real lifetime, and whether it must survive an orchestrator restart at all,
> follow from the recovery question above. A mapping that outlives its session must resolve
> to "gone, start again" rather than a dangling id.

## Pre-Send autocomplete

`@file` and `/skills` keep working with no claim, from the repo's **existing warm session** —
a warm session has a `workspaceDir`, and `resolveSessionDir` (`api-routes.ts` ~391) applies
no warm-session guard. But the client must not hold the warm id itself: claim clears the repo
pointer (`claim-session.ts` ~356) **without broadcasting**, so a retained id can by then be
another tab's active session, and the file/skill store setters are unkeyed
(`file-store.ts` ~431, ~487).

So: a **repo-scoped draft-context endpoint** that resolves the pointer server-side,
**resolves → reads → re-checks → retries** (bounded) so a rotation mid-read cannot serve a
mixed answer, returns explicit "no context" rather than hanging, and states which harness
determines the skill list. The client refetches on `repo_warm_ready`
(`useServerEvents.ts` ~303) so a transient rewarm does not kill autocomplete for the rest of
the visit. Built-in skills are included (req 7): the built-ins route needs a runner
(`api-routes-files.ts` ~301, ~328) which warming does not create
(`warm-pool-manager.ts` ~224), so they come from the standby **worker** or a
backend-scoped cache instead.

## What else must change on `/new`

- The composer is disabled today when there is neither a session nor an open socket
  (`App.tsx` ~2224); that becomes "a repo is selected".
- Issue seeding records the issue only when a session id exists (`App.tsx` ~1415), so it
  binds to the draft generation and is applied after the claim.
- `/review` refuses without a session (`App.tsx` ~531) and continues to, before the first
  message — unchanged, and out of scope.
- A **new-session generation**, incremented on every deliberate new-session action, gives the
  draft an identity: the route and text-draft keys are both `new:${repoSlug}`
  (`App.tsx` ~1692, `useMessageDraft.ts` ~34), so a second new session in the same repo has
  no identity of its own today. It owns the ephemeral choices and single-flight state; the
  per-repo key keeps owning the text.

## Where the tests go

1. The first message reaches its own session when the user switches sessions mid-flight, and
   is not delivered to the session switched to.
2. A lost acceptance echo plus a retry results in **one** persisted message.
3. A lost claim response plus a retry with the same key results in **one** session.
4. A failed claim, upload or send preserves the entire draft, including raw attachments.
5. Attachments arrive with the first message — the test must fail against an implementation
   that captures upload refs before the claim.
6. Autocomplete survives a warm-pointer rotation, returns built-ins, and recovers on
   `repo_warm_ready`.

## Key files

| File | Role |
|---|---|
| `src/client/hooks/useSessionActivation.ts` | Stops claiming on `/new`; owns the generation |
| `src/client/components/MessageInput/MessageInput.tsx` | Async send; stops clearing on call |
| `src/client/hooks/useFileUpload.ts` | `drainDeferredUploads(sessionId)` |
| `src/client/stores/session-store.ts`, `src/client/hooks/useConnectionSync.ts` | Session-keyed pending frame |
| `src/client/utils/send-user-message.ts`, `src/client/hooks/useWebSocket.ts` | Correlated acceptance |
| `src/client/App.tsx` | Composer enablement, issue seeding, navigation during send |
| *new* draft-claim endpoint | Key → session mapping, `skipReuse: true` |
| *new* repo-scoped draft-context endpoint | Warm-resolved tree + skills, including built-ins |
| `src/server/orchestrator/ws-handlers/send-message.ts`, `turn-executor.ts` | Correlated rejections; `(sessionId, clientRequestId)` dedup |
| `src/server/orchestrator/startup-tasks.ts` | Deletes ungraduated sessions on boot — bounds recovery |
