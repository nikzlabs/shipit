# Checklist — Plain-text AI review

## Server
- [ ] `submit_review_comments` → `submit_review` (`{ file_path, markdown }`) in `mcp-tools/review.ts`
- [ ] Update `mcp-shipit-bridge.ts` registry (keep tool id `review`)
- [ ] Markdown submit relay in `agent-ops-routes.ts` + `api-routes-reviews.ts` + `services/reviews.ts`
- [ ] Drop anchoring/snapshot submit path; **keep** user draft/send endpoints
- [ ] Remove `agent-review-store.ts`
- [ ] `chat-history.ts`: `agentReview` → `aiReview` (+ column, toRow/fromRow, migration)
- [ ] `domain-types.ts`: remove `AgentReview*` + AI branch of `ReviewComment`; keep human types
- [ ] `ws-server-messages.ts`: `ai_review_added`

## Client
- [ ] `composeReviewMessage(filePath, { mode, reviewerAgentId })`; drop draft embedding
- [ ] Resolve reviewer at click time in `App.tsx` (`/review` + `handleAskAgentReview`) from settings + registry
- [ ] New `ReviewCard.tsx` (text); remove `AgentReviewCard.tsx` + modal `agent-review` mode
- [ ] `ai-review-added` message handler (replace agent-review-added / review-updated)
- [ ] `CARD_MESSAGE_FIELDS` += `aiReview`; rehydrate in `loadSessionHistory`
- [ ] Confirm `file-review-store.ts` + inline-comment UI unchanged (user comments)

## Tests
- [ ] Rewrite `review-chat-native.test.ts`, `services/reviews.test.ts`, `compose-review-body.test.ts`
- [ ] Card + handler tests for `ReviewCard` / `ai-review-added`
- [ ] `aiReview` added to `EVERY_OPTIONAL_FIELD_MESSAGE` in `chat-history.test.ts` (round-trip + no-dup)

## Docs
- [ ] Point `docs/125` + `docs/151` AI-review sections at `docs/203`
- [ ] Update `src/server/shipit-docs/agent.md` review example if wording shifts
