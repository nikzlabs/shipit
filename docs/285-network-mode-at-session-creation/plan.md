---
title: Network mode at session creation — design
description: Fold network containment into the composer's permission-mode control; reconcile the container at first Send when the pick differs from what it booted with.
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

- **Trigger.** A non-default network mode is named **in words**; the inherited default stays
  the bare icon it is today. Req 10 also needs the *common* state to be readable, so the
  trigger carries an accessible name and title stating the effective mode in both states —
  there is no hover on touch, and the prototype's static markup demonstrates only the
  worded case. For an explicit pick the accessible name says it **overrides the workspace**,
  not merely "Open" or "Contained": that the choice is pinned is the part req 10 asks to be
  stated, and it is exactly what a colour cannot carry.
- **`Inherit workspace` names what is inherited** ("Currently Contained"). The dialog says
  "Inherit global" today; one value must not have two names.
- **The enforcement warning is carried by the composer control as well as the dialog** —
  shown, in either, only when the effective mode is contained; an Open session is not
  claiming protection, so there is nothing to warn about. It must also not overstate. `enforcementActive: false`
  covers two different deployments — a missing sidecar with enforcement *on*, which fails
  closed, and `SESSION_EGRESS_ENFORCE=0`, which starts the session **uncontained**
  (`egress-firewall-install.ts` ~45, `container-lifecycle.ts` ~1451). One boolean cannot
  express which, and the two have **opposite** consequences — fail-closed versus silently
  open — so neither wording is safe on its own. The API should report which case it is; until
  it does, the copy says only what is known ("containment is not enforced on this
  deployment") and never asserts either outcome. Remediation is inline, not a link out
  (§1/§2).
- **The menu states; it does not act.** Before the first turn: "In force from this session's
  first turn." On a running session: "Applies on next container start — restart from Session
  settings", shown **only when the server says something is pending** (`pendingRestart`
  already reflects whether the live topology actually differs).
- **The setup limitation is stated** (req 11): a trusted repo's `agent.install` may already
  have run in the warm container under the workspace default (`warm-pool-manager.ts` ~297).
  The guarantee is the first *turn*.
- **Never sticky** (req 8); **sandboxes get no network section** (docs/211, docs/279); a
  harness with one permission mode renders the network section alone.

**Mode leaves `ComposerSettingsMenu`** on every viewport; the role root collapses so the
anchor opens the **role list directly** (req 9).

**`SessionSettingsDialog` keeps its network section.** Req 7 is one authoritative *value*.

### Keeping the two surfaces honest

The dialog fetches on open and consumes its `PUT` response; no store, no SSE
(`SessionSettingsDialog.tsx` ~117, ~170). The composer piggybacks that, with four rules:

- **Hydrate on active-session mount/change**, via the dedicated session GET
  (`api-routes-egress.ts` ~319) rather than the full effective-allowlist view. Without this
  the always-visible trigger would not know an existing session has an override *before its
  first open* — wrong, not merely stale.
- **Every fetch is owned by its session id *and* a mutation revision held by one shared
  coordinator**, and a response is applied only if both still match. Two component-local
  revisions would not order the dialog's mutations against the composer's — they have to
  count the same clock. Session-id ownership alone stops A's response landing
  in B, but not an older GET for A landing after a newer PUT or change-card refresh for A.
  The stale-response class is already documented in `session-data.ts` ~260.
- **Session-filtered refetch on a transient, session-scoped settings-changed event.** The
  persisted `session_settings_change_card` cannot serve as the invalidation signal: the
  creation-time choice deliberately emits no card (below), so another tab would receive
  nothing at all, and per-session PUTs do not broadcast the global `egress_settings` event
  either. So a small transient event carries invalidation for **every** change; the persisted
  card continues to carry *audit* for changes to an existing session. Two signals, two jobs.
- **Follow the workspace default while showing `Inherit`.** The global handler receives the
  new value but discards it unless the egress store was already loaded
  (`useServerEvents.ts` ~733); it should always update the minimal global fields.

**No audit card for the creation-time choice.** The `session-settings-change` card
(docs/279 req 8) records a *change*; at creation there is no prior state, and a "changed
network containment" card above the first message describes something that never happened.

## Mechanism

Egress is plumbed when the container is *created* (`container-lifecycle.ts`); a running
container cannot be re-plumbed. `/new` claims a session on arrival
(`useSessionActivation.ts` ~96), which opens the WS and materializes a runner — so by the
time a mode is picked, a container already exists, created under the *inherited* default.

