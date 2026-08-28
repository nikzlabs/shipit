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
> Keep such a comparison only as an optimisation, never as the guarantee — and if kept, gate
> it on `isStandby`: both call sites also run for ordinary existing containers, and
> `claimStandby()` silently no-ops for a non-standby id (`session-container.ts:1534-1546`).

**The guarantee is a server-side gate immediately before the first turn is dispatched**,
after the desired mode is durably known:

- The **first** `send_message` of an ungraduated session carries the desired network mode.
  The server persists it, then — before dispatch — checks the live container's
  `egressContainedAtStart` against the now-resolved containment and **recreates the
  container if they disagree**. `ws-handlers/send-message.ts` (~583) is where the runner is
  reused, so the gate belongs on that path, awaited.
- **Quick Capture** cannot write the override "before the claim": it has no session id until
  `claim()` returns (`services/headless-sessions.ts:403`). It persists **after** the claim
  and **before** the runner is created and dispatched (~426), explicitly awaited.

`egressContainedAtStart === undefined` means **unknown**, not "matches" — it is documented
absent on rediscovered/re-adopted containers (`session-container.ts:304`). Unknown must
neither pass the gate silently nor be grounds to destroy an ordinary rediscovered
container.

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
  remain openable under `inert`. There is **no** HTML `inert` attribute on the composer, so
  this is a small change, not a relocation. The existing split stays: a *running turn* locks
  the pickers but leaves the mode readable.
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
- **Scope the client egress store carefully.** `egress-store.ts` is a single-scope store
  keyed by one `sessionId` (its docstring, ~line 20), not a per-session cache; the global
  Settings dialog loads it with `load(null)`. Sharing it with a per-session composer control
  needs explicit ownership or a separate slice, or one surface will clobber the other's
  scope.

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
| `src/server/orchestrator/ws-handlers/send-message.ts` | **The first-turn gate** — persist, validate, recreate, then dispatch |
| `src/server/orchestrator/services/headless-sessions.ts` | Quick session: persist after the claim, before dispatch |
| `src/server/orchestrator/app-lifecycle.ts` | Standby adoption — optional optimisation only, gated on `isStandby` |
| `src/server/orchestrator/egress-allowlist-store.ts` | Durable per-session override |
