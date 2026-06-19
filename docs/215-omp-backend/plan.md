---
issue: https://linear.app/shipit-ai/issue/SHI-173
title: omp (Oh My Pi) as a third agent backend
description: Scoping what it would take to add the omp terminal coding agent as a ShipIt agent backend alongside Claude Code and Codex.
---

# omp (Oh My Pi) as a third agent backend

> **Status: exploratory scoping, not committed work.** This doc evaluates whether
> [omp](https://omp.sh) ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi))
> is worth adding as a third agent backend and, if so, what the adapter would
> entail. No code has been written.

## What omp is

omp is a **terminal-native AI coding agent** — a fork of Mario Zechner's *pi* by
Can Bölük, MIT-licensed. A ~55k-line Rust core (`pi-natives`, `pi-shell`,
`pi-ast`, `pi-iso` — in-process regex/ripgrep, embedded bash, AST, workspace
isolation) plus ~13 TypeScript packages for the TUI, LLM runtime, and tooling.

Relevant capabilities:

- **Multi-provider:** 40+ model providers with role-based routing
  (`default`/`smol`/`slow`/`plan`/`commit`), incl. Anthropic, OpenAI, Gemini,
  xAI, Mistral; coding plans (Cursor, Copilot); local runners (Ollama, vLLM,
  LM Studio, llama.cpp, LiteLLM).
- **IDE-grade tools:** LSP-driven renames (workspace/willRenameFiles), DAP
  debugging (lldb/dlv/debugpy), 32 built-in tools, subagents (the `task` tool)
  with schema-validated results + an IRC-style inter-agent bus.
- **Efficiency:** hashline (content-hash) edits instead of line numbers,
  time-traveling stream rules, hindsight memory (`retain`/`recall`) across
  sessions.
- **Entry points:** interactive CLI, **single-prompt mode**, **Node SDK**, and
  **RPC / ACP (Agent Client Protocol)** for editor embedding.

## Why this is a backend question, not a competitive threat

ShipIt and omp occupy **different layers**:

- **ShipIt** is the *surface* — a browser chat IDE with inline PRs, diffs,
  preview, CI, containers. Per product principle §1 the surface is the product,
  and §5 says ShipIt deliberately hides terminal-shaped affordances.
- **omp** is an *actor* — a terminal agent process. It competes head-to-head with
  Claude Code CLI and Codex CLI, the two backends ShipIt already wraps.

So omp is **not a competitor to ShipIt**; it is a candidate for the same slot the
Claude and Codex adapters fill today. ShipIt's architecture is explicitly
agent-agnostic for exactly this reason (`docs/155`).

## Integration shape

Adding a backend means implementing the established adapter surface (mirror the
`codex` adapter, which is the most recent precedent):

### Session-side — `src/server/session/agents/omp/`
- `adapter.ts` — implements `AgentProcess`: spawn the binary, stream a turn,
  steer/cancel, resume. **ACP/RPC is the integration seam** — prefer driving omp
  over its structured protocol or Node SDK rather than scraping the TUI.
- An event handler translating omp's event stream → ShipIt's canonical agent
  events (mirror `codex-event-handler.ts`).
- `tool-map.ts` — map omp's 32 tool names → the canonical tool-name slice that
  `tool-map.ts` (orchestrator) merges. omp's tool set (`read`/`write`/`edit`/
  `ast_edit`/`bash`/`eval`/`lsp`/`debug`/`browser`/`web_search`/`task`/…) is
  richer than either existing backend, so the canonical map grows.

### Orchestrator-side — `src/server/orchestrator/agents/omp/`
- `auth-manager.ts` — **the hard part** (see Open questions).
- `limits-provider.ts` — subscription/usage pills, if a notion of "plan limit"
  even applies (omp is BYO-key per provider).
- `run-params-prep.ts`, `system-prompt.md` + `system-prompt.ts`.

