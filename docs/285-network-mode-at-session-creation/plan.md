---
title: Network mode at session creation — design
description: Fold network containment into the composer's permission-mode control; make /new sessionless so the mode is chosen before any runner exists.
---

# Network mode at session creation

Implements [requirements.md](./requirements.md). Prototype: [mockup.html](./mockup.html).

## Shape

Network containment gets **no new control**. It joins the composer's existing
permission-mode button (`PermissionModeSelector`), which becomes one flat popover with two
labelled sections — **Permission mode** and **Network access** — and no drill-down
(reqs 5, 6). One trigger, on desktop and mobile, for new sessions and running ones.

Why not a pill of its own: the setting is needed rarely and the composer row is the scarcest
space in the product (docs/260 exists to keep that row from pushing Send off the edge).

- **Trigger.** Auto with an inherited network mode is the bare icon it is today. A
  non-default network mode is named **in words**, not by a glyph and a tint — this control is
  used on touch, where there is no hover, and req 10 wants the effective mode visible before
  committing. Amber marks a loosening and sits on top of the words.
- **`Inherit workspace` names what is inherited** ("Currently Contained"), re-read on open.
  The same wording is used in `SessionSettingsDialog`, which says "Inherit global" today —
  one value must not have two names.
- **The enforcement warning appears here**, not only in the dialog: policy and enforcement
  are separate, and the UI must never imply protection it cannot deliver
  (`docs/172-agent-containment/egress-control.md` ~566).
- **The menu states; it does not act.** Before the first turn: "In force from this session's
  first turn." On a running session: "Applies on next container start — restart from Session
  settings." No restart button here, so no need for the popover to survive its own selection.
- **No claim about warm containers in the copy.** An earlier draft said Send would be a cold
  container start when the pick differs from the standby. The browser cannot know a standby's
  boot state, so that sentence was asserting something the client cannot see.
- **Never sticky** (req 8): every new session opens at "Inherit workspace".
- **Sandboxes get no network section** (docs/211, docs/279); a harness with one permission
  mode renders the network section alone, with no dead "Auto" row.

**Mode leaves `ComposerSettingsMenu`** on every viewport; the role case loses a nesting level
so the anchor opens the **role list directly** (req 9).

**`SessionSettingsDialog` keeps its network section** — but it is *not* untouched: its copy
changes to match, and it joins the shared client state below. Req 7 asks for one
authoritative value, and today the dialog fetches only on open
(`SessionSettingsDialog.tsx` ~117) and then keeps its own optimistic state (~170), while the
`egress_settings` SSE refreshes the global store only when it was already loaded
(`useServerEvents.ts` ~733). So: **one session-scoped client slice, and a session-scoped
update carrying the complete server-normalized value.** Not "invalidation" in the abstract.

## Mechanism

Egress is plumbed into the agent netns when the container is *created*
(`container-lifecycle.ts`); a running container cannot be re-plumbed. Today `/new` claims a
session on arrival (`useSessionActivation.ts` ~96), which opens the WS and materializes a
runner — so a mode picked afterwards arrives at a session that is already live. `/new`
therefore stops claiming, and one server-side transaction does the whole thing at Send.

**It is not a new subsystem.** `createHeadlessSession` already is this transaction — validate,
claim, apply settings, materialize, dispatch — so the work is generalizing it to serve both
Quick Capture and `/new`, not writing a second one beside it. It claims with
**`skipReuse: true`** (as headless already does, `headless-sessions.ts` ~396): with no
server-side draft there is nothing to recycle, and reuse lets two tabs alias onto one
ungraduated session via `findUngraduatedWarm` (`claim-session.ts` ~340).

### The first-turn payload

With no socket, everything the WS used to carry must ride the creation request and be
**validated server-side**:

- the text, and the **raw attachments** (chat buffers them in a hook-local ref today, and
  only the overlay backend exposes `File[]` — `useFileUpload.ts` ~124,
  `useUploadBackend.ts` ~25);
