---
title: Network mode at session creation — design
description: One creation-time network control on the composer, shared by the new-session view and Quick Capture.
---

# Network mode at session creation

Implements [requirements.md](./requirements.md). Prototype: [mockup.html](./mockup.html).

## Shape

The control is **the composer's**, not a new dialog. `MessageInput` is already the
new-session UI on `/{owner}/{repo}/new` *and* the body of `QuickCaptureOverlay`, and it
already carries the per-session creation-time choices (permission mode, harness, model,
reasoning level, role) — the wide row as pills, the narrow row folded into
`ComposerSettingsMenu` (docs/260 req 3). Adding **Network** there satisfies reqs 1 and 2
with one control rather than two surfaces (req 4's vocabulary is `SessionSettingsDialog`'s,
unchanged).

- Shown **only while the session has not taken its first turn**. That is req 6: after the
  first turn `SessionSettingsDialog` is the one control, and the composer stops offering a
  second one. The rule already has a neighbour — the harness pill locks at the first
  message for a different reason and says so in the menu.
- The pill names the **effective** mode ("Contained"), never "Inherit". The menu row says
  what is being inherited (req 5).
- A mode that **loosens** the workspace default (Open on a contained workspace) takes the
  warning tint; a tightening stays neutral. Tinting the safe choice would train the user to
  ignore the tint.

Placements still open: see `requirements.md` → Open questions (stickiness, and Quick
Capture row vs. footer). The mockup renders both Quick Capture variants.

## Mechanism — the part that is not free

Egress is a **container-creation** topology choice (docs/172-agent-containment
`egress-control.md`): the Tier A firewall, Tier B resolver and Tier C SNI proxy are plumbed
into the agent netns by `container-lifecycle.ts` when the container is *created*. That is
why today's per-session control can only offer "Pending · applies on next container start".

Both creation surfaces claim a **warm session**, whose container was created **ahead of
time** by the warm pool (`warm-pool-manager.ts` → `SessionContainerManager.createStandby`,
verified at `session-container.ts:1524`). The regular new-session view claims one when the
route is *entered* (`useSessionActivation.ts:102`); Quick Capture claims one inside
`createHeadlessSession` (`services/headless-sessions.ts:403`). So by the time the user
picks a mode, a container already exists — and it was created with the *inherited*
containment, since the fresh session id carries no override.

The choke point is the runner factory in `app-lifecycle.ts:764`, the one place a claimed
standby is adopted (`mgr.claimStandby`, lines 776 and 810). The container already records
what it booted with — `SessionContainer.egressContainedAtStart`, the same field the pending
indicator diffs against. So the rule is a comparison at that single site:

> If the session's now-resolved containment differs from the standby's
> `egressContainedAtStart`, **do not adopt the standby** — destroy it and create a fresh
> container for this session.

Nothing has run in that container yet: no turn, no clone-side work the user can see. This
is why the creation-time control can promise "applied when the session starts", with no
restart and no pending state, where the post-first-turn dialog cannot.

Cost, stated rather than hidden: picking a non-inherited mode **throws away one warm
container** and pays a cold container create (seconds) before the first turn. Two ways to
keep that off the idle path, to be decided with the placement questions:

1. Persist the override on pick, and let the existing claim/adopt path do the comparison at
   **first send** — the user is already waiting for the turn to start.
2. Recreate eagerly on pick, so the wait is absorbed while the user is still typing.

(1) is the smaller change and never pays for an abandoned draft; (2) is faster when the
user types slowly. Neither changes the UI in the mockup.

## Wiring

- **Storage.** No new store: `egress-allowlist-store.ts` already holds a per-session
  override (`user-session` scope, `resolveContained(sessionId)`), and
  `PUT /api/egress/session/:id` already writes it. The new-session composer has a claimed
  session id by the time it renders, so it can use that route directly, exactly as
  `SessionSettingsDialog` does.
- **Quick Capture** dispatches its first turn server-side at creation (docs/205), before any
  WS connect — so the mode rides the creation params (`POST /api/sessions/headless`) the way
  `reasoning`, `role` and `armAutoMerge` already do, and is written to the store before the
  claim in `createHeadlessSession`.
- **Sandboxes are already covered and stay out of scope.** `SandboxDialog` picks Network as
  one of the capability grants at creation (docs/211, docs/279). A sandbox's Network access
  IS a capability, so it must not also get this pill — the same mutual exclusion
  `SessionSettingsDialog` enforces.

## Key files

| File | Role |
|---|---|
| `src/client/components/MessageInput/MessageInput.tsx` | Wide-row pill; passes state to the folded menu |
| `src/client/components/MessageInput/ComposerSettingsMenu.tsx` | Narrow-row root row + Network panel |
| `src/client/components/QuickCaptureOverlay.tsx` | Creation params; placement variant B's footer line |
| `src/client/components/SessionSidebar/SessionSettingsDialog.tsx` | The post-first-turn control — vocabulary source, unchanged |
| `src/server/orchestrator/app-lifecycle.ts` | Standby adoption — where a mode mismatch must refuse the warm container |
| `src/server/orchestrator/services/headless-sessions.ts` | Quick session creation, before the claim |
| `src/server/orchestrator/egress-allowlist-store.ts` | Durable per-session override |