### Shared registry — `src/server/shared/agent-registry.ts`
- Add an `AGENT_DEFS` entry: `id: "omp"`, `binary: "omp"`, `capabilities`
  (models list, `supportsResume`, `supportsImages`, `skillsDirName`,
  `skillInvocationPrefix`, etc.).
- Add the `AgentId` union member in `shared/types/agent-types.ts`.
- Wire `isAuthConfigured` / `AUTH_ENV_KEYS` for omp's credential model.

### Container image — `docker/agent-cli/`
- Install the omp binary (Homebrew/curl/`bun install -g
  @oh-my-pi/pi-coding-agent`) so `which omp` succeeds inside the session
  container. Cross-platform native binary, no WSL bridge needed.

### Cross-agent surfaces that come "for free" but need verifying
- Skills auto-disclosure (`.claude/skills/` is read by both backends today,
  `docs/209`); confirm omp reads the same dir or add a mapping.
- Review bridge / chat-native review (`supportsReview`).
- `shipit agent run --agent omp` one-shot consultation path.

## Auth — concrete options

This is the load-bearing decision and the primary blocker, so it gets its own
section. ShipIt's premise is "use your existing subscription, **no per-call API
keys**," and the codebase has exactly **two** auth mechanisms today, both of
which omp could plug into:

- **(M1) Subscription brokering via an `AgentAuthManager`.** Claude uses OAuth
  (`AuthManager`); Codex uses RFC-8628 device flow (`CodexAuthManager` →
  `codex login --device-auth`, token persisted to `auth.json` on the
  `/credentials` volume so it survives container rebuilds). The registry's
  `isAuthConfigured` treats either an on-disk credential file **or** the
  agent's `AUTH_ENV_KEYS` env var as "configured."
- **(M2) BYO API key via the `set_agent_env` allowlist.** The `set_agent_env`
  WS message writes a key into `CredentialStore.agentEnv`, gated by
  `isAllowedAgentEnvKey` (literal `ALLOWED_ENV_KEYS` = `{OPENAI_API_KEY}` today,
  plus the `mcp__*` namespace). `app-di.ts` loads persisted `agentEnv` into
  `process.env` at startup; the adapter inherits it. Adding a provider key is a
  one-line edit to `ALLOWED_ENV_KEYS`.

The four ways to wire omp onto those, best to worst fit:

### Option A — Anthropic-only, ride the existing Claude OAuth (honors the promise)
Configure omp with **Anthropic as its sole provider** and feed it the OAuth
credential ShipIt already brokers (M1). No new auth surface, no API keys, no
product-promise violation.

- **Pro:** zero new auth code; the cleanest possible fit with §"no API keys."
- **Con:** suppresses omp's headline feature (40-provider routing) — at which
  point *"why not just use Claude Code?"* is a fair question. omp's
  differentiators (LSP/DAP, hashline edits, hindsight) would be the only reason
  to bother.
- **Gating unknown (must spike first):** does the omp binary accept Anthropic
  **subscription OAuth** credentials, or only `ANTHROPIC_API_KEY`? Claude Code
  reads OAuth tokens from its own credential file; a separate binary likely
  expects an API key. If omp can't consume the subscription token, Option A
  collapses into Option B for Anthropic. **This is the single most important
  thing to verify before any adapter work.**

### Option B — BYO multi-provider keys via `set_agent_env` (unlocks the USP, breaks the promise)
Add omp's provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, …) to `ALLOWED_ENV_KEYS`; the user pastes keys in settings,
they persist in `CredentialStore.agentEnv`, omp routes across them.

- **Pro:** minimal new code — the plumbing already exists (M2); unlocks omp's
  full multi-provider/role-routing value.
- **Con:** **directly violates the no-API-keys promise** — the user is back to
  managing raw provider keys, the exact friction ShipIt exists to remove.
  Category-mismatched with the product unless framed as a power-user escape
  hatch.

