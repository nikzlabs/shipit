---
status: planned
priority: high
description: Global-hotkey overlay that captures a prompt and spawns a new session in the background, without leaving the current view.
---

# Quick-capture overlay: spawn background sessions

## Goal

Let the user fire off a prompt to a new session at any moment, from anywhere
in ShipIt, without losing what they were doing. A global hotkey opens a
centered input overlay; the user types (or, later, dictates) a prompt;
hitting Enter creates a new session, starts the agent on it, and returns
the user to whatever they were looking at. The new session runs in the
background and surfaces in the sessions sidebar.

This is the "I just thought of something I want the agent to do" path. The
existing path requires the user to click "New Session," wait for the
session view to mount, type the prompt there — and lose their current
session context in the process. Quick-capture removes that whole detour.

## Why this matters

Two product motivations:

1. **Parallelism without context loss.** ShipIt sessions are independent
   agent workstreams; a user reviewing PR feedback in one session shouldn't
   have to abandon that view to spin up a "fix the failing CI on a
   different branch" session. Quick-capture makes the second action a
   2-second interruption, not a full navigation.

2. **Capture-the-thought UX.** Voice users (doc 144) and high-throughput
   typists want an always-available "drop a prompt here" surface. Without
   one, ideas evaporate while the user clicks through navigation chrome.
   The overlay is the chat-shaped equivalent of Spotlight / Raycast / the
   "quick add" pattern.

This stays well within the §1/§5 principles in `CLAUDE.md`. The overlay is
chat-input-shaped — the user types a prompt, the agent acts. It is not a
shell-shaped affordance (no buttons that run commands, no preconfigured
actions). It is just *a different entry point into the same chat surface*.

## Why this lands before voice input (doc 144)

The voice input doc identifies two natural modes for dictation:

- **Mode A — insert into the current session's input.** Voice replaces or
  augments typing in the existing MessageInput textarea. Covered by 144 v1.
- **Mode B — dictate a prompt that starts a *new* session in the background.**
  Voice replaces typing into the quick-capture overlay.

