---
status: done
---

# 116 — Fake `gh` CLI Shim for Agent-Driven PR Creation

## Summary

Ship a small, sandboxed `gh` shim inside session worker containers that exposes only a curated PR-related subset of the real GitHub CLI. The agent uses it like `gh pr create …` from its bash tool; under the hood, the shim brokers the call through the session worker to the orchestrator, which mutates GitHub via the user's Octokit-authenticated `GitHubAuthManager`. The agent never sees the token, never reaches arbitrary GitHub APIs, and cannot escalate to repo/release/workflow surfaces.

The current harness-side auto-create flow (`quickCreatePr` → `generatePrDescriptionFromContext` → `generateText`) stays in place as a backstop. Because the orchestrator path already deduplicates against existing PRs, the two paths compose cleanly.

## Motivation

§5 of `CLAUDE.md` ("chat is the input surface; the agent is the actor") is in tension with how PR creation works today:

1. The harness extracts conversation context, builds a synthetic prompt, and calls a side-channel LLM via `generateText` to produce a PR description.
2. In production, `generateText` is a no-op (`app-di.ts:228-253` — `agentFactory` is `undefined` in production, so it returns `""`). **All auto-created PRs ship with empty bodies today.** This is a real, observable bug.
3. Even when `generateText` works (in tests), it operates on an extracted excerpt of the conversation, not the agent's live context — strictly less information than the agent already has.

The cleanest fix is to make the agent the actor: when it has finished a meaningful chunk of work, it runs `gh pr create` itself with a title and body it composes from full live context. The harness only fires its fallback if the agent didn't.

We deliberately do **not** install the real `gh`. Doing so would expose `gh api`, `gh repo create/delete`, `gh workflow run`, `gh release`, `gh secret set`, `gh ssh-key`, etc. — a large mutation surface backed by the user's GitHub token, reachable from any process the agent spawns. A purpose-built shim with a narrow allowlist eliminates that risk.

## Non-goals

- **Not** a general-purpose `gh` replacement. We do not aim to pass `gh`'s test suite.
- **Not** a wrapper around the real `gh`. The shim does not call out to GitHub directly; it always brokers through the orchestrator.
- **Not** a permanent allowlist. If a future feature legitimately needs another subcommand, we add it explicitly.
- **Not** a replacement for the orchestrator's PR routes. Those still serve the UI.

## Design

### Architecture

```
agent bash tool
   │
   │ gh pr create -t "..." -b "..."
   ▼
[/usr/local/bin/gh]  ← shim (Node script, ~200 lines)
   │
   │ POST http://localhost:9100/agent-ops/pr/create
   ▼
[session-worker.ts]  ← new /agent-ops/* router
   │
   │ POST http://orchestrator:3000/api/sessions/{id}/pr/quick
   │ (or /pr, /pr/edit — see route table)
   ▼
[api-routes-github.ts]
   │
   │ services/github.ts → GitHubAuthManager → Octokit
   ▼
GitHub
```

Three layers:

1. **Shim** (`/usr/local/bin/gh`, baked into the session worker image). Parses `gh <command> <subcommand> <args>`, validates against the allowlist, POSTs JSON to a localhost worker endpoint, prints the response in `gh`-compatible format on stdout.
2. **Worker broker** (`/agent-ops/*` routes in `session-worker.ts`). Receives requests from the shim, talks to the orchestrator over the existing Docker network. The worker's session ID is implicit — the agent never has to specify it.
3. **Orchestrator endpoints**. Mostly reuse existing routes (`POST /api/sessions/:id/pr/quick`, etc.); add new ones only where needed (`PATCH .../pr/{number}` for edits, `POST .../pr/{number}/comment`, etc.).

### Why the worker broker (not direct shim → orchestrator)

The shim *could* hit the orchestrator's HTTP routes directly, but routing through the worker buys two things:

