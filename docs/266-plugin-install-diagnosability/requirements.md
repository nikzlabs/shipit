---
title: A live plugin version that is broken must be diagnosable and retryable from a session
description: A consuming session can read why the live plugin version is unusable, and can force a re-install of that same version without waiting for the plugin author.
---

# Plugin install diagnosability and retry — requirements

Human-owned. Numbered statements are what the feature must do, in the reporter's
terms — observable outcomes, never mechanism. Gaps the agent had to fill live
under **Open questions** until a human answers them.

## Context, in the reporter's words

Filed as nikzlabs/shipit#2323 by a plugin author, as a follow-up to
nikzlabs/shipit#2315 (whose `dep-dirs` and install-wording fixes shipped in
a93dc730 and are explicitly **not** in scope here).

A consuming project reported that every surface of their plugin failed at run
time. From that session:

- `shipit plugin refresh` exited **0** and reported the commit live;
- the Plugins tab reported the plugin active, exports listed, no warnings;
- every surface failed, because the checkout held no built code;
- re-activating did not re-run the install, and flipping the declaration
  `branch:` → `pin: <sha>` → `branch:` reported "already at `<sha>`" both times;
- unchanged after 12 minutes, so not an install still running.

The author could not determine, from a session, whether that install had
**failed** or had **succeeded and produced the wrong thing** — two conditions
with opposite fixes. They picked one, shipped it, and read the consumer's later
"it works now" as confirmation. It confirmed nothing: a new generation had
shipped at the same time, whose install ran for the first time. The wrong
diagnosis stood in their design docs for two days.

Their framing, which is the point of this feature: the platform is not being
asked to prevent a bad inference. It is being asked to make the one artifact
that settles it reachable, and to stop making "the author shipped something and
it started working" the normal recovery path — because that signal is confounded
and looks reliable.

Two conditions are explicitly **not** in scope, at the reporter's request: any
change to `dep-dirs` behaviour, and anything that makes plugin containers
writable.

## Requirements

1. From inside a consuming session, an agent can determine whether the plugin
   version that is currently live is usable — without a human reading the
   Plugins tab, and without the plugin author being involved.
2. When it is not usable, the same answer says **why**, specifically enough to
   tell a failed install apart from an install that succeeded and produced the
   wrong tree. Those have opposite fixes, and picking between them is the whole
   diagnostic question.
3. The answer includes the outcome of the last install for the live version:
   whether it ran at all, and whether it succeeded or failed. Exit status alone
   is enough to settle the case above; output is better.
4. When an install failed, its output is readable from the session, so the
   consumer can quote it into an issue filed on the plugin repository. Evidence
   that only a human looking at a panel can see does not reach the plugin
   author, which is where the fix has to happen.
5. A consumer can retry: force the install to run again for the version that is
   already live, without the plugin author publishing a new commit.
6. That retry is available whatever caused the bad version — a transient
   registry or network failure and a real defect in the plugin are
   indistinguishable to the consumer, and both must be locally recoverable.
7. `shipit plugin refresh` does not report plain success when the live version's
   install did not complete. The docs already promise that a *failed* refresh is
   distinguishable from a working one specifically so "nothing is broken, but
   you are not running what you think" is visible; a live-but-unusable version
   gets the same courtesy.
8. Nothing in this feature changes `dep-dirs` behaviour, and nothing in it makes
   a plugin's checkout or containers writable.

## What is already true (verified, not requirements)

Checked against the code on 2026-08-16, so the design does not re-solve solved
parts and does not inherit a guarantee that is not there:

- A refresh **whose own round failed** does exit non-zero and does print the
  failure detail, which carries the tail of the install's output
  (`plugin-install.ts` `logTail`, `services/plugin-refresh.ts`,
  `agent-shim/shipit-plugin.ts`). The gap is durable state: a session that opens
  onto an already-broken live version has no round of its own to report.
- The "active but not installed" condition IS recorded, on the live generation's
  `manifestWarnings` (`plugin-generations.ts`), and reaches the Plugins card and
  the tab's HTTP snapshot (`api-routes-plugin-repos.ts`) — and **deliberately**
  does not reach the refresh row, which carries only that round's own warning.
  So the fact the reporter needed exists; only the session cannot read it.
- There is no force path. `activateGeneration` returns `unchanged` when the
  resolved commit equals the live one, before any staging or install
  (`plugin-generations.ts`), which is exactly the reported "already at `<sha>`".
- `shipit plugin` exposes `refresh` and `exec` only
  (`agent-shim/shipit-plugin.ts`).

## Open questions

- **What surface answers requirements 1–4?** The issue offers two shapes:
  `shipit plugin logs [name]`, or the last install's exit status and output on
  `shipit plugin refresh --json`. A third fits what was actually verified above
  — a read verb (`shipit plugin status [name]`) that reports the live version
  and why it is degraded, since the failure the reporter hit is durable state
  rather than the outcome of any round they could run. Which surface does ShipIt
  want to own, and should it be one verb or two?
- **What should `refresh` exit when the live version is degraded but this
  round did nothing?** Non-zero (matching req 7 literally, and matching the
  existing "you are not running what you think" precedent) changes the exit code
  of a command that today succeeds, for a condition that is not new. A line of
  output with exit 0 is weaker but breaks nothing. Which?
- **Is "usable" broader than the install?** A version can also be live with a
  withheld command, a rejected service fragment, or a settings mismatch — all
  already on the card, all equally unreadable from a session. Does this feature
  cover every reason a live version is degraded, or only the install?

## Resolved questions

_None yet._