Mode B is more useful in practice (the killer case is "I noticed a bug, let
me dictate a fix-it prompt without leaving what I'm doing"). But Mode B
only exists if there is somewhere to dictate *into* — which is exactly what
this overlay is. So the overlay ships first, with text-only entry; voice
adds itself as a second modality on top of it in doc 144.

## Design

### Trigger

A new global keyboard shortcut, **`Ctrl+Shift+N`** by default (rebindable).
Mnemonic: "new." Active everywhere inside ShipIt — sessions view, docs
viewer, settings, the home / no-session view, the preview pane.

The hotkey is intercepted at the `AppLayout` level so it works regardless
of which panel has focus. It is **not** active when an input element
(textarea, contenteditable, code editor) is focused and the user hasn't
held a modifier that disambiguates intent — see "Open questions" below
for the focus-arbitration policy.

### Overlay UI

A centered modal, roughly the proportions of Spotlight: ~600px wide,
auto-height, dropped over a dimmed backdrop. Contents top-to-bottom:

1. **Repo / context badge** — small label at the top showing where the new
   session will be created: e.g. "New session in `shipit`" or "New
   session in `shipit` from branch `main`." Clicking the badge opens the
   existing repo picker so the user can change targets before submitting.
2. **Prompt input** — a single textarea, autofocused, matching the
   MessageInput visual style. Supports the same affordances where they
   make sense:
   - `@`-autocomplete for files (in the chosen repo)
   - `/`-autocomplete for skills
   - Multi-line via Shift+Enter
   - The existing draft-persistence helper, scoped to the overlay (not
     per-session, since there is no session yet)
3. **Hint row** — small text: "Enter to send · Shift+Enter for newline ·
   Esc to dismiss."
4. **Send button** — optional; Enter is the primary path.

States:

- **idle** — input ready
- **submitting** — Enter pressed; session-creation request in flight
- **error** — session creation failed (e.g. no repo, container provision
  failed); error message inline, retry / dismiss

The overlay is dismissed by Esc, by clicking outside the modal, or
automatically after a successful submit. On dismiss without submit, the
draft is preserved so re-opening the overlay restores the in-progress
prompt — important when the user accidentally hits Esc mid-thought.

### Submission flow

The honest description, because the existing "New Session" flow is more
subtle than "create with prompt":

**Today's "New Session" path is two-stage and viewer-driven.** Clicking
"New Session" calls the HTTP `claim-session` route which returns a session
ID claimed from the warm pool — *without* booting a container. The
container only starts once the browser navigates to `/session/{id}`,
opens the per-session WebSocket, and the server runs `activateSession`.
The agent only starts when the first WS `send_message` message arrives.
"Don't navigate" is therefore not a one-line flag — it's the load-bearing
trigger for the whole runtime chain.

**But the right primitive already exists.** Look at
`src/server/orchestrator/services/child-sessions.ts:spawnChildSession`:
it creates a session, queues the first prompt via `sendSystemMessage` on
the runner, and starts the agent — explicitly *"matching the home-screen
'send a message' behaviour without needing a WS to be attached."* That
function is used today by the CLI shim's `shipit session create` to spawn
sibling sessions from inside an agent turn. It is the proven shape of
"create + start agent without a viewer." Quick-capture reuses this shape.

**The actual submission flow:**

1. Overlay enters `submitting` state.
2. Client posts to a new HTTP route `POST /api/sessions/headless` (name
   reflects what it actually does internally — see "Naming" below) with
   `{ repoUrl, initialPrompt, branch? }`.
3. Server creates a session along the same disk-and-clone path as
   `spawnChildSession` (or by generalising that function — see
   "Architecture" below — into a shared helper used by both
   parent-spawned and quick-capture-spawned headless sessions), claims a
   warm-pool runner, queues the prompt with `sendSystemMessage`, returns
   the new session ID.
4. SSE pushes the new session into every connected client's session list.
   The overlay closes; the user stays where they were. The new session
   appears in the sidebar with the existing "running" indicator.

What is **new** server-side:

- A new HTTP route or service entry point — name TBD, "headless session"
  is the internal term. Wraps the shared helper.
- Refactoring `spawnChildSession` into:
  - `createHeadlessSession(opts)` — the bare creation + agent-start
    primitive, no parent assumption. Takes `repoUrl`, `branchBase`
    (commit SHA or ref name), `prompt`, `agentId`, `model` directly
    rather than deriving them.
  - The existing `spawnChildSession` becomes a thin wrapper that
    derives the parent-specific bits before delegating: `parent.remoteUrl`,
    `parent.workspaceDir → revparse HEAD` (for the base commit),
    `parent.model` inheritance, `setParentSession(newSessionId, parentSessionId)`,
    plus the parent quotas (`maxActiveSpawnedSessions`,
    `maxSpawnedSessionsPerTurn`) and the `spawnedByTurn` tag.
- The quotas in `spawnChildSession` (per-parent active, per-turn) do
  *not* apply to quick-capture — those exist to keep an agent from
  fan-out-spawning thousands of children. We need a different cap here
  (e.g. "at most 8 background sessions in flight at once") to keep the
  overlay from becoming a denial-of-service.

What is **new** client-side:

- A new action in `session-actions.ts` (`createHeadlessSession`,
  matching the server name) that posts to the new route and pushes the
  resulting session into the store *without* navigating.
- The existing claim-session + navigate flow remains for the visible
  "New Session" button. They are two distinct paths now, even though
  they end at the same place.

### Naming

User-facing term: **"background session."** Definition, surfaced as a
tooltip on the sidebar indicator and in settings docs:

> A session whose agent starts immediately on creation, without the
> creating client attaching as a viewer. It runs to completion (or to its
> next pause point) in the background; you can switch into it from the
> sidebar at any time.

Internal (code-facing) term: **"headless session"** — used in route
names, service function names, and tests. The distinction matters
because there are *already* sessions running in a loose "background"
sense (warm-pool dormant sessions, sessions whose tab the user has
detached). "Headless start" is precise: the *startup* did not involve a
viewer. After the user clicks into the session in the sidebar, it
becomes a normal viewer-attached session and there is nothing
distinguishing it from any other.

### Background-session indicators

The user needs to know that something they kicked off is running, without
the overlay forcing them into the session.

- **Sidebar.** The session appears with the existing "running" pulse the
  app already uses for in-progress turns. No new visual primitive needed.
- **Completion notification.** When the first turn finishes, the existing
  `useNotification` hook fires — it already accepts a parameterized
  `NotifyContext` with `sessionName` and `repoLabel`, so per-session
  notifications are mechanically supported. The work is the call site:
  today it is wired through the active session's message handler, which
  means a non-attached background session would silently miss the
  notify. **Fix: hoist the notification trigger to the SSE-broadcast
  handler.** That's a cleaner shape than the alternative (a per-session
  listener for every headless-started session, dropping itself after the
  first turn), and it does not regress the existing
  attached-session path because SSE fires for the active session too.
  The listener-based alternative is listed here only so future readers
  see it was considered.