**So the container is reconciled at first Send, using the restart path that already exists.**

1. Picking a mode writes the per-session override immediately — the same
   `PUT /api/egress/session/:id` the dialog uses. Nothing else happens yet.
   **Send is barred while that write is in flight**, and after a failed write until the
   displayed value has reverted. Without that, picking Contained and pressing Send at once
   lets the server resolve the *old* value, see no mismatch, and run the first turn under the
   wrong policy — requirement 3 lost to ordinary mutation ordering. This is a save barrier on
   one control, not a Send transaction.
2. On the session's **first** Send, the server compares the resolved containment against the
   live container's recorded boot mode. If they agree — the common case, since most sessions
   never change it — nothing happens and the message goes as it does today.
3. If they differ, it runs **`restartContainer` (`services/recovery.ts`)** and then sends.

"First Send" is `session.warm`: the handler graduates on the first message
(`ws-handlers/send-message.ts` ~482) and graduation clears the flag synchronously
(`graduate-session.ts` ~194), so reconciliation sits **after activation, before graduation**.

It also needs a **session-keyed critical section**. Dispatch admission is checked near handler
entry (~122) while `running` is not claimed until just before execution (~590), and WS
callbacks are independently asynchronous — so with an 8-second restart in between, two
near-simultaneous first Sends (two tabs, or a fast double Enter) can both pass the idle check
and both attempt reconciliation. One reconciles; the others wait and then **re-enter the
ordinary send-or-queue path** rather than proceeding on a stale decision. The section is held
until the winner has claimed the new runner's dispatch slot — releasing at the end of
reconciliation would let a waiter back in while `running` is still false.

**What that step actually gives us**, which is a lot but not everything:

- it **force-disposes** the runner, overriding the normal refusal, and **destroys the
  container — including cancelling a creation still in preflight**, because `destroy` bumps
  the teardown counter before its own "nothing to destroy" return
  (`container-lifecycle.ts` ~1799). That is exactly the `starting`-container race;
- it **reaps orphaned compose children** so the new `ServiceManager.start()` cannot collide
  with survivors — and a full restart is the right unit, since Compose services share the
  session's containment policy;
- it recreates via the ordinary factory;
- it is **idempotent**: if the container is already gone, destroy is a no-op and the next
  attach creates a fresh one.

**What it does not give us, and the plan must handle:**

- **It does not guarantee readiness.** The wait is bounded (`RESTART_READY_TIMEOUT_MS`, 8s)
  and can return with the container still `starting`/`pending` (`recovery.ts` ~340), and the
  replacement Compose stack starts lazily on viewer attachment (~346). So Send does not
  proceed on "restart returned"; it proceeds through the **new runner's worker-readiness
  gate**, never the disposed one.
- **It reports success too eagerly.** The call returns `ok` even when replacement creation
  errored; the meaningful values are `newContainerState` and `error` (~362). A **failed**
  replacement aborts the Send with a correlated error rather than dispatching into nothing.
- **It does not migrate other viewers, and nothing else does either.** Attachment is per
  connection (`route-registry.ts` ~1037). The *sending* connection recovers, because
  reconciliation is inserted before the handler's existing `getOrCreate`/`attachToRunner`
  block (`ws-handlers/send-message.ts` ~578). An earlier draft of this plan said the existing
  manual restart asks every browser to reattach — **it does not**: only the tab that pressed
  the button calls `onReconnectWs()` (`SessionHealthStrip/RecoveryActions.tsx` ~82), while the
  `container_restarting` handler merely updates rescue state
  (`message-handlers/container-restarting.ts`). So this design needs a **session-scoped
  reconnect signal** emitted after replacement creation, or a second viewer sits on the
  disposed runner and misses the whole first turn. It goes over **session-filtered global
  SSE, not `runner.emitMessage`** — the old viewers are attached to the disposed runner and
  the new one has no viewers yet — and it fires once the winning sender has attached to the
  new runner and claimed its dispatch slot.
- **It can interrupt a warm preinstall.** Warm readiness is announced without waiting for the
  fire-and-forget `agent.install` (`warm-pool-manager.ts` ~297, ~331), so a changed-mode
  first Send can destroy an install in flight. The replacement reruns setup; the cost is a
  longer Send, and it is stated rather than discovered.
