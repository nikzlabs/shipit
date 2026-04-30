---
status: planned
---

# 100 — Custom Quick Actions

## Summary

Let users define **named shell commands** ("actions") on a per-repo basis, declared in `shipit.yaml` and surfaced as a button row in the chat input toolbar. Optional features: a keyboard shortcut per action, and an `autoRun` flag that runs the action once when a new session/worktree is first activated.

This is directly inspired by T3 Code's "Custom Quick Actions" — project-scoped buttons like `npm run dev`, `npm test`, `npx prisma studio` that users wire up to their flow. T3 Code also auto-runs flagged actions on worktree creation (`npm install`).

## Motivation

ShipIt has a terminal panel and the agent can run `npm install` itself, but there's no first-class way for a *user* to bind a frequently-used command to a one-click button. Today the user has three options, all worse than a single button:

1. Open the terminal, type the command, hit enter.
2. Ask the agent in chat: "run `npm test`" — costs an LLM turn.
3. Edit a docker-compose service to run it as a long-lived process — only fits dev servers.

A button row in the input toolbar would make repeated commands (test, lint, regenerate types, open Prisma Studio, run a migration) one click. And `autoRun: true` means a fresh session that needs `npm install` doesn't have to wait for the agent to figure that out — it just runs the moment the container is up.

## Design

### shipit.yaml schema

Extend `ShipitConfig` (`src/server/shared/shipit-config.ts`) with a new optional top-level `actions` block:

```yaml
version: 1
agent:
  install:
    - npm install
actions:
  - name: Test
    command: npm test
    shortcut: cmd+shift+t      # optional, parsed loosely (cmd|ctrl|alt|shift + key)
    autoRun: false             # optional, default false
  - name: Lint
    command: npm run lint
    shortcut: cmd+shift+l
  - name: Regenerate types
    command: npx prisma generate
  - name: First-time setup
    command: npm install && npm run db:migrate
    autoRun: true              # runs once when the session is first activated
```

Add to `KNOWN_TOP_LEVEL_KEYS`. Add a parser for the array form with strict validation:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | 1–32 chars, used as button label and in WS messages |
| `command` | string | yes | 1–4096 chars, treated as a shell line (run via `/bin/sh -c`) |
| `shortcut` | string | no | parsed as modifiers + key; ignored on the server, validated client-side |
| `autoRun` | boolean | no | default false |

Validation errors should NOT throw — they should populate `ShipitConfig.warnings` so a typo doesn't break session start. Unknown action keys → warning.

### Server: where actions execute