- **Multiple in-flight background sessions.** Several can run at once
  (the doc-145 quota caps it at 8 — see "Submission flow"). When more
  than two finish within ~3 seconds, coalesce into a single
  "N sessions finished" notification rather than stacking. Single
  completions use the normal "✓ {sessionName} — ShipIt" title format.
- **Browser notification.** Same code path; respects the existing
  `notifyOnFinish` user setting.

If the user has notifications disabled, the only signal is the sidebar
state change — that is intentional, the principle is "the overlay is a
fire-and-forget surface, the sessions list is where you go to follow up."

### Repo / target context

The badge defaults to:

1. The repo of the currently active session, if one is open.
2. Otherwise, the most-recently-used repo from `RepoStore`.
3. If `RepoStore` is not yet hydrated (the user opens the overlay
   immediately on page load before bootstrap completes), the overlay
   shows a brief spinner in the badge position and keeps the input
   disabled until repos load.
4. If bootstrap has completed and no repo exists at all, the overlay
   shows an inline message ("Add a repo first") with a link to the
   existing add-repo flow, and the prompt input is disabled.

Branch defaults to the repo's default branch. The badge is clickable to
open a small inline picker for both repo and branch — same affordances
as the existing new-session flow, just lifted into the overlay.

### Architecture

Client-heavy, but with real server work for the headless-start primitive.

**Client (new):**

- `src/client/components/QuickCaptureOverlay.tsx` — the modal component.
  Mounted once at `AppLayout` level, visibility controlled by a UI store
  field. Owns its own input state and the repo/branch selection.
- `src/client/hooks/useQuickCaptureHotkey.ts` — global key listener that
  toggles the overlay. Conflict-detected against existing hotkeys at
  registration time.

**Client (modified):**

- `src/client/AppLayout.tsx` — mount the overlay; wire the hotkey hook.
- `src/client/stores/ui-store.ts` — add `quickCaptureOpen: boolean` and
  setters.
- `src/client/stores/actions/session-actions.ts` — new action
  `createHeadlessSession` that posts to `POST /api/sessions/headless`,
  pushes the resulting session into the store, and does *not* navigate.
  The existing claim-session + navigate path stays untouched for the
  visible "New Session" button.
