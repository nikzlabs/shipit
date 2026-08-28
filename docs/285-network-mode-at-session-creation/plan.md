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
(reqs 5, 6). Both settings are one tap from the same trigger, on desktop and on mobile.

Why this and not a pill of its own: the setting is needed rarely, and the composer row is
already the scarcest space in the product — docs/260 exists to keep the harness, model and
reasoning labels from pushing Send off the edge.

- **Trigger.** Unchanged in the common case: Auto with an inherited network mode is the bare
  icon it is today. A non-default network mode is stated **in words on the trigger** — not a
  glyph and a tint alone. A tooltip does not count: this is used on touch, where there is no
  hover, and req 10 asks for the effective mode to be visible *before* committing. Amber is
  reserved for a loosening and sits on top of the words, never instead of them.
- **The `Inherit workspace` row names what is inherited** ("Currently Contained"), re-read at
  open rather than cached — the global can change while a draft is sitting there.
- **The enforcement warning belongs here too.** The API separates containment *policy* from
  actual *enforcement*, and the UI is required never to imply protection it cannot deliver
  (`docs/172-agent-containment/egress-control.md` ~566). The "Contained — NOT enforced on
  this deployment" warning therefore appears in this control, not only in the retained
  dialog.
- **The menu states, it does not act.** Before the first turn: "In force from this session's
  first turn." On a running session: "Applies on next container start" — and **no restart
  button**. Session settings stays the lifecycle surface and already has that control;
  duplicating it here would put two restart affordances on one session and force the popover
  to survive its own selection. The menu closes on pick, as it does today.
- **Never sticky** (req 8): every new session opens at "Inherit workspace", reset explicitly
  where Quick Capture resets its other non-sticky fields (`QuickCaptureOverlay.tsx` ~134).
- **Sandboxes get no network section** — their network access is a capability grant
  (docs/211, docs/279), the mutual exclusion `SessionSettingsDialog` already enforces.
- **Harness with one permission mode**: renders the network section alone, no dead "Auto"
  row.

**Mode leaves `ComposerSettingsMenu`** on every viewport. That menu keeps only what a role
sets, and the role case loses a nesting level (req 9): the anchor opens the **role list
directly**, with "Adjust parameters…" beneath it.

**`SessionSettingsDialog` keeps its network section.** Req 7 asks for one authoritative
*value*, not one location. But two surfaces reading the same row is not yet "consistently
represented": the dialog fetches only when it opens (`SessionSettingsDialog.tsx` ~117) and
the composer would hold its own state, so a change in one can leave the other stale. They
need **shared invalidation** — a session-scoped update event both listen to — or the
requirement is met on paper only.

## Mechanism — no runner exists before the choice

Egress is a **container-creation** topology choice: the Tier A firewall, Tier B resolver and
Tier C SNI proxy are plumbed into the agent netns when the container is *created*
(`container-lifecycle.ts`). A running container cannot be re-plumbed.

Today `/new` claims a session on arrival (`useSessionActivation.ts` ~96), which opens the WS
(`App.tsx` ~186) and materializes a runner (`route-registry.ts` ~1263). A mode picked
afterwards therefore arrives at a session that is already live. **So `/new` stops claiming**
and holds a draft until Send, at which point one server-side service does the whole thing in
order, with nothing to race.

### The draft is the whole composer, not just the network field

This is the part an earlier draft of this plan got wrong by assuming `/new` was already
close to sessionless. It is not — several things currently work *because* an id exists:

