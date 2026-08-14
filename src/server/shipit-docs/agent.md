# Sub-agents — `shipit agent run`

`shipit agent run` spawns **another** agent for a one-shot sub-task and gives you
its final text back, synchronously, in the same turn. Use it when the user wants
a second model's eyes on the work — "review this" — without you leaving the
session or surrendering the session's pinned agent. A second model's *hands*
("draft the migration") are reachable too, but only under the conditions the
next section states.

The command has two shapes, and which of them you can reach is decided for you:

- **Name the ROLE.** `--role reviewer` asks for a review and lets ShipIt pick the
  reviewer, from settings the user owns. This is the only shape you can reach on
  your own initiative, and it is the normal case.
- **Name EVERYTHING.** An explicit run states the harness, the service, the
  billing mode, the model and the reasoning level. Nothing is filled in from a
  stored default, so an incomplete call is refused. Use this shape only when all
  five values were handed to you — by the user, or by a repository's own
  instructions overriding ShipIt's reviewer.

The two do not mix, and a call in between is rejected with an error naming what
is missing (docs/261).

**So a delegation that is not a review is usually not available to you.** There
is no role for it, and you cannot complete the explicit shape yourself: nothing
in this container lists the service ids, the model ids or the reasoning levels,
and guessing them is forbidden below. When the user asks for one without naming
every parameter, say which parameters are missing and let them decide.

## When to use it

The user says something like:

- "review this" / "get a second opinion from another model"

Recognize the intent and run the command yourself. There is no slash command and
no button — the natural-language request is the trigger.

A request that is **not** a review — "ask another model to write the test
fixtures", "have a second model explain this subsystem" — reaches the same
command, but only through the explicit shape. Run it when the user named all
five parameters. When they did not, tell them which ones are missing instead of
choosing them. Often what they want is reachable another way: `Task` for a
fan-out under your own model, or `shipit session create --agent <id>` for work
that gets its own branch and PR.

**Do not choose the reviewer yourself, and do not guess to fill the explicit
shape out.** If the user names a backend ("review this with Codex") without
naming a service, a billing mode, a model and an effort, use `--role reviewer`:
which model reviews is a ShipIt setting, not a judgement call you make per turn,
and it is what keeps the reviewer distant from the implementer when the
implementer changes. Tell the user which reviewer actually ran and that ShipIt's
own reviewer settings are where they change it.

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
shipit agent run --role reviewer --prompt-file FILE [--json]
shipit agent run --agent claude|codex --service S --billing-mode sub|key \
                 --model M --effort LEVEL --prompt-file FILE [--json]
shipit agent result [RUN-ID] [--wait [--timeout SECONDS]] [--json]
```

- **`--prompt-file`** (required, both shapes) — the prompt, read from a file or
  from **stdin** with `--prompt-file -`. There is no inline `-p`/`--prompt` flag:
  a prompt on the command line gets mangled the moment it contains backticks or
  `$(...)`. Use a single-quoted heredoc, exactly like `gh pr create --body-file -`.
- **`--json`** (optional) — print the full result object instead of just the
  text.

### The role — `--role reviewer`

Names **what you want done**, not who does it. ShipIt resolves the reviewer from
its own settings and ranks the two configured reviewers by distance from what
*you* are running: a different model family first, then a different model, then a
different harness, degrading to the best difference the install actually offers.
The reviewer is resolved and routed once, when the spawn is admitted, so a retry
cannot quietly move the review onto a different model.

`--role` may not be combined with any of the five explicit flags — a call
carrying both is asking two different questions ("who should review this?" and
"run exactly this model"), and is refused.

### The explicit run — all five, or nothing

Outside a role you name everything the run executes on:

- **`--agent`** — the harness to spawn (`claude` or `codex`).
- **`--service`** and **`--billing-mode`** (`sub` for a subscription, `key` for a
  metered API key) — together with `--model` these identify *which* offering
  runs, because one model id can be served by several services and only the pair
  says which credential pays.
- **`--model`** — the model id as the catalogue lists it for that service.
- **`--effort`** — the reasoning level, validated against the named harness's own
  levels. An unrecognized level is an error, not a silently dropped flag.

**Omitting any of them is an error**, and the message names the missing flags.
Nothing is filled in from a stored setting, so a half-specified call can never be
completed from somewhere you cannot see.

**And there is no discovery command.** `shipit agent` has exactly two
subcommands, `run` and `result`; nothing in this container lists the catalogue.
So values you were not given, you cannot look up. Do not guess them. For a
review, use `--role reviewer`. For anything else, report which parameters are
missing and let the user supply them.

### Not the same as a child session

There are three ways an agent gets started, and each answers "what does it run
on" differently. Keep them apart:

| Path | What it runs on |
|---|---|
| `shipit agent run --role reviewer` | ShipIt's reviewer settings resolve it |
| `shipit agent run` (explicit) | Named in full at the call; an omission is refused |
| `shipit session create` | **Inherited from you**, with partial override (`--agent`, `--model`) |

The child-session rule is deliberately the opposite of the one-shot rule: a child
session has a parent to inherit from, and a one-shot run has nothing but its own
arguments. So `shipit session create --agent codex` is a complete, valid command,
while a one-shot run given only those same two flags is refused for the four it
did not name.

The prompt is the **single context channel**. Put everything the sub-agent needs
into it: the task, any `git diff`, file references, focus hints. The sub-agent
starts with a fresh context and sees only what you give it.

### Example — second-opinion review

```
shipit agent run --role reviewer --prompt-file - <<'EOF'
Review only — do not edit this workspace.

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
surfaces the sub-agent's verbatim output inline, in the persisted consult card,
attributed to the agent that ran it (docs/220). So treat stdout as input for
*acting*, not as something to re-type into chat — re-pasting it just duplicates
what the card already shows.

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