### Option C — Dedicated `OmpAuthManager` with per-provider device/OAuth flows
Mirror `CodexAuthManager` for each provider that supports a headless device
flow.

- **Pro:** keeps the subscription model across multiple providers.
- **Con:** most providers have **no** device flow; omp already owns provider
  auth via its own config; ShipIt would be reimplementing a flow per provider.
  High effort, low return. **Not recommended.**

### Option D — Hybrid: Anthropic OAuth by default, opt-in keys for routing (recommended)
Default omp to **Option A** (Anthropic subscription, promise intact) for the
happy path; let power users **opt in** to extra provider keys via **Option B**
(`set_agent_env`) to light up cross-provider routing. The default honors the
no-API-keys promise; the multi-provider USP becomes an explicit, advanced
opt-in rather than a requirement.

- **Pro:** best of both — clean default, full capability available without
  forcing keys on anyone; both mechanisms already exist.
- **Con:** two code paths to test; still depends on Option A's gating unknown
  (omp consuming the Anthropic OAuth token). If that spike fails, the "default"
  half degrades to "paste at least an Anthropic key," weakening the pitch.

**Recommendation: Option D, contingent on the Option-A spike.** Run the spike
(*can omp authenticate to Anthropic with ShipIt's brokered OAuth token, no API
key?*) first — its outcome decides whether D is viable as written or whether the
realistic floor is Option B with a clear "your keys, your spend" disclosure.

## Open questions / risks

1. **Auth-model mismatch — see "Auth — concrete options" above.** The gating
   spike (Option A: omp + Anthropic OAuth, no API key) blocks the rest of this
   decision.
2. **Maturity / maintenance risk.** omp is new (2025–26) and effectively a
   single-maintainer fork, vs. Anthropic-/OpenAI-backed CLIs. For a *supported*
   backend that's a real reliability and upkeep consideration.
3. **Feature overlap (mostly harmless).** omp's subagents/worktrees/plan-mode
   duplicate ShipIt's `Task` tool and session fan-out. Not conflicting — ShipIt
   would expose omp as a turn-level agent and treat its internals as a black
   box — but it means paying for capability ShipIt already provides.
4. **Event-stream fidelity.** Whether omp's ACP/RPC stream carries enough
   structure (tool start/result boundaries, assistant deltas, usage) to satisfy
   ShipIt's message-group invariants without TUI scraping. Needs a spike.

## Recommendation

Treat omp as a **watch-list backend, not near-term work.** The adapter itself is
medium effort (comparable to the Codex integration) *if* the auth story is
solved — but the auth-model mismatch and single-maintainer maturity mean it
should not jump ahead of hardening the two backends ShipIt already ships. The
clean takeaway is that ShipIt's agent-agnostic design (`docs/155`) means omp
*can* be added cheaply when there's concrete user demand and the credential
model is settled.

A sensible first step short of a full integration is **two spikes**, both behind
`shipit agent run --agent omp` against a BYO-key omp install:
1. **Auth (Option A gate):** can omp authenticate to Anthropic with ShipIt's
   brokered subscription OAuth token, with **no** `ANTHROPIC_API_KEY`? This
   decides whether the recommended Option D is viable or degrades to Option B.
2. **Event seam:** does omp's ACP/RPC stream carry enough structure (tool
   start/result boundaries, assistant deltas, usage) to satisfy ShipIt's
   message-group invariants without scraping the TUI?

Both must pass before committing to the full adapter + auth work.

## Key files (if this proceeds)

- `src/server/shared/agent-registry.ts` — `AGENT_DEFS`, capabilities, auth keys
- `src/server/shared/types/agent-types.ts` — `AgentId` union
- `src/server/session/agents/codex/*` — adapter precedent to mirror
- `src/server/orchestrator/agents/codex/*` — orchestrator-side precedent
- `docker/agent-cli/` — binary install
- `docs/155-agent-abstraction-hairs/plan.md` — the agent-agnostic abstraction