- **service + billing + model as a triple**, never a bare model id (`App.tsx` ~1564);
- reasoning, role, and **permission mode** — which Quick Capture displays but does not send
  today, the server hardcoding `permissionMode: undefined` (`headless-sessions.ts` ~460), so
  req 6 needs this fixed regardless of network;
- the **issue pointer and its lifecycle side effect** — seeding also marks the issue started
  (`api-routes-session-crud.ts` ~679), not just an `issueRef`;
- **dictation provenance** (`App.tsx` ~642);
- the network mode.

**Repository trust is checked before the claim.** Dispatch enforces it synchronously today
(`session-runner.ts` ~393), which in the headless path is *after* a workspace has already
been claimed and mutated.

### Standby reconciliation: one named operation, before materialization

The warm pointer is published before the standby boots, creation is fire-and-forget
(`warm-pool-manager.ts` ~224, ~296), the container record is `starting` before its egress
mode is resolved (`container-lifecycle.ts` ~1191 vs ~1435), and it is not marked a standby
until creation finishes (`session-container.ts` ~1524). Materialization currently waits for
`starting` and then adopts (`app-lifecycle.ts` ~788).

So the transaction calls **one container-manager operation that serializes reconciliation
with creation and completes before `runnerRegistry.getOrCreate`**:

- **Known and matching** → adopt.
- **Known and mismatching, or `starting`, or unknown** → destroy and await a fresh container.
  Paying a replacement in the uncommon cases is worth not having a fourth state to reason
  about.

Two details that decide correctness:

- It must read **raw `egressContainedAtStart`**, never `isEgressContained()`, which
  deliberately substitutes current policy when boot state is unknown
  (`session-container.ts` ~639). That fallback is right for compose reachability and wrong
  here — it is exactly how "unknown" would come to read as "matching".
- Conservative cancellation is already supported: destruction bumps the teardown epoch before
  reading the container record (`container-lifecycle.ts` ~1799) and creation observes it
  (~1012). Name and test that path.

The **legacy claim route uses the same operation** before returning (below).

### Failure, and what "sent" means

`MessageInput` calls a synchronous `onSend` and clears text and uploads immediately
(`MessageInput.tsx` ~640), which is only safe when sending cannot fail. So:

- **Every fallible step happens before dispatch, and dispatch is the commit point.** After it
  succeeds there is no rollback — the turn may already be running. Cleanup covers only the
  pre-dispatch window (a claimed, never-dispatched session).
- **The draft — text and raw files — survives until the server accepts it.** A late *success*
  must clear the originating draft even if the user has navigated away, or an already-sent
  message sits waiting to be sent again. A late success must not yank the user out of a
  session they switched to (`useSessionActivation.ts` ~142 guards the same class of race).
- **Single-flight submission**, not cross-tab exactly-once. Two tabs generate different keys
  and would not coalesce anyway; promising exactly-once would mean draft identity,
  key lifetime, same-key-different-payload rejection, in-flight coalescing, response replay
  and crash semantics — a protocol far larger than this feature. Duplicate submission is
  blocked within a tab; two tabs deliberately create two sessions.

### Rollout

A cached old client still claims, connects and materializes *before* it sends, so "missing
field means Inherit" cannot be repaired at its first dispatch. **The legacy claim route
clears the override to `Inherit` and runs the same reconciliation before returning the id**,
with `skipReuse: true` so it cannot recycle an ungraduated session carrying a live runner or
a stale override.

Validation today is too lax to build on: `PUT /api/egress/session/:id` returns 200 for a
missing or invalid `override` and will write an arbitrary session id
(`api-routes-egress.ts` ~331). One strict service validates the enum **and that the session
exists**, and emits the **persisted audit card** — a trust-boundary change with no transcript
record is the docs/279 req 8 regression. That card already supports a session with no runner
(`services/session-settings.ts` ~61).

## Scope: what is explicitly cut

- **First-action `/review`.** It already refuses without a session (`App.tsx` ~531). Nobody
  asking for a network mode would notice; it is not a requirement.
