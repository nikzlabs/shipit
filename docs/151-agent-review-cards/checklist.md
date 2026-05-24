# 151 — Agent review cards: checklist

## Storage

- [ ] Add `agent_reviews` table (`id`, `session_id`, `file_path`, `file_type`, `snapshot_content`, `snapshot_hash`, `summary`, `created_at`)
- [ ] Add `agent_review_comments` table (`id`, `agent_review_id`, `kind`, `line`, `quoted_text`, `context_before`, `context_after`, `text`, `created_at`)
- [ ] DB migration deletes `source: "ai"` rows from draft `file_reviews`; deletes drafts left empty after the sweep; idempotent (re-run safe)
- [ ] Decide: extend `FileReviewStore` vs new `AgentReviewStore` — pick one and wire DI accordingly

## Service layer (`services/reviews.ts`)

- [ ] Rewrite `submitAiReviewComments` to create an `agent_review` row with snapshot of current file content
- [ ] Anchor selection comments against `snapshot_content`; reject comments whose `quoted_text` is not present in the snapshot (don't fall back to "outdated" — snapshot is what the reviewer saw)
- [ ] Generate the rendered tool-response text (file path, snapshot hash short, finding count, anchored excerpts)
- [ ] Return `{ reviewId, snapshotHash, findingCount, rendered }` instead of the old draft shape
- [ ] Honor `runner.activeReviewFilePath` allow-list unchanged
- [ ] Validator fix: shape check → kind check → text check, each with index-tagged error messages naming the actual problem

## API route (`api-routes-reviews.ts`)

- [ ] `POST /review-submit` routes to the new service path
- [ ] Broadcast `agent_review_added` (not `review_updated`) on success
- [ ] Add `GET /api/sessions/:sessionId/agent-reviews/:reviewId` so the modal can fetch the snapshot + comments when the card is clicked

## Worker bridge (`mcp-review-bridge.ts`)

- [ ] No schema change required; verify the tool description still reads correctly post-redesign
- [ ] Confirm the tool result text returned to the subagent is the new rendered structure

## Orchestrator types & runner

- [ ] Add `WsAgentReviewAdded` to `ws-server-messages.ts` closed union
- [ ] Thread the new message type through `session-runner.ts` / `container-session-runner.ts` `emitMessage` paths
- [ ] Confirm chat-history persistence rehydrates `agent_review_added` on reconnect (open question #1)

## Client

- [ ] New WS handler for `agent_review_added`; appends a card to chat history (does NOT mutate `file-review-store`)
- [ ] Small store for fetched agent reviews keyed by `reviewId` (lazy HTTP fetch on card open)
- [ ] Chat-card component (file path, finding count, summary line, `[open]` action)
- [ ] `FilePreviewModal` gains `mode: "agent-review" | "live"` prop (default `"live"`)
- [ ] Agent-review-mode rendering branch: snapshot content, single-review comments, no draft footer, no Send button, no add-comment affordance, "View live file" link in header
- [ ] Suppress sibling tabs in agent-review mode
- [ ] Update `compose-review-body.ts` to instruct the subagent to echo the tool response verbatim as its final assistant message
- [ ] Drop AI-source comments from the `--- Existing comments ---` embed (they no longer live in drafts); keep human-source comments

## Tests

- [ ] Integration test: `submit_review_comments` call → `agent_review` row written, snapshot persisted, `agent_review_added` WS message delivered to a connected `TestClient`, human draft for the file is untouched
- [ ] Integration test: tool response text contains the rendered structured findings (assertable substring)
- [ ] Integration test: empty-array call produces a `(snapshot, no findings)` rendering and still creates a row
- [ ] Service test: validator returns shape-error with index when payload contains a bare string
- [ ] Service test: validator returns kind-error with index when `kind` is missing or invalid
- [ ] Service test: selection comment whose `quoted_text` is absent from snapshot is rejected
- [ ] Client test: `agent_review_added` handler appends a card, doesn't touch `file-review-store`
- [ ] Client test: agent-review-mode modal renders snapshot content and is read-only (no Send button, no add-comment UI)
- [ ] DB migration test: sweep deletes `source: "ai"` from draft `file_reviews` and removes resulting empty drafts; sent rows untouched; re-running the migration is a no-op

## Docs

- [ ] Update `docs/125-chat-native-ai-review/plan.md` with a status note pointing to this doc as the successor for the AI-comment storage path; the chat-native review *flow* stays as docs/125 describes it
- [ ] Mark this checklist complete and flip `plan.md` to `status: done` when shipped
