---
status: planned
priority: medium
description: Agent-agnostic slash-command layer that classifies /compact, /diff, /review, and other backend commands and routes them to the correct ShipIt surface.
---

# 132 — Slash Commands

## Summary

Claude Code and Codex both expose a large set of `/`-prefixed commands in
their interactive REPLs (`/goal`, `/compact`, `/diff`, `/model`, …). ShipIt
runs these agents *non-interactively* (`claude -p`, `codex exec`), so the
REPL-only commands have nowhere to land today — a user who types `/goal …`
in the composer just sends the literal text to the agent as a prompt.

This doc defines how ShipIt exposes slash commands: a small **agent-agnostic
command layer** that classifies every backend command into one of five
buckets and routes it to the right ShipIt surface — never to an upstream
tab, never as a shell-shaped button row (§5).

## Motivation

- **Discoverability.** Users have muscle memory for `/diff`, `/compact`,
  `/review`. Typing them should do the obvious thing, not produce a
  confused agent turn.
- **Agent-agnostic.** Claude and Codex have heavily overlapping command
  sets (`/goal`, `/init`, `/compact`, `/diff`, `/review`, `/plan`,
  `/model`, `/status`, `/resume`, `/new`, `/clear`, `/permissions`,
  `/mcp`, `/fast`, `/copy`, `/feedback`, `/logout`, `/fork`, `/stop`).
  ShipIt should expose one normalized set, mapped per-backend — the same
  pattern as `tool-map.ts` for tool names.
- **`/goal` specifically.** Both backends ship a `/goal` (Codex marks it
  experimental: "set or view a goal for a long-running task"; Claude:
  "Claude keeps working across turns until the condition is met"). It is
  a *stateful, cross-turn* concept that neither `-p` nor `codex exec`
  models — it needs a native ShipIt feature.

## Key fact: built-ins are CLI process-state, not prompts

Claude's docs are explicit: bundled **skills** are "a prompt handed to
Claude"; everything else is "a built-in command whose behavior is coded
into the CLI." Built-ins mutate the interactive process — they do not
flow through `-p` / `codex exec`. So the strategy is **not** "pass them
through." It is: classify each command by what it maps onto in ShipIt's
architecture.

Exception worth noting: Claude's `/init`, `/review`, `/security-review`
*are* reachable by the agent via the Skill tool, so they do work through
`-p`. That gives a cheap interim path before native UI exists.

## The five buckets

| Bucket | ShipIt behavior | Rationale |
|---|---|---|
| **1. ShipIt already owns the surface** | Intercept the `/command` client-side, route to the existing ShipIt feature. ShipIt's native version is canonical; the slash command is an alias. | §1/§2 — already inline |
| **2. Maps to a spawn arg / session setting** | Expose as a session setting *and* accept the command as a shortcut that sets it. Implemented in the agent adapters' spawn args. | Per-turn CLI flags translate cleanly |
| **3. Bundled skills (Claude only)** | Skill invocation via `/skill-name`. **Carved out into doc 138** — the prompt must reach the CLI with the slash token at index 0, and `Skill` must be allowlisted; neither holds today. | Same mechanism as custom skills |
| **4. Stateful agent-behavior ShipIt doesn't model yet** | Build a native feature: persist on session metadata, inject into agent context each turn. | The real product work — `/goal` |
| **5. Drop** | Not exposed. CLI-environment-specific, provider-cloud-specific, or conflicts with ShipIt's identity. | No meaning in a chat-shaped IDE |

## Command classification

### Claude Code (~70 built-ins + 5 bundled skills)

- **Bucket 1 — ShipIt owns it:** `/diff` (Monaco diff panel) · `/review`
  `/security-review` (doc 125) · `/rewind` `/checkpoint` `/undo` (git
  rollback) · `/usage` `/cost` `/stats` (`UsageManager`) · `/resume`
  `/continue` `/clear` `/new` `/reset` `/branch` `/fork` (session list /
  branching) · `/rename` (`session-namer.ts`) · `/config` `/settings`
  `/theme` `/status` (settings store) · `/memory` `/init` (CLAUDE.md
  editing) · `/login` `/logout` `/install-github-app` `/web-setup`
  (ShipIt auth) · `/agents` `/mcp` `/hooks` `/permissions` `/skills`
  `/plugin` (config-file editors)
- **Bucket 2 — spawn arg / session setting:** `/model` · `/effort` ·
  `/plan` (`--permission-mode plan`) · `/fast` · `/sandbox` · `/add-dir`
  (mostly N/A — ShipIt controls the workspace)
- **Bucket 3 — skill invocation via `/skill-name` (see doc 138):** `/loop` ·
  `/batch` · `/simplify` · `/debug` · `/claude-api` ·
  `/fewer-permission-prompts` · `/btw`, plus any custom/project skill
- **Bucket 4 — needs native feature:** `/goal` · `/compact` `/context`
  (partly `ContextDial`, but the compaction *action* needs a native
  trigger) · `/recap` `/insights` `/export`
