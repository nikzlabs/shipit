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
container cannot be re-plumbed. Today `/new` claims on arrival
(`useSessionActivation.ts` ~96), which opens the WS and materializes a runner — so a mode
picked afterwards arrives at a live session. `/new` therefore claims nothing until Send.

### Send claims, and carries only the network mode

**Only the network mode has to precede container materialization.** Everything else already
has an authoritative path, and duplicating it would create two owners that can disagree:

| Already owned by | What |
|---|---|
| The WS handshake URL (`useSessionWebSocket.ts` ~18), applied before runner activation (`route-registry.ts` ~884, activation at ~1464) | harness, the model triple, reasoning, role |
| The ordinary first message (`App.tsx` ~628) | permission mode |
| `ws-handlers/send-message.ts` ~482 | the issue pin, graduation, and mark-started |

So Send is: **claim with the network mode → persist → reconcile → return the id →
connect the ordinary WebSocket → send the first message down the existing path.** Nothing
new carries a payload, and no create-and-dispatch transaction exists.

Two things this deletes outright. **Trust-before-claim** goes: the composer is already
blocked for an untrusted repo (`App.tsx` ~2210) and the server's boundary stays at dispatch
(`runner-registry-factory.ts` ~295) — avoiding an unused claim is optional hardening, not
this requirement. **Issue mark-started stays where it is**: moving it to claim would mark an
issue started even when the first message never reaches the socket.

**Quick Capture keeps its own headless path**, gaining the network mode, the permission mode
it currently drops (`headless-sessions.ts` ~460), and the same reconciliation preflight. It
is not merged with `/new`, and `headless-sessions.ts` is *not* generalized. It **resets the
network pick to `Inherit` on every opening**, where it already resets its other non-sticky
fields (`QuickCaptureOverlay.tsx` ~134) — req 8 applies to it as much as to `/new`, and it
has no generation to hang the reset on.

### Why not one create-and-dispatch call

`dispatch()` is not a commit point: it sets `running = true` in memory and launches the turn
with `void runner.runDispatchedTurn(...)` (`session-runner.ts` ~555), while attachment
resolution, agent creation and parameter assembly happen afterwards
(`dispatched-turn.ts` ~90, ~119, ~241), and a setup failure turns `running` back off after
dispatch returned (~561). An HTTP 200 can precede a crash that loses the turn. Making that
honest needs durable idempotent admission — the subsystem this design exists to avoid.

### The prerequisite: docs/286

Claiming at Send needs a contract of its own — transaction ownership, delivery, acceptance,
idempotency, recovery — and **none of it is about network modes**. It is extracted to
[docs/286-first-send-creates-the-session](../286-first-send-creates-the-session/plan.md) so it
can be reviewed on its own terms, and it is a **prerequisite**: this feature cannot land
before it, and the honest cost of this feature is the sum of both docs.

Two open questions in that doc block implementation — how far recovery must reach, and
whether the composer freezes while a Send is in flight.

What this design needs from it, and nothing more: **a claimed session id, with the network
mode applied and the standby reconciled, before any runner exists.**

### Standby reconciliation: evict, never create

The container record exists as `starting` before its containment is resolved
(`container-lifecycle.ts` ~1191 vs ~1435), and the standby marker lags the record
(`session-container.ts` ~1524) — so key on the **record** (~521), not on "is it a standby".
Before materialization:

- **Running, and recorded boot mode matches** → leave it.
- **Anything else** — mismatching, `starting`, unknown → `await destroy(sessionId)` and
  return. The ordinary factory then creates the replacement, asynchronously
  (`app-lifecycle.ts` ~840); this operation never creates one itself.

It reads **raw `egressContainedAtStart`** (~304), never `isEgressContained()` (~639), which
deliberately re-derives current policy when boot state is unknown — precisely how "unknown"
would come to read as "matching". Destroying an in-flight creation is supported by the
teardown epoch (~1799).

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

`PUT /api/egress/session/:id` gains strict validation: it currently accepts an invalid body
and an arbitrary session id (`api-routes-egress.ts` ~331). Narrow fix, not a subsystem.

The legacy claim route is **left alone** — a cached old client has no network control, so
there is nothing to reconcile for it, and the new behaviour lives on docs/286's draft-claim
endpoint.

## Where the tests go

Only what is network-specific; docs/286 owns the transaction, delivery and idempotency tests.

1. **Mode in force on the first turn**, for explicit Contained and Open, on `/new` and Quick
   Capture.
2. **Reconciliation in every state** — matching leaves the container; mismatching, `starting`
   and unknown all evict. Must fail if the implementation reads `isEgressContained()` instead
   of the raw boot value.
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
| *new* draft-claim endpoint (docs/286) | Carries the network mode; persists and reconciles before returning |
| `src/server/orchestrator/session-container.ts` | Evict-only reconciliation on the container record; raw `egressContainedAtStart` |
| `src/server/orchestrator/container-lifecycle.ts` | Teardown-epoch cancellation; where `Inherit` is re-resolved (~1435) |
| `src/server/orchestrator/api-routes-egress.ts` | Strict validation; dedicated session GET for hydration |
| `src/server/orchestrator/services/headless-sessions.ts` | Quick Capture only: + network mode, + permission mode, + preflight |
| `src/client/components/SessionSidebar/SessionSettingsDialog.tsx` | Keeps its section; matched copy; propagates its PUT result |
