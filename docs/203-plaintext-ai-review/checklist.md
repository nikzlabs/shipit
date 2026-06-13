# Checklist — Plain-text AI review

## Server
- [x] `submit_review_comments` → `submit_review` (`{ file_path, markdown }`) in `mcp-tools/review.ts`
- [x] Update `mcp-shipit-bridge.ts` registry (keep tool id `review`)
- [x] Markdown submit relay in `agent-ops-routes.ts` + `api-routes-reviews.ts` + `services/reviews.ts`
- [x] Drop anchoring/snapshot submit path; **keep** user draft/send endpoints
- [x] Remove `agent-review-store.ts`
- [x] `chat-history.ts`: `agentReview` → `aiReview` (+ column, toRow/fromRow, migration)
- [x] `domain-types.ts`: remove `AgentReview*` + AI branch of `ReviewComment`; keep human types
  - Note: `AgentReview*` removed. `ReviewCommentSource` (`human`/`ai`) was **kept** intentionally —
    the AI write path that produced `source:"ai"` is gone (no new ai rows), and dropping the field
    type would destabilize the kept user-comment storage. Decoupling is achieved by removing the writer.
- [x] `ws-server-messages.ts`: `ai_review_added`

## Client
- [x] `composeReviewMessage(filePath, { mode, reviewerAgentId })`; drop draft embedding
- [x] Resolve reviewer at click time in `App.tsx` (`/review` + `handleAskAgentReview`) from settings + registry
- [x] New `ReviewCard.tsx` (text); remove `AgentReviewCard.tsx` + modal `agent-review` mode
- [x] `ai-review-added` message handler (replace agent-review-added / review-updated)
- [x] `CARD_MESSAGE_FIELDS` += `aiReview`; rehydrate in `loadSessionHistory` (rides on the message field, no store seed)
- [x] Confirm `file-review-store.ts` + inline-comment UI unchanged (user comments)

## Tests
- [x] Rewrite `review-chat-native.test.ts`, `services/reviews.test.ts`, `compose-review-body.test.ts`
- [x] Card + handler tests for `ReviewCard` / `ai-review-added`
- [x] `aiReview` added to `EVERY_OPTIONAL_FIELD_MESSAGE` in `chat-history.test.ts` (round-trip + no-dup)
- [x] Client reviewer-resolution test: cross-agent vs subagent from (enableSubAgents × other-agent-authed) matrix
- [x] Integration: `/review` requests cross-agent → `runSubAgent` succeeds → one card; reviewer label names the agent
- [x] Integration: cross-agent **fails** (disabled / not signed in / not pinned / spawn-cap) → falls back to `Task`, still one card, label notes fallback
- [x] `submit_review` rejected outside a review turn / for a non-`reviewFilePath` file; fails clearly with no active runner
- [x] Re-review submit patches the same `reviewId` card (no duplicate); legacy `agent_review` row renders degraded

## Docs
- [x] Point `docs/125` + `docs/151` AI-review sections at `docs/203`
- [x] `src/server/shipit-docs/agent.md` reviewed — the `shipit agent run` primitive wording is unchanged
      (the review *card* is produced by the orchestrated `/review` flow, not ad-hoc `shipit agent run`)