1. **Allowlist gate at a single chokepoint**. The worker exposes only `/agent-ops/{operation}` routes. The shim cannot reach arbitrary orchestrator endpoints even if a future bug makes it want to.
2. **Session-scoping is automatic**. The worker knows its session ID. The shim doesn't transmit it; the worker injects it. There is no path by which the agent can request operations against a different session.

The cost is one new HTTP client (worker → orchestrator), and a small `/agent-ops` router. Both are mechanical.

### Allowlist (initial)

| Subcommand | Maps to | Notes |
|---|---|---|
| `gh pr create` | `POST /api/sessions/:id/pr/quick` (existing) or new `POST .../pr` | Title and body are the agent's input. Falls back to the existing description generator only if `--fill` is passed and body is empty. |
| `gh pr edit [<n>]` | new `PATCH /api/sessions/:id/pr/:number` | Updates title/body. `<n>` defaults to current branch's PR. |
| `gh pr view [<n>] [--json …]` | existing PR status data via `prStatusPoller` | Read-only; returns JSON when `--json` requested. |
| `gh pr list [--json …]` | existing GitHub auth + Octokit list | Read-only; scoped to session's repo. |
| `gh pr status` | derived from `prStatusPoller` for current branch | Convenience read. |
| `gh pr comment [<n>] -b BODY` | new `POST /api/sessions/:id/pr/:number/comment` | Useful for the agent to leave a follow-up note. |
| `gh pr ready [<n>]` | new `POST .../pr/:number/ready` | Mark draft as ready. |
| `gh pr close [<n>]` | new `POST .../pr/:number/close` | Useful for abandoning superseded PRs. |
| `gh pr reopen [<n>]` | new `POST .../pr/:number/reopen` | Symmetric. |

Explicitly **rejected** with a helpful error and non-zero exit:

- `gh api …` — arbitrary endpoint access defeats the design.
- `gh repo create|delete|edit|fork|sync|view|list` — repo lifecycle is orchestrator-owned; not the agent's concern.
- `gh release …` — releases are deliberate human acts.
- `gh workflow …`, `gh run …` — CI manipulation.
- `gh auth …` — auth is harness-owned.
- `gh secret …` — secret management is via ShipIt's own secrets surface.
- `gh ssh-key …`, `gh gpg-key …`, `gh codespace …`, `gh extension …` — irrelevant to the workflow.
- `gh issue …` — out of scope for v1; can be added later if there's demand.

The error message:

```
ShipIt's `gh` shim only supports a subset of pull-request operations.
Tried: gh repo create
See /shipit-docs/github.md for the full list.
```

### `--repo` flag

Not supported in v1. Operations are always scoped to the session's remote. Passing `--repo other/repo` errors with the same allowlist message. This is a non-trivial scoping benefit: even if the agent is confused about which repo it's working in, the shim cannot mutate a different one.

### Output formats

The shim must match real `gh` closely enough that the agent doesn't get confused on parse:

- `gh pr create` prints the PR URL to stdout, exits 0. (Real `gh` does this.)
- `gh pr view --json title,body,state` prints valid JSON with exactly the requested fields.
- Errors go to stderr; exit code is non-zero.
- `--help` prints a brief summary of supported subcommands and exits 0.

### Auth and identity

The shim never sees the GitHub token. The orchestrator owns it. If GitHub auth is not configured for the session, the worker rejects the request with a clear error: *"GitHub is not connected for this ShipIt session. Ask the user to connect GitHub in the UI."* The shim prints this verbatim.

The workspace's git config still uses the user's identity (`/credentials/.gitconfig`); the agent's commits keep their existing authorship. The shim only touches GitHub-side state.

### Push semantics

`gh pr create` requires a pushed branch. Two options:

1. **Mirror `quickCreatePr`**: the orchestrator pushes synchronously before creating the PR (current behavior of the harness path). The agent doesn't have to push manually.
2. **Require push first**: the agent runs `git push` before `gh pr create`. But `git push` doesn't have credentials inside the container today (no helper configured) — would require its own surface.

