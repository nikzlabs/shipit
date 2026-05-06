---
status: planned
priority: medium
---

# 125 — Chat-native AI Review

## Summary

Today the unified review surface (`docs/112-unified-review-surface`) carries
an "AI Review" button that calls a dedicated server endpoint, runs an agent
out-of-band, parses its JSON output, and injects the resulting comments
back into the modal as draft entries. This doc proposes removing that
out-of-band path and replacing it with a chat-native flow: the button
composes a chat message describing what to review and submits it to the
active session's agent. The agent reviews in the dialog — with full repo
context, tool use, and the user's normal iteration affordances — and writes
its findings back into the same review draft via a tool call.

The section-anchored comment surface stays. The hidden second-LLM-process
goes away.

## Motivation

### The current design conflicts with a load-bearing product principle

`CLAUDE.md` §5 reads, in part:

> Chat is the input surface. The agent is the actor. […] We deliberately
> do not give the user shell-shaped affordances — quick-action button rows,
> command palettes that execute shell, hotkey-bound task runners, "click
> to run npm test" buttons. […] In ShipIt, they aren't a feature gap;
> they're a category mistake that nudges the product back toward the CLI
> wrapper it's trying to replace.

And the corollary:

> "Saves an LLM round-trip" is not a feature.

The "AI Review" button is exactly the affordance §5 names. It is a button
in a non-chat surface that runs an LLM action the agent could perform via
chat. The defense most likely to be raised — that going through chat
costs an extra turn — is exactly the rationale the corollary explicitly
rejects.

### The current design is fragile in production

Reviewing `services/reviews.ts:generateAiReview` and the DI wiring in
`app-di.ts`:

- The endpoint depends on a `generateText(prompt, cwd)` factory that
  spawns the agent CLI in-process and collects `agent_assistant` text
  events until done.
- In containerized mode (i.e. real production), `agentFactory` is
  undefined; the endpoint silently returns an empty array.
- The integration test file `doc-reviews.test.ts` covers CRUD and Send
  but does **not** assert that AI Review returns non-empty output.
- The client store test mocks the response.

So the feature is marked `status: done` in `docs/112-*/plan.md`, but the
deployed path no-ops without any user-visible signal. Anyone using it
in production sees the spinner, then "0 AI comments added," and has no
idea why.

### The current design loses the things that make a review useful

Even when the endpoint *does* return comments, the out-of-band agent run:

- Sees only the file under review. It can't read related plans, the
  source files the doc is about, sibling docs, or recent diffs.
- Can't be steered. The user has no way to say "ignore nits, focus on
  contradictions with `docs/095-*`" or "compare against the
  implementation in `src/server/...`."
- Can't iterate. The output is a single shot. If it's not useful, the
  user discards it; there's no "regenerate with different focus."
- Is invisible in chat history. The fact that an AI review happened
  doesn't appear in the conversation log, so the user can't refer back
  to it, and the agent in the next turn doesn't know it ran.

A chat turn fixes all four. It also costs nothing extra to build because
the chat surface already exists.

## Goals

1. **Remove the out-of-band AI Review path.** No second LLM process
   spawned by an HTTP endpoint; no `generateText` factory.
2. **Keep the unified review surface.** Section- and line-anchored
   comments, draft → sent → history, server-persisted per
   `(session, file)` — all preserved. The thing that goes away is the
   button's *implementation*, not the comment surface around it.
3. **Make AI review a chat turn that delegates to a subagent.** The
   user clicks "Ask agent to review," a structured chat message is
   composed and submitted, and the parent agent spawns a subagent to
   do the actual review. The subagent leaves anchored comments via a
   tool call. Going through a subagent is not an implementation
   detail — it is the correctness story for self-review (see
   "Subagent, not parent agent" below).
4. **Keep the user in chat for iteration.** Once the agent has reviewed,
   the user steers it the same way they steer anything else — by
   continuing the conversation.
5. **Stop silently no-op'ing in production.** Whatever ships must work
   in containerized mode or not exist at all.

## Non-goals

- **Replacing the human-comment surface.** Human-drafted section/line
  comments stay exactly as they are.
- **Touching diff review.** The diff panel's comment flow is a
  different surface and out of scope.
- **Making AI review available without the agent running.** If the user
  has no agent available (no auth, no session), there is no AI review.
  The feature is a chat turn; chat turns require an agent.
- **Persisting "AI review" as a distinct lifecycle state.** A review is
  draft → sent → history regardless of whether the comments came from
  the user or the agent.

## Proposed design

### Surface

