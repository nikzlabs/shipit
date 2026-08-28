---
title: Network mode at session creation — design
description: Fold network containment into the composer's permission-mode control; one menu, every surface, new and running sessions.
---

# Network mode at session creation

Implements [requirements.md](./requirements.md). Prototype: [mockup.html](./mockup.html).

## Shape

Network containment gets **no new control**. It joins the composer's existing
permission-mode button (`PermissionModeSelector`), which becomes one flat popover with two
labelled sections — **Permission mode** and **Network access** — and no drill-down
(reqs 5, 6). Both settings are one tap from the same trigger, on desktop and on mobile,
for a session that has not started and one that is running.

Why this and not a pill of its own: the setting is needed rarely, and the composer row is
already the scarcest space in the product — docs/260 exists to keep the harness, model and
reasoning labels from pushing Send off the edge. A control that is usually invisible and
occasionally essential belongs *inside* one that is already there.

- **Trigger.** Unchanged in the common case: Auto with an inherited network mode is the
  bare icon it is today. A non-default network mode adds a glyph, and a *loosening* takes
  the amber tint — colouring a tightening too would train the eye past the tint that
  matters. The tint is decoration on top of words, never the message: the accessible name
  and tooltip state the effective network mode, and pending-restart, in text.
- **The `Inherit workspace` row names what is inherited** ("Currently Contained") rather
  than making the user hold the workspace default in their head (req 10).
- **Footer.** Before the first turn: "Applied when this session starts — nothing to
  restart." On a running session: the existing "Pending · applies on next container start"
  strip with **Restart to apply now**, moved here from `SessionSettingsDialog`.
- **Never sticky** (req 8): every new session opens at "Inherit workspace". The pick is a
  per-session state like the Quick Capture auto-merge checkbox, deliberately not a
  localStorage seed like the model — a sticky loosening is an invisible standing change to
  the containment default.

### Two things move out

**Mode leaves `ComposerSettingsMenu`** on every viewport (today it folds in below 700px).
That menu keeps only what a role sets, and the role case loses a nesting level (req 9): a
session running under a role had a root of one row that opened another panel, so the
anchor now opens the **role list directly**, with "Adjust parameters…" beneath it. Quick
Capture's `modeInRow` special case (docs/260 req 19) stops being special — it becomes what
every surface does.

**The network radio group leaves `SessionSettingsDialog`** (req 7). Since the composer
control serves running sessions, keeping it there would be a second control over one
session's egress. What remains in that dialog is the sandbox capability grants (docs/279),
a different question with a different vocabulary — so for a **non-sandbox** session the
dialog has nothing left and the sidebar's "Session settings" item goes with it.

**`PermissionModeSelector` stops hiding, but never shows a dead row.** Today it returns
`null` when the harness advertises only `auto` (`PermissionModeSelector.tsx:121` — Codex has
nothing to toggle). Carrying network it must render, since network is meaningful whatever
the harness offers — but in that case it renders the **network section alone** and omits the
permission section entirely. A non-actionable "Auto" row above the network section would be
worse than the `null` it replaced.

## Mechanism — a first-turn gate, not a standby comparison

Egress is a **container-creation** topology choice (docs/172-agent-containment
`egress-control.md`): the Tier A firewall, Tier B resolver and Tier C SNI proxy are plumbed
into the agent netns by `container-lifecycle.ts` when the container is *created*. That is
why the running-session half of the menu still says "applies on next container start" — no
UI change removes that.

The **new-session** half is the hard part, because both creation surfaces claim a **warm
session** whose container the warm pool created **ahead of time**
(`warm-pool-manager.ts` → `SessionContainerManager.createStandby`, verified at
`session-container.ts:1524`), with the *inherited* containment — a fresh session id carries
no override.