Actions run inside the **agent container** (the same place the agent's bash tool runs), reusing the existing terminal infrastructure rather than creating a parallel runtime. There are two natural integration points:

**Option A — write to the existing terminal PTY** (`TerminalProcess.write()` in `src/server/session/terminal.ts`).
- Pro: zero new infra; output flows through the same SSE channel; user sees it in the terminal panel.
- Con: races with whatever the user is currently typing into the terminal.

**Option B — new `worker-http` endpoint `POST /actions/run`** that spawns a one-shot `/bin/sh -c <cmd>` and streams output as a dedicated SSE event type.
- Pro: clean isolation; can capture exit code; can render output in a dedicated panel/toast.
- Con: more code.

**Recommendation: Option B**, but pipe the output into the same terminal panel as a clearly-labeled block (`▶ Running action: Test\n…\n✓ Test exited 0`). Implementation sketch:

- New route in `session-worker.ts`: `POST /actions/run` with body `{ name, command }`.
- Spawns `child_process.spawn("/bin/sh", ["-c", command], { cwd: WORKSPACE })`.
- Streams stdout/stderr as `action_output` SSE events.
- Emits `action_started` / `action_finished` (with exit code) events.
- Cap concurrency: refuse to start a second action with the same `name` while one is running. Allow different actions in parallel.
- Hard timeout: 10 minutes (configurable via `actions[].timeoutSec` later).

Orchestrator side: add `worker-http.ts` wrapper `runAction(sessionId, name, command)`; expose as a WS handler `run_action` (handler reads the action by name from the parsed `ShipitConfig` — the **client never sends the raw command**, only the name. This prevents arbitrary-command injection from a compromised browser session).

### Client: button row

Place actions in a horizontal scroll row immediately above the chat input in `MessageInput.tsx`:

```
┌───────────────────────────────────────────────────────────┐
│ [▶ Test] [▶ Lint] [▶ Regenerate types]    ⌥ shortcuts on │
│ ─────────────────────────────────────────────────────────│
│ Type a message…                                  [Send]  │
└───────────────────────────────────────────────────────────┘
```

- Each button: `name` + a small ▶ icon (Phosphor `Play` at `ICON_SIZE.XS`). Disabled while that action is running; spinner replaces ▶.
- Hovering shows the full command in a tooltip.
- A subtle indicator on the right shows whether keyboard shortcuts are armed (focus must be in the action bar or the global shortcut handler picks it up — see below).
- Hidden entirely if `actions` is empty in shipit.yaml.

State lives in a new `actions-store.ts` (Zustand): `{ definitions: ActionDef[], runningByName: Set<string> }`. Updated by the dispatcher in `useMessageHandler` on `action_started` / `action_finished` events.

### Client: keyboard shortcuts

Parse `shortcut: "cmd+shift+t"` into `{ meta: true, shift: true, key: "t" }` (Mac uses `cmd`/`meta`, others use `ctrl`). Register a global `keydown` listener in `AppLayout.tsx` that:

- Only fires when no input/textarea has focus, OR when focus is in the action bar.
- Looks up the matching action and dispatches `run_action`.
- Conflicts with system shortcuts (cmd+t opens new tab) are the user's responsibility — we just match what they wrote, no automatic remapping.

### Auto-run

Actions with `autoRun: true` fire **once per session**, on first activation, after the container is healthy and before the agent starts. Tracked via a `firstActivationCompleted: boolean` field on `SessionMetadata` (persists across restarts so we don't re-run on every reattach).

Exact lifecycle:
1. Session activated (cold start).
2. Container becomes healthy.
3. Orchestrator reads `ShipitConfig.actions`, fires each `autoRun` action sequentially (not parallel — `npm install` followed by `db:migrate` likely depends on order, and the YAML order is the user's expressed order).
4. After all complete (or first failure), set `firstActivationCompleted = true` and save.
5. Output streams to the terminal panel as a labeled block, same as a manual run.

Failure handling: if an autoRun action exits non-zero, mark `firstActivationCompleted = true` anyway (don't retry on every reattach), and surface a toast "Action 'First-time setup' failed (exit 1) — see terminal for details."

### shipit-docs update

Add `src/server/shipit-docs/actions.md` documenting the schema, with examples. Cross-link from `shipit-yaml.md`.

## Why not just put commands in the terminal?

Three reasons we want this even though the agent has bash:

1. **No LLM round-trip.** Asking the agent "run npm test" costs a turn ($, latency). One-click does not.
2. **Repeatability.** `shipit.yaml` is checked in, so a new collaborator cloning the repo gets the same buttons.
3. **autoRun.** "Set up the new worktree" is a recurring papercut that this fixes structurally.

## Tests

### Server

- `shipit-config.test.ts` — `actions` block parsed correctly; bad fields produce warnings, not throws; unknown keys warned.
- New integration test `custom-actions.test.ts` (`src/server/orchestrator/integration_tests/`):
  1. **Run-by-name** — send `run_action {name: "Test"}` → server resolves the command from parsed config (NOT from the WS payload) → spawns shell → emits `action_started`/`action_finished` with exit 0.
  2. **Unknown action name** — server replies with an error event, no shell spawn.
  3. **Concurrency** — sending the same `run_action` twice in a row → second is rejected while first is running.
  4. **autoRun on first activation** — session with two `autoRun` actions activates → both run in YAML order → `firstActivationCompleted=true` persisted.
  5. **autoRun does not re-run on reattach** — restart session worker → no autoRun fires.

### Client

- `MessageInput.test.tsx` — action bar renders one button per definition; clicking a button dispatches `run_action`; while running, button is disabled and shows spinner.
- New `useActionShortcuts.test.ts` — pressing the bound shortcut fires the action; pressing it while focused in the textarea does not.

## Key files

| File | Change |
|---|---|
| `src/server/shared/shipit-config.ts` | Add `actions` block parsing + validation; add `KNOWN_TOP_LEVEL_KEYS` entry |
| `src/server/shared/shipit-config.test.ts` | Coverage for the new block |
| `src/server/session/session-worker.ts` | New `POST /actions/run` route + SSE emission |
| `src/server/orchestrator/worker-http.ts` | `runAction()` wrapper |
| `src/server/orchestrator/ws-handlers/misc-handlers.ts` | New `run_action` handler (reads command by name from config) |
| `src/server/orchestrator/sessions.ts` | Add `firstActivationCompleted` to `SessionMetadata` |
| `src/server/orchestrator/container-lifecycle.ts` | Fire autoRun actions after container health passes |
| `src/server/shared/types/ws-client-messages.ts` | Add `WsRunAction` |
| `src/server/shared/types/ws-server-messages.ts` | Add `WsActionStarted`, `WsActionOutput`, `WsActionFinished` |
| `src/client/stores/actions-store.ts` | New Zustand store |
| `src/client/components/MessageInput.tsx` | Render action bar above input |
| `src/client/components/ActionBar.tsx` | New component |
| `src/client/hooks/useActionShortcuts.ts` | New hook for keyboard shortcuts |
| `src/client/hooks/useMessageHandler.ts` | Dispatch action_* events into actions-store |
| `src/server/shipit-docs/actions.md` | New agent-facing doc |
| `src/server/shipit-docs/shipit-yaml.md` | Cross-link to actions.md |

## Out of scope

- **Per-action env vars** — could be added as `env: { KEY: VALUE }` later. For now, actions inherit the agent container env.
- **Action chaining / dependencies** — users can chain with `&&` in the command itself. No need for declarative deps.
- **Cron / interval actions** — see `schedule` skill for the agent-driven equivalent. This feature is for *manual* triggers + first-activation auto-run.
- **Showing action output in a dedicated panel** — for v1, output goes to the existing terminal panel as a labeled block. A dedicated panel can come later if users complain.
- **Rich output (diff render, table render)** — actions are plain shell. Out of scope.