In the file preview modal header, the existing "AI Review" button is
replaced by **"Ask agent to review."** It is enabled whenever the
session has a runnable agent and the file is one the agent can usefully
read (markdown today; expandable later — same gating logic as today,
moved to a capability check rather than a per-endpoint check).

Clicking it does exactly two things on the client:

1. Composes a structured chat message that **embeds every unaddressed
   comment verbatim** and instructs the agent to **delegate the review
   to a subagent**. "Unaddressed" means every comment in the current
   draft (by definition not yet sent), and — see open questions — the
   comments from any prior sent review on this file in this session
   that the agent's subsequent turns did not visibly resolve. The
   embedded comments matter for two reasons: they tell the subagent
   what the user already cares about (so it doesn't repeat them or
   contradict them), and they keep "what's still open" in the prompt
   instead of summarized away. The subagent matters because the parent
   agent likely *wrote* the file under review, and asking the author
   to review their own work produces sycophantic output. A subagent
   gets a fresh context window with no prior loyalty to the artifact.

   Example body:

   ```
   Review docs/064-pr-lifecycle-flow/plan.md.

   Use the Task tool to delegate this review to a subagent. You wrote
   (or recently edited) this file in the current conversation, so a
   first-person review will be biased toward defending the existing
   text. The subagent should approach the file fresh, treat it as work
   it has not seen before, and use the `add_review_comment` tool to
   leave anchored comments on the current draft.

   Focus on correctness, completeness, internal consistency, and
   contradictions with the rest of the repo. Skip nits.

   --- Existing unaddressed comments on this file ---

   ## Architecture (section, draft)
     [user] This section is too vague — what does "unified" mean in
     concrete terms?

   ## Failure modes (section, sent 2026-05-06, not visibly addressed)
     [user] What about 5xx from GitHub? Doc still doesn't say.

   line 142 (draft)
     [user] This contradicts the diagram above.

   ---

   Do not duplicate the comments above; build on them or address gaps
   they leave. If you agree with an existing comment, add a new
   comment that extends it rather than repeating it.
   ```

2. Submits that message via the existing `send_message` flow, then
   closes (or minimizes — see open questions) the modal so the user
   can watch the agent work in chat.

### Subagent, not parent agent

