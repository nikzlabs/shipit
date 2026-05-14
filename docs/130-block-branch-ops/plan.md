---
status: done
---

# 130 — Keep the agent on the session branch (branch-op block hook)

## Summary

Every ShipIt session is created on its own dedicated branch — auto-commit,
auto-push, and `gh pr create` all target it. The agent sometimes runs
`git checkout -b …` (typically right before `gh pr create`), which strands
the turn's work on a branch ShipIt isn't tracking: the commit lands nowhere
useful and the PR is opened empty.

The system prompt already tells the agent not to create branches
(`agent-instructions.ts`), but the Claude Code CLI injects its own built-in
git guidance ("if on the default branch, branch first") that the agent
sometimes follows instead. Prompt-level instructions lose to prompt-level
instructions.

This feature adds a **PreToolUse hook** that structurally blocks
branch-creating / branch-switching `git` commands, regardless of prompt
precedence — the same enforcement-at-the-hook-layer pattern as
docs/129-stop-hook-pr-enforcement.

## Design

### The hook

`docker/agent-hooks/block-branch-ops.mjs` — a small Node script (no deps,
runs under the session-worker image's `node`). It reads the Claude Code
PreToolUse JSON envelope on stdin and:

- Fails open (exit 0) for non-`Bash` tools, empty commands, or unparseable
  stdin — the prompt instruction remains the first line of defense.
- Splits the Bash command on shell separators (`&&`, `||`, `;`, `|`,
  newlines) and inspects each segment that actually invokes `git` (stepping
  past leading `VAR=value` env assignments and git's own global options).
- Blocks (exit 2, reason on stderr) when a segment is:
  - `git checkout -b` / `-B`
  - `git switch -c` / `-C` / `--create` / `--orphan`, or `git switch <branch>`
    (a plain switch moves off the session branch)
  - `git branch <name>` without a delete (`-d`/`-D`/`--delete`) or list
    (`--list`, `-a`, `--merged`, `--contains`, …) flag — i.e. create / rename / move
  - `git worktree add`
- Allows everything else, including `git checkout -- <file>` (discard
  changes), `git branch` / `git branch -a` (list), and `git branch -d`
  (delete).

It's a heuristic, not a shell parser: exotic quoting can slip a false
negative through, which is acceptable. False positives are avoided by
requiring `git` to be the command token of a segment.

### Wire-up — always-on settings file

Previously `managed-settings.json` was passed to the Claude CLI only when
`autoCreatePr` was on (docs/129). Branch-stranding happens regardless of
that setting, so the settings file is now passed **unconditionally** for the
`claude` agent. To keep PR enforcement opt-in, the Stop hook self-gates:

```
agent-execution.ts
  settingsPath = agentId === "claude" ? "/etc/shipit/managed-settings.json" : undefined   // always
  autoCreatePr = autoCreatePrActive                                                       // gates the Stop hook
        │
        ▼
claude.ts → claude CLI
  --settings <path>                       → registers BOTH hooks
  env SHIPIT_AUTO_CREATE_PR=1 (iff autoCreatePr) → consumed by the Stop hook
        │
        ├── PreToolUse: block-branch-ops.mjs   — always runs
        └── Stop:       stop-pr-check.sh        — runs, but exits early
                                                  unless SHIPIT_AUTO_CREATE_PR=1
```

### Files

| File | Role |
|---|---|
| `docker/agent-hooks/block-branch-ops.mjs` | New PreToolUse hook. Node, no deps. Blocks branch create/switch. |
| `docker/agent-hooks/managed-settings.json` | Adds the `PreToolUse` entry (matcher `Bash`) alongside the existing `Stop` entry. |
| `docker/agent-hooks/stop-pr-check.sh` | Early-exits unless `SHIPIT_AUTO_CREATE_PR=1` — PR enforcement stays opt-in now that the settings file is always wired up. |
| `docker/Dockerfile.session-worker.{prod,dev,dogfood}` | `COPY` + `chmod` the new hook into `/etc/shipit/agent-hooks/`. |
| `src/server/shared/types/agent-types.ts` | `AgentRunParams.autoCreatePr?: boolean` — new optional field. |
| `src/server/session/claude.ts` | `ClaudeRunOptions.autoCreatePr`; sets `SHIPIT_AUTO_CREATE_PR=1` in the CLI spawn env when true. |
| `src/server/session/agents/claude-adapter.ts` | Forwards `autoCreatePr` from `AgentRunParams` into `ClaudeRunOptions`. |
| `src/server/orchestrator/ws-handlers/agent-execution.ts` | `settingsPath` is now unconditional for `claude`; passes `autoCreatePr: autoCreatePrActive`. |

### Tests

| Test | What it covers |
|---|---|
| `src/server/session/agent-shim/block-branch-ops.test.ts` | Runs the real hook with `node`: ~15 blocked forms (incl. compound commands, env prefixes, git global options), ~15 allowed forms, and fail-open cases. |
| `src/server/session/agent-shim/stop-pr-check.test.ts` | Updated: `runHook` now sets `SHIPIT_AUTO_CREATE_PR=1` by default; added a case proving the hook no-ops when the var is unset. |
| `src/server/session/claude.test.ts` | Added: `SHIPIT_AUTO_CREATE_PR=1` is set in the spawn env iff `autoCreatePr` is true. |

## Codex (out of scope)

Same as docs/129: the `codex-adapter` has no equivalent hook surface. The
`autoCreatePr` / `settingsPath` fields are Claude-only; the
`agentId === "claude"` guard keeps both off for Codex sessions.

## Future extensions

- **Block on the orchestrator side too** — the `gh` shim already resolves the
  current branch; if branch-stranding is ever observed via paths other than
  the Claude CLI, add a guard there.
- **`git checkout <branch>` (plain switch)** — left allowed because
  `git checkout <path>` (discard changes) is indistinguishable without
  consulting the repo. `git switch <branch>` is already blocked since it's
  unambiguously branch-oriented.
