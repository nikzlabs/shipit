---
status: done
priority: high
description: Global-hotkey overlay that captures a prompt and spawns a new session in the background, without leaving the current view.
---

# Quick-capture overlay: spawn quick sessions in the background

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

A new global keyboard shortcut, **`Ctrl+Alt+N`** (macOS: `Cmd+Opt+N`)
by default (rebindable). Mnemonic: "new." Active everywhere inside
ShipIt — sessions view, docs viewer, settings, the home /
no-session view, the preview pane.

**Why not `Ctrl+Shift+N`** (the obvious mnemonic): it's taken by every
major browser for incognito / private-window. Page-level
`preventDefault` does not reliably reach the browser-chrome handler,
so a meaningful fraction of users would hit `Ctrl+Shift+N` and open
incognito instead of the overlay. **Why not `Ctrl+Shift+K` / `J` / `I`:**
DevTools shortcuts in Chrome/Firefox. **Why not the existing
`Ctrl+Shift+O`** (which is already wired for "new session" — see
`useKeyboardShortcuts.ts` line 69): muscle-memory collision; a
one-letter difference between two new-session flavoured shortcuts is
the worst case. `Ctrl+Alt+N` avoids the browser-chrome collisions
and is two-modifier-letter distant from the existing shortcut.

**Known limitation: `Ctrl+Alt` is AltGr on Windows / Linux
international layouts.** On Polish keyboards, `AltGr+N` produces `ń`;
other layouts have analogous bindings. Users on those layouts will
need to rebind. We accept this tradeoff (no globally-conflict-free
single-key default exists for a web app) and rely on the in-settings
rebinder + conflict-detector to make the workaround obvious. If
production telemetry shows enough international users are blocked,
fall back to a chord (e.g. `Ctrl+K` then `N`, à la Linear / Notion).

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
2. **Prompt input** — the existing `MessageInput` component
   (`src/client/components/MessageInput.tsx`), reused verbatim. Not a
   lookalike, not a refactor-into-a-shared-shell — the same
   `<MessageInput />` that renders inside the chat panel. That buys us,
   for free, exactly the affordances the overlay needs to feel
   continuous with the rest of the app:
   - `@`-autocomplete against the chosen repo's file tree
   - `/`-autocomplete for skills (Codex `$`-prefix swap included)
   - Multi-line via Shift+Enter, Enter to submit, autosize, paste, drag-drop
   - Attachment chips, file picker, permission-mode selector, agent /
     model selector
   - Draft persistence via the existing `focusKey` plumbing — pass a
     sentinel like `"__quick_capture__"` and the overlay gets its own
     entry in `shipit-draft-message:*` localStorage, isolated from any
     session's draft. No new persister, no new helper.

   The overlay supplies the props `MessageInput` already expects
   (`onSend`, `disabled`, `fileTree`, `skills`, `agents`, `activeAgentId`,
   `modelInfo`, `pendingFiles`, `uploads`, …) sourced from the chosen
   repo and the global bootstrap state. Overlay-context props are
   stubbed: `isLoading=false` (no agent in flight yet),
   `hasActiveSession=false`, `contextTokens=0`, `hasPrCard=false`,
   `liveSteeringActive=false`. The stop button and live-steering UI
   hide automatically when `isLoading=false`.

   **One MessageInput change is required**, because three of its
   internals were written under the implicit assumption that exactly one
   MessageInput is mounted in the tree at a time. With the overlay also
   mounting one, the assumption breaks:

   - The global `prefillText` zustand subscription (MessageInput.tsx
     lines 132–151) is consumed by whichever instance's effect fires
     first. Without scoping, the overlay can swallow a prefill intended
     for the chat input, or vice-versa.
   - The auto-focus block keyed on `focusKey` change
     (lines 164–173) fires per-instance, so the chat's MessageInput can
     race the overlay's for focus on a session switch that happens
     while the overlay is open.
   - `ContextDialMount` (lines 605–637) subscribes unconditionally to
     the active session's `sessionId`/`turnUsage`, and the parent
     hide-gate is `(modelInfo ?? contextTokens > 0)` — a truthy
     `modelInfo` keeps it rendered even when `contextTokens === 0`.
     The overlay therefore can't fully suppress the dial just with
     stubbed props.

   The fix is one new `surface?: "chat" | "overlay"` prop on
   MessageInput (default `"chat"`, preserving today's behaviour).
   When `surface === "overlay"`: skip the `prefillText` subscription,
   skip the `focusKey`-driven focus path (the overlay handles focus
   itself on mount), and skip the `ContextDialMount` render. Three
   guards, no behaviour change for the existing chat call site.

   Two other per-instance pieces of MessageInput state were considered
   and deliberately *not* gated: (a) the document-level `pointerdown`
   capture listener (MessageInput.tsx lines 192–202), and (b) the
   per-textarea `handleBlur` iframe-reclaim. With two instances
   mounted, both pointerdown listeners fire on every event — but
   each writes to its own instance-local `lastIframePointerDownRef`,
   so they're idempotent and don't fight; the only cost is a handful
   of extra cycles per pointer event. The `handleBlur` reclaim is
   per-textarea and only fires for the textarea that just lost focus,
   so there's no cross-instance interference (only one textarea can
   be focused at a time). Documenting these as known, benign
   duplications so a future contributor doesn't waste time gating
   them.

   This is still a hard constraint on **reusing the component**, not a
   licence to clone it. If a future change tempts a contributor to fork
   MessageInput "just for the overlay," that's the signal a new prop
   is needed — like `surface` here — not a parallel file.
