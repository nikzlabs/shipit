
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

### Second rule — destructive git on a merged branch (SHI-265)

The same hook carries a second, **conditional** rule. `shipit branch
reset-to-base` (docs/239) fails closed on a safety gate — `HEAD ===
mergedHeadSha`, clean tree, on the session branch, no in-progress sequencer —
and that refusal is what turns three hazards (a wake queued behind uncommitted
work, a branch advanced between merge and detection, a duplicate wake after a
restart) from unrecoverable data loss into a visible no-op. The refusal was
prompt-mediated only: a refused agent could run `git reset --hard origin/main`
and reproduce the loss in one line. This is the same "prompt precedence is not
enough" argument that created the hook.

**Blocked when armed:** `git reset --hard`, `git checkout -f` / `--force`,
`git push -f` / `--force` / `--force-with-lease[=…]` / `--force-if-includes[=…]`.

**Not blocked:** a mixed/soft reset, `git checkout -- <path>`, a plain push, and
`shipit branch reset-to-base` itself (it relays to the orchestrator, so no `git`
runs in the agent's shell — and the hook only matches segments whose command
token is `git`).

**Scoping — deliberately not a blanket block.** `git reset --hard` has
legitimate uses (throwing away a local mess the user asked to discard), so the
rule is armed only in the state the reset command guards. The signal is
`SHIPIT_GUARD_DESTRUCTIVE_GIT=1`, set exactly like `SHIPIT_SANDBOX`: the
orchestrator derives it from the session row at run-params build time and it
reaches the hook as CLI spawn env, never as anything the agent can write.

```
session-agent-run-params.ts   guardDestructiveGitActive = Boolean(session.mergedHeadSha)
        ▼
agents/claude/run-params-prep.ts   → params.guardDestructiveGit
        ▼
claude/adapter.ts → claude/process.ts   spawnEnv.SHIPIT_GUARD_DESTRUCTIVE_GIT = "1"
        ▼
block-branch-ops.mjs   arms offendsDestructive()
```

`mergedHeadSha` is the right anchor rather than a new flag: it is set at merge
detection and dropped by `clearMerged` **and** by a successful reset, so the
guard arms and disarms itself with no extra bookkeeping. Sandbox sessions never
carry one, and the hook's docs/211 early exit covers them regardless.

**Known limitation — resident streaming processes.** The env is fixed at spawn,
and under live steering (docs/140) one CLI process serves many turns. A session
that merges *while* a streaming process is resident keeps the pre-merge env
until the process exits. This is acceptable because the hazard window — the
docs/239 self-merge wake — arrives as a **system turn**, and system turns never
reuse the resident process (`dispatched-turn.ts` nulls `resident` when
`opts.systemTurn`), so a wake turn always spawns with freshly-computed env. The
residual case is a user-typed turn on a session that merged mid-conversation,
where nothing has refused and so nothing is being worked around. The same
staleness already applies to `SHIPIT_AUTO_CREATE_PR`.

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
| `docker/agent-hooks/block-branch-ops.mjs` | New PreToolUse hook. Node, no deps. Blocks branch create/switch, and (SHI-265, armed by `SHIPIT_GUARD_DESTRUCTIVE_GIT=1`) destructive git. |
| `docker/agent-hooks/managed-settings.json` | Adds the `PreToolUse` entry (matcher `Bash`) alongside the existing `Stop` entry. Also carries `"includeCoAuthoredBy": false` (always-on, ungated) so the Claude CLI drops the `Co-Authored-By: Claude` commit trailer and the `🤖 Generated with Claude Code` PR footer — ShipIt owns the commit/PR surface, so the upstream attribution is noise. Takes effect on the next session-worker image rebuild (the file is `COPY`'d in, not mounted). |
| `docker/agent-hooks/stop-pr-check.sh` | Early-exits unless `SHIPIT_AUTO_CREATE_PR=1` — PR enforcement stays opt-in now that the settings file is always wired up. |
| `docker/Dockerfile.session-worker.{prod,dev,dogfood}` | `COPY` + `chmod` the new hook into `/etc/shipit/agent-hooks/`. |
| `src/server/shared/types/agent-types.ts` | `AgentRunParams.autoCreatePr?: boolean` — new optional field. |
| `src/server/session/claude.ts` | `ClaudeRunOptions.autoCreatePr`; sets `SHIPIT_AUTO_CREATE_PR=1` in the CLI spawn env when true. |
| `src/server/session/agents/claude-adapter.ts` | Forwards `autoCreatePr` from `AgentRunParams` into `ClaudeRunOptions`. |
| `src/server/orchestrator/ws-handlers/agent-execution.ts` | `settingsPath` is now unconditional for `claude`; passes `autoCreatePr: autoCreatePrActive`. |

SHI-265 additions:

| File | Role |
|---|---|
| `src/server/orchestrator/session-agent-run-params.ts` | Derives `guardDestructiveGitActive` from the session's `mergedHeadSha` (synchronous, in the pre-`await` DB block). |
| `src/server/orchestrator/agent-run-params-prep.ts` | `PrepareRunParamsInput.guardDestructiveGitActive`. |
| `src/server/orchestrator/agents/claude/run-params-prep.ts` | Forwards it as `guardDestructiveGit`. |
| `src/server/shared/types/agent-types.ts` | `AgentRunParams.guardDestructiveGit?: boolean` (Claude-only). |
| `src/server/session/agents/claude/adapter.ts` | Forwards it into `ClaudeRunOptions`. |
| `src/server/session/agents/claude/process.ts` | Sets/clears `SHIPIT_GUARD_DESTRUCTIVE_GIT` in the spawn env — both the PTY and the streaming class. |
| `src/server/shipit-docs/sessions.md` | Tells the agent the "don't hand-roll a reset" rule is enforced, and that the block is scoped to merged sessions. |

### Tests

| Test | What it covers |
|---|---|
| `src/server/session/agent-shim/block-branch-ops.test.ts` | Runs the real hook with `node`: ~15 blocked forms (incl. compound commands, env prefixes, git global options), ~15 allowed forms, and fail-open cases. SHI-265 adds the destructive-git matrix: blocked-when-armed, untouched-when-not, sandbox-exempt, `shipit branch reset-to-base` allowed, and branch ops still getting the branch-op message. |
| `src/server/orchestrator/session-agent-run-params.test.ts` | SHI-265: the guard arms iff the session row carries `mergedHeadSha` (off when unmerged, cleared, missing, or sandbox). |
| `src/server/orchestrator/agent-run-params-prep.test.ts` | SHI-265: Claude's hook forwards `guardDestructiveGitActive` → `guardDestructiveGit`, defaulting false. |
| `src/server/session/agents/claude/process.test.ts` | SHI-265: `SHIPIT_GUARD_DESTRUCTIVE_GIT=1` is set in the spawn env iff `guardDestructiveGit` is true. |
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