| What | Today | Consequence |
|---|---|---|
| The composer itself | Enabled only with a socket or a session id (`App.tsx` ~2224) | Would render permanently disabled |
| Send | With no id, appends an optimistic bubble and logs that it cannot send (`App.tsx` ~613, ~680) | There is no creation path to call |
| Attachments | Raw files sit in a hook-local ref until an id appears; only the overlay backend exposes `File[]`, selected on `surface` not on absence of id (`useFileUpload.ts` ~124, `useUploadBackend.ts` ~27) | Atomic Send cannot reach the bytes |
| Issue seeding | `pendingIssueRef` is keyed to the claimed id and discarded when there is none (`App.tsx` ~1415) | Issue-started sessions lose their pointer |
| Harness / model / reasoning / role | Applied to the new session over WS `set_*` messages (`App.tsx` ~1532, ~1569, ~1594, ~1628) | With no socket, the creation request must carry and the server must validate the whole tuple |
| `/review @path` as a first action | Works only because the eager claim supplied an id (`App.tsx` ~530) | Needs an explicit decision, not silence |

So the deliverable is a **draft→session transaction**, and the network mode is one field in
it. That is still far smaller than the admission protocol it replaces, but it is not a
one-line change and this plan should not have implied it was.

Related, and required by req 6 rather than by this list: **Quick Capture does not send the
permission mode today** — it displays one (`QuickCaptureOverlay.tsx` ~197) while the server
hardcodes `permissionMode: undefined` (`headless-sessions.ts` ~460). A combined control that
sets both settings has to fix that too.

### One create-and-dispatch service

A new orchestration service owns the transaction: apply the draft, reconcile the standby,
materialize, graduate, dispatch. It **calls** `claim-session` and does not become part of it
— claim is a workspace allocator shared by the child, install, headless and interactive
paths (its own docstring, ~100), and widening its responsibility drags those callers back
into this feature.

It claims with **`skipReuse: true`**, as headless creation already does
(`headless-sessions.ts` ~396). With no server-side draft there is no abandoned interactive
draft to recycle, and reuse actively hurts: two tabs sending to the same repo can alias,
the second finding the first's still-ungraduated session through `findUngraduatedWarm`
(`claim-session.ts` ~340).

Quick Capture shares this **core**, not the whole surface. It is background and optimistic;
`/new` must keep its draft on failure and navigate only if its originating route is still
active. Treating the two as identical hides that difference.

### Standby reconciliation has three states, not two

The warm pointer is published **before** standby creation finishes, and creation is
deliberately fire-and-forget (`warm-pool-manager.ts` ~224, ~296). The container record exists
as `starting` before its egress mode is resolved (`container-lifecycle.ts` ~1231 vs ~1435),
and it is not marked a standby until creation completes (`session-container.ts` ~1524).
Materializing inside that window creates a runner that waits and then adopts the container
(`app-lifecycle.ts` ~788). So reconciliation must be atomic *with respect to that window*,
and must happen before materialization:

- **Known and matching** → adopt.
- **Known and mismatching** → destroy, create fresh.
- **`starting`, or unknown** → await the boot decision, or conservatively destroy before
  materializing. **Unknown must never read as matching** — that is the state that would
  silently run the first turn under the wrong mode.

### Failure, duplication and navigation

`MessageInput` calls a synchronous `onSend` and immediately clears the text and uploads
(`MessageInput.tsx` ~640). Creation can now fail at claim, validation, upload, container
replacement or dispatch, so:

- **The draft survives until the server accepts it** — text *and* raw attachments. Clearing
  on call is only safe when sending cannot fail.
- **Duplicate submission is blocked**, and the request carries a client-generated
  **idempotency key**: a lost response, a double Enter or two tabs must not create or
  dispatch twice. A failure after the claim currently leaves side effects with no rollback
  (`headless-sessions.ts` has several throws after its claim, ~403), so the service needs
  cleanup for a claimed-but-never-dispatched session.
- **A late response must not yank the user** out of a session they switched to — the same
  race the eager-claim path already needed a route guard for (`useSessionActivation.ts` ~142).

### Rollout

A cached old client still claims, connects its WS and materializes a runner *before* it
sends, so "missing network field means Inherit" cannot be repaired at first dispatch for it.
**The legacy claim route must clear the override to `Inherit` before returning the session
id**, and the old claim/WS path stays supported for the rollout window.

