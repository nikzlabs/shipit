---
status: done
---

# 129 — Stop-hook enforcement of agent-driven PR creation

## Summary

Convert the existing "open a PR at end-of-turn" instruction from a *prompt-level
hope* into a *Stop-hook enforcement*. When `autoCreatePr` is on, the Claude
CLI is launched with `--settings /etc/shipit/managed-settings.json`, which
registers a Stop hook that refuses to let a turn finish while the branch has
unmerged commits and no PR. The hook hands the work back to the agent — the
agent itself writes the title and body, with full conversation context.

This is the answer to the empirically-observed compliance problem with the
existing system-prompt nudge (`agent-instructions.ts:62-81`): agents read
"please run `gh pr create`" and routinely don't. The hook makes the prompt
non-optional without taking the title/body authorship away from the agent.

## Motivation

Two compounding facts:

1. **Server-side summarization of PR titles/bodies produces low-quality
   output.** The previous fallback (`generatePrDescription` in
   `services/github.ts`) feeds `git log` + `diffSummary` to an LLM. Those
   inputs describe *what* changed but not *why*. The agent that wrote the
   change knew why; a separate summarizer doesn't.
2. **Telling the agent "please call `gh pr create`" is unreliable.** It's a
   plain prompt instruction. Agents skip it routinely, especially on long
   turns where the instruction is far back in context.

The cleanest fix is *enforcement at the same layer that already enforces
other turn-end behaviors* — the Claude Code Stop hook. The hook runs
immediately before the agent finalizes a turn. If it exits with code 2, the
agent must continue, with the hook's stderr fed back as a system message.
At that exact moment the agent has full live context of the turn it just
did — perfect for authoring a real title and body.

