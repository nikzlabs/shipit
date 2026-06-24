# Sub-agents — `shipit agent run`

`shipit agent run` spawns **another** registered agent for a one-shot sub-task
and gives you its final text back, synchronously, in the same turn. Use it when
the user wants a second model's eyes or hands — "review this with Codex", "ask
Claude to draft the migration" — without you leaving the session or surrendering
the session's pinned agent.

This is a generic delegation primitive, not a review tool: you spawn any
registered agent with any prompt and read its text back. Review is just the most
common prompt shape.

## When to use it

The user says something like:

- "review this with Codex" / "get a second opinion from the other model"
- "ask Claude to write the test fixtures for this"
- "have Codex explain how this subsystem works"

Recognize the intent and run the command yourself. There is no slash command and
no button — the natural-language request is the trigger.

**Never reach for the raw `codex` / `claude` CLI to do this.** Per-agent
credential isolation mounts only *your* pinned agent's credentials in this
container, so invoking the other backend's bare CLI fails with **401
Unauthorized**. `shipit agent run` is the only authenticated path — it brokers
through the orchestrator, which supplies the spawned agent's credentials
server-side.

For an in-turn fan-out under your *own* model (parallel research, parallel
codegen you'll synthesize), prefer the built-in `Task` tool. `shipit agent run`
is for a *different* agent (or a deliberately fresh-context helper).

## The command

```
shipit agent run --agent claude|codex --prompt-file FILE [--model M] [--json]
```

- **`--agent`** (required) — the agent to spawn (`claude` or `codex`). May be the
  same provider as you (a fresh-context helper) or a different one.
- **`--prompt-file`** (required) — the prompt, read from a file or from **stdin**
  with `--prompt-file -`. There is no inline `-p`/`--prompt` flag: a prompt on
  the command line gets mangled the moment it contains backticks or `$(...)`.
  Use a single-quoted heredoc, exactly like `gh pr create --body-file -`.
- **`--model`** (optional) — a model alias/id for the sub-agent.
- **`--json`** (optional) — print the full result object instead of just the
  text.

The prompt is the **single context channel**. Put everything the sub-agent needs
into it: the task, any `git diff`, file references, focus hints. The sub-agent
starts with a fresh context and sees only what you give it.

### Example — second-opinion review

```
shipit agent run --agent codex --prompt-file - <<'EOF'
Review this diff for correctness bugs and security issues. Report each finding
as `file:line — comment`. Be concise; skip praise.

$(git diff)
EOF
```

The command prints the sub-agent's findings on stdout. You read them and **act**
— fix what's real, or summarize. You do **not** need to paste the output back for
the user to see it: ShipIt surfaces the sub-agent's verbatim output inline, in
the persisted "Consulted Codex" card, with attribution (docs/220). So treat
stdout as input for *acting*, not as something to re-type into chat — re-pasting
it just duplicates what the card already shows.

## What to expect

- **It blocks.** The command runs until the sub-agent finishes — typically
  30–120s for a review-sized task. That's normal; wait for it like any long
  shell command.
- **Output is plain text** on stdout (exit 0), or a clear error on stderr with a
  non-zero exit (feature disabled, unknown agent, cap exceeded, crash, timeout,
  cancel).
- **The sub-agent runs full-capability** in the *same* workspace — it can read,
  write, and run shell. If you want it to only review (not edit), **say so in the
  prompt**. Any files it writes are committed under the session's pinned agent at
  the end of your turn, same as your own changes.

## Limits

- **Opt-in.** The feature only works when the user has enabled **Settings →
  Multi-agent sessions**. Otherwise the command returns a clear "disabled" error.
- **No recursion.** A spawned sub-agent cannot itself spawn a sub-agent.
- **At most 3 spawns per turn.** Enough for "review with both other models" or a
  couple of delegations. A 4th returns an error without spawning.
- **Bounded run.** Each spawn has a wall-clock cap (~30 min) and an output cap; an
  over-limit run is truncated and flagged.
- **Cancel is symmetric.** If the user cancels your turn while a sub-agent is
  running, the sub-agent is cancelled too.
