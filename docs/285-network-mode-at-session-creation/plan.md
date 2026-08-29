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

The gap is narrower than a cache, but wider than "stale after a dialog write". The trigger is
always visible, so fetch-on-menu-open is not enough: **before its first open it would not
know an existing session has an explicit Open or Contained override at all**, so its initial
label would be wrong, not merely out of date. Four small rules, all local state:

- **Hydrate on active-session mount/change**, so the trigger is truthful before anyone opens
  it.
- **Re-fetch when the menu opens.**
- **Propagate the dialog's successful `PUT` response to the active control in-process** — an
  App-owned callback or a typed same-tab event, filtered by `sessionId`. Not a server event;
  both surfaces are in one tab.
- **Follow the workspace default while showing `Inherit`.** The existing global SSE handler
  only refreshes the egress store when that store was already loaded
  (`useServerEvents.ts` ~733), so a global change would otherwise leave "Currently Contained"
  saying the wrong thing.

Cross-tab divergence stays out of scope, exactly as it is today.

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
runner — so a mode picked afterwards arrives at a session that is already live.

**`/new` therefore holds a draft and claims nothing until Send.** But Send is deliberately
**not** a generalized create-and-dispatch call. It is the smallest step that makes the choice
land, followed by the paths that already exist:

1. **Claim** a fresh session, carrying only the creation-time settings — network mode, the
   picker tuple, permission mode, the issue pointer — with `skipReuse: true` so two tabs
   cannot alias onto one ungraduated session via `findUngraduatedWarm`
   (`claim-session.ts` ~340). Repository trust is checked **before** the claim; today it is
   enforced at dispatch (`session-runner.ts` ~393), which in the headless path is after a
   workspace has been claimed and mutated.
2. **Persist** the override and **reconcile** the standby (below), before returning.
3. **Return the session id.**
4. The client connects the session's ordinary WebSocket and sends the first message down the
   **existing** upload/send path.

### Why not one create-and-dispatch call

An earlier draft generalized `createHeadlessSession` into a single transaction carrying the
whole first-turn payload. Two reasons it is wrong:

**`dispatch()` is not a commit point.** It sets `running = true` in memory and then launches
the turn without awaiting it — `void runner.runDispatchedTurn(...)`
(`session-runner.ts` ~555) — while attachment resolution, trust re-checking, agent creation
and run-parameter assembly all still happen afterwards (`dispatched-turn.ts` ~90, ~119,
~241), and a setup failure turns `running` back **off** after dispatch already returned
(~561). So an HTTP 200 can be followed by the orchestrator crashing before the turn ever
reaches a worker. That is not at-least-once, as a previous draft of this plan claimed: it has
a **loss** window as well as a duplication one. Making it honest would need durable,
idempotent first-turn admission with a retry supervisor — which is the subsystem this whole
design exists to avoid.

**And moving graduation in front of dispatch does not make it transactional.** Graduation
broadcasts the session and schedules asynchronous naming; the issue lifecycle update is an
external side effect. Neither un-happens.

Reusing the WS send path sidesteps all of it: the first message is an ordinary message on an
ordinary session, with the delivery semantics every other message already has. Raw
attachments do not need migrating into an HTTP payload either — they are already buffered
until a session id exists (`useFileUpload.ts` ~124), and now one does.

**What still must ride the claim**, validated server-side, because it decides how the
container and the first turn are set up:

- the network mode;
- **service + billing + model as a triple**, never a bare id (`App.tsx` ~1564);
- reasoning, role, and **permission mode** — which Quick Capture displays but does not send,
  the server hardcoding `permissionMode: undefined` (`headless-sessions.ts` ~460), so req 6
  needs that fixed regardless of network;
- the **issue pointer**, including its mark-started side effect
  (`api-routes-session-crud.ts` ~679).

**Quick Capture keeps its own path.** It is background and optimistic and already creates and
dispatches server-side; it gains the network mode and the permission mode, and the same
reconciliation preflight. It is not merged with `/new`, and `/new` does not become headless.

### The new-session generation

Requirement 8 does not hold without one. The new-session key is `new:${repoSlug}`
(`App.tsx` ~1692) and `useMessageDraft` only swaps state when that key changes
(`useMessageDraft.ts` ~34); route activation likewise recognises a new `/new` by repo slug
(`useSessionActivation.ts` ~69). So starting another new session **for the same repository**
produces no new identity, and a network pick would silently persist into it.

An explicit in-memory `newSessionGeneration` fixes it: incremented on every deliberate
new-session action even for the same repo; it resets the network mode to `Inherit`, owns
single-flight submission, and guards late completion so one submission cannot clear or
navigate another. It does **not** go into the text-draft storage key — retaining text per
repository is deliberate. The generation owns the ephemeral choices; the repo key keeps the
text. The pending issue reference, which today parks against a real `sessionId`
(`App.tsx` ~1405), hangs off the generation until the claim succeeds.

### Standby reconciliation: one named operation, before materialization

The warm pointer is published before the standby boots, creation is fire-and-forget
(`warm-pool-manager.ts` ~224, ~296), the container record is `starting` before its egress
mode is resolved (`container-lifecycle.ts` ~1191 vs ~1435), and it is not marked a standby
until creation finishes (`session-container.ts` ~1524). Materialization currently waits for
`starting` and then adopts (`app-lifecycle.ts` ~788).