Validation is currently too lax to rely on: `PUT /api/egress/session/:id` returns 200 for an
invalid or missing `override` instead of rejecting it (`api-routes-egress.ts` ~331). One
strict enum conversion serves the JSON, multipart, legacy-claim and dialog paths.

Every mutation goes through the service that emits the **persisted audit card** — a
trust-boundary change with no transcript record is the docs/279 req 8 regression, and that
card already supports a session with no runner (`services/session-settings.ts` ~61).

### Copy that is actually true

- **"In force from this session's first turn"**, not "applied when this session starts".
  A trusted repo's `agent.install` may already have run in the standby before the mode was
  chosen (`warm-pool-manager.ts` ~297). Req 3 is a promise about the first *turn*.
- **Picking a mode that differs from the standby means Send is a cold container start.** The
  checkout stays warm; the container does not. Say so rather than implying the choice is
  free.

### Cost of the draft, stated

No live preview and no warm container while the first message is composed
(`requirements.md`, resolved 2026-08-28).

## Sequencing

The draft→session transaction is a prerequisite that stands on its own and touches more of
the client than this feature does. It is worth landing as its **own change** — `/new` becomes
a draft, with the full tuple (text, attachments, harness/model/reasoning/role, permission
mode, issue ref) carried in one create-and-dispatch request and no behaviour change the user
can see — and then adding the network field and the combined control on top. Two reviewable
steps, each of which can be reverted without the other.

## Where the tests go

1. **Mode in force on the first turn**, across `/new` Send and Quick Capture: force a
   mismatch against the standby and assert the first turn runs on a container created with
   the requested mode.
2. **Standby reconciliation in all three states** — matching adopts, mismatching destroys,
   `starting`/unknown never silently adopts. It must be able to fail in both directions.
3. **The full draft tuple survives creation**: harness, model, reasoning, role, permission
   mode (including Quick Capture's, which is dropped today), issue ref, and raw attachments.
4. **Failed submission preserves the draft** — text and attachments — and a duplicate or
   two-tab Send creates exactly one session.
5. **Legacy rollout**: an old client that claims and connects before sending gets `Inherit`,
   not a stale override on a recycled warm id.
6. **The audit card is emitted** for a creation-time choice and survives a reload.
7. **Composer and dialog agree** after a change in either.

## Key files

| File | Role |
|---|---|
| `src/client/components/PermissionModeSelector.tsx` | Becomes the combined mode + network control |
| `src/client/components/MessageInput/MessageInput.tsx` | Renders it on every viewport; must not clear a draft that failed to send |
| `src/client/components/MessageInput/ComposerSettingsMenu.tsx` | Loses its Mode row; role case opens the list directly |
| `src/client/hooks/useSessionActivation.ts` | Stops claiming on `/new` |
| `src/client/hooks/useFileUpload.ts`, `MessageInput/hooks/useUploadBackend.ts` | Raw attachments must be reachable with no session id |
| `src/client/App.tsx` | Composer enablement, Send, issue seeding, `/review`, the `set_*` tuple |
| `src/client/components/QuickCaptureOverlay.tsx` | Sends mode + permission mode; resets on open |
| `src/client/components/SessionSidebar/SessionSettingsDialog.tsx` | Keeps its network section; needs shared invalidation |
| *new* create-and-dispatch service | Owns the transaction; calls claim with `skipReuse: true` |
| `src/server/orchestrator/services/claim-session.ts` | Unchanged responsibility — workspace allocator |
| `src/server/orchestrator/services/headless-sessions.ts` | Quick Capture, through the same core |
| `src/server/orchestrator/api-routes-egress.ts` | Strict validation; the one mutation path with the audit card |
| `src/server/orchestrator/egress-allowlist-store.ts` | Durable per-session override |

**Separable hygiene, not on this path:** permanent deletion clears several stores but not
egress (`services/session.ts` ~924), and the egress tables have no session foreign key
(`database.ts` ~632). UUID-scoped rows leak storage but cannot reach a future session id, so
this is worth fixing on its own rather than inside this feature.
