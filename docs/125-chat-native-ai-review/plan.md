---
status: in-progress
priority: medium
description: Replace the out-of-band AI review endpoint with a chat-native flow where the agent reviews code through the normal message channel with full repo context.
---

# 125 — Chat-native AI Review

> **Status note (Phase 1 landed).** The capability gate is in place:
> `AgentCapabilities.supportsReview` ships true on Claude, false on Codex,
> and the file-preview modal hides the "AI Review" button when the active
> agent reports `supportsReview === false`. The existing out-of-band AI
> Review endpoint is still present and still works on Claude — its removal
> is Phase 3. The chat-native flow itself (MCP bridge,
> `submit_review_comments`, `/review` slash command, button rewording) is
> Phase 2 and not yet implemented. See `checklist.md` for tracking.

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

### The current design conflicts with §5 of `CLAUDE.md`

§5: "Chat is the input surface. The agent is the actor." The current
"AI Review" button is a non-chat surface that runs an LLM action the
agent could perform in chat — the textbook category mistake §5 names,
and the corollary ("'saves an LLM round-trip' is not a feature")
rejects the obvious defense. This doc replaces that path with a chat
turn. The composer-native entry point is a `/review` slash command;
the button in the file-preview modal stays as a contextual shortcut
because composition needs the modal's draft state and routing the
user out to the composer first is worse UX.

### The current design is fragile in production

Reviewing `services/reviews.ts:generateAiReview` and the DI wiring in
`app-di.ts:308–333`:

- The endpoint depends on a `generateText(prompt, cwd)` factory that
  spawns the agent CLI in-process and collects `agent_assistant` text
  events until done.
- In containerized mode (i.e. real production), `agentFactory` is
  undefined. The default `generateText` checks for this and returns
  `Promise.resolve("")` (`app-di.ts:311`). The empty string flows into
  `generateAiReview`, the JSON-extraction regex doesn't match, and the
  service returns `[]`. The user sees the spinner, then "0 AI comments
  added," with no error.
- The integration test file `doc-reviews.test.ts` covers CRUD and Send
  but does **not** assert that AI Review returns non-empty output.
- The client store test mocks the response.

So the feature is marked `status: done` in `docs/112-*/plan.md`, but the
deployed path is a verified no-op without any user-visible signal.

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

### Backend support: Claude-only in v1

Two pieces of this design have no Codex equivalent:

- **Subagent primitive.** Claude Code exposes a `Task` tool that
  spawns a subagent with a fresh context window. Codex's tool
  surface is fixed (`shell`, `file_write`, `file_read`, `file_edit`
  — see `codex-adapter.ts:108`); there is no analogous primitive.
- **Custom tool registration.** Claude Code's `mcpConfigPath` is
  already wired through the adapter (`claude-adapter.ts:137`), so
  ShipIt can publish an in-process MCP server and Claude will see
  its tools. Codex has no equivalent config and hardcodes its tool
  list.

Both pieces are load-bearing for this design (the first for
unbiased review, the second for tool-driven write-back), so v1 ships
**Claude-only**:

- The "Ask agent to review" button and the `/review` slash command
  are visible only when the active session's adapter reports
  `capabilities.supportsReview === true`. v1 sets this on the
  Claude adapter and leaves it false on Codex. We deliberately do
  not ship two finer-grained flags (`supportsSubagents`,
  `supportsMcp`); the feature requires both, and a single
  feature-shaped flag avoids forcing every future adapter to
  declare the matrix. When 088 (user MCP) or a Codex subagent
  primitive lands, a future PR can split the flag if the
  granularity becomes useful elsewhere.
- On a Codex session, the file preview modal renders without the
  AI affordance. Human comment authoring is unchanged. This is a
  capability gap we surface honestly, not a silent degradation.
- The 088 and Codex-subagent designs, if and when they land,
  flip the flag for those backends. This doc does not block on
  either.

### Surface

In the file preview modal header, the existing "AI Review" button is
replaced by **"Ask agent to review."** It is shown when **all** of the
following hold:

- The session's adapter has subagent and MCP capabilities (see
  "Backend support" above).