The chat message instructs the parent agent to invoke its `Task` tool
(or whatever the active backend's subagent primitive is) and let the
subagent perform the review. This is the load-bearing piece of the
design — it is *why* this works as a quality feature and not just as
an architectural cleanup.

Concretely:

- The parent agent is the same agent that has been writing in this
  conversation. By the time the user clicks "Ask agent to review,"
  the parent has almost certainly authored or edited the file under
  review somewhere in its history. Asking it to critique its own
  output produces output that ranges from "lukewarm" to "actively
  defending the choices it just made."
- The subagent inherits the system prompt and tool surface but starts
  with a fresh context. It does not know that the parent wrote the
  file. It treats the file as foreign code, which is exactly the
  posture a useful review needs.
- The subagent has no incentive to keep its prior decisions intact,
  because it has none. It can flag things the parent would
  rationalize.
- The subagent's output is summarized back to the parent — but by
  that point the comments have already been written to the draft via
  the tool, so the parent's summarization can't soften them. The
  durable artifact is the comment list, not the summary.

The chat-message body explicitly names this — "you wrote this file in
the current conversation, so a first-person review will be biased" —
rather than relying on the parent to figure out the right move. This
is the kind of instruction that belongs in the prompt because it's
about what the *parent* should do (delegate), not what the reviewer
should do (review).

### Embedding existing comments in the prompt

The composed message embeds every unaddressed comment verbatim, with
its anchor (section heading or line number) and source (`user` or `ai`
from a prior turn). Two reasons:

1. **Don't make the subagent re-discover what the user already said.**
   If the user already wrote "this is too vague" on the Architecture
   section, the subagent should know that and either build on it
   ("specifically, X and Y are undefined") or move on to other
   sections. A summary loses this; verbatim text preserves it.
2. **Don't waste comments on things already raised.** A duplicate
   "this is vague" comment from the AI is worse than no comment at
   all — it implies the AI didn't read the existing draft.

The embedding logic lives client-side in the same place that builds
the chat-message body, and reads from the existing
`FileReviewStore.getDraft(sessionId, filePath)` and the most recent
sent review's comment list. The prompt explicitly tells the subagent
not to duplicate.

"Unaddressed" for sent reviews is best-effort: we don't have a
reliable signal that the agent's subsequent edits resolved a given
comment. v1 includes all comments from the most recent sent review
unless the user has explicitly marked them resolved (a small UX
addition — see open questions). v2 can get smarter.

### Server: a tool, not an endpoint

The agent gets a new tool — `add_review_comment` — exposed via the
existing tool surface. The tool takes:

- `file_path` (string)
- `kind` (`"line"` | `"section"`)
- `line` (number, when `kind === "line"`)
- `section_heading` + `section_index` (when `kind === "section"`)
- `text` (string)

When the agent calls it, the server appends a comment with
`source: "ai"` to the current draft for `(session, file_path)`,
matching the schema introduced in `112-unified-review-surface`.
If no draft exists, the tool ensures one. The tool returns the comment
id so the agent can refer to it later (e.g., to delete or rewrite it).

This keeps the data model identical to today. The only change is who
writes the row: a tool call, not a one-shot endpoint.

### What goes away

- `POST /api/sessions/:sessionId/file-reviews/:reviewId/ai-review`
  (route handler in `api-routes-reviews.ts`, lines around 248–271).
- `generateAiReview` in `services/reviews.ts`.
- The `generateText` factory wired in `app-di.ts:308–333`.
- The `aiReview` action in `file-review-store.ts` and the corresponding
  spinner state in `FilePreviewModal.tsx`.
- `AI_REVIEW_PROMPT_TEMPLATE` (the server-baked review prompt). The
  agent's system prompt + the chat message body cover this now.

### What stays

- The `file_reviews` / `file_review_comments` tables.
- Section parsing, line anchoring, re-anchoring, and prompt construction
  for **Send**. None of those are AI-specific.
- The "AI" badge on comments with `source: "ai"`. The visual distinction
  between human and agent comments still matters — we just produce them
  differently now.
- All the human-side flows: add, edit, delete, send, history.

### Mockup (delta from `112-unified-review-surface`)

Only the header button changes. Everything below the header is the
same surface.

```
┌─────────────────────────────────────────────────────────────────────┐
│  docs/064-pr-lifecycle-flow/plan.md  [Ask agent to review] [Send] [×] │
│─────────────────────────────────────────────────────────────────────│
│   …rest of the panel unchanged…                                      │
```

Clicking "Ask agent to review" submits the chat message and shifts focus
to the chat panel. As the agent's tool calls land, the modal — if still
open — receives the new comments via the existing per-session WebSocket
push for review state, the same way it already receives Send results.

### Failure modes

- **No agent available** (no auth, no runnable session). The button is
  hidden, not disabled-with-spinner. We do not show an affordance for
  something that can't run.
- **Parent agent skips the subagent and reviews directly.** The
  prompt is an instruction, not a hard guarantee. If the parent
  ignores it and reviews in-context, we get the biased review we
  were trying to avoid. Mitigation: phrase the instruction as a
  precondition ("before reviewing, spawn a subagent") rather than a
  suggestion, and verify in dogfooding that current Claude/Codex
  models follow it. If they don't, the next step is a tool that
  *only* a subagent is allowed to call (e.g., `add_review_comment`
  rejects invocations from the root turn), which forces the
  delegation by construction.
- **Subagent finishes without calling `add_review_comment`.** The
  chat shows whatever the subagent (and then the parent) said; the
  draft is unchanged. This is fine — the user got a review in chat,
  which is what they asked for. They can copy any worth-keeping notes
  into the draft as human comments, or ask the agent to "now add
  those as anchored comments."
- **Agent anchors a comment to a section that no longer exists** (e.g.,
  user is editing the file mid-review). The existing re-anchoring path
  in `services/reviews.ts` already handles drift; comments fall back to
  "outdated" rather than being dropped.

## Decisions

1. **Chat is the only path to AI review.** No second surface, no
   button-triggered out-of-band agent run.
2. **The review runs in a subagent, not the parent.** Self-review by
   the author of the artifact is the failure mode we're designing
   against; delegating to a subagent is how we avoid it.
3. **The composed prompt embeds every unaddressed comment verbatim.**
   Not a summary, not a count — the actual text and anchors. The
   subagent must see what the user already cares about.
4. **The write-back mechanism is a tool call.** Not a JSON-coerced
   assistant message, not a separate endpoint.
5. **The button composes and submits a chat message.** It does not
   directly call any review endpoint.
6. **Source-of-comment distinction is preserved.** Human vs AI comments
   still render differently; the schema is unchanged.
7. **No migration.** `source: "ai"` rows produced by the old endpoint
   stay in place; new ones come from the tool. Both look identical.

## Open questions

1. **Does the modal close, minimize, or stay open when the message is
   sent?** Closing makes the chat turn the focus, which is the point.
   Minimizing keeps the comment context one click away. Likely answer:
   close, with a follow-up notification in the modal trigger when new
   AI comments land.
2. **Quick-pick focus areas.** Whether v1 ships with a small set of
   pre-canned focuses ("correctness", "missing tests",
   "contradictions with code") that get appended to the chat message,
   or whether we keep v1 minimal and let users describe focus in chat
   themselves.
3. **Code files.** §3 of `112` left this open. With the chat-native
   approach, there's no infrastructure barrier — the agent already
   reads code well. Likely answer: enable for code files in v1 and let
   the model decide whether anchored comments are useful.
4. **Tool naming.** `add_review_comment` is descriptive but verbose.
   The existing tool-name convention in `tool-map.ts` should drive the
   final choice.
5. **Resolved-comment marker.** To make "unaddressed" precise across
   sent reviews, the user needs a way to mark a comment resolved
   without sending a new review. Likely a small checkbox in the
   "Past reviews" disclosure that sets a `resolved_at` column on the
   comment. The composed prompt then filters out resolved comments.
   v1 can ship without this and just include all sent comments,
   accepting the duplication risk; the UI hook is the same shape if
   we add it later.
6. **Tool gating to force delegation.** If parent agents prove
   unreliable about delegating to a subagent, we can make
   `add_review_comment` reject calls from the root agent turn (only
   subagent contexts can write). This is the structural fallback if
   prompting alone isn't enough. Decision deferred until we have
   real-world signal.

## Risks

- **Discoverability.** Users who are used to "click button → comments
  appear in modal" will see a different motion: "click button → chat
  starts working → comments appear in modal as the agent calls the
  tool." Mitigation: the button label change ("Ask agent to review"
  vs "AI Review") signals that an agent turn is starting; the chat
  scrolls into view; the modal can show a pending state until the
  first tool call lands.
