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
  bare icon it is today. A non-default network mode adds a glyph (and, for a loosening, the
  amber tint); a tightening takes the mode's own tint. Colouring the safe choice would
  train the eye past the tint that matters.
- **The `Inherit workspace` row names what is inherited** ("Currently Contained") rather
  than making the user hold the workspace default in their head (req 10).
- **Footer.** Before the first turn: "Applied when this session starts — nothing to
  restart." On a running session: the existing "Pending · applies on next container start"
  strip with **Restart to apply now**, moved here from `SessionSettingsDialog`.
- **Never sticky** (req 8): every new session opens at "Inherit workspace". The pick is a
  per-session state like the Quick Capture auto-merge checkbox, deliberately not a
  localStorage seed like the model — a sticky loosening is an invisible standing change to
  the containment default.

### Two things move out, and one thing can no longer hide

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

**`PermissionModeSelector` can no longer hide itself.** Today it returns `null` when the
harness advertises only `auto` (`PermissionModeSelector.tsx:121` — Codex has nothing to
toggle). Carrying network, it must render anyway, with a single already-current mode row
above the network section. That is the accepted price of one control instead of two.

## Mechanism — the part that is not free

Egress is a **container-creation** topology choice (docs/172-agent-containment
`egress-control.md`): the Tier A firewall, Tier B resolver and Tier C SNI proxy are plumbed
into the agent netns by `container-lifecycle.ts` when the container is *created*. That is
why the running-session half of the menu still says "applies on next container start" — no
UI change removes that.

The **new-session** half is what needs work, because both creation surfaces claim a **warm
session** whose container the warm pool created **ahead of time**
(`warm-pool-manager.ts` → `SessionContainerManager.createStandby`, verified at
`session-container.ts:1524`). The regular new-session view claims one when the route is
entered (`useSessionActivation.ts:102`); Quick Capture claims one inside
`createHeadlessSession` (`services/headless-sessions.ts:403`). So by the time the user
picks, a container exists — created with the *inherited* containment, since a fresh session
id carries no override.

The choke point is the runner factory in `app-lifecycle.ts:764`, the single place a claimed
standby is adopted (`mgr.claimStandby`, lines 776 and 810). The container already records
what it booted with — `SessionContainer.egressContainedAtStart`, the same field the pending
indicator diffs against. So the rule is a comparison at that one site:

> If the session's now-resolved containment differs from the standby's
> `egressContainedAtStart`, **do not adopt the standby** — destroy it and create a fresh
> container for this session.

Nothing has run in that container yet, which is exactly why the new-session footer can
promise "nothing to restart" where the running-session footer cannot.

Cost, stated rather than hidden: a non-inherited pick **throws away one warm container**
and pays a cold create (seconds) before the first turn. Two ways to keep that off the idle
path:

1. Persist the override on pick and let the existing adopt path do the comparison at
   **first send** — the user is already waiting for the turn to start.
2. Recreate eagerly on pick, absorbing the wait while the user is still typing.

(1) is the smaller change and never pays for an abandoned draft. Neither changes the UI.

## Wiring

- **Storage.** No new store. `egress-allowlist-store.ts` holds the per-session override
  (`resolveContained(sessionId)`) and `PUT /api/egress/session/:id` writes it — the route
  `SessionSettingsDialog` uses today. The new-session composer has a claimed session id by
  the time it renders, so it calls the same route.
- **Quick Capture** dispatches its first turn server-side at creation (docs/205), before any
  WS connect, so the mode rides the creation params of `POST /api/sessions/headless`
  alongside `reasoning`, `role` and `armAutoMerge`, and is written to the store before the
  claim in `createHeadlessSession`.
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
| `src/client/components/SessionSidebar/SessionSettingsDialog.tsx` | Loses its network half; sandbox capabilities remain |
| `src/server/orchestrator/app-lifecycle.ts` | Standby adoption — where a mode mismatch must refuse the warm container |
| `src/server/orchestrator/services/headless-sessions.ts` | Quick session creation, before the claim |
| `src/server/orchestrator/egress-allowlist-store.ts` | Durable per-session override |