- **Bucket 5 — drop:**
  - CLI-environment UX: `/vim` `/tui` `/focus` `/scroll-speed`
    `/keybindings` `/color` `/statusline` `/terminal-setup` `/exit`
    `/quit` `/copy`
  - Other-surface launchers: `/ide` `/desktop` `/app` `/mobile`
    `/chrome` `/install-slack-app` `/voice`
  - CLI-install diagnostics: `/doctor` `/heapdump` `/reload-plugins`
  - Provider auth ShipIt doesn't use: `/setup-bedrock` `/setup-vertex`
    `/extra-usage` `/privacy-settings` `/upgrade`
  - Novelty: `/radio` `/stickers` `/passes` `/powerup` `/release-notes`
  - **Conflicts with ShipIt's identity:** `/background`
    `/remote-control` `/remote-env` `/teleport` `/autofix-pr`
    `/ultraplan` `/ultrareview` `/schedule` `/stop`. These are
    Anthropic-cloud / "Claude Code on the web" features — exposing them
    pushes the user out of ShipIt onto claude.ai (direct §1 violation).
    Where the underlying need is real (`/autofix-pr` ≈ CI auto-fix,
    `/schedule` ≈ recurring agent) ShipIt should build its own inline
    version, tracked as separate docs.

### Codex CLI (~33 commands)

Codex has no bundled-skill equivalent (custom prompts live in
`.codex/prompts/`), so there is no Bucket 3 for Codex.

- **Bucket 1 — ShipIt owns it:** `/diff` · `/review` · `/clear` `/new`
  `/resume` `/fork` · `/status` · `/permissions` · `/mcp` · `/logout` ·
  `/init` (AGENTS.md)
- **Bucket 2 — spawn arg / session setting:** `/model` · `/fast` ·
  `/plan` · `/personality` · `/sandbox-add-read-dir` (N/A) ·
  `/experimental`
- **Bucket 4 — needs native feature:** `/goal` · `/compact` · `/copy`
  `/feedback`
- **Bucket 5 — drop:** `/exit` `/quit` · `/statusline` `/title`
  `/keymap` `/debug-config` (CLI-environment UX/diagnostics) · `/agent`
  `/ps` `/stop` `/side` (background-terminal / thread mechanics with no
  ShipIt analog) · `/apps` `/plugins` `/mention` (`@`-autocomplete
  already covers `/mention`)

### Cross-backend normalized set

The commands worth a first-class ShipIt identity (present and meaningful
on **both** backends): `/goal`, `/compact`, `/diff`, `/review`, `/model`,
`/plan`, `/init`, `/clear` `/new` `/resume` `/fork`, `/status`,
`/permissions`. The command layer resolves each to a backend-specific
handler (or native ShipIt action) via an `AgentCapabilities`-style map.

## Design

### Agent-agnostic command registry

A new shared registry — sibling to `agent-registry.ts` / `tool-map.ts` —
maps a normalized command name to:
- the bucket,
- a handler (native ShipIt action, spawn-arg mutation, or pass-through),
- per-backend availability (so the `/` menu only lists what the active
  agent supports).

`AgentCapabilities` gains the available command set, the way doc 125
added `supportsReview`.

### Composer `/` autocomplete

Mirror the existing `@` file-autocomplete in `MessageInput.tsx` /
`message-editor.tsx`: typing `/` at the **start** of the composer opens a
menu listing available commands (Bucket 3 skills + recognized commands),
filtered as the user types. This is the right surface — it is typed in
chat, not a button row, so it satisfies §5.

### Interception in `send-message.ts`

Before `runAgentWithMessage`:
- Bucket 1 → emit a client action / route to the existing feature, do
  not start an agent turn.
- Bucket 2 → apply the session-setting change, optionally continue with
  the remaining text as a prompt.
- Bucket 3 → skill invocation, handled in doc 138 (preserve the leading
  `/`, allowlist `Skill`); pass the text through unchanged otherwise.
- Bucket 4 → route to the native feature handler.
- Unrecognized `/foo` → warn in the composer instead of sending a
  literal prompt to the agent.

### `/goal` as a native feature

The one genuinely new capability:
- Stored on session metadata (`sessions.ts`).
- Injected into the agent's context each turn via
  `agent-instructions.ts` — survives reconnects, session switches, and
  the turn-capture model in a way a REPL `/goal` never could.
- Rendered inline in the chat surface (a goal banner / card), with
  `/goal clear` to remove it.
- Backend-agnostic: it is a ShipIt construct, not a proxy of either
  CLI's `/goal`.

## Build order

1. Skill invocation + `/` autocomplete — **see doc 138** (the Bucket 3
   slice). Discoverability, ships fast, low risk; the autocomplete surface
   it builds is shared by the recognized commands below.
2. Agent-agnostic command registry + `AgentCapabilities` wiring.
3. Bucket 1 interception in `send-message.ts` — recognized commands
   route to existing UI; unrecognized `/foo` warns.
4. Bucket 2 — fold `/model`, `/plan`, effort/fast into session settings.
5. `/goal` native feature.

## Key files

- `src/client/components/MessageInput.tsx`, `message-editor.tsx` — `/`
  autocomplete (reuse the `@` machinery)
- `src/server/orchestrator/ws-handlers/send-message.ts` — interception
- `src/server/shared/agent-registry.ts`, `agents/tool-map.ts` — pattern
  reference for the new command registry
- `src/server/shared/types/agent-types.ts` — `AgentCapabilities`
- `src/server/orchestrator/agent-instructions.ts` — `/goal` context
  injection
- `src/server/orchestrator/sessions.ts` — `/goal` persistence
- `docs/125-chat-native-ai-review/plan.md` — precedent for capability
  gating and chat-native command flow

## Open questions

- Should Bucket 2 commands (`/model`, `/plan`) also be reachable from a
  settings panel, or only via the slash command? (Leaning: both — the
  command is the shortcut, the panel is the discoverable home.)
- `/compact` — does ShipIt trigger the CLI's own compaction (if the
  adapter exposes a way) or implement its own context summarization?
  Needs an adapter-capability investigation.
- `/goal` rendering: dedicated banner vs. reuse the scratchpad surface
  (`docs/106-session-scratchpad`)?