**Do not pipe the run through `tail`, `head`, `grep`, or any other filter.** The
sub-agent's report *is* the deliverable, and a review is long precisely when it
matters — the findings you most need are as likely to be at the top as the
bottom. Backgrounding invites this mistake, because trimming a command's output
is a reasonable habit everywhere else; here it silently throws away most of a
consult that cost many minutes and a lot of tokens. Let it print in full and read
it. If you only want to check whether a run has *finished*, that is the exit
code's job (see below), not a `grep`.

If a run does get killed — or you truncated its output — the work is not lost:
the spawn completes server-side and its output is persisted. Fetch it with:

```
shipit agent result            # the most recent run in this session
shipit agent result <RUN-ID>   # a specific run (a unique id prefix works)
```

That prints the same artifact the user sees in the card. Use it to recover a
lost result, or to double-check that what you acted on is what was rendered.

A run that is **still in flight** has a card too — `shipit agent result` reports
it with status `pending` rather than pretending it doesn't exist. The user sees
the same thing: the consult card appears in the transcript the moment the run
starts, shows an in-progress row for the duration, and turns into the finished
record when the run ends. So a backgrounded consult is visible to the user the
whole time, and neither of you has to guess whether it is still going.

### Waiting for a backgrounded run — use `--wait`, never a poll loop

```
shipit agent result <RUN-ID> --wait                  # block up to 5 minutes
shipit agent result <RUN-ID> --wait --timeout 600    # …or up to 10, max 30
```

`--wait` returns as soon as the run reaches a terminal status. It absorbs
dropped connections beneath your timeout, so a network blip costs a few seconds
rather than the whole wait. If the timeout elapses with the run still going it
exits **4** and prints the command to resume — every call re-derives the answer
from the persisted card, so an interrupted wait has lost nothing. Pick a
`--timeout` that fits under your own shell's foreground cap and re-run as needed.

**Branch on the exit code, never on the output text:**

| Exit | Meaning |
|---|---|
| `0` | The run finished successfully. |
| `4` | Still running (no `--wait`, or the wait timed out). |
| `3` | The run failed — errored, timed out, or was cancelled. |
| `1` | The lookup failed: unknown run id, ambiguous prefix, orchestrator unreachable. |
| `2` | Bad invocation (unknown flag, two run ids, `--timeout` without `--wait`). |

Do **not** write a `sleep`-and-`grep` loop:

```sh
# WRONG — gives up after 45s on a run that can last 30 minutes, and a finished
# review whose text happens to contain "pending" reads as still-running.
for i in 1 2 3; do sleep 15; shipit agent result "$ID" 2>&1 | tee /tmp/r.txt;
  if ! grep -q 'pending' /tmp/r.txt; then break; fi; done

# RIGHT
shipit agent result "$ID" --wait --timeout 540
```

"Still running" (`4`) is deliberately distinct from every failure code: a bare
retry-until-it-succeeds loop would otherwise spin forever against a mistyped run
id or a bad flag, since neither condition can ever clear.

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
  prompt**. Any files it writes are committed for you: if the run finishes while
  your turn is still open, they ride your turn's ordinary end-of-turn commit; if
  it outlives your turn (the normal shape for a backgrounded consult), they are
  committed and pushed on their own as soon as it finishes, under a commit named
  `Sub-agent consult (<agent>): work committed after the turn ended`. Either way
  you do **not** need to commit them yourself, and they will not be sitting
  uncommitted when the PR is reviewed.

## Limits

- **Opt-in.** The feature only works when the user has enabled **Settings →
  Multi-agent sessions**. Otherwise the command returns a clear "disabled" error.
- **Only harnesses this deployment installed.** Which agent CLIs an install has is
  chosen when ShipIt is deployed, so a backend an *explicit* call names may simply
  not be present here — the command then fails with "<name> is not installed in
  this deployment". That is not something you or the user can fix from inside a
  session; report it and carry on without the second opinion. `--role reviewer`
  never hits this: ShipIt only ever picks a harness that is installed and has a
  usable credential.
- **A role can still find nobody.** If neither configured reviewer has a
  credential that can run right now — none connected, or every account
  quota-exhausted — the run is refused rather than silently downgraded. Say so; the
  fix is in ShipIt's reviewer settings or a quota reset, not in your prompt.
- **No recursion.** A spawned sub-agent cannot itself spawn a sub-agent.
- **At most 3 spawns per turn.** Enough for "review with both other models" or a
  couple of delegations. A 4th returns an error without spawning. The budget
  refills whenever a new instruction from the user arrives — a new turn, or a
  message they type while you are still working — so a long session never runs
  out permanently. A background job finishing does not refill it.
- **Bounded run.** Each spawn has a wall-clock cap (~30 min) and an output cap; an
  over-limit run is truncated and flagged.
- **Cancel is symmetric.** If the user cancels your turn while a sub-agent is
  running, the sub-agent is cancelled too.