We pick (1). `gh pr create` behind the shim does push-then-create, just like `quickCreatePr` already does. The agent doesn't need a separate push affordance.

### Interaction with the harness fallback

`claude-execution.ts:259-301` calls `quickCreatePr` after the post-turn commit when `autoCreatePr` is on. `quickCreatePr` already short-circuits if a PR exists for the branch (`services/github.ts:242-254`). So:

- If the agent ran `gh pr create` mid-turn → PR exists → harness fallback no-ops with a "found existing PR" return.
- If the agent didn't → harness fallback fires the existing path, including the (currently empty) `generateText` description. **Fixing the empty-body bug is a side benefit, not the goal of this doc** — see "Open question" below.

There is no need to coordinate the two paths beyond the existing dedup.

### Agent-facing documentation

Update `src/server/shipit-docs/github.md` to tell the agent:

- It can run `gh pr create -t "<title>" -b "<body>"` at end-of-work.
- It should write a real title and a body that explains *why* (Summary / Changes / Test plan).
- The list of supported subcommands and the rejected ones.
- That `gh` here is a ShipIt shim, not the real `gh`.

### Agent system prompt

In a follow-up, when `autoCreatePr` is on, append a short instruction to `agent-instructions.ts`:

> When you finish a meaningful chunk of work and there isn't already an open PR for this branch, run `gh pr create -t "<title>" -b "<body>"` to open one. Write a clear title and a markdown body with `## Summary`, `## Changes`, and `## Test plan` sections.

Whether to include this is gated by the same `autoCreatePr` setting the harness path uses, so users who turn off auto-PR don't get the prompt either.

## Phasing

| Phase | Scope | Status |
|---|---|---|
| **1** | Build the shim + worker `/agent-ops/*` routes + supporting orchestrator endpoints. Update `shipit-docs/github.md`. **No agent prompt changes.** Harness path untouched. The agent *could* use `gh` if it decides to, but nothing nudges it. This phase is fully backwards-compatible. | done |
| **2** | Update `agent-instructions.ts` to recommend `gh pr create` when `autoCreatePr` is on. The agent now drives the happy path; harness is the backstop. This is when empty-body PRs go away in practice. | done |
| **3** *(optional)* | Reduce the harness fallback to a true backstop that only fires N seconds after turn-end if no PR was created by the agent. Removes the "double work, dedup-saves-us" pattern. Probably not worth doing until we have telemetry showing harness fallback rarely fires. | planned |

## Security model

Threats considered:

| Threat | Mitigation |
|---|---|
| Agent uses real `gh api` to call arbitrary GitHub endpoints | Real `gh` not installed. Shim rejects `gh api`. |
| Agent operates on a different repo (`--repo other/x`) | `--repo` flag rejected. Worker injects session's repo. |
| Agent reads the GitHub token (`echo $GITHUB_TOKEN`, `cat /credentials/...`) | Token never injected into container env or filesystem; only the orchestrator on the host has it. |
| Agent escalates from PR creation to repo/release/workflow mutation | Allowlist denies all of these. |
| Prompt injection in PR body (e.g., user-influenced text containing markdown that triggers GitHub Actions, autolinks, etc.) | Same risk surface as the existing harness path. Bodies are passed through unchanged. Mitigation is at GitHub, not us. |
| Spamming PRs / GitHub abuse | Agent only acts during user-driven turns; existing rate limits apply. Optional: add a per-session debounce in the worker (e.g., max 1 `gh pr create` per turn). |
| Shim binary tampered with by the agent | `/usr/local/bin/gh` is in the image, owned by root, not writable by the agent's process. The agent could `PATH=/something/else gh` but the shim doesn't gate security — the worker's allowlist does. |
| Worker `/agent-ops` reachable from outside the container | Bind to localhost only inside the container; orchestrator's existing reverse proxy doesn't forward this path. |

