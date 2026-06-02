---
description: The shipit-review MCP tool gets stuck in a permission-denied loop in subagents and re-invoked agents, with no UI prompt for the user to approve.
---

# `mcp__shipit-review__submit_review_comments` permission denial loop

## Symptom

When an agent (subagent or freshly-spawned agent) attempts to call
`mcp__shipit-review__submit_review_comments`, the call returns an error
of the form:

```
Claude requested permissions to use mcp__shipit-review__submit_review_comments,
but you haven't granted it yet.
```

The agent's retries surface the same error. Crucially, **the user is
never shown a permission prompt** in the UI for this MCP call — so the
agent has no path to recovery short of asking the user to approve out
of band.

## Where it was observed

In a session reviewing `docs/145-quick-capture-overlay/plan.md`:

1. Parent agent spawned a general-purpose subagent to perform the
   review (to avoid first-person bias on a file the parent had edited).
2. Subagent did the review correctly, prepared 13 comments, called
   `mcp__shipit-review__submit_review_comments` exactly once with the
   findings as a single array — and was rejected with the error above.
3. Subagent reported the blockage back to the parent and exited.
4. Parent re-spawned a fresh subagent with the same brief. Same
   outcome — review done, submission blocked.
5. Parent loaded the tool schema in its own context via `ToolSearch`
   (which DID surface a permission prompt — the user approved it) and
   called the tool directly to relay the subagent's findings. **The
   call was still rejected with the same "permission not yet granted"
   error**, even though the schema-load prompt had been approved.
6. A second identical retry from the parent got the same rejection,
   with no new UI prompt.

So the permission state has at least two distinct gates — schema-load
and tool-invocation — and approving the first one does not advance the
second one. And whichever gate governs tool-invocation does not appear
to surface a UI prompt at all (or surfaces one the user does not see).

## Why this matters

The whole point of the `shipit-review` MCP server is to let a *fresh*
reviewer (typically a subagent) submit anchored comments without the
parent author getting in the loop. If the only way to actually
submit comments is for the parent to call the tool — and even that
path is intermittently blocked — then the review workflow degenerates
to "parent prints the comments inline as text," which:

- defeats the anchoring (no `submit_review_comments` round-trip means
  comments aren't attached to lines/sections in the UI)
- defeats the audit trail (no record that a review actually ran)
- forces the parent to relay findings the subagent generated, which
  is exactly the bias-laundering the review workflow was set up to
  avoid

## Likely culprits (places to look first)

1. **Permission scope between parent and subagent.** When the parent
   has been granted permission for an MCP tool, that grant may not
   propagate to subagents (or to subagents spawned in a later turn).
   If subagent MCP calls always need their own user prompt, the prompt
   plumbing has to actually fire — and right now it doesn't.

2. **Permission-prompt plumbing for the second gate.** The
   schema-load gate via `ToolSearch` did surface a prompt. The
   tool-invocation gate did not. Whatever the difference is between
   those two gates is probably the bug — the second one is missing
   the UI-prompt path.

3. **Cached "denied" state.** Once the call is rejected once, the
   denial may be cached so that retries don't re-prompt the user.
   This would explain why two back-to-back invocations from the
   parent got identical "not granted" errors with no intervening UI
   activity.

## Reproduction recipe

1. Open a ShipIt session with the `shipit-review` MCP server enabled
   (any session — the bug isn't repo-specific).
2. Spawn a subagent and prompt it to read any markdown file and call
   `mcp__shipit-review__submit_review_comments` with `comments: []`
   (an empty review is the cheapest reproducer).
3. Observe: the subagent gets the "permission not yet granted" error.
   No UI permission prompt appears.
4. Retry from the parent context after loading the tool schema via
   `ToolSearch`. Same error. No UI prompt.

## What good looks like (acceptance criteria)

- A subagent's first attempt to call an MCP tool that requires
  permission surfaces a UI prompt to the user, and approving it lets
  the subagent's call complete.
- Approval persists for the session so subsequent calls of the same
  tool by the same subagent don't re-prompt.
- If the user denies, the agent gets a *distinct* error
  (`permission-denied`) so it knows to stop retrying, rather than the
  current ambiguous "not yet granted" which reads as a transient race.
- The parent's tool-invocation gate uses the same prompt plumbing as
  the schema-load gate — approving one approves both, or the user is
  prompted exactly once for the combined grant.

## Out of scope

- The contents of the review that triggered this (already folded
  into `docs/145-quick-capture-overlay/plan.md` directly).
- The broader question of when ShipIt should allow subagents to use
  MCP tools at all — that's a policy question, not a bug.

## Workaround

Until this is fixed, MCP-submitting review subagents have to fall
back to printing their findings as text and letting the parent
manually fold them into the doc (or, if line-anchored comments are
critical, the user approves the tool out of band before the
subagent runs). Both workarounds are friction-heavy and defeat the
point of the review tool.

## Root cause

The `shipit-review` MCP server is registered in the per-run
`mcp.json` that `session-worker.generateMcpConfig` writes — it sits
alongside `playwright` as a *built-in* server, not a user-configured
one, so it never flows through `params.mcpServers` /
`mcpServerNames`. The `--allowedTools` glob assembly in
`ClaudeProcess.run` / `StreamingClaudeProcess.run` only adds an
`mcp__<name>__*` entry for *user* MCP servers, and the hardcoded
allowlist mentions only `mcp__playwright__*`.

The Claude CLI in `-p` (print) mode has no interactive prompt path:
when a tool is connected but not allowlisted, it returns the
literal "Claude requested permissions to use … but you haven't
granted it yet" error and never escalates to the orchestrator's
permission UI. The user sees nothing to approve, the agent retries
into the same wall, and a subagent inherits the parent's allowlist
so spawning a fresh one doesn't change the outcome.

The misleading "two gates" feeling in the symptom is a side effect:
`ToolSearch` runs in the harness's own deferred-tool plumbing
(separate from the CLI allowlist), so loading the schema *did*
surface a prompt; the actual tool *invocation* runs through the
CLI's allowlist, which never prompted because there's nothing to
prompt.

## Fix

Add `mcp__shipit-review__*` to both `AUTO_TOOLS` and `PLAN_TOOLS`
in `src/server/session/claude.ts` (and the matching
`StreamingClaudeProcess.run` copy). The tool only writes to
ShipIt's review-draft state — not to source files — and the
server-side authorization gate (`runner.activeReviewFilePath` in
`api-routes-reviews.ts`) already restricts which file each turn
can submit against, so allowlisting it under plan mode does not
expand the trust boundary.

Coverage lives in `src/server/session/claude.test.ts` —
parameterized across `auto` / `plan` / `guarded` so future allowlist
churn can't silently drop the entry from any mode.