- **Latency.** A chat turn is slower than the old endpoint's single
  request. This is the cost §5's corollary names explicitly and
  accepts: "the cost of chat-shaped UX is intentional." If it feels
  bad in practice, the answer is to make chat turns faster generally,
  not to add a second non-chat path.
- **Tool-call visibility.** Each `add_review_comment` call shows up in
  the chat as a tool invocation. For a review with 8 comments, that's
  8 tool calls in the transcript. Mitigation: the existing
  subagent-transparency / collapsed tool group rendering already handles
  this shape; verify it stays readable, and if not, group consecutive
  `add_review_comment` calls under a single chat-history entry.
- **Coverage gap shipping the tool path.** This time we land an
  integration test that drives the full flow: send the chat message,
  let a fake agent emit `add_review_comment` tool calls, assert the
  draft picks up the comments. This is the regression that the current
  feature lacks.

## Implementation sketch

Touchpoints:

- **Server**
  - Delete `generateAiReview` and the `/ai-review` route.
  - Delete the `generateText` factory in `app-di.ts`.
  - Add `add_review_comment` to the agent tool surface; route it
    through the same `FileReviewStore` calls that
    `addLineComment` / `addSectionComment` already use.
  - Broadcast a `review_updated` WS message (likely already exists for
    Send; reuse it) so an open modal picks up new comments live.
  - Update `tool-map.ts` to normalize the tool name across adapters.

- **Client**
  - Replace the AI Review button + `handleAiReview` in
    `FilePreviewModal.tsx` with "Ask agent to review" that builds the
    chat-message body, calls the existing `sendMessage` action, and
    closes the modal.
  - Remove the `aiReview` action from `file-review-store.ts`.
  - Subscribe to the existing per-session review-update WS push so
    comments appearing via tool calls render without a manual reload.

- **Docs**
  - Update `docs/112-unified-review-surface/plan.md` to point to this
    doc as the successor for the AI Review affordance, leaving the
    rest of the unified surface description intact.

- **Tests**
  - Add an integration test under
    `src/server/orchestrator/integration_tests/doc-reviews.test.ts`
    that uses the existing `FakeClaudeProcess` to emit
    `add_review_comment` tool calls and asserts the draft picks them
    up. This is the test the current implementation is missing.
  - Update `file-review-store.test.ts` to drop `aiReview` coverage and
    add coverage for the WS-driven update.
  - Add a tool-handler test asserting `add_review_comment` is rejected
    on a sent review (matches the current endpoint's 400 behavior).

## Relationship to existing docs

- **Successor to the AI Review portion of `112-unified-review-surface`.**
  The unified comment surface stays; the out-of-band AI Review path is
  retired.
- **Aligned with `109-subagent-transparency`.** Tool calls from the
  review turn render under the same transparency rules as any other
  tool use; no special-casing.
- **Aligned with `CLAUDE.md` §5.** This doc exists primarily because
  the existing feature is the textbook violation §5 warns against.