> **Rejected: comparing at the `claimStandby` sites.** An earlier draft of this plan put the
> check in the runner factory (`app-lifecycle.ts:764`), refusing a standby whose
> `egressContainedAtStart` disagreed with the resolved containment. **That does not deliver
> requirement 3**, and the review that found it was verified against the code:
>
> - On `/{owner}/{repo}/new` the session WebSocket connects as soon as the claim resolves,
>   and that connect materializes the runner — `route-registry.ts` (~1279) →
>   `materializeRunnerSync` → `runnerRegistry.getOrCreate` (`services/materialize-runner.ts:113`)
>   → the factory → `claimStandby` (`app-lifecycle.ts:775`). The standby is therefore
>   adopted **before the user has opened the menu**.
> - `RunnerRegistry.getOrCreate` returns an existing, non-disposed runner **without calling
>   the factory at all** (`session-runner.ts` ~2269), so no later pick can re-trigger the
>   comparison.
> - A `PUT` immediately followed by Send races unless Send awaits it or carries the mode.
>
> And it is **not** kept as an optimisation either. The gate below has to handle every case
> regardless, so a second, partial check earns nothing and adds `isStandby` / `starting`
> edge cases to reason about. There is one mechanism, not one-and-a-fallback.

### One serialized admission service

The guarantee is **`admitFirstTurn(sessionId, desiredMode?)`** — a single service every
first-dispatch path awaits before the turn runs. Not a check bolted onto one handler: there
are four ways to dispatch a first turn, and all four are real.

| Caller | Where | Note |
|---|---|---|
| WebSocket send | `ws-handlers/send-message.ts` | Must run **before** graduation (~485), or capture "was ungraduated" first — graduation clears the flag the gate keys on. |
| HTTP dispatch | `services/agent.ts` (~213) | `POST /api/sessions/:id/agent/dispatch` graduates and dispatches on its own, never entering `send-message.ts`. `App.tsx` (~816) uses it from the `/new` route for compose-error and preview-setup messages, so it genuinely carries first turns. It accepts no network mode today. |
| Quick Capture | `services/headless-sessions.ts` | Between `claim()` (~403) and runner creation (~426). It cannot persist "before the claim" — there is no session id until the claim returns. |
| Child spawn | `services/child-sessions.ts` | Graduates (~881) and dispatches (~948) without touching any caller above. |

These four are the whole set: every other `runner.dispatch()` site is a follow-up, a queue
drain, or remediation, none of which can be a session's *first* turn. Every client that
produces a first dispatch sends the mode through one shared request shape; `/review` and the
other frame-constructing paths get it from the same helper rather than each growing a field.

> **A rejected exclusion, kept as the reason.** An earlier draft left child spawns out,
> arguing that a child is a new session with no explicit override, so its resolved
> containment must equal what its container booted with. **Both halves are false**, and both
> were checked:
>
> - A child does **not** necessarily get a freshly allocated id. `claim-session.ts` (~356)
>   reuses the repo's existing `warmSessionId`, and `PUT /api/egress/session/:id`
>   (`api-routes-egress.ts` ~331) writes an override with **no check** that the session
>   exists, is graduated, or is visible. So an override can already be sitting on the id a
>   child claims.
> - Flipping the global toggle (`api-routes-egress.ts` ~208) does not retire standbys, so a
>   container created before the flip disagrees with the current global even when nobody set
>   an override at all.
>
> This also names a hazard the feature *creates*: writing per-session overrides to
> claimed-but-ungraduated warm ids becomes routine, so a stale override can leak onto
> whatever unrelated session later inherits that id. See below for how it is handled —
> **not** by clearing on claim.

#### Stale overrides: write a concrete mode, clear only on permanent deletion

The obvious fix — clear the override whenever `claim()` returns an id — is wrong. The browser
can issue both an imperative claim and the route's auto-claim
(`useSessionActivation.ts` ~96 and ~143), so a second, later claim result would erase a
selection the user had already made against the first. Instead:

- **Every first-turn admission carries a concrete mode**, and `Inherit` is a value, not an
  omission: it writes `setSessionOverride(id, null)`. Child spawn supplies `Inherit`
  explicitly rather than leaving the field out. A stale override is therefore overwritten by
  the very act of admitting the first turn, which is the only moment it could matter.
- **The client persists its current local selection when it adopts a claimed id** — including
  `Inherit` — and does not reset that selection on a duplicate claim result.
