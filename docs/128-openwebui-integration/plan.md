---
title: Integrate Open WebUI in place of the custom chat / session UI
---

# Open WebUI integration — rejected

## Decision

**Rejected.** Do not replace ShipIt's chat or session UI with [Open WebUI](https://docs.openwebui.com/).

This doc exists so the proposal isn't re-litigated. If someone raises "why don't we just use Open WebUI?" again, point them here first.

## The proposal

Adopt Open WebUI as the frontend surface for one of:
1. The chat / `MessageList` view.
2. The session sidebar and session management view.
3. Both.

The pitch is "there's a mature, community-maintained chat UI — why are we maintaining our own?"

## Why it's rejected

### 1. Open WebUI is the wrong shape of tool

Per its own docs, Open WebUI is a "self-hosted AI platform" — a provider-agnostic chat frontend for LLM APIs (Ollama, OpenAI-compatible). Its extension surface is:

- **Tools / Functions** — server-side Python the model can call.
- **Pipelines** — server-side filter/provider middleware.
- **OpenAPI servers** — auto-discovered tool endpoints.
- **Skills** — markdown instruction sets.
- **Prompts** — slash-command templates.

All of these are server-side or chat-shaped. The docs do not advertise a way for a plugin to own a client-side UI surface — no custom React panels, no sidebar widgets, no non-chat views. First-party features (RAG, Notes, Channels, Open Terminal, agents) are not extension points; they're built-in.

That single fact is fatal. ShipIt is mostly *not* chat.

### 2. The ShipIt client is ~15K lines and only a slice is chat

Snapshot at time of writing:

- 70 non-test component files, ~15.5K lines under `src/client/components/`.
- `AppLayout.tsx`, `FileTree`, `PreviewFrame`, `InteractiveTerminal`, `DiffPanel`, `PrLifecycleCard`, `ServicesPanel`, `SessionSidebar`, `GitHistory`, `RewindDropdown`, `RollbackDropdown`, `OnboardingWizard`, `MemoryPressureBanner`, `RebaseBanner`, `SessionDiagnosticsPanel`, etc.
- `MessageList.tsx` is 492 lines. `MessageInput.tsx` is 537. The chat itself is ~7% of the client.

Replacing the chat surface alone leaves the other 93% orphaned. Replacing the "session UI" (sidebar + everything around it) means replacing the entire IDE shell.

### 3. The WebSocket protocol is mostly not chat either

The server sends ~60 distinct WS message types (`src/server/shared/types/ws-server-messages.ts`). Categorized:

| Category                | Examples                                                                                                                                                | Open WebUI fit |
|-------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|----------------|
| Agent stream            | `agent_event`                                                                                                                                            | partial (schema mismatch) |
| Git                     | `git_log`, `git_committed`, `git_push_rejected`, `commit_linked`, `rollback_complete`, `rewind_complete`, `rebase_started/conflicts/complete/aborted`   | none           |
| Container / session     | `container_restarting`, `full_reset_complete`, `session_status`, `session_started`, `session_forked`, `session_agent_started/finished`, `install_*`     | none           |
| Compose / services      | `service_status`, `service_list`, `service_log`, `service_log_buffer`, `service_oom`, `compose_error`, `compose_not_configured`, `stack_error`          | none           |
| Preview                 | `preview_status`, `preview_error`                                                                                                                        | none           |
| Files                   | `file_tree`, `file_content`, `files_changed`, `turn_diff`                                                                                                | none           |
| Auth                    | `auth_required`, `auth_complete`, `codex_auth_*`, `git_identity_required/set`                                                                            | none           |
| Queue / model / agents  | `message_queued`, `queue_updated`, `agent_list`, `agent_interrupted`, `model_info`                                                                       | partial        |
| Docs / templates        | `doc_list`, `doc_content`, `template_applied`, `global_settings`                                                                                         | none           |

Roughly **1 of ~10 message categories** maps onto Open WebUI's chat model. The other 9 would have to be reimplemented as Pipelines + bespoke admin pages + forked-in client code — at which point "integrating Open WebUI" means forking it, and ShipIt loses the only thing that made it worth picking up.

### 4. The agent stream that *seems* to map doesn't

ShipIt's chat is not OpenAI-shaped `chat.completions` SSE. It's a stream of NDJSON events from Claude Code / Codex CLI, grouped by tool-result boundary into message bubbles by `ws-handlers/agent-listeners.ts`. Distinct render paths exist for:

