# Sub-agents — `shipit agent run`

`shipit agent run` spawns **another** agent for a one-shot sub-task and gives you
its final text back, synchronously, in the same turn. Use it when the user wants
a second model's eyes or hands — "review this", "ask another model to draft the
migration" — without you leaving the session or surrendering the session's
pinned agent.

This is a generic delegation primitive with a review path built into it. **What
a run executes on is named by a ROLE** — a unit the user configured in ShipIt's
Settings, which already holds the harness, the model and the reasoning level. All
you supply is the name:

- **`--role reviewer`** asks for a review and lets ShipIt pick the reviewer, from
  settings the user owns. This is the normal case.
- **`--role NAME`** starts any other role the user configured. `shipit agent
  roles` lists what this install has.
- **A parameter the user asked to change rides alongside** — `--role deep-dive
  --model X`. The role supplies everything you did not name. **Relay** an
  override the user asked for; never **decide** one yourself.

If the role you need does not exist, say so — the user creates it in Settings.
And if repository policy hands you a **complete target** (a command naming every
parameter it runs on), pass it through **unchanged**: that is a different
invocation and it stays available. What you may never do is assemble one
yourself.

## When to use it

The user says something like:

- "review this" / "get a second opinion from another model"
- "ask another model to write the test fixtures for this"
- "have a second model explain how this subsystem works"

Recognize the intent and run the command yourself. There is no slash command and
no button — the natural-language request is the trigger.

**Do not choose the reviewer yourself.** When the user just asks for a review,
`--role reviewer` alone is the whole answer: which model reviews is a ShipIt
setting, not a judgement call you make per turn, and it is what keeps the
reviewer distant from the implementer when the implementer changes. Tell the user
which reviewer actually ran and that ShipIt's own reviewer settings are where
they change it.

**When the user names one themselves** — "review this with Codex", "review it
with Opus at high effort" — that is an override you **relay** onto the role, not
a reviewer you picked. Relaying it sets the distance guarantee aside (see
*Overrides*), so the review can land on the model that wrote the code; that is
the user's call. The line is between a value they said and a value you supplied —
the second is you choosing a reviewer, whatever it is dressed up as.

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
shipit agent run --role NAME [OVERRIDE…] --prompt-file FILE [--json]
shipit agent roles [--json]
shipit agent params [--json]
shipit agent result [RUN-ID] [--wait [--timeout SECONDS]] [--json]
```

- **`--prompt-file`** (required) — the prompt, read from a file or
  from **stdin** with `--prompt-file -`. There is no inline `-p`/`--prompt` flag:
  a prompt on the command line gets mangled the moment it contains backticks or
  `$(...)`. Use a single-quoted heredoc, exactly like `gh pr create --body-file -`.
- **`--json`** (optional) — print the full result object instead of just the
  text.

### The role — `--role NAME`

Names **what you want done**, not who does it. A role is a complete unit the user
configured: starting one needs nothing added to it, which is why the whole
invocation is one word.

`--role reviewer` is the one role ShipIt ships and the one whose target it
resolves per run: it ranks the two configured reviewers by distance from what
*you* are running — a different model family first, then a different model, then
a different harness, degrading to the best difference the install actually
offers. It is resolved and routed once, when the spawn is admitted, so a retry
cannot quietly move the review onto a different model. The reviewer always
exists, even on an install where nobody has configured anything.

An unknown role name is refused, and the refusal lists the roles that do exist —
so a wrong guess corrects itself rather than falling back to something else.

### Overrides — relay, never decide

Any parameter a role carries may be overridden when you start it, and you name
only what changes:

```
shipit agent run --role deep-dive --model claude-opus-5 --prompt-file - <<'EOF'
…
EOF
```

The role supplies the rest. An invalid override is **refused by name**, never
quietly dropped — a dropped override would run something other than what was
asked for.

**The rule that matters: an override is the USER's, and you relay it.** You may
carry "review this with Opus at high effort" because the user said so. You may
not decide on your own that a run deserves a different model or a deeper
reasoning level. ShipIt cannot tell a relayed value from an invented one, so this
rule lives here rather than in anything it can detect. **Default to a bare role**
— it is shorter, and it keeps what runs anchored to something the user chose.

Overriding `--role reviewer` also sets its distance guarantee aside: once you
have named what to run, ShipIt does not overrule you, and the review may land on
the very model that wrote the code. That is the caller's call to make, not yours
to make for them.

### Seeing what exists — `shipit agent roles` and `shipit agent params`

You can only name what you can see, so both are readable from inside the session:

```
shipit agent roles     # every role on this install: name, what it is for, what it runs on
shipit agent params    # every parameter an override may name here, and the flag that names each
```

`roles` is how you map an intent onto a role ("review the PR" → `reviewer`) and
how you tell the user what exists. `params` is what makes an override name
something **real**: it prints this install's harnesses, their reasoning levels,
and the models each can run with the service and billing mode that serve them —
so you never name a model from memory that this install does not have. A role
that cannot run right now is still listed, with the reason.

Both take `--json`. Neither is an invitation to assemble a target from scratch: a
role plus an override does the same job in less.

### Not the same as a child session

`shipit agent run` returns its output to you; `shipit session create` starts a
sibling session with its own branch and pull request. **Both take the same target
vocabulary** — a role, a role with any subset of its parameters overridden, or a
complete target — through one parser and one refusal rule, so `--role deep-dive`
and `--role deep-dive --effort high` mean the same thing on either command.

They differ in exactly one thing, and it is the one thing a child has that a
one-shot run does not: **a parent to complete a partial call from.**

| Path | What it runs on |
|---|---|
| `shipit agent run --role NAME` | the role, with anything you overrode |
| `shipit agent run` (no role) | **refused** — a one-shot run has nothing to complete itself from |
| `shipit session create --role NAME` | the role, resolved once at creation; the child then routes like any other session |
| `shipit session create` (no role) | **inherited from you**, with any parameter you named overriding it |

So `shipit session create --model claude-opus-5` is a complete, valid command —
the parent supplies the rest — while a one-shot run given only that one flag is
refused for the parameters it did not name. A role hands a child its *starting*
point, not a binding: the child keeps ordinary routing, account failover and
model-retirement behaviour for the rest of its life, and editing the role later
does not reach back into it.

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
  chosen when ShipIt is deployed, so a harness a role names — or one you named as
  an override — may simply not be present here, and the command then fails with
  "<name> is not installed in this deployment". That is not something you or the
  user can fix from inside a session; report it and carry on without the second
  opinion. `shipit agent params` lists only harnesses that are actually here, so
  an override read from it never hits this.
- **A role can still find nobody, and *why* decides the remedy.** Where the role
  names its own target, the refusal distinguishes three cases and you should relay
  it rather than guessing: the role's model, service or harness **no longer
  exists** (it needs an edit in Settings); the service it names has **no usable
  credential** (reconnect that service — the role itself is fine, and telling the
  user to edit it is the wrong advice); or the account is **quota-exhausted**
  (nothing to fix, it recovers when the quota resets). `shipit agent roles` marks
  an unavailable role with the same reason. **`--role reviewer` is the exception**:
  when *neither* configured reviewer can run, the ranking cannot attribute a
  single cause, so its refusal names both remedies at once — connect a service, or
  wait for the quota. Pass that on as it stands rather than picking one. In none
  of these is the run silently downgraded onto something else.
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