3. **Hint row** — small text: "Enter to send · Shift+Enter for newline ·
   Esc to dismiss."
4. **Send button** — optional; Enter is the primary path.

States:

- **idle** — input ready
- **submitting** — Enter pressed; session-creation request in flight
- **error** — session creation failed; error message inline, retry /
  dismiss. `spawnChildSession` today surfaces `ServiceError(status,
  message)` for a small set of structured failures (invalid prompt,
  prompt too long, parent not found, branch rename / reset / create
  failures, child read-back failure). The new `createHeadlessSession`
  primitive inherits that pattern and adds two reasons specific to
  this entry point:
  - **cap exceeded (429)** — "You already have 8 quick sessions
    running. Open one from the sidebar before starting another."
  - **no repo selected** (400) — "Add a repo first." With a deep-link
    to the add-repo flow.
  Generic failures (clone errors, container start failures, OOM
  pressure) currently bubble as 500s with whatever message the
  underlying error produced. The route should surface those as
  "Couldn't start a session — try again" with the underlying message
  available via "Show details." Structuring *those* error reasons as
  named codes is out of scope for v1 — it's a wider orchestrator
  cleanup, not something this feature should drag in. Track as a
  follow-up if quick-capture's error surface ends up needing more
  granularity in practice.

The overlay is dismissed by Esc, by clicking outside the modal, or
automatically after a successful submit. On dismiss without submit, the
draft is preserved so re-opening the overlay restores the in-progress
prompt — important when the user accidentally hits Esc mid-thought.

### Submission flow

The honest description, because the existing "New Session" flow is more
subtle than "create with prompt":

**Today's "New Session" path is two-stage and viewer-driven.** Clicking
"New Session" calls the HTTP `claim-session` route which returns a session
ID claimed from the warm pool. Since commit 7a3f3249 (`Always create
standby on warm-pool`), every warm-pool repo has a standby container
already booted at warm time, so the claim usually hands back a session
whose container is up — `claim-session` is no longer the moment that
triggers boot. What still *does* hinge on navigation is **activation**:
the container is sitting there idle until the browser navigates to
`/session/{id}` and opens the per-session WebSocket, at which point the
server runs `activateSession` to attach a runner to that standby
container. The agent only starts when the first WS `send_message`
message arrives. So "don't navigate" is still load-bearing — but for
activation + first message, not for container boot.

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

Startup failure hardening: the headless route necessarily dispatches the
first turn without a WebSocket viewer attached, so the server-dispatched
turn path must treat startup preparation and worker launch failures as
terminal turn failures, not background promise rejections. If run-parameter
assembly or launch throws after `runner.dispatch()` has synchronously marked
the runner running, the listener path now appends an assistant error row,
emits `session_status { running: false }`, broadcasts
`session_agent_finished`, and drains any queued turn. This prevents the
quick session from being created with the prompt recorded but no agent work
starting and no visible recovery signal.

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
  fan-out-spawning thousands of children. We need a different cap
  here to keep the overlay from becoming a denial-of-service: a
  **per-installation cap** (default **8** in-flight headless
  sessions), settable in settings. ShipIt today is single-user per
  orchestrator (no `userId` / tenant primitive in the server — see
  `api-routes-session.ts`, no auth pre-handler), so per-installation
  is per-user by construction. If multi-tenancy lands later, revisit
  to split into per-user + per-install ceiling — but designing that
  split now is over-spec for a model the codebase doesn't have. The
  429 surfaced from the route is "You already have 8 quick sessions
  running — open one from the sidebar before starting another."

