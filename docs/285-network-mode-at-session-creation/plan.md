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
- **Every fetch is owned by its session id**, and a response for a different one is dropped.
  This exact stale-response class is already documented in `session-data.ts` ~260.
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
is not merged with `/new`, and `headless-sessions.ts` is *not* generalized.

### Why not one create-and-dispatch call

`dispatch()` is not a commit point: it sets `running = true` in memory and launches the turn
with `void runner.runDispatchedTurn(...)` (`session-runner.ts` ~555), while attachment
resolution, agent creation and parameter assembly happen afterwards
(`dispatched-turn.ts` ~90, ~119, ~241), and a setup failure turns `running` back off after
dispatch returned (~561). An HTTP 200 can precede a crash that loses the turn. Making that
honest needs durable idempotent admission — the subsystem this design exists to avoid.

### The first message must be scoped to its claimed session

This is the risk the split introduces, and it is not hypothetical. A send that arrives before
the socket is open is stashed in **one global `pendingWsMessage`** (`App.tsx` ~658) with no
owning session (`session-store.ts` ~117), and it is flushed onto whichever session is active
— overwriting its `sessionId` (`useConnectionSync.ts` ~173, ~181). Today that is a narrow
race because `/new` usually has a socket already; this design makes the stash **the normal
first-send path**. So: the stash is keyed by its claimed session, flushed only by that
session's socket, and its id is never rewritten.

### Attachments need an explicit drain

"Raw files already buffer until a session id exists" is only half true. `useFileUpload`
(~124) buffers `File`s and uploads them in an effect when `sessionId` changes, but
`MessageInput` captures `uploadRefs` *before* invoking Send (~640) — so immediately after a
claim the refs do not exist yet and the WS frame would leave without them. Send needs an
awaitable **`drainDeferredUploads(claimedSessionId)`** before it builds the frame.

On failure the draft is preserved **whole**: text, upload chips, pending files, dictation
state, the issue seed and the network pick — not just text and the mode.

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

**`Inherit` must be snapshotted, or requirement 3 is unmet.** Passing a resolved boolean into
reconciliation is not enough: the replacement container re-reads current policy on its own,
later, at `container-lifecycle.ts` ~1435. A workspace-default change between resolving
`Inherit`, evicting, and creating the replacement therefore still lands the wrong mode.
Either the claim-time snapshot is carried through materialization, or `Inherit` means
"whatever the global says when the container boots" and the promise is narrowed to explicit
Contained/Open. Explicit picks are already stable; `Inherit` is the only unsound case.

### Pre-Send autocomplete: a repo-scoped endpoint, not a client-held warm id

The settled decision keeps `@file` and `/skills` while composing, but reading
`RepoInfo.warmSessionId` directly from the client is unsafe:

- Claim clears the repo's warm pointer (`claim-session.ts` ~356) **without broadcasting it**;
  the client keeps the old id until a replacement emits `repo_warm_ready`
  (`warm-pool-manager.ts` ~331, `useServerEvents.ts` ~303). So the id does not merely 404 —
  it can by then be **another tab's active session**.
- The file and skill store setters are unkeyed (`file-store.ts` ~431, ~487), so a slow warm
  read can overwrite the next repo's or the active session's data — the bug class
  `session-data.ts` ~260 already documents.

So: a **repo-scoped draft-context endpoint** that resolves the current warm pointer
server-side at request time, with client-side repo/generation guards on the response.

Codex's built-in skills are out of reach either way: that route requires a **runner** from
the registry (`api-routes-files.ts` ~328), and warming creates a container but no runner
(`warm-pool-manager.ts` ~224, ~296). Pre-Send skills therefore cover the repo's own
`.claude/skills` / `.codex/skills`, not Codex built-ins.

### The new-session generation

Requirement 8 needs one. The new-session key is `new:${repoSlug}` (`App.tsx` ~1692) and
`useMessageDraft` only swaps state when it changes (~34), so a second new session **in the
same repo** produces no new identity and the pick would persist into it. An in-memory
`newSessionGeneration`, incremented on every deliberate new-session action, resets the mode
to `Inherit`, owns single-flight submission, and guards late completion. It does **not** go
into the text-draft key — per-repo text retention is deliberate.

### Rollout

The legacy claim route is **left alone**. A cached old client has no network control, so
there is nothing to reconcile for it; the new behaviour lives on a new, explicit draft-claim
endpoint. No `skipReuse` change there either — that flag belongs on the new path, where
reusing another tab's server-side draft would be dangerous.

`PUT /api/egress/session/:id` gains strict validation: it currently accepts an invalid body
and an arbitrary session id (`api-routes-egress.ts` ~331). Narrow fix, not a subsystem.

### Failure semantics, stated

A lost response after a successful claim leaves an ungraduated session behind and the user
retries into a second one — the pre-existing behaviour of every claim in the product; the
warm pool reclaims ungraduated sessions. There is deliberately no rollback machinery, and the
egress deletion cascade (`services/session.ts` ~924) goes back to being separable hygiene.

## Where the tests go

1. **Mode in force on the first turn**, for explicit Contained and Open, on `/new` and Quick
   Capture — and the `Inherit` case decided above, tested to whichever promise it lands on.
2. **Reconciliation in every state** — matching leaves the container; mismatching, `starting`
   and unknown all evict. Must fail if the implementation reads `isEgressContained()`.
3. **The first message reaches its own session** when the user switches sessions between
   claim and socket-open.
4. **Attachments arrive with the first message** after a claim — the drain is awaited.
5. **A failed claim preserves the whole draft**; a second new session in the *same repo*
   resets the mode to Inherit.
6. **Composer and dialog agree** after a change in either, including in a second tab.
7. **Pre-Send autocomplete** survives a warm-pointer rotation without reading another
   session.

## Key files

| File | Role |
|---|---|
| `src/client/components/PermissionModeSelector.tsx` | The combined mode + network control |
| `src/client/components/MessageInput/MessageInput.tsx` | Renders it everywhere; awaits the upload drain; preserves the draft on failure |
| `src/client/components/MessageInput/ComposerSettingsMenu.tsx` | Loses its Mode row; role list opens directly |
| `src/client/App.tsx`, `src/client/stores/session-store.ts`, `src/client/hooks/useConnectionSync.ts` | Scope the pending first message to its claimed session |
| `src/client/hooks/useSessionActivation.ts` | Stops claiming on `/new`; owns the generation |
| `src/client/hooks/useFileUpload.ts` | `drainDeferredUploads(sessionId)` |
| *new* draft-claim endpoint | Claim with the network mode, persist, reconcile, return the id |
| *new* repo-scoped draft-context endpoint | Warm-pointer-resolved file tree and skills for `/new` |
| `src/server/orchestrator/session-container.ts` | Evict-only reconciliation on the container record; raw `egressContainedAtStart` |
| `src/server/orchestrator/container-lifecycle.ts` | Teardown-epoch cancellation; where `Inherit` is re-resolved (~1435) |
| `src/server/orchestrator/api-routes-egress.ts` | Strict validation; dedicated session GET for hydration |
| `src/server/orchestrator/services/headless-sessions.ts` | Quick Capture only: + network mode, + permission mode, + preflight |
| `src/client/components/SessionSidebar/SessionSettingsDialog.tsx` | Keeps its section; matched copy; propagates its PUT result |
