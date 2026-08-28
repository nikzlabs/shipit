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
- **The setup limitation is stated, not implied** (req 11). If the workspace default is
  Open, a trusted repo's `agent.install` may already have run in the warm container before
  the mode was picked (`warm-pool-manager.ts` ~297). The menu says the guarantee is this
  session's first *turn*; it does not let "Contained" imply that repository setup was also
  contained.
- **No claim about warm containers in the copy.** An earlier draft said Send would be a cold
  container start when the pick differs from the standby. The browser cannot know a standby's
  boot state, so that sentence was asserting something the client cannot see.
- **Never sticky** (req 8): every new session opens at "Inherit workspace".
- **Sandboxes get no network section** (docs/211, docs/279); a harness with one permission
  mode renders the network section alone, with no dead "Auto" row.

**Mode leaves `ComposerSettingsMenu`** on every viewport; the role case loses a nesting level
so the anchor opens the **role list directly** (req 9).

**`SessionSettingsDialog` keeps its network section**, and the composer control **piggybacks
its existing pattern** rather than introducing state machinery:

- `GET /api/egress/allowlist?session=<id>` when the menu opens;
- `PUT /api/egress/session/:id` on change, reading the returned `EgressSessionSettings`,
  which already carries `pendingRestart` — the same two calls the dialog makes
  (`SessionSettingsDialog.tsx` ~117, ~174), with no store between them.

A review proposed a keyed `sessionId → settings` cache plus a new session-scoped SSE
payload. That is more than this needs. The per-session route **emits no SSE today** (it
persists a transcript card and returns the settings —`api-routes-egress.ts` ~331), the dialog
uses no store, and both surfaces live in one browser tab. Fetch-on-open already makes the
dialog current after a composer write.

The one genuine gap is narrower: the composer's **trigger** is always visible, so it can
show a stale mode after a write made *in the dialog*. That is fixed by the two components
telling each other in-process — the write path notifies, the trigger updates — not by a
server event. Cross-tab divergence is out of scope, exactly as it is today.

**Copy alignment is part of this.** The dialog says "Inherit global" where the composer says
"Inherit workspace"; one value must not have two names.

**No audit card for the creation-time choice.** The route's persisted
`session-settings-change` card (docs/279 req 8) records a *change* to a session's settings.
At creation there is no prior state to change from, and a "changed network containment" card
sitting above the first message describes something that never happened. The card stays for
edits to an existing session — which is what docs/279 asks for — and the creation path
suppresses it.

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

So the transaction calls one container-manager operation **before**
`runnerRegistry.getOrCreate` — and that operation **evicts; it does not create**:

- **A running standby whose recorded boot mode matches** → leave it alone.
- **Anything else** — mismatching, `starting`, or unknown → `await destroy(sessionId)` and
  return. The ordinary runner factory then materializes the replacement.

It must not "destroy and await a fresh container", which an earlier draft said: production
containers are created *by the factory, after* `getOrCreate`, which returns a runner
immediately and kicks off creation with a `void` call (`app-lifecycle.ts` ~840). There is
also no creation mutex or tracked creation promise to serialize against — `destroy()` bumps
the teardown epoch so an in-flight creation aborts (`container-lifecycle.ts` ~1799, observed
at ~1012), and the code explicitly tolerates an old creation failing after a newer
incarnation started (~1597). That is **cancellation with overlap, not serialization**, and
the design has to fit it rather than assume a primitive that does not exist.

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

- **Every fallible step moves in front of dispatch, and dispatch becomes the commit point.**
  It is not one today: `createHeadlessSession` dispatches (~460) and then still graduates
  (~476), arms auto-merge, and re-reads the session in a way that can throw (~510), with the
  route starting the issue lifecycle afterwards (`api-routes-session-crud.ts` ~679). All of
  that has to precede the dispatch, or "committed" means nothing.
- **What dispatch commits is admission, not success.** `dispatch()` returns once the turn is
  synchronously admitted; the actual setup is fire-and-forget and can still fail later during
  attachment, agent creation or run-parameter assembly (`session-runner.ts` ~561). That is a
  fine definition of acceptance — but it is the definition, and it is stated rather than
  assumed.
- **Rollback covers only the pre-dispatch window**, and it must clear the **egress row** it
  wrote. That is why the store's missing deletion cascade (`services/session.ts` ~924) is not
  fully "separable hygiene": this transaction creates the row itself, so it owns cleaning it
  up when it abandons a claimed session. Cleanup also has to coordinate registry disposal
  with the asynchronous container creation `getOrCreate` has already started.
- **At-least-once, stated honestly.** If the response is lost *after* the server accepted,
  the browser cannot know: it keeps the draft and a retry creates a second session. Only
  request idempotency resolves that, and idempotency is cut (above) — so this is a real,
  accepted behaviour, not an oversight. The user sees the extra session in the sidebar. The
  plan must not promise "the draft survives until the server accepts it" as though the client
  can always tell.
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
field means Inherit" cannot be repaired at its first dispatch. The legacy claim route
therefore does the **minimum**, in order: treat a missing mode as `Inherit`; claim a session
that cannot alias a live draft; clear any stale override; evict an incompatible standby via
the same operation; return. It does **not** pre-create a replacement — the factory does that,
as everywhere else.

Validation today is too lax to build on: `PUT /api/egress/session/:id` returns 200 for a
missing or invalid `override` and will write an arbitrary session id
(`api-routes-egress.ts` ~331). One strict service validates the enum **and that the session
exists**. It keeps the persisted `session-settings-change` card for edits to an existing
session (docs/279 req 8 — a trust-boundary change with no transcript record is the
regression that requirement closed) and suppresses it for the creation-time choice, per
above. The card already supports a session with no runner
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

Sessionless `/new` and the combined control **ship together**. Landing "sessionless `/new`,
no network control yet" removes the preview, the warm container and file/skill autocomplete
for no user benefit — there is no product stopping point there.

**And phase one is not invisible either.** An earlier draft claimed a behaviour-preserving
backend phase; it is not one. Quick Capture already calls `createHeadlessSession`
(`stores/actions/session-actions.ts` ~296), so there is no untouched path waiting to be
switched over, and every item in that phase changes something observable: sending Quick
Capture's currently-ignored permission mode changes first-turn behaviour; trust-before-claim
changes when a failure surfaces; reconciliation can evict a standby after a global policy
change, altering both containment and start latency; and `skipReuse: true` on the legacy
route disables its abandoned-draft reuse branch (`claim-session.ts` ~340), leaving more
ungraduated sessions behind.

So it is one change, sequenced internally rather than split into two releases — and the
honest framing is that the backend work is *smaller-blast-radius*, not *invisible*.

**Requirement 9 stays in scope**, despite looking like unrelated cleanup: the one-row role
root exists *because* Mode leaves `ComposerSettingsMenu`, and Mode leaves because of this
feature. It is a consequence, not a bundled chore.

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
6. **The audit card fires for an edit and not for creation** — a change from the dialog or
   the composer on an existing session records a persisted card that survives a reload; the
   initial choice records none.
7. **Composer and dialog agree** after a change in either.

## Key files

| File | Role |
|---|---|
| `src/server/orchestrator/services/headless-sessions.ts` | Generalized into the create-and-dispatch transaction (phase 1) |
| `src/server/orchestrator/session-container.ts` | The named pre-materialization reconciliation op; raw `egressContainedAtStart` |
| `src/server/orchestrator/container-lifecycle.ts` | Teardown-epoch cancellation path |
| `src/server/orchestrator/api-routes-egress.ts` | Strict validation, session existence; card on edit, not on creation |
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