- **Egress state is cleared on permanent session deletion**, through the `deleteSession`
  cascade, which covers warm retirement, zombie cleanup and repo deletion.
- **Not on archive, and not on ordinary runner or container disposal.** The session still
  owns its id and should keep its setting. Full reset needs nothing new: `clearAll`
  (`database.ts` ~1616) already drops both egress tables.

The service runs under a **per-session admission lock** held across all of it. WebSocket
callbacks are not serialized, so two near-simultaneous first sends can both observe
`runner.running === false`, persist different modes, and race the replacement:

1. Persist the desired mode (`PUT`-equivalent into `egress-allowlist-store.ts`).
2. Resolve containment and compare against the live container's `egressContainedAtStart`.
3. On a mismatch, **replace the runner and the container** (below), not the container alone.
4. Graduate.
5. **Claim the dispatch slot while still holding the lock**, and return the claim to the
   caller — see below. Only then release.

#### The dispatch slot must be claimed inside the lock

The slot is not a flag the caller can set afterwards. `dispatchOnRunner` claims it by
flipping `running = true` **synchronously** before scheduling the async turn
(`session-runner.ts` ~463), precisely to close a microtask gap that would otherwise let a
concurrent send race it. So:

- **Releasing the lock before the claim reopens that race** — a second first-send can enter
  admission in the gap.
- **Claiming it inside admission and then letting the caller call `runner.dispatch()`
  normally is worse** — `dispatch` sees `running === true` and *enqueues* the very message
  admission just cleared to run (`session-runner.ts` ~413).
- The WS path adds its own wrinkle: it decides queue-vs-run near the top of the handler via
  the runner-owned admission `assertCanDispatch` (`ws-handlers/send-message.ts` ~122, docs/243),
  long before its own `running` assignment.

So `admitFirstTurn` returns a **discriminated result, never a bare optional token**:

```
{ kind: "reserved",        runner, token }   // this caller owns the slot
{ kind: "already-admitted", runner }          // someone else got there first
```

Three rules make it safe, and each exists because a simpler version has a hole:

- **The caller must use the returned `runner`, never one it captured earlier.** The HTTP path
  reads its runner before this point (`services/agent.ts` ~161), so after a replacement it
  would otherwise dispatch into a disposed runner.
- **A losing contender gets `already-admitted` and dispatches normally**, so the runner's own
  queueing applies. Two WS sends can both clear the early admission check
  (`ws-handlers/send-message.ts` ~122); without this the second reaches the direct run path
  (~590) and races the reserved turn.
- **The token is opaque, single-use, and bound to that runner; it is consumed by the start
  operation, and until then a `finally` releases it.** "Callers that decline must release"
  is not enough, because the work between admission and dispatch can *throw*: Quick Capture
  does branch work, environment prep and uploads after this point
  (`services/headless-sessions.ts` ~407), and the WS path can still return early on a
  missing workspace (~556). An unreleased reservation leaves the session permanently
  "running" — a worse failure than the race it was added to prevent.

The reservation is the whole point of routing every producer through one service: four
callers each hand-rolling "claim, then dispatch, and unwind correctly on every throw" is
precisely the bug this prevents.

#### The reservation is first-class runner state

It cannot be "`running = true` plus a promise the caller holds". Three things in the existing
runner would otherwise walk over it:

- **It must be immune to `verifyRunningState`.** The WS handler probes any `running` runner
  (`ws-handlers/send-message.ts` ~137) by asking the worker whether an agent is actually up
  (`container-session-runner.ts` ~3102). A reserved-but-not-yet-started runner has no worker
  agent, so that probe would conclude the flag is stranded and clear it — erasing the
  reservation and admitting the very race it holds shut. The check exists to un-strand a
  genuinely stuck flag; a reservation must read as legitimately busy, not as stuck.
- **Release must hand off the queue.** If a losing contender queues behind the reservation
  and the owner then throws, clearing the reservation alone leaves a queued turn with no
  completed turn to drain it. Release therefore goes through the existing queued-turn
  release path, so the loser runs.
- **`dispatch` is not the only consumer.** The WS path starts a turn *interactively*, never
  calling `runner.dispatch()` — so the contract needs an explicit token-consuming **start**
  operation that both paths use. "Only `dispatch` consumes it" does not cover the caller
  this feature exists for.

