---
title: Network mode at session creation — design
description: Fold network containment into the composer's permission-mode control, and make the new-session page a draft so the mode is chosen before any runner exists.
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
  bare icon it is today. A non-default network mode is stated **in words on the trigger** —
  not a glyph and a tint alone. A tooltip does not count: this control is used on touch,
  where there is no hover, and requirement 10 asks for the effective mode to be visible
  before committing to it. Amber is reserved for a *loosening* and is decoration on top of
  the words, never the message.
- **The `Inherit workspace` row names what is inherited** ("Currently Contained") rather
  than making the user hold the workspace default in their head (req 10).
- **Footer.** Before the first turn: "Applied when this session starts — nothing to
  restart." On a running session: the "Pending · applies on next container start" strip with
  **Restart to apply now**, matching the dialog.
- **The popover must survive the selection.** Picking a mode has to reveal the pending
  strip, and the current menu closes on select (`PermissionModeSelector.tsx` ~156). The
  network section keeps the menu open on pick.
- **Never sticky** (req 8): every new session opens at "Inherit workspace". The pick is
  per-session state like the Quick Capture auto-merge checkbox, deliberately not a
  localStorage seed — a sticky loosening is an invisible standing change to the containment
  default. Quick Capture resets it explicitly on open, where it resets its other non-sticky
  fields (`QuickCaptureOverlay.tsx` ~134).
- **Sandboxes get no network section.** A sandbox's network access is a capability grant
  (docs/211, docs/279); the same mutual exclusion `SessionSettingsDialog` already enforces.

### One thing moves out; the settings dialog keeps its section

**Mode leaves `ComposerSettingsMenu`** on every viewport (today it folds in below 700px).
That menu keeps only what a role sets, and the role case loses a nesting level (req 9): a
session running under a role had a root of one row that opened another panel, so the anchor
now opens the **role list directly**, with "Adjust parameters…" beneath it. Quick Capture's
`modeInRow` special case (docs/260 req 19) stops being special — it becomes what every
surface does.

**`SessionSettingsDialog` keeps its network radio group.** Requirement 7 asks for one
authoritative *value*, not one location: both surfaces read and write the same per-session
override, so neither is a second source of truth. Deleting the dialog's half was an earlier
inference, and it cost more than it saved — it forced a composer control that had to work
while the composer was inert, a dialog that disappeared for non-sandbox sessions, and a
relocation of the "not enforced on this deployment" warning, all to remove a surface and no
state.

**`PermissionModeSelector` stops hiding, but never shows a dead row.** Today it returns
`null` when the harness advertises only `auto` (`PermissionModeSelector.tsx:121` — Codex has
nothing to toggle). Carrying network it must render, since network is meaningful whatever
the harness offers — but in that case it renders the **network section alone** and omits the
permission section entirely.

## Mechanism — no runner exists before the choice

Egress is a **container-creation** topology choice (docs/172-agent-containment
`egress-control.md`): the Tier A firewall, Tier B resolver and Tier C SNI proxy are plumbed
into the agent netns by `container-lifecycle.ts` when the container is *created*. A running
container cannot be re-plumbed, which is why the running-session case still says "applies on
next container start".

The whole difficulty of the new-session case was self-inflicted. Today `/new` claims a
session on arrival (`useSessionActivation.ts` ~96), the WS connect materializes a runner
(`route-registry.ts` ~1263 → `services/materialize-runner.ts` → `getOrCreate`), and
`getOrCreate` returns that runner forever after without re-evaluating anything
(`session-runner.ts` ~2269). So a mode picked afterwards arrives at a session that is already
live, and any guarantee has to be retrofitted around it.

**So `/new` stops claiming.** It holds a draft — the text, the attachments, the network pick
— entirely client-side until Send. Then one server-side path does the whole thing, in order,
with nothing to race:

1. Claim a warm session.
2. Persist the chosen mode (`Inherit` writes `setSessionOverride(id, null)`, which deletes
   the row so resolution falls back to the global — `egress-allowlist-store.ts` ~188).
3. Compare the standby container's `egressContainedAtStart` against the resolved
   containment; **discard a mismatched standby** rather than adopting it.
4. Materialize the runner.
5. Graduate and dispatch.

**Quick Capture already works exactly this way** (docs/205: it creates and dispatches
server-side in one act, `QuickCaptureOverlay.tsx` ~180), so it uses the same service rather
than a parallel one — the mode rides its creation params.

**Established sessions keep today's path**: the setting persists through
`PUT /api/egress/session/:id` and applies on the next container start, with the existing
restart-to-apply affordance.

### What this deletes

An earlier draft kept eager activation and built a first-turn admission protocol to
compensate. Recording what it needed, because the size of the list is the argument:

a per-session admission lock; a dispatch reservation with its own runner state, immune to
`verifyRunningState`; runner *replacement* borrowed from `restartAgent`; all-viewer
rebinding after that replacement; a bounded lifecycle lease for transportless callers; a
durable, migration-aware "admitted" state; a graduation thunk to carry each caller's
options into the lock; and a four-caller gate spanning WS send, HTTP dispatch, Quick
Capture and child spawn.

