---
issue: https://linear.app/shipit-ai/issue/SHI-306
title: Waiting on a sub-agent run
description: A caller that backgrounded `shipit agent run` can learn when it finished without scripting a sleep/grep loop.
---

# Requirements — waiting on a sub-agent run

## Context

`shipit agent run` blocks until the sub-agent exits, but a review-sized consult
routinely runs longer than the calling agent's own shell cap (10 minutes in
Claude Code; Codex has its own). So callers background the run and then have to
work out, from outside, whether it has finished.

Today there is no signal to work from. `shipit agent result` exits `0` whatever
the run's status, so the only way to detect "not done" is to grep the printed
text for the word `pending` — which a *finished* code review can easily contain.
The observed workaround in the field was:

```sh
for i in 1 2 3; do
  sleep 15
  shipit agent result <ID> 2>&1 | tee /tmp/out.txt
  if ! grep -q 'pending' /tmp/out.txt; then break; fi
done
```

That gives up after 45 seconds on a run that may last 30 minutes, misreads a
finished review whose body says "pending", and spends a tool call per poll.

## Requirements

1. A caller can determine whether a sub-agent run has finished **without
   inspecting the text of its output**.
2. The caller can distinguish these outcomes from one another:
   - the run finished and succeeded,
   - the run reached a terminal state that was not success (errored, timed out,
     was cancelled),
   - the run is still going,
   - the lookup itself failed (no such run id, an ambiguous id prefix, the
     orchestrator unreachable).
3. In particular, "still going" is distinguishable from "the lookup failed", so
   a caller that retries while the run is going cannot spin forever against a
   mistyped run id.
4. A caller can **wait** for a run to finish with a single command, without
   writing its own retry loop.
5. A wait survives a dropped or reset connection beneath it: a transport blip
   costs some of the wait, not the whole wait.
6. A wait is bounded by a caller-supplied timeout. The caller can pick a timeout
   that fits under its own shell cap.
7. When a wait's timeout elapses with the run still going, that is reported as a
   distinct, non-failure outcome, and the caller is told it can re-run the same
   command to keep waiting. Waiting is therefore resumable across several
   invocations without losing progress.
8. Waiting does not change what is printed: the run's output still goes to
   stdout and the `run <id> · <agent> · <status>` line still goes to stderr.
9. A wait costs a bounded, small amount of work on the orchestrator regardless
   of how long it runs.
10. The agent-facing documentation tells a caller to use this instead of a
    sleep/grep loop, and states the exit codes it can branch on.

## Non-requirements

- Notifying the caller when a run finishes (waking it with a turn) instead of
  having it wait. That is a strictly larger mechanism and is tracked separately;
  these requirements are only about making waiting work.
- Any change to `shipit agent run` itself.

## Open questions

None. Requirements 1–10 all trace to the two follow-up actions the user approved
on 2026-08-04; nothing here was supplied by the agent.

## Resolved questions

- **2026-08-04 — exit code for "still running".** The two approved actions
  disagreed: one asked for "a distinct non-zero code" for a pending run, the
  other named `1` (docs/182's timed-out code). Resolved in favour of *distinct*
  (requirement 3): reusing `1` would collide with the lookup failures that
  already exit `1`, and a caller retrying on `1` would loop forever on a
  mistyped run id. The specific number is a mechanism detail and is recorded in
  [plan.md](./plan.md), not here.
