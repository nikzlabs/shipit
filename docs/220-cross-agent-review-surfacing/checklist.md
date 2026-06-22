# Checklist — cross-agent review surfacing (Option B)

Design decided (Option B). Every ShipIt-brokered spawn produces a
content-carrying consult card (stripped-down in-card preview + full markdown on
click); each brokered call is its own card (no patch-in-place); `submit_review`
is removed (same-model review then narrates as prose).

Delivered in two PRs: **Phase 1** (the additive content-carrying card) is done;
**Phase 2** (the destructive `submit_review` removal, entangled with the *kept*
human user-comment path) is sequenced as its own PR so CI can verify the wide
refactor.

## Phase 1 — content-carrying consult card (done)

- [x] `SubAgentConsultCard` gains `outputMarkdown`; reuses the existing
      `truncated` marker (`domain-types/chat.ts`)
- [x] `services/sub-agent.ts` writes `result.text` into the card at emit time;
      keeps the per-spawn `cardId` (no patch-in-place); omitted when empty / on a
      transport-failure card
- [x] Output length is bounded upstream by the spawn primitive's `maxOutputChars`
      cap (32K), which also sets `truncated` — reused, no second cap
- [x] `chat-history.ts` round-trips the field inside the existing
      `sub_agent_consult` JSON column (no new column, no migration)
- [x] `SubAgentConsultCardRow` renders the stripped-down preview + a click target
- [x] Click opens the full output in a **read-only** `MarkdownContent` dialog
      (`ui/dialog`) — **not** `FilePreviewModal`; no comment / ask-review affordances
- [x] `CARD_MESSAGE_FIELDS` already covers `subAgentConsult` (confirmed)
- [x] `services/sub-agent.test.ts` — card carries content; omitted when empty / on
      error; distinct `cardId` per spawn (two spawns → two cards, not patched)
- [x] `chat-history` round-trip covers the field (`EVERY_OPTIONAL_FIELD_MESSAGE`)
- [x] `SubAgentCards.test.tsx` — preview render + click-to-open read-only viewer;
      plain one-liner when there is no output

## Phase 2 — remove `submit_review`, wire `/review`, same-model prose (done)

Full removal (no vestigial scaffolding left), driven by `tsc`:

- [x] `compose-review-body.ts`: dropped the `submit_review` instruction from
      **both** prompts — cross-agent relies on the auto consult card (parent uses
      stdout only to act/fix/re-review); same-model presents **prose**
- [x] **Removed** the `submit_review` MCP tool (`mcp-tools/review.ts` deleted),
      bridge registration, worker relay (`/agent-ops/review/submit`), orchestrator
      endpoint (`/review-submit`), and `services/reviews.ts` AI write-back
- [x] Removed the `ai_review_added` WS message + client handler; **kept** the
      `aiReview` field / column / `ReviewCard` as a **legacy read path** (rows
      written before docs/220 still render). Human user-comment path untouched
- [x] Removed the now-orphaned scaffolding: `send_review_message` WS message +
      handler, `activeReviewFilePath`/`activeReviewId` runner fields, the
      `reviewFilePath` turn-pipeline thread (agent service, turn-executor,
      dispatched-turn, agent-execution, api-routes-agent, bootstrap-managers,
      session-runner queue), `isReviewTurn` steering input, and the orphaned
      `emitOrReplaceChatCard`. `/review` now sends a normal `send_message`
- [x] Removed the Claude `--allowedTools` + Claude/Codex `SHIPIT_MCP_TOOLS`
      `review`/`submit_review` entries
- [x] Tests: rewrote `compose-review-body.test.ts`; deleted the AI-review handler
      test + the `review-chat-native` integration test; updated bridge/route/
      runner/process/adapter tests; kept all human user-comment tests
- [x] Verified: typecheck + lint clean; affected unit + integration tests pass
      (steering, dispatch-route, doc/diff reviews, container-guard, bridge bundle)

## Docs

- [x] Update `docs/144` §7 — consult card is now content-carrying (Phase 1)
- [x] `src/server/shipit-docs/agent.md` — brokered output is surfaced in the
      consult card (agent need not re-emit it) (Phase 1)
- [x] Update `docs/203`: AI-review (`submit_review`) write path removed; cross-agent
      → consult card, same-model → prose; `ReviewCard`/`aiReview` kept legacy-only
- [x] Comment the rollout on SHI-195 (Phase 1 + Phase 2)
