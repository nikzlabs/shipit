---
description: Move AI review submissions out of the human draft bucket into immutable chat-history cards anchored to a snapshot of the file at review time, with the structured findings flowing back to the parent agent via the tool response itself.
---

# 151 — Agent review cards

## Summary

Today `submit_review_comments` (docs/125) writes AI-authored review findings
into the same `file_reviews` draft bucket that humans use to compose their
own comments. Across multiple subagent review rounds, those AI comments
accumulate as "drafts" on the file, and the modal's footer offers a
**"Send N comments"** button that suggests dispatching them back to the
agent — even though the agent is the one that wrote them. After several
rounds of `/review`, the user opens a doc and sees a stack of 30
already-considered AI comments asking to be sent. The button is a
category error.

This doc proposes splitting AI review submissions off into their own
storage path, rendering each submission as an immutable **chat-history
card** that opens the file in a read-only **snapshot mode** showing only
that review's comments against the file content as it was at review
time. The structured findings flow back to the parent agent via the tool
response itself — the subagent is instructed to echo the tool result as
its final response, so the parent receives the comments verbatim without
needing a separate fetch tool.

It also folds in a small fix to the `submit_review_comments` validator
that today returns a misleading *"Each comment must have non-empty text"*
when the caller passes a malformed comment item (e.g. an array of bare
strings rather than `{kind, text, …anchor}` objects).

## Motivation

### The draft bucket is the user's input queue

The "drafts" surface in `FilePreviewModal` exists so the user can compose
anchored comments and dispatch them to the agent via **Send**. It's a
**user → agent** queue. Letting the agent write into it inverts the
direction: the agent fills the user's outgoing pile with feedback the
user never authored, and the "Send" button offers to round-trip that
feedback back to the agent that produced it.

This is the conceptual confusion that produces the stacking-drafts bug.
Auto-marking AI submissions as `sent` (the smaller fix discussed before
this doc) papers over the symptom but keeps the architecture muddled.

### The chat panel already records "what the agent said"

The current design persists AI findings to the file's review history,
then relies on the subagent's free-text Task result to convey them to
the parent. That's two parallel surfaces holding the same information:
the persisted draft AND the chat transcript. Removing the persisted-
drafts path doesn't lose the findings — they remain in the chat panel
where they always were. What it does lose is the **anchored
visualization** (pins on the file showing where each finding sits) and
the **structured-output discipline** the tool's schema imposes on the
subagent.

This doc keeps both of those wins, but routes the anchored display into
a dedicated chat-card surface instead of co-mingling with the human
draft.

### The parent agent doesn't reliably receive the findings

Today the parent sees only the subagent's free-text Task result, which
may or may not include the structured findings. A previous round of
discussion considered adding a `get_review_comments` MCP tool the parent
would call after the subagent finishes. That adds a round trip and
still depends on the parent remembering to call it.

If `submit_review_comments` instead returns the rendered findings in its
tool response, and the subagent is instructed to **echo that response
verbatim as its final assistant message**, the findings flow to the
parent naturally through the Task tool result that Claude Code already
constructs. One round trip, no new tool, no fetch step.

### The validator returns a misleading error for shape-invalid payloads

Reported case: the agent submitted a payload with `comments` as an array
of one non-empty string (i.e. `["my finding"]` rather than
`[{kind, text, …}]`). The MCP bridge forwarded it; the server's
per-comment loop hits `typeof c.text !== "string"` and throws
*"Each comment must have non-empty text."* The error tells the agent
the text is empty, when in fact the entire comment object is the wrong
shape. The agent has no signal that the schema is what's wrong, so it
retries with the same shape and gets the same error.

The fix is small but worth landing alongside this redesign because the
same surface is being touched.

## Non-goals

- **Removing the human comment surface.** Humans still author drafts in
  `file_reviews`, click **Send**, see history. None of that changes.
- **Removing the `submit_review_comments` tool.** It stays — same name,
  same call shape from the agent's perspective. What changes is where
  the persisted output lands and what comes back in the tool response.
- **Migrating existing `source: "ai"` rows.** Old AI comments stuck in
  human drafts are addressed by a one-shot cleanup (§Migration); we do
  not try to back-populate them into the new agent-review tables.
- **A `get_review_comments` fetch tool.** Explicitly punted — the tool
  response carries the findings, and the subagent's echoed response is
  the delivery mechanism.
