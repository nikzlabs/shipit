---
status: planned
priority: medium
description: Detect compose service crashes and setup script failures post-turn, surface logs inline, and optionally trigger an agent fix turn automatically.
---

# 107 — Auto-Fix for Preview & Setup Script Failures

## Summary

Extend the existing CI auto-fix loop (`github-ci-fix.ts`) to cover preview-side failures: docker-compose service crashes, setup script errors, and dev-server boot failures. When a service in the user's stack fails to start or crashes after a turn, ShipIt surfaces the failure inline (logs visible without leaving ShipIt, per CLAUDE.md §1) and — if the user has opted in — automatically triggers an agent turn that feeds the cleaned logs to Claude. Conductor v0.45.0 calls this "Quick Fix Failed Setup."

## Motivation

ShipIt has a rich preview system (`ServiceManager`, compose stacks, file watcher, lockfile-debounced restarts) but when a service fails to come up, the user is on their own. They have to:

1. Notice the preview pane is broken.
2. Fetch logs (`/api/sessions/:id/services/:name/logs`).
3. Paste them into chat.
4. Ask Claude to fix.

Steps 2 and 3 are the entire reason `services/github-ci-fix.ts` exists for CI failures — they're the same shape of problem, just for local services. We already have all the plumbing.

This is also a textbook application of CLAUDE.md §1: today, "fetch the logs" implicitly means the user runs `docker compose logs` in the terminal panel, then copy-pastes. Surfacing the logs inline removes that detour, and the auto-fix loop closes the cycle without a button-row that runs commands (§5).

## Design

### What counts as a "preview failure"

`ServiceManager` exposes container state. The auto-fix trigger fires when:

1. A container that was up after the previous turn has exited or restarted with a non-zero status.
2. A new service was introduced this turn (e.g. compose file edited) and never reached `running` after 30s.
3. A setup script (`shipit.yaml`'s `agent.install` or compose `command`) exited non-zero.

### Detection point

Hook into the existing post-turn flow (`post-turn.ts`). After auto-commit but before auto-push, run a "preview health check":

1. List services and their statuses (already an HTTP endpoint).
2. For any service in `failed` / `restarting` / `exited(non-zero)`, fetch the last 200 log lines.
3. If any failures, emit a new WS message `preview_fix_available { sessionId, services: [{ name, lastError, logsRef }] }`.

### UI

A new lifecycle card sibling to `PrLifecycleCard` — `PreviewHealthCard.tsx` — appears above the message list when failures are detected. Phases:

- `unhealthy` — shows the failed service(s) and renders the cleaned log tail in a Monaco read-only viewer (collapsed by default). **No "Fix it now" button** — the manual path is to type a message in the composer (e.g. "the web service is crashing, please fix"), which the chat already handles. The card surfaces the data inline (§1, §2); the chat is the input surface (§5).
- `fixing` — pulse state while the auto-triggered fix turn runs.
- `recovered` — green pill, auto-dismisses after 10s.

Mirrors the auto-fix CI card visually so users learn the pattern once.

### The fix loop

Largely mirrors `github-ci-fix.ts`:

1. Fetch logs via the worker SSE log stream (already implemented).
2. Strip noise: docker compose framing lines (`web_1  | `), color codes (`strip-ansi.ts`), repeated stack frames.
3. Build the prompt: `"The {serviceName} service failed to start. Here are the last 200 log lines:\n\n{logs}\n\nPlease investigate and fix."` plus the file paths likely involved (cross-reference any files the service's `build:` context touches).
4. Trigger a new agent turn with this prompt — same path as the CI auto-fix uses (`triggerCIFix` analog).

### How fixes get triggered

Two paths only — no button-row:

1. **Auto** — `previewAutoFix` toggle in the card's overflow menu (analogous to `autoFix` for CI). When on, the post-turn detector runs the fix loop above. Default OFF because preview failures are noisier than CI ones (a misconfigured port can spam the loop).
2. **Manual** — the user reads the inline log tail and types a message in the composer. The composer is already the input surface; a quick-action button would be the prohibited shell-shaped affordance (§5: "Recurring user-driven task → Ask the agent in chat").

### Avoiding the loop

Same protections as CI auto-fix:

- Counter `previewAutoFixAttempts` per service per session, max 3. After 3, the card shows "Auto-fix exhausted — please intervene" and stops.
- Counter resets when the service successfully reaches `running` for >60s.
- A turn whose only outcome is more failures of the same service does not retrigger.

## Server pieces

- New service: `src/server/orchestrator/services/preview-fix.ts`:
  - `detectFailures(sessionId): PreviewFailure[]`
  - `triggerPreviewFix(sessionId, serviceName)`
- `service-manager.ts`: emit `service_health_changed` events when a container transitions to a failed state.
- Hook into `post-turn.ts`: call `detectFailures` after auto-commit.
- Reuse `services/github-ci-fix.ts`'s log-cleaning helpers — extract them into `services/log-cleanup.ts`.

## Client pieces

- New component: `src/client/components/PreviewHealthCard.tsx`.
- New store slice in `preview-store.ts`: `failures: Record<sessionId, PreviewFailure[]>`.
- Mount above `MessageList` alongside `PrLifecycleCard`.

## Tests

`integration_tests/preview-auto-fix.test.ts`:

1. Service exits non-zero post-turn → `preview_fix_available` emitted with cleaned logs.
2. `previewAutoFix=true` → fix triggers automatically with constructed prompt.
3. `previewAutoFix=false` → no agent turn triggered; card renders logs only.
4. After 3 failed attempts → card shows exhausted state, no further triggers.
5. Service recovers → counter resets.
6. User-typed prompt referencing the failure → existing chat path handles it; no preview-fix-specific endpoint is involved.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/services/preview-fix.ts` | New service |
| `src/server/orchestrator/services/log-cleanup.ts` | Extracted from `github-ci-fix.ts` |
| `src/server/orchestrator/service-manager.ts` | Emit health change events |
| `src/server/orchestrator/ws-handlers/post-turn.ts` | Call `detectFailures` |
| `src/shared/types/ws-server-messages.ts` | `preview_fix_available`, `service_health_changed` |
| `src/client/components/PreviewHealthCard.tsx` | New card |
| `src/client/stores/preview-store.ts` | Failure state |
| `src/client/stores/settings-store.ts` | `previewAutoFix` setting |

## Future extensions

- **Cross-fix CI + preview** — when both fail in the same turn, batch them into one auto-fix prompt.
- **Failure pattern library** — track common errors (port-in-use, missing dep, syntax error) and short-circuit known fixes without an LLM call.
- **Preview restart QoL** — also auto-fix preview after `npm install` failures, captured separately by the compose log stream.