- `agent_assistant` (text turns)
- `agent_tool_use` / `agent_tool_result` (per-tool rendering — `DiffBlock`, `InteractiveTerminal`, `TodoPanel`, `AskUserQuestion`, `PlanApproval`, `FileTree` highlight scroll)
- `agent_thinking`
- `agent_result` (post-turn summary, auto-commit, auto-push, PR card emission)
- Turn-event log buffering for reconnecting viewers
- `needsNewMessageGroup` flags for message-bubble grouping

Flattening this into OpenAI-shaped chat completions to fit Open WebUI's renderer drops the rich per-tool rendering, which is the entire value of the chat surface. We'd "adopt" Open WebUI and immediately regret it because every tool call would render as a flat code block.

### 5. The session model can't be retrofitted

A ShipIt session is not a chat thread. It is, simultaneously:

- A Docker container (`ContainerSessionRunner`).
- A git worktree (`RepoGit.createWorktree`).
- A Compose stack (`ServiceManager`).
- A preview proxy route (`preview-proxy.ts`).
- A terminal PTY (`session-worker.ts` + `InteractiveTerminal`).
- A file watcher (`file-watcher.ts`).
- An agent process (`ProxyAgentProcess`).
- A row in `SessionRunnerRegistry` with viewer reference counting, warm-pool warming, 60s idle grace, and OOM-resilient suspension.

The `SessionSidebar` (555 lines) renders status badges driven by all of that. Open WebUI's "sessions" are rows in `conversations`. There is no place in their data model for "this session's container is OOM-killed, here's the preview restart status, here's its branch's PR check state."

You cannot subclass your way out of that mismatch. Using Open WebUI as a chat-rendering library is the most you could hope for — and we already have a chat-rendering library that knows how to render our tool calls.

### 6. Violates product principles §1, §2, §5

From `CLAUDE.md`:

- **§1 — ShipIt is the surface.** Adopting Open WebUI means anything not in their model (PR card, deploy status, Monaco diff, Compose service list, preview iframe, terminal panel) gets dropped, gets jammed into a chat bubble, or gets a "View in admin" link-out. All three are explicit failures.
- **§2 — Inline beats link-out.** Open WebUI's overflow surfaces (admin pages, model picker config, RAG settings) push the user *out of the chat* into separate admin views. ShipIt is one surface; Open WebUI is many.
- **§5 — Chat is input, agent is actor.** Open WebUI ships shell-shaped affordances by default: prompt libraries, slash commands as user-facing menus, model pickers, RAG document uploaders, "Open Terminal" as a first-class user feature. Importing the UI imports the affordances, and §5 is explicit that those are a category mistake.

### 7. Auth and runtime mismatch

ShipIt uses the user's existing Anthropic / Codex subscription via the CLI's OAuth flow — no per-call API keys. Open WebUI's model is "point it at an inference endpoint." There is no first-class way to say "this UI talks to a CLI agent running in a Docker container that the orchestrator spawned for this session." Wiring this up means writing an adapter that pretends our agent stream is an OpenAI endpoint, which strips out every tool-use event we care about (see §4).

## What we'd build instead, if the underlying complaint is real

The reason someone reaches for Open WebUI is usually one of these specific gaps. Each is a small native change measured in hundreds of lines, not tens of thousands:

1. **Slash-command / prompt library.** Add a `MessageInput` prompt picker backed by markdown files in the repo. ~1 day.
2. **Better markdown / code rendering in chat bubbles.** `MessageList.tsx` + `message-highlighting.tsx`.
3. **Multi-model switching UX.** We already have `AgentPicker` / `ModelAgentSelector`; specific borrowed interactions are fine.
4. **Conversation search / history.** We have `SearchBar` and `AllSessionsDialog`; concrete gaps are easy to close.
5. **Notes / scratchpad alongside chat.** A native panel, not an imported platform.

## Cherry-picked ideas worth studying

Not enough to justify adopting the platform, but interesting in isolation:

- Open WebUI's slash-prompt UX.
- Their model-picker interaction patterns.
- Specific markdown / code rendering polish (line numbers, copy buttons, language tabs).

## If the decision changes

Reasons that could revisit this:

- Open WebUI ships a documented client-side plugin API that lets third-party plugins own non-chat UI surfaces.
- ShipIt pivots away from being an IDE and toward being a general chat client (we wouldn't be ShipIt anymore at that point).
- A maintained fork of Open WebUI emerges that's structured as "headless chat library" with first-class non-chat panel slots.

Absent one of those, this stays rejected.