- **Rich diff between snapshot and live file.** The snapshot view is
  read-only and shows the file as the reviewer saw it. A "show me
  what's changed since" overlay is a future enhancement, not v1.
- **Cross-session sharing of agent reviews.** A review belongs to the
  session that produced it. Other sessions' modals on the same file
  don't show it.

## Design

### 1. Storage: `agent_reviews` and `agent_review_comments`

Two new tables, parallel to `file_reviews` / `file_review_comments`:

```
agent_reviews
  id               text pk
  session_id       text
  file_path        text
  file_type        text ("markdown" | "code")
  snapshot_content text   -- the file as the reviewer saw it
  snapshot_hash    text   -- sha256, used as a stable identity
  summary          text   -- optional one-line takeaway from the subagent
  created_at       text

agent_review_comments
  id               text pk
  agent_review_id  text fk
  kind             text ("line" | "selection")
  line             integer
  quoted_text      text
  context_before   text
  context_after    text
  text             text
  created_at       text
```

Key differences from `file_reviews`:

- **No `status`.** An agent review is immutable on creation. There is no
  draft phase; there is no Send action; nothing transitions.
- **No `source` column.** Every row here is by definition agent-authored.
  Human comments do not live in this table.
- **Snapshot lives in the row.** Anchors are relative to
  `snapshot_content`, not to the live file. That's why this design
  doesn't re-anchor on read — the snapshot doesn't move.

### 2. `submit_review_comments` behavior change

The MCP tool name and JSON schema stay the same (the agent-facing
contract is unchanged, no prompt rewrites needed for the existing
review composer). What changes is server-side:

- **Old:** resolve-or-create a draft `file_review`, append comments with
  `source: "ai"`, broadcast `review_updated`.
- **New:** snapshot the file's current content, create a new
  `agent_review` row with that snapshot, persist comments against the
  snapshot, broadcast a new `agent_review_added` message.

Anchoring happens against the snapshot in the same call: selection
comments locate their `quoted_text` in `snapshot_content` (not the live
file), and a comment whose quoted text isn't present in the snapshot is
rejected outright — the agent saw the file it's quoting, so a miss here
is a real bug on the agent side, not a re-anchoring concern.

The `runner.activeReviewFilePath` allow-list (docs/125 §6) still
applies — chat-native review turns narrow writes to the one file the
user asked to review.

### 3. Tool response: structured findings flow back through the Task result

The tool result returned to the subagent is no longer a one-line
`"Recorded N review comments."`. It's a structured rendering:

```
Review of docs/foo/plan.md (snapshot {hash[:8]}, 5 findings):

«…the unified review surface…» (line 42)
  The phrase "unified" is undefined here; the rest of the doc treats it
  as a term of art without first introducing it.

«…draft → sent → history…» (line 67)
  This contradicts the diagram above, which shows draft → sent only.

…

End of review.
```

