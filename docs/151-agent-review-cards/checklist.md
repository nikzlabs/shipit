# 151 — Agent review cards: checklist

## Storage

- [x] Add `agent_reviews` table (`id`, `session_id`, `file_path`, `file_type`, `snapshot_content`, `snapshot_hash`, `summary`, `created_at`)
- [x] Add `agent_review_comments` table (`id`, `agent_review_id`, `kind`, `line`, `quoted_text`, `context_before`, `context_after`, `text`, `created_at`)
- [x] DB migration deletes `source: "ai"` rows from draft `file_reviews`; deletes drafts left empty after the sweep; idempotent (re-run safe)
- [x] Decide: extend `FileReviewStore` vs new `AgentReviewStore` — pick one and wire DI accordingly *(picked a new `AgentReviewStore`; the two surfaces have different lifecycles, no `status` / `source`, so colocating would have been misleading)*

## Service layer (`services/reviews.ts`)

- [x] Rewrite `submitAiReviewComments` to create an `agent_review` row with snapshot of current file content
- [x] Anchor selection comments against `snapshot_content`; reject comments whose `quoted_text` is not present in the snapshot
- [x] Generate the rendered tool-response text (file path, snapshot hash short, finding count, anchored excerpts)
- [x] Return `{ reviewId, snapshotHash, findingCount, rendered }` instead of the old draft shape
- [x] Honor `runner.activeReviewFilePath` allow-list unchanged
- [x] Validator fix: shape check → kind check → text check, each with index-tagged error messages naming the actual problem

## API route (`api-routes-reviews.ts`)

- [x] `POST /review-submit` routes to the new service path
- [x] Broadcast `agent_review_added` (not `review_updated`) on success
- [x] Add `GET /api/sessions/:sessionId/agent-reviews/:reviewId` so the modal can fetch the snapshot + comments when the card is clicked

## Worker bridge (`mcp-review-bridge.ts`)

- [x] No schema change required; tightened the tool description to call out the kind requirement and the echo expectation
- [x] Confirm the tool result text returned to the subagent is the new rendered structure

## Orchestrator types & runner

- [x] Add `WsAgentReviewAdded` to `ws-server-messages.ts` closed union
- [x] Thread the new message type through `session-runner.ts` / `container-session-runner.ts` `emitMessage` paths *(union widening only — emitMessage takes `WsServerMessage`)*
- [ ] Confirm chat-history persistence rehydrates `agent_review_added` on reconnect (open question #1) *(deferred — matches the `session_spawned` pattern: the card lives in the per-turn buffer for in-turn reconnects; cross-reload rehydration is a v2 follow-up that touches `chat-history.ts`)*

## Client

- [x] New WS handler for `agent_review_added`; appends a card to chat history (does NOT mutate `file-review-store`)
- [x] Small store for fetched agent reviews keyed by `reviewId` (lazy HTTP fetch on card open) *(implemented as `previewMode` + `previewAgentReview` on the existing `useFileStore` — keeps everything modal-related in one place)*
- [x] Chat-card component (file path, finding count, summary line, `[open]` action)
- [x] `FilePreviewModal` gains `mode: "agent-review" | "live"` prop (default `"live"`)
- [x] Agent-review-mode rendering branch: snapshot content, single-review comments, no draft footer, no Send button, no add-comment affordance, "View live file" link in header
- [x] Suppress sibling tabs in agent-review mode
- [x] Update `compose-review-body.ts` to instruct the subagent to echo the tool response verbatim as its final assistant message
- [x] Drop AI-source comments from the `--- Existing comments ---` embed (they no longer live in drafts); keep human-source comments

## Tests

- [x] Integration test: `submit_review_comments` call → `agent_review` row written, snapshot persisted, `agent_review_added` WS message delivered to a connected `TestClient`, human draft for the file is untouched
- [x] Integration test: tool response text contains the rendered structured findings (assertable substring)
- [x] Integration test: empty-array call produces a `(snapshot, no findings)` rendering and still creates a row
- [x] Service test: validator returns shape-error with index when payload contains a bare string
- [x] Service test: validator returns kind-error with index when `kind` is missing or invalid
- [x] Service test: selection comment whose `quoted_text` is absent from snapshot is rejected
- [x] Client test: `agent_review_added` handler appends a card, doesn't touch `file-review-store`
- [x] Client test: agent-review-mode modal renders snapshot content and is read-only (no Send button, no add-comment UI)
- [x] DB migration test: sweep deletes `source: "ai"` from draft `file_reviews` and removes resulting empty drafts; sent rows untouched; re-running the migration is a no-op

## Docs

- [x] Update `docs/125-chat-native-ai-review/plan.md` with a status note pointing to this doc as the successor for the AI-comment storage path; the chat-native review *flow* stays as docs/125 describes it
- [x] Mark this checklist complete and flip `plan.md` to `status: done` when shipped