This pattern is option **F** in the design conversation (see also the
discussion of why options A/D are dead — both rely on the same compliance
that's already failing).

## Design

### Wire-up

```
                                 autoCreatePr on?
                                       │
                       ┌───── yes ─────┴──── no ─────┐
                       ▼                             ▼
       agent-execution.ts adds                 no --settings;
       --settings /etc/shipit/                 no Stop hook;
       managed-settings.json to                turn ends normally
       AgentRunParams
                       │
                       ▼
       claude.ts → claude CLI sees --settings → registers Stop hook
                       │
                       ▼
       on turn end: /etc/shipit/agent-hooks/stop-pr-check.sh
                       │
            ┌──────────┴───────────┐
            ▼                      ▼
       changes ahead of base &&    everything else
       no PR exists                (no diff, PR exists,
            │                       gh auth failure,
            ▼                       not a git repo, etc.)
       exit 2 with stderr:         exit 0 — turn ends
       "run gh pr create ..."
            │
            ▼
       agent receives stderr      [normal post-turn:
       as a system message and    auto-commit, auto-push,
       continues the turn →       harness-fallback quickCreatePr
       calls gh pr create with    no-ops because PR now exists]
       its own title + body
```

### Files

| File | Role |
|---|---|
| `docker/agent-hooks/stop-pr-check.sh` | The hook itself. POSIX shell. Reads Claude's Stop-hook JSON on stdin, examines git state and gh state, exits 0 or 2. |
| `docker/agent-hooks/managed-settings.json` | Claude Code settings file that registers the Stop hook by absolute path. |
| `docker/Dockerfile.session-worker.{dev,prod,dogfood}` | `COPY` both files into `/etc/shipit/` inside the session-worker image. The `.docker` variant inherits via `BASE_IMAGE`. |
| `src/server/shared/types/agent-types.ts` | `AgentRunParams.settingsPath?: string` — new optional field. |
| `src/server/session/claude.ts` | When `settingsPath` is set, append `--settings <path>` to the spawn args. |
| `src/server/session/agents/claude-adapter.ts` | Forward `settingsPath` from `AgentRunParams` into `ClaudeRunOptions`. |
| `src/server/orchestrator/ws-handlers/agent-execution.ts` | Set `settingsPath = "/etc/shipit/managed-settings.json"` iff `autoCreatePrActive && agentId === "claude"`. Single source of truth: `autoCreatePrActive` also drives the system-prompt nudge and the harness fallback. |
| `src/server/session/claude.test.ts` | Regression: `--settings` flag is forwarded when `settingsPath` is set, omitted when it isn't. |
| `src/server/session/agent-shim/stop-pr-check.test.ts` | Functional tests for the script: runs the real `/bin/sh` against a real temp git repo with a stubbed `gh` on PATH. Covers the full decision table — stop-hook-active, not a repo, no diff, default branch, PR exists, gh auth failure, and the blocking case. |

### The hook script in detail

The hook is a small POSIX shell script (~50 lines of logic). Its decision
table mirrors the inline doc comment at the top of the file:

| Condition | Action |
|---|---|
| `stop_hook_active: true` in stdin envelope | exit 0 (we've already blocked once on this turn — don't loop) |
| Not inside a git repo | exit 0 |
| No resolvable base branch (`origin/HEAD` / `origin/main` / `origin/master`) | exit 0 |
| `HEAD` is on the default branch | exit 0 (no PR concept) |
| `git rev-list --count base..HEAD == 0` | exit 0 (no commits to PR) |
| `gh pr view` exits 0 (PR exists) | exit 0 |
| `gh pr view` errors with anything other than "No pull request found" | exit 0 (fail open — auth not configured, no remote, etc.) |
| `gh pr view` errors with "No pull request found" | exit 2, stderr tells the agent what to run |

The fail-open posture matters: users on a session with no GitHub auth, or no
remote, should not see their turns blocked by an enforcement that can't
succeed. The hook only blocks when there's a clear "PR is missing and could
be created" state.

### Why `--settings` flag, not `/root/.claude/settings.json`

`/root/.claude` in the session-worker image is a *symlink to
`/credentials/.claude`* (see the Dockerfile). That target is the user's
persisted Claude credentials volume — writing settings.json there pollutes
user data and creates an implicit dependency on volume layout. The
`--settings <file>` CLI flag is the documented way to point Claude at a
managed settings file from a known image-baked path. It's also conditional
(no flag → no hook), which gives us the autoCreatePr gating for free.

### Codex (out of scope)

The `codex-adapter` does not have an equivalent Stop hook mechanism in its
current CLI surface. The `settingsPath` field on `AgentRunParams` is silently
ignored by non-Claude adapters; the `agentId === "claude"` guard in
`agent-execution.ts` keeps the flag off for Codex sessions. If a future Codex
version exposes a hook surface, plumb it the same way.

### Loop safety

Claude's Stop-hook envelope includes a `stop_hook_active` boolean that's
`true` when the hook is being re-invoked after a previous block on the same
attempt. The first check in our script honors that flag — if a block-loop
ever forms (e.g., `gh pr create` keeps failing for some reason), the hook
yields after one round and lets the turn end.

The harness fallback (`quickCreatePr` in `post-turn.ts`) still runs after
the agent's turn finalizes. So the worst-case is: agent ignores the hook
guidance, hook gives up after one block, harness fallback fires its existing
no-context summarizer. This is no worse than today; on the happy path the
agent now creates the PR with its real understanding of the work.

## Integration with prior auto-PR docs

| Doc | Role | Relationship |
|---|---|---|
| `docs/099-auto-pr-on-meaningful-turn` | Established `autoCreatePr` setting + harness fallback after meaningful commits | This doc keeps that fallback as the backstop. |
| `docs/116-fake-gh-cli-shim` | Ships the `gh` shim the hook depends on | The hook's `gh pr view` and the agent's `gh pr create` both go through the shim → `/agent-ops/*` broker → orchestrator. |
| `docs/116-fake-gh-cli-shim` Phase 3 (planned) | "Reduce harness fallback to true backstop with delay" | This doc moves us closer: with the hook reliably forcing the agent to create the PR, the harness fallback rarely fires. |

## Tests

| Test | What it covers |
|---|---|
| `claude.test.ts` "includes --settings flag when settingsPath is provided" | Plumbing: ClaudeProcess wires the flag through. |
| `claude.test.ts` "does not include --settings when settingsPath is omitted" | Plumbing: flag is conditional. |
| `stop-pr-check.test.ts` (7 cases) | Script-level decision table — every branch from the table above is exercised against a real temp git repo with a stubbed `gh`. |

End-to-end coverage (orchestrator → worker → CLI flag) is implicitly
covered by the existing `agent-driven-pr.test.ts` integration test plus
the new unit tests; a dedicated e2e for the hook would require running the
actual Claude CLI against a managed-settings.json, which is out of scope.

## Future extensions

- **Per-session opt-out** — currently auto-PR is global. If we add a
  per-session toggle (`SessionMetadata.autoCreatePr?: boolean`), this doc's
  `autoCreatePrActive` predicate is the single line to update.
- **Diff-size threshold** — skip the hook for very small diffs (typo fixes,
  comment-only edits). Probably handled better by the agent's own judgment
  in the PR body than a hard rule here.
- **Codex hook parity** — when/if the Codex CLI ships a Stop-hook
  equivalent, mirror this wiring in `codex-adapter` and drop the
  `agentId === "claude"` guard.
- **PR template integration** — if a repo ships `.github/pull_request_template.md`,
  surface it to the agent in the hook's stderr so the body matches house style.