- **It is container-runtime only.** In `RUNTIME_MODE=local` there is no container manager and
  the call throws 503 (`recovery.ts` ~235). So "anything else → restart" is scoped to the
  container runtime; local mode persists the override, reports the policy/enforcement
  limitation, and reconciles nothing.

### The rejected alternative: claiming late

An earlier version of this design had `/new` hold a draft and claim at Send, so that no
runner could exist before the choice. It is recorded here because it will be proposed again.

It works, but it costs a **platform-sized prerequisite** — the Send transaction, first-message
delivery scoped to its claimed session, a correlated acceptance echo, claim idempotency
across a lost response, per-tab keys, a recovery matrix — and it *gives up* the live preview,
the warm container and `@file`/`/skills` autocomplete while composing, then needs a new
repo-scoped endpoint to win the autocomplete back. Reconciling at Send buys the same
guarantee out of a path that already handles viewers, in-flight creation, orphans and
readiness.

The one thing late-claiming is genuinely better at: the container is never built under a mode
the user did not choose, so there is no restart and no window in which it existed. That is
worth knowing, and it is not worth the prerequisite.

### What the user sees

Pressing Send after changing the mode waits for a container restart — seconds, with the
existing restarting UI — and only when the mode actually changed. The menu says so before
the fact (`In force from this session's first turn`), rather than presenting the choice as
free.

Quick Capture is unchanged in shape: it persists the override and reconciles **before
`runnerRegistry.getOrCreate`** (`headless-sessions.ts` ~426, not merely before `dispatch()`
at ~460), since it creates and dispatches server-side in one act.

**It must hand its resolved `agentId` to the reconciliation**, or a non-default harness is
silently lost. `restartContainer` creates the replacement runner itself, seeded
`session.agentId ?? defaultAgentId` (`recovery.ts` ~332) — and at that point Quick Capture
has *resolved* the requested agent but not persisted it: it supplies it to `getOrCreate` at
~426, and warm-up env preparation deliberately does not persist the selection
(`session-agent-env.ts` ~595). The later `getOrCreate` cannot repair it, because an existing
runner is returned unchanged (`session-runner.ts` ~2268). So picking Codex on a
Claude-default deployment *and* changing the network mode would create and dispatch through a
Claude runner. The reconciliation therefore takes an agent seed; it does **not** pin the
session's agent early — ordinary first-turn preparation keeps that job.

### Comparing: what counts as "the container disagrees"

The comparison feeding step 3 above:

- **Running, and the recorded boot mode matches** → agree; send as normal.
- **Anything else** — mismatching, `starting`, or unknown → restart.

It keys on the **container record** (`session-container.ts` ~521), never on the standby
marker, which lags the record (~1524). And it reads **raw `egressContainedAtStart`** (~304),
never `isEgressContained()` (~639), which deliberately re-derives *current policy* when boot
state is unknown — precisely how "unknown" would come to read as "matching". Treating
`starting` and unknown as disagreement costs an unnecessary restart in a rare case and cannot
silently run the first turn under the wrong mode; `restartContainer` handles both, since its
destroy cancels a creation that has not published a record.

**`Inherit` resolves at container start, and is not snapshotted** (req 3, resolved
2026-08-29). Containment is re-read when the container is created
(`container-lifecycle.ts` ~1435), so a Send-time snapshot would need new claim-owned boot
state threaded through materialization — machinery for a race that requires a concurrent
workspace-default change. So reconciliation compares against the mode the session *resolves
to now*, and a container created afterwards resolves again; for an explicit Contained or Open
those are the same answer, which is why explicit picks keep the hard guarantee and `Inherit`
means what the word says.

**What "hard guarantee" means, precisely.** It is about *policy*: an explicit Contained or
Open cannot be moved by a workspace-default race. It is **not** a promise of physical
enforcement — the record is set to the resolved policy before the firewall install, which
only runs when enforcement is enabled (`container-lifecycle.ts` ~1435 vs ~1440), so on a
deployment with `SESSION_EGRESS_ENFORCE=0` a "Contained" session is contained by policy and
open in fact. That is exactly what the enforcement warning above exists to say, and the two
statements must not drift apart.

### Rollout

**Both** session egress routes gain strict validation — the GET and the PUT each accept an
arbitrary session id today, and the PUT also accepts an invalid body
(`api-routes-egress.ts` ~319–363). Narrow fix, not a subsystem.

