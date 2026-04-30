---
status: planned
---

# 108 — `@terminal` Composer Mention

## Summary

Add `@terminal` to the composer's autocomplete (which already supports `@file` mentions). Selecting `@terminal` attaches the visible terminal pane's recent output as context to the next agent turn, with optional line-range selection. Conductor v0.46.0 ships this and it removes the most common copy-paste flow from a debugging session.

## Motivation

When debugging a failed command, users currently:

1. Run a command in the terminal.
2. See the error.
3. Select the output with the mouse.
4. Copy.
5. Switch to chat.
6. Paste.
7. Type the question.

`@terminal` collapses this to typing `@terminal what's wrong with this?`. It's the local-machine equivalent of the existing log-attachment story for CI, but for ad-hoc terminal sessions.

## Design

### What gets attached

When the user selects `@terminal` from the composer autocomplete:

- Default: last 100 lines of the **active** terminal pane (the one currently visible / focused).
- Selected text: if the user has a selection in the terminal, attach exactly that.
- Range: typing `@terminal:50` attaches the last 50 lines.

The attached payload is wrapped in a fenced code block in the user's message:

```
@terminal output (terminal "main", last 100 lines):

```
$ npm test
FAIL src/foo.test.ts
  ...stack trace...
```
```

### Source

ShipIt's `terminal-buffer.ts` already buffers terminal output server-side. We add a method `getRecentLines(terminalId, count)` that returns clean (ANSI-stripped) text.

Multiple terminals: ShipIt supports more than one terminal pane. The composer needs to know which one is "active" — we track this in `terminal-store.ts` already (focused terminal). For users with multiple terminals, future versions can offer `@terminal/main`, `@terminal/test` namespaced mentions.

### Composer UX

`MessageInput.tsx` already has `@file` autocomplete (`useFileAutocomplete` or similar). Extend the autocomplete provider to include `@terminal` as a virtual entry at the top of the list when `@` is the trigger:

```
@terminal      Attach terminal output
@terminal:50   Attach last 50 lines
@src/foo.ts    Attach file
```

Selecting `@terminal` inserts the literal `@terminal` token in the message. On send:

1. Client resolves `@terminal` mentions: GET `/api/sessions/:id/terminal/:terminalId/recent?lines=N`.
2. Replaces the token with the fenced block before sending the user message.
3. Stores the original token in metadata so on chat reload, the message can be redacted to `@terminal (100 lines)` rather than re-rendering the whole block.

### Stripping

ANSI escape codes via `strip-ansi.ts`. Trim trailing whitespace. If the buffer contains the user's command at the top and the prompt at the bottom, keep both for context.

### Privacy

Terminal output can contain secrets (e.g. `aws login` echoing tokens). Add a one-time confirmation banner the first time `@terminal` is used in a session: "Terminal output may contain secrets. Continue?" with "Always allow for this session" / "Ask each time" options.

## Server pieces

- New endpoint: `GET /api/sessions/:id/terminal/:terminalId/recent?lines=N` — returns ANSI-stripped recent lines.
- Service: `services/terminal.ts` (new) — wraps the existing `terminal-buffer.ts` for HTTP consumers.
- The terminal buffer already exists; we just expose it.

## Client pieces

- Extend `MessageInput.tsx` autocomplete provider to surface `@terminal` entries.
- New util: `src/client/utils/resolve-mentions.ts` — turns `@terminal` and `@terminal:N` tokens into fenced blocks at send time.
- Update message rendering to collapse fenced terminal blocks past 50 lines under a "Terminal output (143 lines)" disclosure for readability.

## Tests

`integration_tests/terminal-mention.test.ts`:

1. Send a message containing `@terminal` → server sees the resolved fenced block in the user message.
2. `@terminal:25` returns exactly 25 lines.
3. ANSI codes stripped from attached output.
4. First-use confirmation gate: setting unmet → request rejected with 403.

Component tests for autocomplete entry rendering and selection.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/terminal-buffer.ts` | Add `getRecentLines` accessor |
| `src/server/orchestrator/services/terminal.ts` | New service wrapper |
| `src/server/orchestrator/api-routes-session.ts` | New `/terminal/:id/recent` route |
| `src/client/components/MessageInput.tsx` | Autocomplete extension |
| `src/client/utils/resolve-mentions.ts` | New util |
| `src/client/stores/settings-store.ts` | `terminalMentionConfirmed` flag |

## Future extensions

- **`@terminal/<name>`** — explicit terminal selection when multiple are open.
- **`@terminal:command N`** — attach the output of just the last N commands (parsed by detecting prompt lines).
- **`@logs/<service>`** — sibling mention for compose service logs, reusing the worker log stream.