- `src/client/hooks/message-handlers/agent-event.ts` — adjust the
  notification trigger so it fires for headless-started sessions the
  user is not currently viewing (today the notify call site is wired
  through the active session's handler; see "Background-session
  indicators" for the fix).
- `src/client/components/Settings.tsx` — add a hotkey-binding setting for
  the quick-capture trigger (under a new "Shortcuts" section if one
  doesn't exist yet, otherwise alongside the existing ones).
- `src/client/stores/settings-store.ts` — `quickCaptureHotkey` field +
  setter, persisted to localStorage.
- `src/client/utils/local-storage.ts` — persister for the new hotkey.

**Server (new):**

- `src/server/orchestrator/api-routes-session.ts` (existing file —
  *modified*, not new) — register `POST /api/sessions/headless`.
- `src/server/orchestrator/services/headless-sessions.ts` (new) —
  factored-out core of `spawnChildSession`: clones the repo into a fresh
  session dir, generates a branch, claims a warm-pool runner, queues the
  prompt via `sendSystemMessage`, returns the new `SessionInfo`. No
  parent assumption. Quotas: a per-installation cap on simultaneous
  in-flight headless sessions (default 8, settable).

**Server (modified):**

- `src/server/orchestrator/services/child-sessions.ts` — refactor
  `spawnChildSession` to delegate to the shared helper in
  `headless-sessions.ts`, retaining only the parent-specific concerns
  (parent quotas, `spawnedByTurn` accounting, base-branch defaults
  derived from the parent).
- `src/server/orchestrator/services/index.ts` — re-export the new
  service.
- `src/server/orchestrator/app-di.ts` — wire the headless-sessions
  service into route registration.

No new WS message types are needed — the new route is HTTP, and the
server's existing per-session SSE broadcasts cover everything the client
needs to learn about the new session (creation, "running" indicator,
turn completion).

### Why the work is bounded despite the new server primitive

ShipIt already has the architectural premise this feature depends on:
sessions run independently of viewer attachment (see "WebSocket lifecycle
MUST NOT affect server behavior" in `CLAUDE.md`). `spawnChildSession`
already exercises that premise — it creates and starts a session with
no WS attached, kicked off by the CLI shim. What we're adding is a
*second caller* of that pattern that originates from a quick-capture
overlay rather than from an agent invocation, plus a small refactor to
split the parent-specific concerns from the headless-start core.

The reason this is not "the cheapest possible server-side change" (as an
earlier draft of this doc claimed) is that the client-facing
`createSession` action does not go through `spawnChildSession` today —
it goes through claim-session + navigate + first send_message. Quick-capture
needs the spawn-style flow exposed via HTTP. That HTTP route plus its
service layer plus the refactor is what makes this 6–8 days instead of
the 3.5 days the earlier draft estimated.

### Interaction with the warm session pool

The warm pool (`docs/session-lifecycle`, `SessionRunnerRegistry`) makes
session start-up feel instant. `spawnChildSession` already uses it via
`runnerRegistry`; the refactored `createHeadlessSession` keeps that
behaviour. The overlay benefits from instant startup with no additional
work — provided we don't accidentally bypass `runnerRegistry` when
moving code between files.

## Out of scope (v1)

- **Voice input.** The overlay is text-only for v1. Voice integration is
  doc 144; the overlay component is designed to accommodate a mic button
  in the same row as the prompt input, but the wiring lives in 144.
- **Browser-extension / OS-level entry point.** Quick-capture is only
  available *inside* ShipIt. A future enhancement could expose it via a
  Chrome extension or an Android intent, but that is a separate effort.
- **Templates / preset prompts.** "Quick-add a `fix CI` task" with
  pre-filled text. Easy to add later as overlay-level dropdown; not in v1
  because we don't yet know which presets users want.
- **Multi-prompt batch mode.** Submitting a list of prompts to spawn
  several sessions at once. Tempting but a separate UX problem
  (validation, partial failures, naming) — defer.
- **Selecting an existing session as the target.** If the user wants to
  send a prompt to an *existing* session without switching to it, that's
  a different feature (call it "fire-and-forget to session N"). Not
  supported by v1 — the overlay always creates a new session.
- **Persistence of the in-progress draft across reloads.** Saving to
  localStorage is fine for "Esc and re-open in the same tab," but a
  cross-reload draft is overkill for an overlay that takes 2 seconds to
  refill. Skip.

## Key files

### Client (new)

- `src/client/components/QuickCaptureOverlay.tsx`
- `src/client/hooks/useQuickCaptureHotkey.ts`
- `src/client/components/QuickCaptureOverlay.test.tsx`
- `src/client/hooks/useQuickCaptureHotkey.test.ts`

### Client (modified)

- `src/client/AppLayout.tsx` — mount overlay, wire hotkey
- `src/client/stores/ui-store.ts` — `quickCaptureOpen` + setters
- `src/client/stores/actions/session-actions.ts` — new `createHeadlessSession` action; existing claim-session+navigate action untouched
- `src/client/hooks/message-handlers/agent-event.ts` — fire `useNotification` for headless-started sessions the user isn't currently viewing
- `src/client/stores/settings-store.ts` — `quickCaptureHotkey` field
- `src/client/utils/local-storage.ts` — hotkey persister
- `src/client/components/Settings.tsx` — hotkey setting UI

### Server (new)

- `src/server/orchestrator/services/headless-sessions.ts` — factored-out core of `spawnChildSession`. Used by both the new route and (after refactor) by `spawnChildSession` itself.

### Server (modified)

- `src/server/orchestrator/api-routes-session.ts` — register `POST /api/sessions/headless`
- `src/server/orchestrator/services/child-sessions.ts` — delegate to `headless-sessions.ts`, retain parent-specific concerns
- `src/server/orchestrator/services/index.ts` — re-export the new service
- `src/server/orchestrator/app-di.ts` — wire the new service

## Testing

Vitest (client):

- **`QuickCaptureOverlay.test.tsx`** — open/close behaviour, Enter submits,
  Esc dismisses with draft preserved, Shift+Enter newline, error state
  rendering, repo badge defaults including the "bootstrap not yet loaded"
  spinner state.
- **`useQuickCaptureHotkey.test.ts`** — hotkey fires with modifier
  regardless of focus, settings rejects no-modifier hotkeys, cleanup on
  unmount.
- **`session-actions.test.ts`** — `createHeadlessSession` posts to the
  expected route, pushes the new session into the store, does *not*
  navigate.
- **`agent-event.test.ts`** — extend to verify `useNotification` fires
  for headless-started sessions even when the user is viewing a different
  session, and that coalescing kicks in when ≥2 finish within ~3s.

Vitest (server):

- **`headless-sessions.test.ts`** — creates a session with a prompt,
  warm-pool runner is claimed, prompt is queued, agent starts, returns
  the new `SessionInfo`. Failure modes: invalid prompt, no repo, cap
  exceeded.
- **`child-sessions.test.ts`** — existing tests stay green after the
  refactor (delegation to `headless-sessions.ts` is internal).
- **`api-routes-session.test.ts`** — `POST /api/sessions/headless`
  round-trip, error mapping, cap-exceeded path returns 429.

Integration:

- **`integration_tests/quick-capture-headless.test.ts`** — full round-trip
  with `TestClient`: post to the route, verify SSE broadcasts the new
  session, agent runs to completion, no WS attach required.

Manual QA:

- Hotkey conflict scan on macOS / Windows / Linux.
- Esc → reopen → draft restored.
- Multiple headless sessions in flight at once → sidebar shows each;
  finish notifications coalesce when bursty.
- `notifyOnFinish` toast fires for a background session whose tab the
  user has never opened.
- The per-installation cap surfaces a clear error when exceeded.

## Decisions (previously open questions)

1. **Focus arbitration: hotkey fires regardless of focus.** The default
   hotkey requires modifiers (`Ctrl+Shift+N`), which disambiguates intent
   even when a textarea is focused. The settings UI rejects no-modifier
   hotkeys with a "modifier required" validation error rather than
   leaving focus-arbitration policy implicit.
2. **Sidebar surface for "just-created."** Brief pulse (~2 seconds) on
   the new sidebar entry to draw the eye, then settles into the normal
   "running" state. Reuses the existing pulse primitive.

## Open questions to settle during build

1. **Hotkey default.** `Ctrl+Shift+N` is the suggested default; verify
   no in-app shortcut already uses it. Backups: `Ctrl+Shift+K`,
   `Ctrl+Shift+J`.
2. **Coalesce-toast threshold.** "Two or more completions within ~3
   seconds" is a guess; tune during manual QA. May need to differ for
   sound vs. browser notification (sound is more intrusive).
3. **Per-installation cap value.** "At most 8 in-flight headless sessions"
   is the proposed default. Could be 4, could be 16 — depends on how
   much warm-pool / container budget a typical install can support
   without thrashing. Surface as a settings entry from day one so we can
   tune in production.

## Effort estimate

| Step | Effort |
|---|---|
| Server: refactor `spawnChildSession` → `createHeadlessSession`, new HTTP route, tests | 2 days |
| Server: per-installation in-flight cap + tests | 0.5 day |
| Client: overlay component (markup, draft persistence, repo badge, states) | 1 day |
| Client: global hotkey hook + conflict detection + settings UI | 0.5 day |
| Client: new `createHeadlessSession` action + store wiring | 0.5 day |
| Client: notification path adjustment for non-attached sessions + toast coalescing | 1 day |
| Tests (component, hook, action, integration round-trip incl. server) | 1.5 days |
| Manual QA + polish | 1 day |

**Total: ~6.5–8 days for v1.** The earlier draft of this doc estimated
3.5 days on the false assumption that "create + start agent without
attaching" was a one-line client change. It isn't — the server-side
spawn pattern exists but is currently parent-scoped, and lifting it to a
general-purpose primitive plus the notification-path adjustment for
non-attached sessions are the bulk of the work.