An old client has no network control, never sets an override, and its sessions reconcile to a
no-op — so there is no rollout concern for cached clients.

**But claiming is not entirely untouched, and requirement 8 depends on it.** An interactive
claim deliberately **reuses an ungraduated warm session from the same repo**
(`claim-session.ts` ~340). So: pick Open on `/new`, walk away without sending, start another
new session in that repo — and the reused session still carries Open. "Every new session
starts at Inherit" would be false, through a path that has nothing to do with the composer.

So the interactive claim **resets a reused draft's override to `null`**, emits the transient
invalidation for any viewer already attached, and writes **no audit card** while the session
is still warm — there is no prior state for a card to describe. The reset belongs at the
reuse branch itself, not in the composer, because the composer is not involved in that flow.

## Where the tests go

1. **Mode in force on the first turn**, for explicit Contained and Open, on `/new` and Quick
   Capture.
2. **Reconciliation in every state** — a matching container is left alone and the turn is not
   delayed; mismatching, `starting` and unknown all restart before the first turn. Must fail
   if the implementation reads `isEgressContained()` instead of the raw boot value.
2b. **Only the first turn reconciles** — a second message on the same session never restarts,
   and a change made later shows the pending strip instead.
2c. **Concurrent first Sends** — two near-simultaneous first messages reconcile once and both
   land in the ordinary send-or-queue path, never two restarts or a turn on a stale decision.
2d. **A failed replacement aborts the Send** with a correlated error rather than dispatching,
   and a still-`starting` replacement waits on the *new* runner's readiness gate.
2e. **Send is barred while the network write is in flight**, and after a failed write until
   the shown value reverts.
2f. **Local runtime** (`RUNTIME_MODE=local`) persists the override and reconciles nothing,
   rather than failing the first Send on a 503.
3. **`Inherit` follows the workspace at container start**, and an explicit pick does not move
   when the workspace default changes between Send and boot.
4. **Reset**: a second new session in the *same* repo starts at `Inherit` — including the
   real abandon→reopen path, where the claim **reuses** the untouched draft session — and
   Quick Capture resets on every opening.
4b. **A second viewer survives the restart**: two tabs on one session, first Send changes the
   mode, and the non-sending tab reattaches and sees the first turn.
4c. **Quick Capture keeps its harness through a reconcile**: a non-default agent plus a
   changed network mode, asserting the first dispatched turn runs on the selected harness and
   not the deployment default.
5. **Composer and dialog agree** after a change in either, including in a second tab.
6. **No audit card** for the creation-time choice; a card **is** written for a later change.

## Key files

| File | Role |
|---|---|
| `src/client/components/PermissionModeSelector.tsx` | The combined mode + network control |
| `src/client/components/MessageInput/MessageInput.tsx` | Renders the combined control on every viewport |
| `src/client/components/MessageInput/ComposerSettingsMenu.tsx` | Loses its Mode row; role list opens directly |
| `src/server/orchestrator/services/claim-session.ts` | Reused-draft reuse branch (~340) — reset the override |
| `src/server/orchestrator/services/recovery.ts` | `restartContainer` — the reconciliation; read `newContainerState`/`error`, not the `ok` |
| `src/server/orchestrator/ws-handlers/send-message.ts` | First-Send reconcile-before-dispatch |
| `src/server/orchestrator/api-routes-egress.ts` | Strict validation on **both** the session GET and PUT (~319–363 accept arbitrary ids); dedicated GET for hydration |
| `src/server/orchestrator/services/headless-sessions.ts` | Quick Capture: persist + reconcile after claim (~403), before `getOrCreate` (~426) |
| `src/server/orchestrator/api-routes-session-crud.ts` | Headless request parsing for the new field (~562) |
| `src/client/stores/actions/session-actions.ts` | Quick Capture request type / form serialization (~205) |
| `src/client/components/SessionSidebar/SessionSettingsDialog.tsx` | Keeps its section; matched copy; propagates its PUT result |
| `src/client/hooks/useServerEvents.ts` | Transient session-scoped invalidation; stop discarding the global egress value (~733) |

**Verified dependencies, not expected to change:** `session-container.ts` (the raw
`egressContainedAtStart` record, and why `isEgressContained()` is wrong here) and
`container-lifecycle.ts` (teardown-epoch cancellation, and where `Inherit` re-resolves at
~1435). The design leans on their current behaviour; if either needs editing, that is a
signal the design drifted.
