
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

### Second rule — destructive git on a merged branch (planning#267)

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
`git push -f` / `--force` / `--force-with-lease[=…]` / `--force-if-includes[=…]`,
any `git rebase` that STARTS one, and `git pull --rebase` / `-r` — the same
rewrite under another name, and the form an agent reaches for once the plain
`rebase` is refused. (`git -c pull.rebase=true pull` sets it through config the
hook does not read; that is the same exotic-form false negative the heuristic
already accepts.)

The rebase clause was added after the 2026-08-30 incident (see
`docs/218-auto-reset-merged-branch-on-continue/plan.md` → "Continuing after the
reset"). It closes a gap rather than widening the rule: a rebase reaches the same
end state as the hard reset beside it, and in this exact window it is the wrong
tool twice over — add/add conflicts against a squash-merged base, plus stranded
published commits that no later plain auto-push can ever land. CLAUDE.md
post-turn invariant 4 already said "never a rebase" here; this is the structural
half of that sentence.

**Not blocked:** a mixed/soft reset, `git checkout -- <path>`, a plain push, a
plain `git pull` (it merges, so it loses nothing), `git rebase --help`,
`git rebase --continue` / `--abort` / `--skip` / `--quit` / `--edit-todo` /
`--show-current-patch` (a rebase already in flight must stay exitable — blocking
`--abort` would trap the agent inside it), and `shipit branch reset-to-base`
itself (it relays to the orchestrator, so no `git` runs in the agent's shell —
and the hook only matches segments whose command token is `git`).

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

### Third rule — a process test that matches its own command line

Always on, and the only rule here that is not about `git`. The Bash tool runs a
command as `bash -c '<the whole command>'`, so every literal in the command is
part of the command line of the process running it — and `pgrep -f` / `pkill -f`
match full command lines. A pattern written in the command therefore matches the
shell running it.

**The precise claim, because a looser one is false.** This holds while that
shell is still alive to be matched, and here it always is: the harness appends
`&& pwd -P >| /tmp/claude-<id>-cwd`, so the agent's command is never the last
thing the shell does. Measured — `bash -c 'pgrep -fc UNIQUE'` alone reports **0**,
because bash `exec`s the final external command and replaces itself, while
`bash -c 'pgrep -fc UNIQUE; echo done'` reports **1**. So the rule rests on the
wrapper's trailing command, which is a property of the harness rather than a law
about shells, and it is worth knowing that the upstream fix this repository
cannot make — keeping the command text out of the wrapper's argv — would retire
this rule rather than change it.

**Blocked:** a readable `pgrep -f` / `pkill -f` whose pattern, read as a regex,
matches the command text it appears in. **Not blocked:** every form that
excludes the caller (`-A`, `-P`, `-x`, `-v`, a uid or session filter), a bracket
pattern (`'[v]itest'`) or an alternation that cannot match its own literal, a
pattern only known at run time (`"$PAT"`), `pgrep` without `-f` (it matches a
process *name*), an option the hook does not know, two operands, quoting that
never closes, and a pattern this runtime does not read as a regex. The option
list is an allowlist on purpose: only options that provably cannot change
whether the caller matches are understood, and anything else means no judgement,
because refusing the fix would be the worst outcome available.

Quoting is the line between code and data, so a loop inside `printf '…'`, an
`echo "…"` or a heredoc body is left alone; `#` comments are dropped for the
same reason. The match itself runs under a 100 ms `vm.runInNewContext` deadline
it is allowed to lose — `a(a+)+$` backtracks for seconds and a `try` cannot
interrupt it, and a hook that stalls is the failure this rule exists to prevent.

**What the tokenizer has to get right, each found by a review hunting for false
refusals.** Leaving the loop condition exposed four ways to refuse correct work,
because a loop condition is a small, tidy region and the whole command is not:

- **Command position.** `echo pgrep -f x` prints a word; it runs no `pgrep`.
  Tokens now carry whether they are the command of a simple command, which an
  env assignment (`VAR=v pgrep …`) and a reserved word (`until`, `!`, `then`, …)
  preserve and an ordinary word ends.
- **Redirections do not end the arguments.** `pgrep -f x >/dev/null -A` passes
  `-A` to `pgrep`, and stopping the scan at the redirection read it as a plain
  `-f` and refused the very escape the message recommends. The scan steps over
  a redirection and its operand and keeps reading. Relatedly `2>&1` is one
  redirection word: reading its `&` as a control operator left a stray `1` that
  looked like a second pattern, which declined to judge `… >/dev/null 2>&1` —
  the commonest shape there is.
- **A newline ends a command.** Treated as plain whitespace, one line's
  arguments ran into the next, read as a second operand, and declined. Multi-line
  commands are most of what an agent writes.
- **A line continuation is removed, not turned into a newline.** Seeding a word
  with it hid the `#` on the next line from the comment test, so
  `echo one \` + `# note ; pgrep -f x` — which bash only echoes — was refused.
- **`pgrep` compiles POSIX ERE; this compiles a JS `RegExp`.** They disagree:
  ERE's `[[:digit:]]+` wants digits, JS reads it as a set of `[:digt` plus `]+`
  and matches the pattern's own text. Bracket expressions and letter escapes are
  declined rather than judged. Which letter escapes actually agree is a libc
  detail — measured here, glibc's ERE does support `\w` — so the class is
  declined whole and only misses are paid.
- **A pipe means someone else reads the result — for `pgrep` only.**
  `pgrep -af x | grep -v '[p]grep'` filters the wrapper back out and is correct,
  and no reading of the filter is anything but a guess. `pkill` is not exempt:
  the signal is sent before anything downstream sees a byte, and
  `pkill -f <self-matching> | cat` was measured still killing the shell.
- **Quoting is read as bash reads it, not approximately.** Inside double quotes
  a backslash survives unless it escapes ``$ ` " \`` or a newline, so
  `"job\.js"` reaches `pgrep` as a literal dot; consuming it made the dot match
  anything and refused a correct command. A heredoc delimiter may be quoted,
  backslash-escaped or carry a hyphen, and one line may open two — each missed
  delimiter read a `cat`'s data as commands.
- **An opening `^` anchor cannot be judged from the submitted text.** The real
  argv starts with the wrapper, so `^pgrep…` never matches it, while the text
  the hook holds does start with `pgrep`. Declined.

The second and third of these were found by successive reviews asked to hunt for
false refusals, which is the standing lesson: the refusal is cheap to get wrong
in a direction nobody sees, because a refused agent rewrites its command and
moves on.

**Why it is not scoped to wait loops.** It first shipped judging only `until` /
`while` conditions, after a loop ran 36 minutes against a test run that had
already finished. The one-shot form was left alone on the reasoning that
"matching itself costs one extra line of output". That was wrong, and a second
incident refuted it: `pgrep -f` **exits 0** and `pgrep -fc` **counts 1** on the
strength of the self-match, so a bare liveness check returns a wrong answer with
nothing in the output to notice, and the agent told the user a suite was still
running minutes after it finished. `pkill -f` is worse than wrong — measured
here, it signals the shell running it, so the tool call dies part-way with no
error. Dropping the loop scope also removed the code that found loop conditions:
the rule judges the test, and a test that cannot change is broken with or
without a loop around it.

The refusal names the pattern and the ways out, and the escapes it recommends
are escapes the hook actually leaves alone — pinned by a test, so the advice
cannot drift from the behaviour. `pkill` gets a different message: the pgrep
advice is all about waiting, and none of it applies to a kill.

### Wire-up — always-on settings file

Previously `managed-settings.json` was passed to the Claude CLI only when
`autoCreatePr` was on (docs/129). Branch-stranding happens regardless of
that setting, so the settings file is now passed **unconditionally** for the
`claude` agent. To keep PR enforcement opt-in, the Stop hook self-gates:

```
agent-execution.ts
  settingsPath = agentId === "claude" ? "/etc/shipit/managed-settings.json" : undefined
  autoCreatePr = autoCreatePrActive
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
| `docker/agent-hooks/block-branch-ops.mjs` | New PreToolUse hook. Node, no deps. Blocks branch create/switch, and (planning#267, armed by `SHIPIT_GUARD_DESTRUCTIVE_GIT=1`) destructive git. |
| `docker/agent-hooks/managed-settings.json` | Adds the `PreToolUse` entry (matcher `Bash`) alongside the existing `Stop` entry. Also carries `"includeCoAuthoredBy": false` (always-on, ungated) so the Claude CLI drops the `Co-Authored-By: Claude` commit trailer and the `🤖 Generated with Claude Code` PR footer — ShipIt owns the commit/PR surface, so the upstream attribution is noise. Takes effect on the next session-worker image rebuild (the file is `COPY`'d in, not mounted). |
| `docker/agent-hooks/stop-pr-check.sh` | Early-exits unless `SHIPIT_AUTO_CREATE_PR=1` — PR enforcement stays opt-in now that the settings file is always wired up. |
| `docker/Dockerfile.session-worker.{prod,dev,dogfood}` | `COPY` + `chmod` the new hook into `/etc/shipit/agent-hooks/`. |
| `src/server/shared/types/agent-types.ts` | `AgentRunParams.autoCreatePr?: boolean` — new optional field. |
| `src/server/session/claude.ts` | `ClaudeRunOptions.autoCreatePr`; sets `SHIPIT_AUTO_CREATE_PR=1` in the CLI spawn env when true. |
| `src/server/session/agents/claude-adapter.ts` | Forwards `autoCreatePr` from `AgentRunParams` into `ClaudeRunOptions`. |
| `src/server/orchestrator/ws-handlers/agent-execution.ts` | `settingsPath` is now unconditional for `claude`; passes `autoCreatePr: autoCreatePrActive`. |

planning#267 additions:

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
| `src/server/session/agent-shim/block-branch-ops.test.ts` | Runs the real hook with `node`: ~15 blocked forms (incl. compound commands, env prefixes, git global options), ~15 allowed forms, and fail-open cases. planning#267 adds the destructive-git matrix: blocked-when-armed, untouched-when-not, sandbox-exempt, `shipit branch reset-to-base` allowed, and branch ops still getting the branch-op message. The third rule adds its own matrix: self-matching loops **and** one-shot checks blocked, every caller-excluding form allowed, the two message variants, and the backtracking deadline. |
| `src/server/orchestrator/session-agent-run-params.test.ts` | planning#267: the guard arms iff the session row carries `mergedHeadSha` (off when unmerged, cleared, missing, or sandbox). |
| `src/server/orchestrator/agent-run-params-prep.test.ts` | planning#267: Claude's hook forwards `guardDestructiveGitActive` → `guardDestructiveGit`, defaulting false. |
| `src/server/session/agents/claude/process.test.ts` | planning#267: `SHIPIT_GUARD_DESTRUCTIVE_GIT=1` is set in the spawn env iff `guardDestructiveGit` is true. |
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