- **Cross-tab exactly-once**, per above.
- **Pre-Send `@file` and project-skill autocomplete.** Both need a session checkout
  (`utils/session-data.ts` ~272, `MessageInput.tsx` ~717, `api-routes-files.ts` ~301). This is
  a **user-visible loss beyond the preview** already accepted in `requirements.md`, and it is
  accepted on the same grounds: building repo-scoped replacement APIs to preserve it would
  cost more than the feature.
- **A new client draft model.** Text is already sessionless and persisted per repo
  (`App.tsx` ~1692, `useMessageDraft.ts` ~35); the pickers already have sessionless seeds.
  What is missing is submission state and server-side application, not a draft abstraction.

## Sequencing

The earlier "land a sessionless `/new` invisibly, then add the control" split was false —
sessionless `/new` *is* the user-visible change (no preview, no warm container, no file or
skill autocomplete). The real split:

1. **Backend only, invisible:** generalize `createHeadlessSession` into the create-and-dispatch
   transaction — full payload validation, the reconciliation operation, trust-before-claim,
   pre-dispatch cleanup. Eager `/new` claim stays; Quick Capture switches to it.
2. **User-visible, together:** `/new` goes sessionless and the combined control ships in the
   same change. Landing "sessionless `/new`, no network control" has no product stopping
   point.

## Where the tests go

1. **Mode in force on the first turn**, across `/new` Send and Quick Capture.
2. **Reconciliation in every state** — matching adopts; mismatching, `starting` and unknown
   all destroy-and-await. Must fail in both directions, and must fail if the implementation
   reads `isEgressContained()` instead of the raw field.
3. **The complete payload survives**: model triple, reasoning, role, permission mode
   (including Quick Capture's, dropped today), issue pointer *and* its mark-started effect,
   dictation, raw attachments.
4. **Failure before dispatch** preserves the draft and leaves no claimed session behind;
   **success after navigation** still clears the originating draft.
5. **Legacy rollout**: an old client that claims and connects before sending gets `Inherit`.
6. **The audit card** is emitted for a creation-time choice and survives a reload.
7. **Composer and dialog agree** after a change in either.

## Key files

| File | Role |
|---|---|
| `src/server/orchestrator/services/headless-sessions.ts` | Generalized into the create-and-dispatch transaction (phase 1) |
| `src/server/orchestrator/session-container.ts` | The named pre-materialization reconciliation op; raw `egressContainedAtStart` |
| `src/server/orchestrator/container-lifecycle.ts` | Teardown-epoch cancellation path |
| `src/server/orchestrator/api-routes-egress.ts` | Strict validation, session existence, audit card |
| `src/server/orchestrator/services/claim-session.ts` | Unchanged responsibility; called with `skipReuse: true` |
| `src/client/components/PermissionModeSelector.tsx` | The combined mode + network control |
| `src/client/components/MessageInput/MessageInput.tsx` | Renders it everywhere; must not clear a draft that failed |
| `src/client/components/MessageInput/ComposerSettingsMenu.tsx` | Loses its Mode row; role list opens directly |
| `src/client/hooks/useSessionActivation.ts` | Stops claiming on `/new` (phase 2) |
| `src/client/hooks/useFileUpload.ts`, `MessageInput/hooks/useUploadBackend.ts` | Raw attachments reachable with no session id |
| `src/client/App.tsx` | Composer enablement, Send, issue seeding, the picker tuple, dictation |
| `src/client/components/QuickCaptureOverlay.tsx` | Sends network **and** permission mode; resets on open |
| `src/client/components/SessionSidebar/SessionSettingsDialog.tsx` | Keeps its section; shared slice, matched copy |

**Separable hygiene, not on this path:** permanent deletion clears several stores but not
egress (`services/session.ts` ~924), and the egress tables have no session foreign key
(`database.ts` ~632). UUID-scoped rows leak storage but cannot reach a future session id.

**Open for local mode:** `RUNTIME_MODE=local` has no container manager, so reconciliation has
nothing to reconcile while the durable setting and the first turn must still work. The
transaction must no-op that step rather than assume a manager exists.