The composed review prompt (`composeReviewMessage`) gains an instruction
to the subagent: **"After calling `submit_review_comments`, return the
tool result verbatim as your final response. Do not paraphrase, do not
add commentary, do not summarize — the parent needs the exact rendered
list."** Subagents follow precondition-shaped instructions reasonably
reliably on Claude (docs/125's same prompt-only bet); when they don't,
the chat-card UI still has the structured findings, so the parent's
copy is the only thing degraded.

The prompt also keeps reviews convergent: the subagent reports only
material findings with concrete user impact and a specific fix, orders
them by severity, and treats an empty array as success when no material
issue remains. The parent applies material fixes, runs at most one
fresh-subagent re-review, and does not loop on lower-severity follow-up
suggestions.

This is what removes the need for a `get_review_comments` fetch tool:
the tool's *response* is the delivery mechanism, and the Task tool's
existing return-the-final-assistant-message contract carries it the rest
of the way.

For the empty-array case (the "review ran, found nothing" signal), the
tool returns *"Review of <file> (snapshot <hash>, no findings)."* —
same shape, zero findings.

### 4. Chat-card rendering

A new server→client WS message type:

```ts
interface WsAgentReviewAdded {
  type: "agent_review_added";
  sessionId: string;
  filePath: string;
  reviewId: string;
  fileType: "markdown" | "code";
  snapshotHash: string;
  findingCount: number;
  summary?: string;
  createdAt: string;
}
```

The client renders this as an inline message card in the chat
transcript at the position the review landed:

```
┌──────────────────────────────────────────────────────────┐
│ 🔍 Reviewed docs/foo/plan.md — 5 findings                │
│    "The doc conflates X and Y in §3 and §7." [open]      │
└──────────────────────────────────────────────────────────┘
```

The `[open]` action opens `FilePreviewModal` in **agent-review mode**
(see §5). The card stays in chat history forever — it's a record of the
review having happened, the same way tool-use cards record other agent
actions.

The card does **not** appear in the file's review history list (`Past
reviews` disclosure in the modal footer) — that surface is for the
draft/sent lifecycle, which agent reviews don't participate in.

### 5. Agent-review mode in `FilePreviewModal`

When the user clicks `[open]` on a card, the modal opens with:

- **Content:** `snapshot_content` from the `agent_review` row, NOT the
  live file. The header explicitly labels this: *"Snapshot from
  YYYY-MM-DD HH:MM — file may have changed since."* This is the only
  way pins line up with what the reviewer saw.
- **Comments:** only this review's comments. No human drafts. No other
  reviews from this or any prior session.
- **Controls:** no Send button, no "Ask agent to review" button, no
  add-comment affordance. The modal in this mode is read-only — same
  rendering primitives as the normal modal, no draft controls in the
  footer.
- **Tabs / siblings:** suppressed. This view is scoped to one review of
  one file, not the file's general modal experience.
- **Switch-back:** a small "View live file" link in the header takes
  the user to the normal modal on the same file (draft state, history,
  human authoring all available there).

The mode is selected by a new prop, e.g. `mode: "agent-review" | "live"`,
defaulting to `"live"`. The card's open action passes
`mode: "agent-review"` and the `reviewId`.

### 6. The validator fix (folded in)

`submitAiReviewComments` in `services/reviews.ts` currently treats every
loop item as an object and reaches for `c.text` before validating
shape. When the caller passes a bare string (or any non-object), the
*"non-empty text"* error misdirects the agent.

Replace the per-item validation with a shape check first:

```ts
for (let i = 0; i < comments.length; i++) {
  const c = comments[i];
  if (c === null || typeof c !== "object" || Array.isArray(c)) {
    throw new ServiceError(
      400,
      `Comment at index ${i} is not an object. Each comment must be `
      + `{kind: "line", line: number, text: string} or `
      + `{kind: "selection", quoted_text: string, text: string}.`,
    );
  }
  if (c.kind !== "line" && c.kind !== "selection") {
    throw new ServiceError(
      400,
      `Comment at index ${i} has invalid kind "${String(c.kind)}". `
      + `Expected "line" or "selection".`,
    );
  }
  if (typeof c.text !== "string" || !c.text.trim()) {
    throw new ServiceError(
      400,
      `Comment at index ${i} has empty or missing "text".`,
    );
  }
  // …existing length and per-kind anchor checks…
}
```

The shape-and-kind checks precede the text check, so a malformed payload
returns an error that names the actual problem and the index in the
array that has it. The agent can then fix its call rather than retrying
the same shape.

The MCP bridge's JSON Schema already declares the correct `oneOf`
structure for items, so well-behaved MCP clients reject malformed
payloads before they reach the bridge. The server-side fix is the
backstop for clients that don't enforce item schemas.

## Migration

Existing rows are not moved. Two concrete moves to clean up the visible
artefact of the bug without touching history:

1. **One-shot cleanup on first boot after deploy.** Delete all rows from
   `file_review_comments` with `source = "ai"` belonging to drafts
   (`file_reviews.status = "draft"`). If a draft is left with zero
   comments after the sweep, delete the draft. This wipes the
   accumulated 30-comment piles users are seeing today; no chat history
   is lost because the AI's findings were always also recorded in the
   chat transcript (the Task tool result that triggered each
   `submit_review_comments` call).
2. **Leave sent `source: "ai"` rows alone.** Those participated in a
   user-confirmed Send (the user explicitly clicked Send on a draft
   that contained AI comments). The history record is still meaningful.

A migration note in the relevant DB-migration file documents the
deletion and references this doc.

## Touchpoints

- **DB schema** — add `agent_reviews`, `agent_review_comments` tables.
  New `ReviewStore`-shaped accessor or extension of
  `FileReviewStore` (decision deferred to implementation; both are
  defensible).
- **`services/reviews.ts`** — `submitAiReviewComments` rewritten to
  target the new tables and snapshot the file; validator fix folded in.
- **`api-routes-reviews.ts`** — `POST /review-submit` still receives
  the submission, but routes it through the new service. Broadcasts
  `agent_review_added` (not `review_updated`).
- **`session-runner.ts` / `container-session-runner.ts`** — propagate
  the new message type through `emitMessage` (no logic change, just
  union widening).
- **`ws-server-messages.ts`** — add `WsAgentReviewAdded` to the closed
  union. Keep `WsReviewUpdated` for the human-draft path.
- **`client/hooks/message-handlers/`** — new handler for
  `agent_review_added` that appends a card to chat history (does NOT
  touch `file-review-store`).
- **Chat history rendering** — new card component for agent-review
  cards. Slots into the existing message-group rendering the same way
  other tool-use cards do.
- **`FilePreviewModal.tsx`** — `mode` prop, agent-review-mode rendering
  branch (read-only, snapshot content, single-review comments, no
  draft footer).
- **Client store** — small `agent-review-store.ts` (or extension of an
  existing store) holding fetched agent reviews keyed by reviewId, with
  a one-shot HTTP fetch when the modal opens a review.
- **`mcp-review-bridge.ts`** — no schema change; optionally tighten the
  tool description to call out the `kind` requirement more loudly, but
  the substantive change is server-side.
- **`compose-review-body.ts`** — update the composed review prompt to
  instruct the subagent to echo the tool result verbatim as its final
  response, gate findings to material issues only, order findings by
  severity, and bound re-review to one fresh-subagent pass. Drop the
  `--- Existing comments ---` embed for AI-source comments (now lives in
  chat history, not in any draft); keep the human-draft embed.
- **Integration tests** — `integration_tests/review-chat-native.test.ts`
  updates: a `submit_review_comments` call produces an `agent_review`
  row + an `agent_review_added` WS message, the human draft is
  untouched, and the tool response contains the structured rendering.
  Add a shape-validation test covering the bare-string case from §6.
- **Migration** — DB migration file deleting `source: "ai"` rows from
  draft `file_reviews`, with a guard so it runs once.

## Risks

- **Subagent doesn't echo the tool response.** Prompt-only enforcement;
  the structured findings still exist on the chat card, but the
  parent's copy of them degrades to whatever the subagent decided to
  say. Same shape of risk as the docs/125 "subagent skips the tool"
  failure mode — we ship and measure. The fallback if it doesn't hold:
  the orchestrator could intercept the Task tool result, detect the
  preceding `submit_review_comments` call, and rewrite the result to
  include the rendered findings before the parent sees them. Real
  work, deferred.
- **Snapshot bloat.** Storing the full file content per review costs
  storage. For markdown docs this is small (KB per row); for a code
  file at the 10 KB cap it's at most 10 KB per row. Bounded by the
  per-review cap. Not worth compressing in v1; revisit if storage
  becomes a concern.
- **The chat card is a new surface to maintain.** It's small (one
  message type, one component, one mode toggle on the modal), but it
  is net-new UI. Justified by removing the duplication between the
  draft bucket and the chat transcript that today motivates the bug.
- **Two surfaces for "AI findings on a file."** Old `source: "ai"`
  rows in sent reviews still exist (per Migration §2); new submissions
  land in agent-review cards. The modal's `Past reviews` disclosure
  will continue to show the old AI rows as part of historical sent
  reviews. That's acceptable as a transitional state — the divergent
  paths only matter for files whose review history pre-dates this
  feature.

## Open questions

1. **Should agent-review cards persist across container restarts the
   same way chat history does?** Chat history is already persisted per
   docs/095 (or whichever). The card is just a render of an
   `agent_review` row, so as long as the row survives, the card does
   too — but the rendering depends on the message being in the chat
   history pipe. Worth confirming during implementation that the new
   message type rehydrates correctly from persisted history, not just
   live WS.
2. **Should the snapshot be content-addressed (one snapshot per hash,
   referenced N times) to dedupe?** Probably not v1 — the simplicity
   of "row owns its snapshot" outweighs the storage win at the volumes
   we're talking about. Revisit if reviews-per-file gets very high.
3. **Should the card render a "diff against current file" toggle?**
   Useful when the parent has applied fixes and the user wants to see
   what changed. Defer to v2; the snapshot label in the header is
   enough signal that the live file may have moved.
4. **For code files: do we still apply the 10 KB review cap?** Yes,
   keeping the same cap docs/125 set. The cap is about whether the
   subagent can usefully review, not about whether the storage path
   can handle it.
