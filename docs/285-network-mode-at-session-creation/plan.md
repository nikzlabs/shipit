---
title: Network mode at session creation — design
description: Fold network containment into the composer's permission-mode control; rebuild the container when the mode changes, before the write answers.
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
  open — so neither wording is safe on its own. **The API therefore reports which case it
  is**, and the copy names that case and its remediation inline (§1/§2): "enforcement is
  switched off … unset `SESSION_EGRESS_ENFORCE=0`", or "the egress sidecar is unavailable …
  contained sessions will not start". Covering copy that asserts neither was the interim
  answer and is not good enough — it leaves the user unable to tell whether their Contained
  session is about to run wide open or refuse to start. The prototype shows the
  enforcement-off case concretely rather than a hedge.
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
(`useSessionActivation.ts` ~96), which opens the WS and materializes a runner.

**But the claim is asynchronous, and the control works before it lands.** `disabled` blocks
Send without making the selector inert (`App.tsx` ~2222, `MessageInput.tsx` ~1338), so a mode
can be picked with no session id to write it to. An earlier draft of this plan assumed a
container always exists by then; it does not. So the selection is held as a **non-sticky,
claim-generation-scoped draft**, written the moment the claim returns, with **Send disabled
until that write succeeds** — the same barrier as below, extended over the claim. It resets
on abandonment or route change. (Disabling the network section until the claim completes
would be simpler and is worse: the one moment the user is most likely to set it is while the
page is still settling.)

**So changing the mode rebuilds the container, at the moment of the change, using the restart
path that already exists.**

1. Picking a mode writes the per-session override — the same `PUT /api/egress/session/:id`
   the dialog uses.
2. For a session that has **not graduated**, that route then compares the resolved
   containment against the live container's recorded boot mode, and on a disagreement runs
   **`restartContainer` (`services/recovery.ts`)** before answering. Precisely: it waits for
   the replacement to be *created*, not necessarily *ready* — `restartContainer` bounds its
   readiness wait at 8 s and can return with the container still `starting`. That is enough,
   because the containment is decided at creation and the turn separately waits on the
   worker-readiness gate; but "the container exists with the right topology" is the claim,
   not "the container is up".
3. **Send is barred for the whole write**, by the save barrier the control already had. That
   is the "wait for the container" state the user sees, and it is the same shape `/new`
   already shows before its session is claimed.
4. A **graduated** session is untouched: it keeps the ordinary "applies on next container
   start" pending state. Restarting a container out from under a session the user is working
   in is not a settings change, it is Rescue.

**Why at the write and not at the first Send.** Reconciling at Send reads as more efficient —
one comparison, skipped entirely when nobody touched the mode — and it is a race generator.
The write, the comparison, the teardown, the replacement's creation and the turn's dispatch
are five moments with a mutable store underneath, and the container samples that store at a
moment the Send path does not control: `restartContainer`'s readiness wait is bounded at 8 s
and can return with the replacement still `starting`, while the agent start is fire-and-forget
so the handler returns before the container exists. Five review rounds each closed one
interleaving and exposed another, and the mechanism grew a session-keyed admission section, a
runner-local pre-spawn reservation, a session claim, a hand-off path, and a timer-backed
policy snapshot before the shape rather than the details was questioned.

Doing it at the write costs one thing and buys the rest: the settings PUT is slow, because it
waits for a container. In exchange the container is created *immediately after* the value it
reads was written, by the only writer there is. Nothing has to be frozen, because nothing has
time to move — and everything in the list above is deleted rather than fixed.

**What that deleted.** `services/first-turn-admission.ts` in full (the admission section, the
session claim and the egress pin); `turnStartInProgress` on both runner implementations and
the `verifyRunningState()` early-returns that read it; the dispatch busy-check addition; the
first-Send block, entry claim, hand-off and direct-turn-start guard in
`ws-handlers/send-message.ts`; the pin application in `index.ts`'s `resolveEgressConfig` and
its consumption in `container-lifecycle.ts`. `send-message.ts` and both runners end up
byte-identical to `main`, which is the honest measure of how much of this feature was
mechanism defending mechanism.

**What is kept, and why.** `containerDisagreesWithEgressPolicy` keys on the **container
record** (`session-container.ts` ~521), never on the standby marker, which lags it (~1524);
and it reads **raw `egressContainedAtStart`** (~304), never `isEgressContained()` (~639),
which deliberately re-derives *current policy* when boot state is unknown — precisely how
"unknown" would come to read as "matching". Treating `starting` and unknown as disagreement
costs an unnecessary restart in a rare case and cannot leave the session on the mode the user
just replaced; `restartContainer` handles both, since its destroy cancels a creation that has
not published a record. It resolves through the container manager's seam rather than the
store directly, so a docs/211 sealed sandbox cannot report a disagreement no rebuild can fix.

**Quick Capture** does the same two steps server-side, in one act: persist the override, then
reconcile, both **before `getOrCreate`** — the reconcile destroys the claimed container and
builds the replacement runner itself, so a runner made first would be returned unchanged by
that later call. `agentSeed: agentId` is why the harness survives: the requested agent has
been resolved but deliberately not persisted, so the replacement runner would otherwise be
seeded with the deployment default, and picking Codex *and* a network mode would dispatch the
turn to Claude.