The trust boundary that matters: **the worker's `/agent-ops/*` allowlist**. Shim and prompt are conveniences; the worker is the security gate.

## Open questions

1. **Should Phase 1 also fix the empty-body bug independently?** The current `generateText` no-op is a separate, smaller bug. We could land a one-line fix that routes `generateText` through a session-scoped proxy agent (see `docs/116`'s sibling discussion of "approach #1") without doing this whole shim. Recommendation: **no — fix it via Phase 2 of this doc instead.** Two fixes for the same symptom is wasted work, and the shim is the better long-term answer.
2. **Do we want `gh issue create` in v1?** It's tempting because the agent often uncovers follow-up work it doesn't want to do now. But it widens the surface and complicates the trust story. Recommendation: defer.
3. **What about `git push`?** Currently authenticated only on the orchestrator side. The shim pushes implicitly via `gh pr create`. If the agent ever needs a standalone authenticated push, we add it later — out of scope here.
4. **Should the shim live in `src/server/session/` or `src/agent-shim/` or its own package?** Recommendation: `src/server/session/agent-shim/gh.ts` (compiled to `/usr/local/bin/gh` in the Dockerfile via `tsc` in the build stage). Keeps it close to the worker code that brokers it.

## Tests

Phase 1 coverage shipped:

- **[done] Shim unit tests** — `src/server/session/agent-shim/gh.test.ts` covers
  argument parsing (positional/value/boolean/`--flag=value`), allowlist
  enforcement, every supported subcommand's happy path, JSON-field filtering,
  PR-number fallback to current branch, error formatting (auth/validation),
  and exit codes. 47 cases.
- **[done] Worker broker tests** — `src/server/session/agent-ops-routes.test.ts`
  covers every `/agent-ops/*` route, body+query forwarding, status
  pass-through, and the misconfigured-orchestrator-client failure mode.
  11 cases.
- **[done] Allowlist denial tests** — covered by the shim unit tests above
  (`gh api`, `gh repo`, `gh release`, `gh workflow`, `gh auth`, `gh secret`,
  `gh ssh-key`, `gh codespace`, `gh extension`, `gh issue`, `gh gist`,
  `gh run`, plus unknown subcommands and `--repo`/`--web` flags).
- **[done] Backstop interaction (regression) test** — `pr-auto-create-on-turn.test.ts`
  continues to pass unchanged: the harness fallback still fires when the
  agent doesn't drive PR creation.

Phase 2 coverage shipped:

- **[done] Agent-instructions unit tests** —
  `src/server/orchestrator/agent-instructions.test.ts` covers the
  `autoCreatePr` branch of `buildAgentSystemInstructions`, the no-options
  default (used by `AGENT_SYSTEM_INSTRUCTIONS`), the preview-URL branch, and
  the backwards-compatible string-arg form. 9 cases.
- **[done] Integration test** —
  `src/server/orchestrator/integration_tests/agent-driven-pr.test.ts` covers
  - System prompt contains the `gh pr create` nudge when `autoCreatePr` is on
    AND GitHub is connected.
  - System prompt does NOT contain the nudge when `autoCreatePr` is off.
  - System prompt does NOT contain the nudge when GitHub is not connected
    (even with `autoCreatePr` on).
  - `POST /api/sessions/:id/pr/agent-create` (the orchestrator end of the
    shim chain) routes through to `GitHubAuthManager.createPullRequest` with
    the agent-supplied title and body — not a harness-derived description.
  - Dedup: when the agent has already created a PR for the branch, the
    harness backstop's `quickCreatePr` short-circuits via `findPullRequest`
    and does not double-create.

## Key files

| File | Change | Status |
|---|---|---|
| `src/server/session/agent-shim/gh.ts` | **New.** The shim entry point. Parses args, calls the worker, formats output. | done |
| `src/server/session/agent-shim/gh.test.ts` | **New.** Unit tests for parsing, allowlist, every subcommand, error formatting. | done |
| `src/server/session/session-worker.ts` | Register `/agent-ops/*` routes; accept a `createOrchestratorClient` injection point. | done |
| `src/server/session/agent-ops-routes.ts` | **New.** The narrow allowlist router. Pipes shim requests to the orchestrator. | done |
| `src/server/session/agent-ops-routes.test.ts` | **New.** Tests every relay route + misconfig path. | done |
| `src/server/session/orchestrator-client.ts` | **New.** Tiny HTTP client for worker→orchestrator. Reads `SHIPIT_HOST`/`SHIPIT_PORT`/`SESSION_ID` from env. | done |
| `src/server/orchestrator/api-routes-github.ts` | New routes: `POST /pr/agent-create`, `PATCH /pr/:n`, `GET /pr/list`, `GET /pr/view`, `POST /pr/:n/{comment,ready,close,reopen}`. | done |
| `src/server/orchestrator/services/github.ts` | Added `agentCreatePr`, `editPullRequest`, `commentOnPullRequest`, `markPrReady`, `closePullRequest`, `reopenPullRequest`, `viewPullRequest`, `listPullRequests`. | done |
| `src/server/orchestrator/github-auth-prs.ts` | Added `updatePullRequest`, `addPullRequestComment`, `markPullRequestReady`, `listPullRequests`, `viewPullRequest` (REST + GraphQL via fetch). | done |
| `src/server/orchestrator/github-auth.ts` | Wrapper methods on `GitHubAuthManager` for the new PR operations. | done |
| `docker/Dockerfile.session-worker.{dev,prod}` | Install shim at `/usr/local/bin/gh` as a small `sh` wrapper that runs `node --import tsx …/gh.ts`. The `.docker` image inherits via `BASE_IMAGE`. | done |
| `src/server/shipit-docs/github.md` | Documents the shim — supported / rejected subcommands, push semantics, auth model. | done |
| `src/server/orchestrator/agent-instructions.ts` | *(Phase 2)* When `autoCreatePr` is on, append the "use `gh pr create`" instruction. Refactored to take an options object (`{ previewUrl, autoCreatePr }`) while preserving the legacy `string` form for backwards-compat. | done |
| `src/server/orchestrator/agent-instructions.test.ts` | *(Phase 2)* Unit tests for the new `autoCreatePr` branch and the existing branches. | done |
| `src/server/orchestrator/ws-handlers/claude-execution.ts` | *(Phase 2)* Pass `autoCreatePr = credentialStore.getAutoCreatePr() && githubAuthManager.authenticated` into the agent-instructions builder, so the nudge is gated on the same surface that drives the harness fallback. | done |
| `src/server/orchestrator/services/settings.ts` | *(Phase 2)* Render `agentSystemInstructions` for the Settings UI through `buildAgentSystemInstructions({ autoCreatePr })` so the displayed copy matches what the agent actually receives. | done |
| `src/server/orchestrator/integration_tests/agent-driven-pr.test.ts` | *(Phase 2)* End-to-end coverage of the agent-driven path: system-prompt gating, orchestrator → `GitHubAuthManager` wiring, harness dedup. | done |
| `src/server/orchestrator/integration_tests/test-helpers.ts` | *(Phase 2)* `StubGitHubAuthManager` now records `createPullRequest` calls in `createPullRequestCalls`, so tests can assert on the title/body the orchestrator sent. | done |

## Future extensions

- **`gh issue *`** subset for follow-up tracking.
- **Per-repo allowlist policy** — `shipit.yaml` could let advanced users opt in to a wider surface (e.g., `gh release create`).
- **Telemetry** on which subcommands the agent uses, to inform future allowlist changes.
- **Replace harness fallback entirely** once Phase 2 has been stable for a while and we have data showing the agent reliably uses the shim.
