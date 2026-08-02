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

The broker selects among connected subscription accounts using the same quota
policy as an ordinary session turn. If the selected account reports hard quota
exhaustion, the run is retried once on the next eligible account for that same
provider. It never falls through to a pay-as-you-go API key, and model-access
errors are returned as-is rather than routed around.

For an in-turn fan-out under your *own* model (parallel research, parallel
codegen you'll synthesize), prefer the built-in `Task` tool. `shipit agent run`
is for a *different* agent (or a deliberately fresh-context helper).

## The command

```
shipit agent run --agent claude|codex --prompt-file FILE [--model M] [--json]
shipit agent result [RUN-ID] [--json]
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

The command prints the sub-agent's findings on stdout. **A review you asked for
is input to your work, not the deliverable.** Triage the findings in the same
turn: fix the ones that are real, and say which ones you are not acting on and
why. Relaying the list and ending the turn is not a completed task — it leaves
the user to do the triage you were asked to do. The one exception is a finding
whose fix needs a decision or authority you don't have; ask about *that* finding
and act on the rest.

You also do **not** need to paste the output back for the user to see it: ShipIt
surfaces the sub-agent's verbatim output inline, in the persisted "Consulted
Codex" card, with attribution (docs/220). So treat stdout as input for *acting*,
not as something to re-type into chat — re-pasting it just duplicates what the
card already shows.

**Your copy and the user's copy are the same document.** stdout and the card are
written from one string, so there is no "the UI has more" — if you and the user
appear to be reading different reports, you are looking at two different *runs*
(each `shipit agent run` is its own run and its own card). Every run prints its
id on stderr; use it to say which one you mean.

## Run it in the background if it may be long

**A consult can run up to 30 minutes; your shell tool almost certainly can't.**
Claude Code's Bash tool caps a foreground command at 10 minutes and SIGTERMs it
on expiry — and because output only arrives at exit, a killed foreground run
hands you *nothing*, even though the sub-agent kept working. So for anything
review-sized or open-ended, **launch it in the background** (`run_in_background`),
which has no cap, and collect the output when it finishes.

If a run does get killed, the work is not lost — the spawn completes
server-side and its output is persisted. Fetch it with:

```
shipit agent result            # the most recent run in this session
shipit agent result <RUN-ID>   # a specific run (a unique id prefix works)
```

That prints the same artifact the user sees in the card. Use it to recover a
lost result, or to double-check that what you acted on is what was rendered.

## What to expect

- **It blocks, and how long is not predictable.** The command runs until the
  sub-agent finishes. A narrow question can come back in well under a minute,
  but a real consult — an audit, a review of a large diff, a generation task —
  routinely runs for many minutes, up to the 30-minute cap. (That cap started
  at 5 minutes and was raised precisely because real consults kept overrunning
  it.) So assume "long" unless the prompt is small, and wait for it like any
  long shell command — in the background if it may exceed your tool's
  foreground limit.
- **You get the sub-agent's whole answer**, not just its last message. A run
  that produces several messages (a long report, then a wrap-up) returns all of
  them, in order.
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