With those three, an immediate `finally` covers every early return and every throw.

### Replacement is a runner replacement

A `ContainerSessionRunner` holds worker-specific state — its readiness promise (already
resolved for a runner built against a running worker, `container-session-runner.ts` ~370),
SSE wiring, service manager, file-watch and resource-start flags. Repointing it at a new
worker does not reset that. The shape already exists in `restartAgent`
(`services/recovery.ts` ~407) and this reuses it:

preserve Compose services → dispose the old runner → destroy the agent container →
create the new runner → **rebind every attached viewer** → await readiness → dispatch.

**Every viewer, not just the initiating socket.** Disposal removes the old runner's
listeners (`container-session-runner.ts` ~3287) while attachment is per WebSocket connection
(`route-registry.ts` ~1037), so reattaching only the sender would leave every other viewer of
that session bound to a disposed runner — watching a turn that emits nothing. Replacement
therefore needs a runner-replaced broadcast that rebinds all attached connections, not a
single `attachToRunner` call.

**And a bounded hold for callers with no transport.** Attaching before the readiness wait is
load-bearing because the idle enforcer treats an unviewed, non-running runner as reclaimable
under pressure (`idle-enforcer.ts` ~150). The HTTP dispatch path has no socket to attach at
all, and Quick Capture's headless dispatch has no viewer — so *every* transportless caller
takes a bounded lifecycle lease from replacement until the reservation's dispatch flips
`running`, not just Quick Capture as an earlier draft said.

This does not touch the WebSocket-lifecycle invariant in `CLAUDE.md` — the replacement is
caused by a user dispatch, never by connect or disconnect — but it must capture the session
identity up front and must not rebind to sockets that have since closed.

### What `egressContainedAtStart === undefined` means

It is **unknown**, never "matches" — but two different unknowns hide behind it, and they get
different answers:

- **`status === "starting"`.** The field is assigned inside `create()`
  (`container-lifecycle.ts:1435`) while the record is already published and pollable, so a
  container can legitimately be mid-creation. **Await the in-flight creation, then compare.**
- **Genuinely unknown** (rediscovered / re-adopted, `session-container.ts:304`). "Neither
  pass nor destroy" is not an answer, so: **replace it when the session carries an explicit
  override, accept it otherwise.** Requirement 3 is a promise about a mode the user *picked*;
  where they picked nothing there is nothing to guarantee beyond today's behaviour, and
  recreating every rediscovered container on its first turn would be a cost paid for nobody.

Cost, stated rather than hidden: a non-inherited pick **throws away one warm container** and
pays a cold create (seconds) before the first turn.

**One claim this plan previously made and should not.** "Nothing has run in the standby" is
false: for a trusted repo, `agent.install` runs on the standby before the user ever opens
the session (`warm-pool-manager.ts` ~296, gated by the docs/178 trust check). The defensible
statement is **"no agent turn has run"** — and tightening Open → Contained at first send
cannot retroactively contain that setup code.

## Constraints found in review

These are implications of requirements 6, 7 and 10 rather than new requirements, but the
design is not safe without them.

- **The control must stay usable when the composer cannot send.** `disabledReason` sets a
  local `inert` flag (`MessageInput.tsx:231`) that today closes the mode control's anchor,
  while the sidebar dialog stays usable in exactly that state (a session with no runnable
  service). Since the dialog's network half is being removed, the network section must
  remain reachable. There is **no** HTML `inert` attribute on the composer — it is a boolean
  each affordance reads and passes as `disabled` — so this is a small change, not a
  relocation. The exact split:

  | State | Trigger | Network rows | Permission rows |
  |---|---|---|---|
  | `disabledReason` set (`inert`) | opens | interactive | disabled, as today |
  | Turn running (`pickersLocked`) | opens | interactive | interactive, as today |
  | Normal | opens | interactive | interactive |

  Network stays interactive in every row of that table: it is a container-start setting, so
  nothing about a dead composer or a running turn makes choosing it invalid. Everything else
  keeps the behaviour it has now.