- The file is reviewable: markdown of any size, or code under a size
  cap (10 KB in v1; tunable). Binaries, images, and very large
  generated files have no button — the subagent can't usefully review
  them and we don't show an affordance for it.
- The agent is not already running another turn. If `runner.running`
  is true, the button is shown but disabled with a tooltip; clicking
  is a no-op. We do **not** auto-queue review messages because the
  composed prompt depends on draft state at click time, and the draft
  may change while the user waits — see "Busy-turn behavior" below.

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

   Before reviewing: spawn a subagent via the Task tool and let it
   perform the review. You (the parent) wrote or edited this file
   earlier in this conversation, so a first-person review will be
   biased toward defending the existing text. Do not review it
   yourself.

   Brief the subagent to:
   - Approach the file fresh, treating it as work it has not seen.
   - Read related files in the repo as needed for context.
   - Call the `submit_review_comments` MCP tool exactly once with
     all of its findings as a single array. Do not call it
     per-comment.
   - If the subagent decides the file does not need any new
     comments, it must still call `submit_review_comments` with an
     empty array — that is the signal that the review ran.

   Focus areas: correctness, completeness, internal consistency,
   contradictions with the rest of the repo. Skip nits.

   --- Existing comments on this file (do not duplicate) ---

   The user has already left these comments. Build on them or
   cover gaps they leave; do not repeat them. Comments labeled
   [agent (prior)] are from earlier AI reviews — treat them as
   weaker authority than [user] comments.

   ## Architecture (section, draft)
     [user] This section is too vague — what does "unified" mean in
     concrete terms?

   ## Failure modes (section, sent 2026-05-06)
     [user] What about 5xx from GitHub? Doc still doesn't say.

   line 142 (draft)
     [user] This contradicts the diagram above.

   ## Implementation (section, sent 2026-05-06)
     [agent (prior)] Consider adding a sequence diagram for the
     poller's retry path.
   ---
   ```

   Comments are embedded with a **hard cap and a strict ranking**:
   at most 20 comments total, each truncated to 500 characters
   with a "…" suffix. The ranking, applied in order, is:

   1. All draft comments, most recent first. Drafts are what the
      user is currently working on; they have the strongest claim
      on the cap.
   2. Then comments from the **most recent sent review only**, and
      only those with `source: "human"`. Older sent reviews are
      never embedded. AI-source comments from prior runs are also
      never embedded — see "Avoiding feedback loops" below.

   When the cap is exceeded, **drop ordering is an open question
   and v1 picks the simplest option that ships:** oldest drafts
   dropped first (preserves the comments most likely to be what
   the user just typed). The user-pickable variant ("23 of 35
   comments will be sent — choose which") is strictly better UX
   but is real UI work; v1 takes the simpler default with the cap
   set high enough (20) that overflow is rare in practice. When
   any comments are dropped, the message includes a one-line note
   ("8 older comments omitted") so the subagent knows the embed
   is partial. The cap is enforced client-side where the body is
   built; the prompt size is bounded regardless of session
   history depth.

2. Submits that message via the existing `send_message` flow, then
   closes (or minimizes — see open questions) the modal so the user
   can watch the agent work in chat.

### Slash command

In addition to the button, the chat composer supports a **`/review`**
slash command. Forms:

- `/review` — reviews the file currently open in the file preview
  modal (if any), or errors with a helpful message.
- `/review @path/to/file.md` — reviews the named file. The composer's
  existing `@`-mention picker handles path resolution.

The slash command produces the same composed body as the button,
including embedded draft comments if a draft exists for the named
file in the current session. This is the §5-canonical path: chat
input, agent output. The button is a contextual shortcut from the
modal.

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
comment. v1 includes only `source: "human"` comments from the most
recent sent review unless the user has explicitly marked them
resolved (a small UX addition — see open questions). v2 can get
smarter.

#### Avoiding feedback loops

A naive rule — "embed all comments from the most recent sent review"
— creates a slow-drift loop across reruns. Run 1 produces AI
comments; the user sends; Run 2 sees its own past output relabeled
`[agent (prior)]` and starts caveat-stacking on it. Over several
runs the AI's output becomes recursive commentary on itself.

The rule that prevents this:

- **Drafts** (current state): both human and AI comments are
  embedded. AI comments still in the draft are findings the user
  has implicitly kept by not deleting them; they're part of "what
  the user cares about."
- **Sent reviews** (history): only `source: "human"` comments are
  embedded. The subagent never sees its own past output as input.
  Past AI work is fully in the chat record where the user can
  refer to it; it does not feed forward into future reviews.

This trades a small amount of context (the AI doesn't see its prior
suggestions) for stability across reruns. The subagent's job is to
review *the file*, with the user's notes as the spec; previous AI
critiques are not part of that spec.

### Tool: a single atomic call via a worker-owned MCP bridge

The agent gets a new tool — `submit_review_comments` — exposed via
an MCP server **owned by the session worker**. This is new
infrastructure: the repo has no MCP SDK dependency today, and Claude
Code's MCP transport is stdio-over-subprocess (the existing
`mcpConfigPath` wire on `claude-adapter.ts:137` declares servers via
`{ command, args }` — Claude Code spawns them as child processes).

So the design is concretely:

1. The session worker, on startup, generates an `mcp.json` at a
   known path inside the container that declares one server:

   ```json
   {
     "mcpServers": {
       "shipit-review": {
         "command": "node",
         "args": ["/app/mcp-review-bridge.js",
                  "--socket=/run/shipit/review.sock"]
       }
     }
   }
   ```

2. The worker creates a Unix socket at the path above and listens
   for a single bridge connection. The path is per-worker
   (`/run/shipit/review-${sessionId}.sock`, or under the worker's
   tmp dir) so that local mode — where one orchestrator process
   spawns many in-process workers, per CLAUDE.md "Dogfooding" —
   doesn't collide on a fixed path. On worker startup the
   handler unlinks the socket file if it exists, so a prior
   crash that left a stale socket doesn't block `bind(2)`.

3. `mcp-review-bridge.js` is a tiny Node script (shipped in the
   worker image) using `@modelcontextprotocol/sdk` for the stdio
   protocol. It registers `submit_review_comments`, and on each
   tool invocation forwards the call over the Unix socket to the
   worker process. The worker handles the call (resolve draft,
   re-anchor, persist, broadcast) and returns the result to the
   bridge, which marshals it back to Claude Code over stdio.

4. The bridge is a *transport*: it owns no state, no validation,
   no business logic. All correctness and authorization live in
   the worker's handler. The bridge exists only because Claude
   Code spawns its MCP servers; it cannot connect to an in-process
   handler.

5. When the worker shuts down, the bridge's socket connection
   drops; subsequent tool calls from Claude Code surface a clear
   "review service unavailable" error rather than hanging.

This is distinct from `088-mcp-integration` (planned), which is
about *user-configured external* MCP servers (Linear, Notion, etc.).
The review MCP is internal, ShipIt-controlled, and not user-
configurable. When 088 lands, both coexist — Claude Code accepts
multiple servers in its config.

The repo has a single `package.json` shared between orchestrator
and worker images (the worker Dockerfile copies the same manifest
and runs `npm ci`). Adding `@modelcontextprotocol/sdk` therefore
adds it to both runtimes. The SDK is small (low single-digit MB)
and the orchestrator is unaffected at runtime — it imports
nothing from it. We accept the size cost rather than introduce a
separate worker manifest, which would be a much larger
infrastructure change. The new entry point
(`mcp-review-bridge.js`) ships in the worker image only.

The tool signature:

```ts
submit_review_comments({
  file_path: string,
  comments: Array<
    | { kind: "section",
        section_heading: string,
        section_index: number,
        text: string }
    | { kind: "line",
        line: number,
        text: string }
  >
})
```

One call per review, with the full array of comments. Rationale:

- **Atomic in the chat transcript.** The user sees one tool call
  ("submit_review_comments — 6 comments"), not six. The transparency
  rendering from `109-subagent-transparency` collapses cleanly.
- **Atomic in the draft.** All comments land together; partial
  failures are impossible. If the tool errors, the draft is
  unchanged.
- **Forces the subagent to think holistically.** A per-comment tool
  encourages dribbling out incremental observations; an array
  encourages "review the whole file, then report."
- **Easier to bound.** A single call has a single payload to size-cap
  (e.g., max 50 comments per call, max 2 KB per comment text).

When the worker receives the call, it:

1. **Authorizes the `file_path`.** The agent is not free to write
   review comments on arbitrary files — a confused or off-task
   subagent could otherwise create drafts on files the user never
   opened. The button and slash command do **not** send their
   composed body via the freeform `send_message` WS message; they
   send a new structured message:

   ```ts
   { type: "send_review_message",
     text: string,            // the composed prompt body
     reviewFilePath: string } // the authorized file
   ```

   This lets the WS handler distinguish a button/slash-command
   review from a user who simply typed `Review docs/foo.md` in
   the composer (the latter is just chat — no allow-list, no
   tool access). On receipt, the handler sets
   `runner.activeReviewFilePath = reviewFilePath` and routes the
   text through the same code path as `send_message` for
   everything else.

   **Lifecycle of the allow-list.** Following the WS-handler
   rules in CLAUDE.md ("WebSocket lifecycle MUST NOT affect
   server behavior"):
   - The field lives on the runner, not on the WS connection,
     and is mutated via the registry-resolved runner so a
     reconnect mid-review doesn't clear it.
   - It is set when the review message *starts a turn*, not when
     it's enqueued. If it's queued behind another running turn,
     the set happens at dequeue time. This is the same point at
     which sessionId is captured at turn start.
   - It is cleared in the same `currentAgent.on("done")` callback
     that calls `stopRunner(runner)` — *not* narrowly on
     `agent_result`. There are several non-`agent_result` exit
     paths (the `done` event without a result, interrupt, kill)
     and any of them must leave the field null so the next
     dequeued turn sees a clean slate. Subagent tool calls
     happen *during* the parent's turn (the `Task` tool runs the
     subagent inline within the parent's tool budget), so the
     field is still set when `submit_review_comments` lands.
   - If a second review starts before the first is cleared (which
     can only happen on a new turn), the new value overwrites
     the old. There's no queueing of allow-list values.

   The tool handler rejects calls whose `file_path` is not the
   currently allow-listed value, with a message naming the
   expected path.
2. Resolves the draft for `(sessionId, file_path)`. The session id
   is the worker's own session context — **the agent does not
   pass session id**. If no draft exists (the user closed the
   modal mid-review), the handler ensures a fresh one.
3. Reads the file at the current commit and re-runs
   `parseMarkdownSections()` to get fresh anchors. Each section
   comment is re-anchored using `reanchorComments()` from
   `services/reviews.ts` against the current section list, so a
   comment whose section drifted between the subagent's read and
   write times either lands correctly or is marked outdated.
   Re-anchoring already exists for Send; this extends it to the
   tool handler.
4. Appends the comments with `source: "ai"` set **server-side**.
   The tool ignores any `source` field in the payload — it cannot
   be set by the caller.
5. Refuses the call with a structured error if the draft's status
   is `sent` (i.e., the user sent the review during the subagent's
   run). The subagent's findings are surfaced via the tool error
   text so the parent can render them inline.
6. Broadcasts a `review_updated` event to the worker's SSE stream;
   the orchestrator relays it to attached browser sockets (see
   Implementation sketch — this requires extending closed unions
   in two places).

The data model is unchanged from `112-unified-review-surface`.

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
to the chat panel. As the agent's tool call lands, the modal — if still
open — receives the new comments via a new `review_updated` WebSocket
message broadcast by the tool handler. This message type does not exist
today and is part of this feature's scope (see Implementation sketch).

### Failure modes

- **No agent available, or agent is non-Claude.** The button and
  slash command are hidden, not disabled-with-spinner. We do not
  show an affordance for something that can't run.
- **Busy-turn behavior.** When `runner.running === true` at click
  time, the button is disabled with a tooltip explaining that
  another turn is in progress. We do not auto-queue: the composed
  prompt embeds *current* draft comments, and queueing would send
  a stale snapshot if the draft changed in the meantime. The user
  can either wait for the turn to finish and click again (cheap),
  or cancel the in-flight turn and re-click. The slash command
  behaves the same way — typing `/review` while a turn is running
  flashes an inline error in the composer instead of queueing.
- **Parent agent skips the subagent and reviews directly.** This
  is the design's largest acknowledged risk and deserves a clear
  stance. The "review runs in a subagent" claim is the
  correctness story for *unbiased* review; without it, this
  feature still produces anchored AI comments, just with the
  same author-bias problem the current button has. So:

  **What v1 ships:** prompt-only enforcement. The composed
  message phrases delegation as a hard precondition ("Before
  reviewing: spawn a subagent. Do not review it yourself.") and
  rejects review-via-parent only if the parent's chat output
  shows it never invoked `Task`. There is no machine-enforced
  block on the parent calling `submit_review_comments` directly.

  **What we're betting on:** that current Claude models follow
  precondition-shaped instructions reliably. This is a
  measurable bet — we can sample dogfood reviews and check
  whether the parent's transcript shows a `Task` call before
  any `submit_review_comments` call.

  **What v1 does *not* ship, but is designed:** structural
  enforcement via `parent_tool_use_id`. The MCP tool handler
  runs in the worker via the bridge subprocess, while
  `parent_tool_use_id` lives on Claude's NDJSON event stream
  (`claude-adapter.ts:94,101`), which the worker observes as a
  separate channel. Enforcing it at the tool boundary requires
  correlating the inbound MCP request with the in-flight
  `tool_use` NDJSON event by id and stalling the MCP response
  until the event arrives. This is real work — not a
  one-line check — and v1 defers it. If dogfooding shows
  prompt-only doesn't hold, this is the followup PR.

  **Honesty:** if both prompt-only and the followup
  correlator turn out to be unreliable, the subagent claim is
  no longer the design's correctness story; the design degrades
  to "AI comments via tool, possibly biased." The remaining
  wins (anchored comments via tool, no silent prod no-op,
  iteration via chat) still hold and are themselves worth the
  work, but the bias-resistance claim weakens. We do not paper
  over that — we ship v1, measure, and respond.
- **Subagent finishes without calling `submit_review_comments`.**
  The prompt makes the empty-array call a hard requirement. If
  the subagent skips it anyway, the user gets the parent's
  chat-history summary but no anchored comments. We do **not**
  ask the parent to retroactively transcribe the subagent's
  findings into the tool — that re-introduces exactly the
  parent-as-author bias the design exists to avoid. Instead the
  fallback is: the user re-runs the review. Re-running is bounded
  by the embedding rules above (no AI feedback loop, since past
  AI comments aren't fed back), so it is genuinely idempotent,
  not stochastic.
- **Subagent anchors a comment to a section that no longer exists**
  (e.g., user is editing the file mid-review). The tool handler
  re-anchors at write time using `parseMarkdownSections()` against
  the current file (not the file the subagent read). Comments
  whose section can't be found fall back to "outdated" rather
  than being dropped — this is the same behavior Send already has,
  reused.
- **User sends the review while the subagent is still running.**
  The tool handler refuses the call (the draft is now `sent`),
  surfacing the subagent's output as a tool error so the parent
  can show it in chat. The user can then start a fresh review
  with those comments in mind.
- **Tool payload exceeds size limits.** The handler rejects calls
  with >50 comments in a single payload or any single comment
  >2 KB. The parent gets the error in chat and can retell the
  user. This is a guardrail against runaway output, not an
  expected case.

## Decisions

1. **Chat is the only path to AI review.** No second surface, no
   button-triggered out-of-band agent run.
2. **v1 ships Claude-only**, gated by a single `supportsReview`
   capability flag. The feature requires both subagents and MCP
   tools; a single feature-shaped flag is simpler than two
   primitive flags whose AND is the only thing we ever check.
3. **The review runs in a subagent.** Delegating away from the
   parent (which authored the file) is the correctness story.
4. **The composed prompt embeds comments verbatim with a bounded
   cap.** At most 20 comments, each truncated to 500 chars.
   Drafts are embedded before sent comments; sent comments are
   limited to the most recent sent review and to `source: "human"`
   only. AI-source comments from prior runs are never re-embedded
   — that prevents a feedback loop on rerun. **Ordering on
   overflow is an open question** — see open questions for the
   options (newest first, oldest first, user-pickable).
5. **The write-back is a single MCP tool call.**
   `submit_review_comments` takes the full array in one
   invocation. Atomic in transcript and in storage.
6. **The MCP server lives in a worker-spawned bridge subprocess**,
   not in-process. Claude Code's MCP transport requires a
   subprocess (`{ command, args }`); the bridge is a thin stdio
   shim that forwards to the worker over a Unix socket, where the
   real handler lives. The worker image gains
   `@modelcontextprotocol/sdk` as a dep.
7. **`file_path` is allow-listed per turn.** When the review chat
   message is sent, the orchestrator sets
   `runner.activeReviewFilePath`; the tool rejects calls with any
   other path. The agent cannot create drafts on arbitrary files.
8. **`source: "ai"` is set server-side**, not caller-overridable.
9. **Comments are re-anchored at tool-call time** against the
   current file, reusing `parseMarkdownSections()` from the
   existing Send path.
10. **Structural enforcement of "subagent only" is deferred.**
    `parent_tool_use_id` lives on Claude's NDJSON stream, not on
    the MCP request payload; enforcing it requires a cross-channel
    correlator (described in failure modes), which is real work
    and not v1 scope.
11. **The button composes and submits a chat message; a `/review`
    slash command is the chat-native equivalent.**
12. **Source-of-comment distinction is preserved.** Human vs AI
    rendering and badges unchanged.
13. **No migration.** Old `source: "ai"` rows stay; new ones come
    from the tool.

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
3. **Tool gating to force delegation.** If parent agents prove
   unreliable about delegating, the worker can refuse MCP calls
   whose originating Claude `tool_use` event has
   `parent_tool_use_id == null`. This requires a real
   cross-channel correlator: the worker observes the NDJSON event
   stream and the MCP socket as separate channels, so the tool
   handler must buffer recent `tool_use` events keyed by id, look
   up the inbound MCP call's `tool_use_id`, and stall the
   response until the matching event arrives. Implementable on
   Claude only. Not a one-line check — design and ship this only
   if dogfooding shows the prompt-only path doesn't hold.
4. **Resolved-comment marker.** To make "unaddressed" precise across
   sent reviews, the user needs a way to mark a comment resolved
   without sending a new review. Likely a small checkbox in the
   "Past reviews" disclosure that sets a `resolved_at` column on the
   comment. The composed prompt then filters out resolved comments.
   v1 can ship without this and just include all sent comments under
   the 20-comment cap; the UI hook is the same shape if we add it
   later.
5. **Codex parity.** Once Codex grows a subagent primitive *or* we
   build a worker-internal "fresh-context spawn" wrapper, the
   feature can extend to Codex sessions. Out of scope for this doc
   beyond noting the gating flag is the right surface to flip.
6. **Worker-driven recovery on missed tool call.** v1's only
   fallback for "subagent skipped the tool" is "user re-runs."
   If that proves bad, the next step is to have the worker
   detect a turn that completed without a `submit_review_comments`
   call and auto-call the tool itself with the subagent's final
   message text — bypassing the biased parent entirely. Shares
   the NDJSON-event-buffer infrastructure with question 3 (the
   parent-of-tool-use correlator), but the lookup key is
   different: question 3 keys on `tool_use.id` at MCP-call time;
   this question keys on "last subagent assistant message before
   parent's `agent_result`."
7. **Cap drop-ordering on overflow.** When draft comments alone
   exceed the 20-cap, v1 drops oldest first (assumed: newest
   comments are what the user just typed and is reacting to).
   The alternatives — drop newest (preserve historical
   considered notes), or expose a user-pickable list before
   sending — are both reasonable. v1 picks the simplest default;
   if it's wrong in practice, the user-pickable variant is the
   followup.

## Phasing

This is not small. Surfaces touched: a new MCP bridge subprocess
plus an SDK dependency; a new Unix-socket protocol between the
bridge and the worker; a new tool handler with re-anchoring,
size limits, allow-list authorization, and sent-state checks;
a new worker SSE event type; a new server→client WS message;
a new client→server WS message; a new capability flag; a new
runner field with a careful lifecycle; the button replacement;
the `/review` slash command; client-store WS handlers; fake
MCP infrastructure for tests; integration tests; tool-handler
unit tests; capability-flag tests. We are also deleting an
`/ai-review` route, a service function, a DI factory, and a
client `aiReview` action.

To make this safely shippable and rollback-friendly, the work
is broken into three phases that can land separately:

**Phase 1 — Capability gating, near-no behavior change.**
Add `supportsReview: boolean` to `AgentCapabilities`; set it
on Claude (true) and Codex (false). Hide the existing AI
Review button on Codex sessions. The current AI Review path
continues to work on Claude. The user-visible delta on Codex
is small but real — the button currently exists there and
silently no-ops in prod (per Motivation); after Phase 1 it
disappears, which is strictly better. This phase is a
few-line PR and ships independently.

**Phase 2 — Chat-native review on Claude, behind capability.**
The MCP bridge, `submit_review_comments` tool, allow-list,
re-anchoring, `review_updated` SSE/WS pipe, button-replacement,
`/review` slash command, client store, tests, and fakes. The
old `/ai-review` route still exists at this point but is
unused by the client. This is the substantial PR.

**Phase 3 — Remove the old path.**
Delete `generateAiReview`, `/ai-review`, `generateText`,
`agentFactory` for review use, `AI_REVIEW_PROMPT_TEMPLATE`,
the client `aiReview` action and its tests. Update
`docs/112-unified-review-surface/plan.md` to point at this
doc as the successor. Cleanup-only PR.

If Phase 2 reveals problems, reverting it leaves Phase 1's
capability flag in place and restores the current behavior.

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
- **Tool-call visibility.** `submit_review_comments` is a single
  call carrying the full array, so the chat shows one entry no
  matter how many comments the review produces. The
  `109-subagent-transparency` collapsed-tool rendering handles the
  "subagent did N steps, then submitted" shape natively.
- **Coverage gap shipping the tool path.** This time we land an
  integration test that drives the full flow: send the chat
  message, let a fake agent emit a `submit_review_comments` tool
  call (an MCP fake stood up alongside the existing
  `FakeClaudeProcess`), assert the draft picks up the comments and
  that a `review_updated` WS message reaches a connected client.
  This is the regression the current feature lacks.
- **MCP server lifecycle.** The in-process MCP server runs inside
  the session worker. If it crashes, the tool stops working until
  the worker restarts. Mitigation: keep the server logic small
  (one tool, one handler), supervise it with the worker's existing
  process supervision, and surface a clear error when Claude
  attempts the tool against a downed server.

## Implementation sketch

Touchpoints:

- **Session worker**
  - Add `@modelcontextprotocol/sdk` to the worker's dependencies.
  - Ship `mcp-review-bridge.js` (new file, baked into the worker
    image). Stdio MCP server registering `submit_review_comments`,
    forwarding each call to the worker over a Unix socket whose
    path is passed as `--socket=…`. No business logic — pure
    transport.
  - Worker generates `mcp.json` at session startup pointing to
    the bridge with the per-session socket path; passes the
    config file path to the orchestrator (or exposes it via an
    HTTP endpoint) so it can be threaded into `mcpConfigPath`.
  - Worker creates the Unix socket, accepts the bridge's
    connection, and dispatches inbound tool calls to the review
    handler.
  - Tool handler:
    - Validates `file_path` against `runner.activeReviewFilePath`
      (the per-turn allow-list set when the chat message
      composing this review was sent).
    - Resolves the draft via `FileReviewStore`.
    - Re-anchors section comments using
      `parseMarkdownSections()` against the current file.
    - Persists comments with `source: "ai"` set server-side
      (caller-supplied `source` is ignored).
    - Rejects when draft is `sent`, `>50` comments, or any
      comment text `>2 KB`.
    - Emits a `review_updated` event on the worker's SSE stream.

- **Orchestrator + types**
  - Add `review_updated` to `WorkerSSEEvent.type` (closed union
    in `session-worker.ts:38–43`). [touchpoint 1 of 4]
  - Add a `case "review_updated"` to `handleSSEEvent` in
    `container-session-runner.ts:821` that calls
    `this.emitMessage({ type: "review_updated", … })`.
    [touchpoint 2]
  - Add the `review_updated` message type to
    `ws-server-messages.ts:551–623` (`WsServerMessage` union).
    [touchpoint 3]
  - Add a client-side handler for the new message in the
    file-review-store WS dispatcher. [touchpoint 4 — listed
    again under Client below for completeness]
  - Add a new client→server message
    `send_review_message { type, text, reviewFilePath }` to
    `ws-client-messages.ts` and a handler that sets
    `runner.activeReviewFilePath` before routing into the same
    code path as `send_message`. [+1 touchpoint, separate pipe]
  - Read the worker's `mcp.json` path on session startup and
    pass it through to the agent's `mcpConfigPath` parameter.
  - Track `runner.activeReviewFilePath: string | null` on the
    runner state. Set it at turn-start of a `send_review_message`
    (i.e., when dequeued and the parent agent actually starts
    running, not at WS receipt — same point sessionId is
    captured). Clear it on the parent's `agent_result` event.
    Mutate via the registry-resolved runner per CLAUDE.md
    "WebSocket lifecycle" rules; the field must survive a WS
    reconnect during the review.
  - Delete `generateAiReview` from `services/reviews.ts`, the
    `/ai-review` route in `api-routes-reviews.ts`, the
    `generateText` factory and `agentFactory` plumbing in
    `app-di.ts:308–333`, and `AI_REVIEW_PROMPT_TEMPLATE`.
  - Add `supportsReview: boolean` to `AgentCapabilities`. Claude
    adapter: `true`. Codex adapter: `false`.

- **Client**
  - Replace the AI Review button + `handleAiReview` in
    `FilePreviewModal.tsx` with "Ask agent to review" that builds
    the chat-message body (with the 20-comment cap and 500-char
    truncation), calls the existing `sendMessage` action, and
    closes the modal. Hide the button when capability flags say
    no.
  - Add the `/review [@file]` slash command to the chat
    composer's command list, producing the same body.
  - Remove the `aiReview` action from `file-review-store.ts`.
  - Handle the new `review_updated` WS message: merge new
    comments into the in-memory draft so the modal renders them
    live.

- **Docs**
  - Update `docs/112-unified-review-surface/plan.md` to point to
    this doc as the successor for the AI Review affordance,
    leaving the rest of the unified surface description intact.

- **Tests**
  - Stand up a fake MCP tool emitter usable by integration tests
    (the existing `FakeClaudeProcess` doesn't model custom tool
    surfaces). Either: (a) emit synthetic Claude NDJSON tool-call
    events that look as if they came from MCP, or (b) run a real
    test MCP server in-process and connect a fake adapter to it.
    (a) is cheaper and closer to existing test patterns.
  - Add an integration test under
    `src/server/orchestrator/integration_tests/doc-reviews.test.ts`
    that drives a full flow: send the chat message, fake agent
    emits a `submit_review_comments` call, assert the draft picks
    up the comments and a `review_updated` WS message reaches a
    `TestClient`.
  - Add a tool-handler test asserting:
    - `source: "ai"` is set even if the payload tries to pass a
      different value
    - the call is rejected when the draft is `sent`
    - section re-anchoring runs against the current file, not a
      cached version
    - oversize payloads are rejected
  - Update `file-review-store.test.ts` to drop `aiReview` coverage
    and add coverage for the `review_updated` WS path.
  - Capability-flag tests for both adapters
    (`claude-adapter.test.ts`, `codex-adapter.test.ts`).

## Relationship to existing docs

- **Successor to the AI Review portion of `112-unified-review-surface`.**
  The unified comment surface stays; the out-of-band AI Review path is
  retired.
- **Aligned with `109-subagent-transparency`.** Tool calls from the
  review turn render under the same transparency rules as any other
  tool use; no special-casing.
- **Aligned with `CLAUDE.md` §5.** This doc exists primarily because
  the existing feature is the textbook violation §5 warns against.