**The write serializes against itself, per session.** `restartContainer` has no
concurrency guard, so two writes for one session — two tabs, or the composer and the dialog —
would interleave a destroy and a create. The lock spans this handler only; nothing outside
takes it, which is what distinguishes it from the deleted admission section that spanned the
Send path.

**It is not Rescue.** The rebuild reuses Rescue's teardown/recreate path but not its privilege
of clearing the OOM breaker: a tripped breaker aborts the write with a 503 that offers Rescue,
because toggling a setting must not buy a retry an unchanged session is refused.

**A refused rebuild rolls the write back.** Answering 200 would tell the composer the mode is
in force and release Send; leaving the override persisted behind a 503 is worse still, because
the client re-reads after a failed write and would read back the value it just asked for —
releasing Send over a container still running the mode being replaced. And the rebuild is
deliberately **not** gated on "the override changed": it is already a no-op when the container
matches, so the gate saves nothing and blocks the one case that needs it, re-picking a mode
after a rebuild failed.

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

So a draft carrying an explicit mode is **not recycled at all**. Clearing the override and
handing the session over is the cheaper fix and is wrong: the mode is a container *topology*,
and the recycled container is still running the abandoned draft's one — the next user would
read "Inherit workspace — currently Contained" over an Open container and send their first
turn into it. Refusing the reuse costs one unused warm session, which the pool replenishes,
and needs no rebuild on the claim path.

## Where the tests go

1. **Mode in force on the first turn**, for explicit Contained and Open, on `/new` and Quick
   Capture.
2. **Reconciliation in every state** — a matching container is left alone and the turn is not
   delayed; mismatching, `starting` and unknown all restart before the first turn. Must fail
   if the implementation reads `isEgressContained()` instead of the raw boot value.
2b. **A no-op write rebuilds nothing** — re-selecting the mode a session already has must
   not tear down its container.
2c. **A graduated session is never rebuilt** by a mode change — it keeps the pending strip,
   because restarting a container out from under a live session is Rescue, not a setting.
2d. **A failed rebuild fails the WRITE** with a correlated error rather than answering 200:
   a 200 tells the composer the mode is in force and releases Send.
2e. **Send is barred while the network write is in flight**, and after a failed write until
   the shown value has been re-read — including a pick made **before the claim lands**, which
   is written when it does.
2f. **Local runtime** (`RUNTIME_MODE=local`) persists the override and rebuilds nothing,
   rather than failing the write on a 503.
2g. **A tripped OOM breaker aborts the write** and offers Rescue, and the rebuild clears
   neither the breaker nor the loop detector's history — toggling a setting must not buy a
   free retry that an unchanged session is denied.
3. **`Inherit` follows the workspace at container start**, and an explicit pick does not move
   when the workspace default changes between Send and boot.
4. **Reset**: a second new session in the *same* repo starts at `Inherit` — including the
   real abandon→reopen path, where the claim **reuses** the untouched draft session — and
   Quick Capture resets on every opening.
4b. **A second viewer survives the restart**: two tabs on one session, first Send changes the
   mode, and the non-sending tab reattaches and sees the first turn — **including** when it
   misses the live signal and only reconnects SSE afterwards.
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
| `src/server/orchestrator/services/recovery.ts` | `restartContainer` — the rebuild; read `newContainerState`/`error`, not the `ok` |
| `src/server/orchestrator/api-routes-egress.ts` | **Where the rebuild happens**, before the PUT answers; strict validation on both session routes; dedicated GET for hydration |
| `src/server/orchestrator/services/reconcile-session-egress.ts` | The comparison + rebuild, shared by the PUT and Quick Capture |
| `src/server/orchestrator/services/headless-sessions.ts` | Quick Capture: persist + rebuild after claim, before `getOrCreate` |
| `src/server/orchestrator/api-routes-session-crud.ts` | Headless request parsing for the new field (~562) |
| `src/client/stores/actions/session-actions.ts` | Quick Capture request type / form serialization (~205) |
| `src/client/components/SessionSidebar/SessionSettingsDialog.tsx` | Keeps its section; matched copy; propagates its PUT result |
| `src/client/hooks/useServerEvents.ts` | Transient session-scoped invalidation; stop discarding the global egress value (~733) |

**Verified dependencies, not expected to change:** `session-container.ts` (the raw
`egressContainedAtStart` record, and why `isEgressContained()` is wrong here) and
`container-lifecycle.ts` (teardown-epoch cancellation, and the `resolveEgressConfig` call at
~1435 that decides containment at the plumbing step). The design leans on their current
behaviour; if either needs editing, that is a signal the design drifted. **It held.** An
earlier revision edited `container-lifecycle.ts` to consume a policy snapshot, and that edit
was the tripwire doing its job — the snapshot existed only because the rebuild had been put
at the first Send. Moving the rebuild to the write removed both. `ws-handlers/send-message.ts`
and both runner implementations are likewise back to `main`.