What is **new** client-side:

- A new action in `session-actions.ts` (`createHeadlessSession`,
  matching the server name) that posts to the new route and pushes the
  resulting session into the store *without* navigating.
- The existing claim-session + navigate flow remains for the visible
  "New Session" button. They are two distinct paths now, even though
  they end at the same place.

**Agent / model defaults for the overlay.** `createHeadlessSession`
takes `agentId` and `model` explicitly — somebody has to choose what
to send. Pin the choice rather than letting the implementation pick
silently:

- The overlay's agent / model selector (carried over from
  `MessageInput`) is the source of truth when the user touches it.
- Defaults when the user opens the overlay without touching the
  selector: **the user's most recently chosen agent and model**, the
  same defaults the chat input uses on a fresh "New Session" — pulled
  via `getSavedAgentId()` / `getSavedModelId()` from
  `src/client/utils/local-storage.ts`. **Not** the active session's
  agent/model — a user in a Codex session firing a quick prompt for
  an unrelated Claude task shouldn't get Codex by surprise, and the
  inverse holds.
- Defaults when there is no saved value yet (first-run):
  `getSavedAgentId()` already falls back to the bootstrap default;
  model falls back to that agent's default at the orchestrator.

These defaults are computed client-side and sent on the request
body, so the route's behaviour is fully deterministic given its
input.

**Why agent/model don't inherit from the active session but repo
does** — different signal. Quick-capture is overwhelmingly used
mid-task ("I'm working in `shipit` and just thought of a related
thing"), so the active session's repo is a strong prior. Agent and
model are tied to the *kind of work* the user wants to do, not the
repo they happen to be in; a user editing a Codex session may
quick-capture a Claude task in the same repo, or vice-versa, and
defaulting on the active session's agent would silently flip them
to the wrong one. Treating repo and agent/model symmetrically would
get one of them wrong; the asymmetry is deliberate.

### Naming

User-facing term: **"quick session."** Definition, surfaced as a
tooltip on the sidebar indicator and in settings docs:

> A session you started from the quick-capture overlay. The agent
> begins working on your prompt immediately; you can switch into it
> from the sidebar whenever you want to see what it's doing.

"Background session" was the obvious first choice but is taken: the
codebase and prior conversations already use "background" loosely for
warm-pool dormant sessions and for sessions whose tab the user has
detached. Reusing it for "quick-capture-started" would silently
collapse three distinct things into one word. "Quick session" maps
1:1 onto the user's experience (they pressed the quick-capture
hotkey) and is unambiguous in copy.

Internal (code-facing) term: **"headless session"** — used in route
names, service function names, and tests. "Headless start" is precise:
the *startup* did not involve a viewer. After the user clicks into the
session in the sidebar, it becomes a normal viewer-attached session
and there is nothing distinguishing it from any other.

### Quick-session indicators

The user needs to know that something they kicked off is running, without
the overlay forcing them into the session.

- **Sidebar.** The session appears with the existing "running" pulse the
  app already uses for in-progress turns. No new visual primitive needed.
- **Completion notification.** Already works with no new code on the
  notification side. `useAttentionNotifications`
  (`src/client/hooks/useAttentionNotifications.ts`) is store-driven
  and SSE-fed: it iterates every non-archived session in
  `useSessionStore`, computes an attention reason via
  `computeAttentionReason`, and fires `notify` with per-session
  `NotifyContext` (`sessionName`, `repoLabel`) on every
  `null → reason` transition. A headless session starts with
  `isAgentRunning === true` (reason `null`); when its first turn
  completes, `isAgentRunning` flips to `false` and the catch-all
  "Waiting for your input" reason fires the notification — same code
  path the active session uses. No "hoist to SSE handler" change is
  needed; the SSE handler is already what feeds the store this hook
  reads.

  One real edge: `useAttentionNotifications` silently seeds the first
  observation per session, so a session whose *first* observation
  already has a non-null reason doesn't fire (this is what stops
  page reload from re-firing alerts for sessions already in an
  attention state). The safety property we actually rely on is
  weaker than "we always see `running → finished`" — it's: **once
  any client has observed the session in its `isAgentRunning ===
  true` running state, the subsequent `true → false` transition
  fires the completion notification**. For a quick-capture session
  the spawning client is connected at create time and so always
  observes the running state (this is the test we'll add — see
  Testing). For a client that connects later (e.g. opens a second
  tab after the session has already finished), the seed silently
  swallows the historical "Waiting for your input" reason; that's
  desirable, not a bug — the user shouldn't get notified about
  completions that happened before they opened the tab.