So the transaction calls one container-manager operation **before**
`runnerRegistry.getOrCreate` — and that operation **evicts; it does not create**:

- **A running container whose recorded boot mode matches** → leave it alone.
- **Anything else** — mismatching, `starting`, or unknown → `await destroy(sessionId)` and
  return. The ordinary runner factory then materializes the replacement.

It keys on the **container record**, not on the standby marker: a running record can exist
before the standby set is updated (`session-container.ts` ~1524), so "is it a standby?" is
the wrong question and would let a live-but-unmarked container through.

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
- **The desired containment is resolved once and passed in.** Otherwise a workspace-default
  change racing an `Inherit` session lets reconciliation approve a container against one
  global value while the factory creates against another. The operation takes a resolved
  boolean, never re-derives it.

The **legacy claim route uses the same operation** before returning (below).

### Failure, and what "sent" means

`MessageInput` calls a synchronous `onSend` and clears text and uploads immediately
(`MessageInput.tsx` ~640), which is only safe when sending cannot fail. With Send split into
claim-then-ordinary-message, the fallible part is the **claim**, and its semantics are small:

- **The draft — text and the network pick — survives a failed claim.** Nothing is cleared
  until a session id comes back.
- **Single-flight per generation**, so a double Enter cannot claim twice. Two tabs are two
  deliberate sessions; cross-tab coordination stays cut.
- **A lost response after a successful claim** leaves an ungraduated session behind and the
  user retries into a second one. That is the pre-existing behaviour of every claim in the
  product, not something this feature introduces — the warm pool already reclaims
  ungraduated sessions.
- **No rollback machinery, and no egress deletion cascade in scope.** Both existed only to
  unwind a transaction that no longer exists. The missing cascade
  (`services/session.ts` ~924) goes back to being separable hygiene.

Once the id exists, the first message is an ordinary message on an ordinary session: same
delivery semantics, same queueing, same failure surface as every other turn. No commit point
has to be invented, because none is being claimed.

### Rollout

A cached old client still claims, connects and materializes *before* it sends, so "missing
field means Inherit" cannot be repaired at its first dispatch. The legacy claim route
therefore does the **minimum**, in order: treat a missing mode as `Inherit`; clear any stale
override; evict an incompatible container via the same operation; return. It does **not**
pre-create a replacement — the factory does that, as everywhere else — and it does **not**
gain `skipReuse: true`. That flag belongs on the new Send path, where reusing another tab's
server-side draft would be dangerous; on the legacy route it would disable the existing
abandoned-draft reuse branch (`claim-session.ts` ~340) and strand more ungraduated sessions,
which is a pre-existing cross-tab behaviour change this feature has no business making.

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
Not cut, because it turned out not to need cutting:

- **Pre-Send `@file` and project-skill autocomplete are kept**, read from the repo's
  **existing warm session** with no claim. A warm session already has a `workspaceDir`;
  `RepoInfo.warmSessionId` already reaches the client (`repo-store.ts` ~140); and
  `resolveSessionDir` (`api-routes.ts` ~391) applies no warm-session guard, so
  `GET /api/sessions/<warmSessionId>/files` serves that tree today. Reads only — writes *are*
  refused for warm sessions, and reads are all autocomplete needs.

  Three honest limits. The warm checkout is *usually* the workspace Send hands over, but not
  always — claim can take its reuse path or fall back to a fresh clone — so treat the tree as
  "this repo's checkout" rather than "your session's". The id can go stale mid-compose if the
  pool re-warms, so a 404 degrades to no autocomplete instead of erroring. And Codex's
  built-in skills come from a session-worker endpoint rather than the filesystem
  (`api-routes-files.ts` ~301), so that slice depends on the standby being up and degrades
  the same way.
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
change, altering both containment and start latency.

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
| `src/server/orchestrator/services/claim-session.ts` | Unchanged responsibility; the new Send path passes `skipReuse: true`, the legacy route does not |
| `src/client/components/PermissionModeSelector.tsx` | The combined mode + network control |
| `src/client/components/MessageInput/MessageInput.tsx` | Renders it everywhere; must not clear a draft that failed |
| `src/client/components/MessageInput/ComposerSettingsMenu.tsx` | Loses its Mode row; role list opens directly |
| `src/client/hooks/useSessionActivation.ts` | Stops claiming on `/new` (phase 2) |
| `src/client/hooks/useFileUpload.ts`, `MessageInput/hooks/useUploadBackend.ts` | Raw attachments reachable with no session id |
| `src/client/App.tsx` | Composer enablement, Send, issue seeding, the picker tuple, dictation |
| `src/client/components/QuickCaptureOverlay.tsx` | Sends network **and** permission mode; resets on open |
| `src/client/components/SessionSidebar/SessionSettingsDialog.tsx` | Keeps its section; matched copy; propagates its PUT result same-tab |

**Separable hygiene, not on this path:** permanent deletion clears several stores but not
egress (`services/session.ts` ~924), and the egress tables have no session foreign key
(`database.ts` ~632). UUID-scoped rows leak storage but cannot reach a future session id.

**Open for local mode:** `RUNTIME_MODE=local` has no container manager, so reconciliation has
nothing to reconcile while the durable setting and the first turn must still work. The
transaction must no-op that step rather than assume a manager exists.