- **The enforcement warning and air-gap footnote come along.** `SessionSettingsDialog`
  (~252, ~361) warns "Contained — NOT enforced on this deployment" and states that
  containment is not an air-gap. Deleting the radio group without moving these deletes a
  warning that stops the UI claiming protection it cannot deliver.
- **The trigger must say the effective network mode in words** — accessible name and
  tooltip, including pending-restart. A tint and a second glyph are not an accessible
  statement, and the prototype's "both non-default" state leans on glyphs alone.
- **Omit the permission section when the harness offers only one mode.** Codex advertises
  only `auto`; rendering a non-actionable row above the network section is worse than
  showing the network section alone. (This replaces the plan's earlier framing that the
  control "can no longer hide" — it renders, but only with what is actionable.)
- **Selection exists before a session id does.** The new-session composer renders and the
  claim resolves asynchronously (`useSessionActivation.ts:96-106`), so the control holds the
  pick locally and writes it through once the id arrives. It must also **reset on every new
  session** — the explicit reset Quick Capture already does for auto-merge, not an implicit
  one (req 8).
- **The client egress store stays global-only; the composer owns its own state.**
  `egress-store.ts` holds ONE mutable session scope (`load()` sets `sessionId`, ~line 111),
  so a composer sharing it with the global Settings dialog would have the two overwrite each
  other's scope. The decision: leave that store as the global Settings dialog's
  (`load(null)`), and give the combined control local state plus direct `fetch` calls —
  exactly what `SessionSettingsDialog` already does, and for the stated reason (its
  docstring, ~line 64: "wired with direct fetches so it doesn't depend on the Settings
  store, which is single-session-scoped"). No new store, no new slice.

## Wiring

- **Storage.** No new store. `egress-allowlist-store.ts` holds the per-session override
  (`resolveContained(sessionId)`) and `PUT /api/egress/session/:id` writes it — the route
  `SessionSettingsDialog` uses today.
- **Quick Capture** dispatches its first turn server-side at creation (docs/205), so the mode
  rides the creation params of `POST /api/sessions/headless` alongside `reasoning`, `role`
  and `armAutoMerge`. Those request types and the multipart parsing have no network field
  yet (`stores/actions/session-actions.ts` ~229, `api-routes-session-crud.ts` ~538).
- **Sandboxes stay out.** `SandboxDialog` already picks network as a capability grant at
  creation (docs/211, docs/279), and a sandbox's network access IS that grant — so the
  combined control offers no network section for a sandbox, the same mutual exclusion
  `SessionSettingsDialog` enforces today.

## Key files

| File | Role |
|---|---|
| `src/client/components/PermissionModeSelector.tsx` | Becomes the combined mode + network control |
| `src/client/components/MessageInput/MessageInput.tsx` | Renders that control in the row on every viewport |
| `src/client/components/MessageInput/ComposerSettingsMenu.tsx` | Loses its Mode row; role case opens the list directly |
| `src/client/components/QuickCaptureOverlay.tsx` | Creation params carry the mode |
| `src/client/components/SessionSidebar/SessionSettingsDialog.tsx` | Loses its network half; its enforcement warning moves into the menu |
| `src/client/stores/egress-store.ts` | Single-scope store — needs explicit ownership before the composer shares it |
| `src/server/orchestrator/ws-handlers/send-message.ts` | First-dispatch caller — awaits `admitFirstTurn`, honours its reservation |
| `src/server/orchestrator/services/agent.ts` | First-dispatch caller — the HTTP path, which graduates and dispatches on its own |
| `src/server/orchestrator/services/headless-sessions.ts` | First-dispatch caller — Quick session: persist after the claim, before dispatch |
| `src/server/orchestrator/services/child-sessions.ts` | First-dispatch caller — child spawns graduate and dispatch on their own |
| `src/server/orchestrator/services/claim-session.ts` | Warm-id reuse — where a stale per-session override must be cleared |
| `src/server/orchestrator/services/recovery.ts` | `restartAgent` — the replacement sequence this reuses |
| `src/server/orchestrator/egress-allowlist-store.ts` | Durable per-session override |