None of it survives, because none of it has anything to do with network modes — all of it
existed to make a *live runner* safely change identity mid-flight. **Child spawn drops out
of scope entirely**: it was only ever in the caller table because it dispatches a first turn,
which stops mattering once first dispatch is the only moment a runner is created.

### What the draft costs, stated

No live preview and no warm container while the first message is being composed
(`requirements.md`, resolved 2026-08-28). The warm pool still pre-builds standby containers
per repo, so Send is not a cold start — but it is the moment the container is claimed, so
the first turn begins a little later than it does today.

The `/new` page must therefore tolerate having **no session id at all**: uploads already
buffer locally until one exists (`useFileUpload.ts`), but the preview panel, file tree and
anything else keyed on a session must render their empty state rather than assume a claim is
in flight. That is the migration surface of this change and the place to look for
regressions.

## Constraints found in review

- **Every network mutation goes through one validated service, and that service keeps the
  audit card.** `PUT /api/egress/session/:id` treats a change as a trust-boundary action and
  emits a *persisted* transcript card (`api-routes-egress.ts` ~325, docs/279 req 8). A
  creation-time path that writes the store directly would silently lose that history, so the
  route and the creation path share one service. The same service validates the mode as an
  enum on every entry — WS, HTTP and multipart.
- **Old clients omit the field.** `WsSendMessage` has no network field today
  (`shared/ws-client-messages.ts`), and a cached or mid-rollout client will send none.
  **Missing means `Inherit`** — never "reuse whatever override is on that id", which would
  resurrect a stale value.
- **Deletion cleanup is not a one-liner inside the egress store.** `clearSession()` exists
  (`egress-allowlist-store.ts` ~211), but the egress tables are generic scoped rows with no
  session foreign key (`database.ts` ~632), and permanent deletion clears several stores
  without touching egress (`services/session.ts` ~924). Either every permanent-deletion path
  calls it, or the schema grows the cascade. Full reset is already covered by `clearAll`.
- **The composer's egress state is its own.** `egress-store.ts` holds ONE mutable session
  scope (~line 111), so sharing it with the global Settings dialog would have the two
  overwrite each other. The control uses local state plus direct fetches, exactly as
  `SessionSettingsDialog` does and for the reason its docstring gives (~line 64).
- **A stale async read must not cross a session switch.** The control fetches per session;
  guard the response against the session having changed, the way the rest of the client does.
- **The global default can change while an `Inherit` draft is open.** `Inherit` resolves at
  Send, not at pick time, so the menu's "Currently Contained" line is a snapshot — it must
  re-read rather than cache for the life of the draft.
- **Warm preinstall runs before any of this.** `agent.install` executes on the standby for a
  trusted repo (`warm-pool-manager.ts` ~297) before the mode is chosen. Requirement 3 speaks
  about the first *turn*, so this is permitted — but the copy must not imply that all session
  setup ran under the chosen mode.
- **Mobile layout.** Six rows plus the inherited-default line, the pending strip and any
  enforcement warning is a tall popover on a phone; it needs a scroll and focus story.

## Where the tests go

Guard the mechanism, not the menu:

1. **Mode in force on the first turn**, table-driven across the two creation surfaces
   (`/new` Send and Quick Capture): force a containment mismatch against the standby and
   assert the first actual turn runs on a container created with the requested mode.
2. **The standby is discarded, not adopted**, when its `egressContainedAtStart` disagrees —
   and is adopted when it agrees, so the test can fail in both directions.
3. **Old-client compatibility**: a first dispatch with no network field resolves to
   `Inherit` and does not reuse a stale override on a reused warm id.
4. **The audit card is emitted** for a creation-time choice, not only for a dialog change,
   and survives a reload (the docs/188 persisted-card round trip).
5. **`/new` with no session id** renders without errors and buffers an upload until Send.

## Key files

| File | Role |
|---|---|
| `src/client/components/PermissionModeSelector.tsx` | Becomes the combined mode + network control |
| `src/client/components/MessageInput/MessageInput.tsx` | Renders it in the composer row on every viewport |
| `src/client/components/MessageInput/ComposerSettingsMenu.tsx` | Loses its Mode row; role case opens the list directly |
| `src/client/hooks/useSessionActivation.ts` | Stops claiming on `/new` — the draft change |
| `src/client/components/QuickCaptureOverlay.tsx` | Sends the mode in its creation params; resets it on open |
| `src/client/components/SessionSidebar/SessionSettingsDialog.tsx` | Unchanged — keeps its network section (req 7) |
| `src/server/orchestrator/services/claim-session.ts` | Claim + compare + discard a mismatched standby, then materialize |
| `src/server/orchestrator/services/headless-sessions.ts` | Quick Capture, through the same service |
| `src/server/orchestrator/api-routes-egress.ts` | The one validated mutation service, including the audit card |
| `src/server/orchestrator/egress-allowlist-store.ts` | Durable per-session override; `clearSession` on permanent deletion |
| `src/server/orchestrator/services/session.ts` | Permanent-deletion cascade — must clear egress state |
