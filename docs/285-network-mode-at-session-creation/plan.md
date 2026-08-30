---
title: Network mode at session creation — design
description: Fold network containment into the composer's permission-mode control; /new claims only at Send, carrying nothing but the network mode.
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
  worded case.
- **`Inherit workspace` names what is inherited** ("Currently Contained"). The dialog says
  "Inherit global" today; one value must not have two names.
- **The enforcement warning is carried by the composer control as well as the dialog** —
  shown, in either, only when the effective mode is contained; an Open session is not
  claiming protection, so there is nothing to warn about. It must also not overstate. `enforcementActive: false`
  covers two different deployments — a missing sidecar with enforcement *on*, which fails
  closed, and `SESSION_EGRESS_ENFORCE=0`, which starts the session **uncontained**
  (`egress-firewall-install.ts` ~45, `container-lifecycle.ts` ~1451). The UI cannot infer
  "contained sessions fail to start" from that single boolean, so the copy states what is
  known — containment is not being enforced here — and the remediation is surfaced inline
  rather than as "see the install notes", which is the link-out shape §1/§2 rule out.
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
- **Session-filtered refetch on the existing `session_settings_change_card` event.** No new
  SSE type is needed: that card already fires for every attached viewer on a real change, so
  cross-tab divergence is closed rather than waved away — after this feature one tab shows an
  always-visible trigger while another can change the same value.
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
2. On the session's **first** Send, the server compares the resolved containment against the
   live container's recorded boot mode. If they agree — the common case, since most sessions
   never change it — nothing happens and the message goes as it does today.
3. If they differ, it runs **`restartContainer` (`services/recovery.ts`)** and then sends.

That third step is doing a lot, and none of it is new code:

- it emits `container_restarting` so **viewers are told**, which is the multi-viewer problem
  an earlier design spent rounds on;
- it **force-disposes** the runner, overriding the normal refusal;
- it **destroys the container — including cancelling a creation still in preflight**, because
  `destroy` bumps the teardown counter before its own "nothing to destroy" return. That is
  exactly the `starting`-container race that made the earlier reconciliation design hard;
- it **reaps orphaned compose children** so the new `ServiceManager.start()` cannot collide
  with survivors;
- and it recreates via the ordinary factory and **waits for readiness**.

It is also explicitly idempotent: if the container is already gone, destroy is a no-op and
the next attach creates a fresh one.

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

Nothing about claiming changes, so there is no rollout concern for cached clients: an old
client has no network control, never sets an override, and its sessions reconcile to a
no-op.

## Where the tests go

1. **Mode in force on the first turn**, for explicit Contained and Open, on `/new` and Quick
   Capture.
2. **Reconciliation in every state** — a matching container is left alone and the turn is not
   delayed; mismatching, `starting` and unknown all restart before the first turn. Must fail
   if the implementation reads `isEgressContained()` instead of the raw boot value.
2b. **Only the first turn reconciles** — a second message on the same session never restarts,
   and a change made later shows the pending strip instead.
3. **`Inherit` follows the workspace at container start**, and an explicit pick does not move
   when the workspace default changes between Send and boot.
4. **Reset**: a second new session in the *same* repo starts at `Inherit`, and Quick Capture
   resets on every opening.
5. **Composer and dialog agree** after a change in either, including in a second tab.
6. **No audit card** for the creation-time choice; a card **is** written for a later change.

## Key files

| File | Role |
|---|---|
| `src/client/components/PermissionModeSelector.tsx` | The combined mode + network control |
| `src/client/components/MessageInput/MessageInput.tsx` | Renders the combined control on every viewport |
| `src/client/components/MessageInput/ComposerSettingsMenu.tsx` | Loses its Mode row; role list opens directly |
| `src/server/orchestrator/services/recovery.ts` | `restartContainer` — the reconciliation, reused as-is |
| `src/server/orchestrator/ws-handlers/send-message.ts` | First-Send reconcile-before-dispatch |
| `src/server/orchestrator/session-container.ts` | Evict-only reconciliation on the container record; raw `egressContainedAtStart` |
| `src/server/orchestrator/container-lifecycle.ts` | Teardown-epoch cancellation; where `Inherit` is re-resolved (~1435) |
| `src/server/orchestrator/api-routes-egress.ts` | Strict validation on **both** the session GET and PUT (~319–363 accept arbitrary ids); dedicated GET for hydration |
| `src/server/orchestrator/services/headless-sessions.ts` | Quick Capture only: + network mode, + permission mode, + preflight |
| `src/client/components/SessionSidebar/SessionSettingsDialog.tsx` | Keeps its section; matched copy; propagates its PUT result |