- **Multiple in-flight quick sessions.** Several can run at once
  (the doc-145 quota caps it at 8 — see "Submission flow"). When ≥2
  `notify(...)` calls happen within ~3 seconds, coalesce into a
  single batched notification rather than stacking. `useNotification`
  has two output paths — the tab/document title
  (`● {sessionName} — ShipIt`, from `doneTitle()`) and the OS-level
  `Notification` (title `ShipIt · {repoLabel}`, body
  `[{sessionName}] {reason}`). The coalescer batches both:
  - Tab title becomes `● N sessions need attention — ShipIt` while
    the batch window is open.
  - OS notification fires once at the end of the batch window with
    title `ShipIt` and body `N sessions finished` (no per-session
    sessionName / repoLabel since they'd be heterogeneous).
  - Sound fires once at the start of the batch window, not per
    completion.
- **Browser notification.** Subject to the same `notifyOnFinish`
  user setting that the per-session path uses.

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

- `src/client/components/QuickCaptureOverlay.tsx` — the modal shell:
  backdrop, centered card, repo/branch badge, error state, dismiss
  wiring, and a `<MessageInput />` instance for the prompt. Mounted
  once at `AppLayout` level, visibility controlled by a UI store
  field. This file does *not* re-implement a textarea — it composes
  `MessageInput` as-is. The overlay owns the repo/branch selection,
  submission orchestration, and submitting/error state; `MessageInput`
  owns the text, draft, attachments, autocomplete, and toolbar.
- `src/client/hooks/useQuickCaptureHotkey.ts` — global key listener that
  toggles the overlay. Conflict-detected against existing hotkeys at
  registration time.

**Client (modified):**

- `src/client/AppLayout.tsx` — mount the overlay; wire the hotkey hook.
  On mobile, `AppLayout` also passes quick-capture actions into the
  bottom `MobileTabBar`: Chat/Workspace stay grouped as active-session
  panel tabs, while Sessions, New Session, Quick Session, and Voice
  Quick Session live in a separated action cluster.
- `src/client/stores/ui-store.ts` — add `quickCaptureOpen: boolean` and
  setters.
- `src/client/stores/actions/session-actions.ts` — new action
  `createHeadlessSession` that posts to `POST /api/sessions/headless`,
  pushes the resulting session into the store, and does *not* navigate.
  The existing claim-session + navigate path stays untouched for the
  visible "New Session" button.
- `src/client/components/MessageInput.tsx` — add a `surface?: "chat" |
  "overlay"` prop (default `"chat"`); when `"overlay"`, skip the
  `prefillText` subscription, the `focusKey` auto-focus, and the
  `ContextDialMount` render. See "Overlay UI" for rationale.
- `src/client/hooks/useNotification.ts` — wrap `notify` to coalesce
  bursts of ≥2 calls within ~3s into a single "N sessions finished"
  notification. (The trigger path for non-attached sessions already
  works via `useAttentionNotifications`; only the coalescing is new,
  and it lives at the callback layer so every consumer of
  `useNotification` benefits.)
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
  parent assumption. Quota: per-installation cap (default 8
  in-flight, settable). Single cap because the orchestrator has no
  user-identity primitive today — see "Submission flow" for the
  rationale. Surfaces as 429 with a readable reason string in the
  error body.

**Server (modified):**

- `src/server/orchestrator/services/child-sessions.ts` — refactor
  `spawnChildSession` to delegate to the shared helper in
  `headless-sessions.ts`, retaining only the parent-specific concerns
  (parent quotas, `spawnedByTurn` accounting, base-branch defaults
  derived from the parent).
- `src/server/orchestrator/services/index.ts` — re-export the new
  service.
- `src/server/orchestrator/app-di.ts` — wire the headless-sessions
  service into route registration. **Concretely**, the service takes
  the same dependencies `spawnChildSession` already uses today
  (signature in `services/child-sessions.ts:133`): `SessionManager`,
  `SessionRunnerRegistry`, `createRepoGit` factory, `getBareCacheDir`
  resolver, `sessionsRoot` path, `githubAuthManager`, `claimService`,
  `RepoStore`, `defaultAgentId`, `credentialsDir`. No *new*
  dependencies; the wiring change is just surfacing the new service
  constructor on `ApiDeps` so the route handler can resolve it.

**Auth on the new route.** Today there is none — the orchestrator's
session-creation routes are not gated by any Fastify pre-handler
(`api-routes-session.ts` registers routes without an auth hook).
ShipIt's runtime model is one orchestrator per user, behind whatever
upstream auth the deployment puts in front of it (e.g. the VPS deploy
script's reverse proxy). `POST /api/sessions/headless` inherits the
same posture: no app-level auth, identical to `claim-session` and
`POST /api/sessions`. If app-level auth lands later as part of a
multi-tenant initiative, this route gets gated alongside the others
— there's nothing quick-capture-specific to design here.

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

**`sendSystemMessage` works on both fresh-create and reused-warm
runners.** The registry's `onRunnerCreated` callback
(`runner-registry-factory.ts:124`) calls `setSystemTurnDeps(...)`
exactly once when a runner is instantiated, and those deps persist
for the runner's lifetime. So whether `getOrCreate` returns a
freshly-created runner or one reused from a warm-pool slot, the
runner already has its `SystemTurnDeps` wired and `sendSystemMessage`
takes the `_runSystemTurn` path rather than the enqueue fallback at
`session-runner.ts:560–564`. A regression test for the reuse branch
is in Testing (see `headless-sessions.test.ts`) so this stays true
as the registry evolves.

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

## Key files

### Client (new)

- `src/client/components/QuickCaptureOverlay.tsx`
- `src/client/hooks/useQuickCaptureHotkey.ts`
- `src/client/components/QuickCaptureOverlay.test.tsx`
- `src/client/hooks/useQuickCaptureHotkey.test.ts`

### Client (modified)

- `src/client/AppLayout.tsx` — mount overlay, wire hotkey
- `src/client/components/MobileTabBar.tsx` — mobile bottom dock with
  grouped Chat/Workspace tabs plus a separated thumb-reachable cluster
  for Sessions, New Session, Quick Session, and Voice Quick Session
  actions.
- `src/client/stores/ui-store.ts` — `quickCaptureOpen` + setters
- `src/client/stores/actions/session-actions.ts` — new `createHeadlessSession` action; existing claim-session+navigate action untouched
- `src/client/components/MessageInput.tsx` — new `surface` prop (gates `prefillText` subscription, `focusKey` auto-focus, `ContextDialMount`)
- `src/client/hooks/useNotification.ts` — wrap `notify` in a coalescer that batches ≥2 calls within ~3s into a single "N sessions finished" notification. Coalescing lives at the `notify`-callback layer (not in `useAttentionNotifications`'s reason computation) so every future caller of `useNotification` benefits.
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

- **`QuickCaptureOverlay.test.tsx`** — overlay-specific concerns only:
  open/close behaviour, repo badge default + click-to-pick, error state
  rendering for the two named failure reasons (cap exceeded 429, no
  repo selected 400) plus a generic 500 surfacing as "Couldn't start
  a session — try again" with details available on demand, the
  "bootstrap not yet loaded" spinner state, that the overlay's
  `onSend` wiring posts to `POST /api/sessions/headless` and closes
  on success without navigating, and **focus arbitration on close**:
  opening the overlay while a chat input is focused with selection X,
  then closing the overlay, returns focus and selection X to the
  original input.
  Input-internal behaviour (Enter submits, Shift+Enter newline,
  `@`/`/` autocomplete, draft persistence, attachments) is already
  covered by `MessageInput.test.tsx`; do not re-test it here — the
  overlay test should verify it *renders* `<MessageInput />` with
  `surface="overlay"`, not duplicate its behavioural suite.
- **`MessageInput.test.tsx`** — extend to cover the new
  `surface="overlay"` prop: skipped `prefillText` subscription,
  skipped `focusKey` auto-focus, skipped `ContextDialMount` render.
  Default `surface="chat"` retains all existing behaviour (regression
  guard for the chat path).
- **`useQuickCaptureHotkey.test.ts`** — hotkey fires with modifier
  regardless of focus, settings rejects no-modifier hotkeys, cleanup on
  unmount.
- **`session-actions.test.ts`** — `createHeadlessSession` posts to the
  expected route, pushes the new session into the store, does *not*
  navigate.
- **`useAttentionNotifications.test.ts`** — extend to verify a
  newly-created headless session that the user is *not* viewing
  fires its first-turn-complete notification (the seed-then-transition
  flow described in "Quick-session indicators").
- **`useNotification.test.ts`** — coalescing logic: a single call
  uses the per-session title, ≥2 calls within ~3s coalesce into one
  "N sessions finished" notification with no per-session context.

Vitest (server):

- **`headless-sessions.test.ts`** — creates a session with a prompt,
  warm-pool runner is claimed, prompt is queued, agent starts, returns
  the new `SessionInfo`. Cover both runner branches: (a) **fresh
  create** — registry creates a new runner, `setSystemTurnDeps` fires
  via `onRunnerCreated`, `sendSystemMessage` takes the
  `_runSystemTurn` path. (b) **reused warm-pool runner** — a runner
  that already exists in the registry from a prior warm-up is
  returned by `getOrCreate`; its `SystemTurnDeps` persisted from the
  original `onRunnerCreated` call; the test asserts the prompt
  triggers `_runSystemTurn` rather than the enqueue fallback. The
  reuse branch is the one most likely to silently regress if registry
  internals change. Failure modes: invalid prompt, no repo, cap
  exceeded (assert specific 429 reason string), generic clone /
  container error (asserts the 500-with-message contract from the
  trimmed error list in "Submission flow").
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
- `notifyOnFinish` toast fires for a quick session whose tab the
  user has never opened.
- The per-installation cap surfaces a clear error when exceeded.

## Decisions (previously open questions)

1. **Focus arbitration: hotkey fires regardless of focus.** The default
   hotkey (see "Trigger") requires two modifiers, which disambiguates
   intent even when a textarea is focused. The settings UI rejects
   no-modifier (and single-modifier-without-Shift/Alt) hotkeys with a
   "modifier required" validation error rather than leaving
   focus-arbitration policy implicit.
2. **Sidebar surface for "just-created."** Brief pulse (~2 seconds) on
   the new sidebar entry to draw the eye, then settles into the normal
   "running" state. Reuses the existing pulse primitive.

## Open questions to settle during build

1. **Hotkey default cross-OS verification.** `Ctrl+Alt+N` /
   `Cmd+Opt+N` is the proposed default (rationale + known AltGr
   limitation in "Trigger"). Manual QA must confirm during
   implementation: no Chromium / Firefox / Safari menu shortcut, no
   macOS / Windows / GNOME / KDE WM binding shadows it. Done as part
   of "Manual QA" in the effort estimate, not deferred indefinitely.

(Two earlier entries — coalesce-toast threshold and per-install cap
default — were not actually open design questions but tunable
defaults. The narrative pins defaults of ~3s and 8 respectively and
surfaces both as settings entries so production can tune without a
redeploy; no pre-build decision is needed.)

## Effort estimate

| Step | Effort |
|---|---|
| Server: refactor `spawnChildSession` → `createHeadlessSession`, new HTTP route, tests | 2 days |
| Server: per-installation cap (single 429 reason) + tests | 0.5 day |
| Client: overlay component shell (markup, repo badge, error states) | 1 day |
| Client: `MessageInput` `surface` prop (skip prefill / focus / ContextDial when overlay) | 0.5 day |
| Client: global hotkey hook + browser-collision verification + settings UI | 0.5 day |
| Client: new `createHeadlessSession` action + store wiring | 0.5 day |
| Client: notification coalescing for bursty completions (the trigger itself is free — see "Quick-session indicators") | 0.5 day |
| Tests (component, hook, action, integration round-trip incl. server, focus arbitration, 429 surfacing) | 1.5 days |
| Manual QA + polish (cross-browser hotkey QA, terminology rename if any) | 1 day |

**Total: 8 days for v1.** The earlier draft estimated 3.5 days on the
false assumption that "create + start agent without attaching" was a
one-line client change. It isn't — the server-side spawn pattern exists
but is currently parent-scoped, and lifting it to a general-purpose
primitive plus the `MessageInput` surface-prop fix are the bulk of the
work. The notification-trigger adjustment we'd previously priced as a
full day shrinks to half a day (coalescing only) because
`useAttentionNotifications` already covers the trigger path for
non-attached sessions. Structuring error reasons for generic
container / clone / OOM failures is deliberately out of v1 (see
"Submission flow") so the effort table doesn't price it.
