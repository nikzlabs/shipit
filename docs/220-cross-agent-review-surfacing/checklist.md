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

## Phase 2 — remove `submit_review`, wire `/review`, same-model prose (todo)

- [ ] `compose-review-body.ts`: drop the `submit_review` instruction from **both**
      prompts — cross-agent relies on the auto consult card (parent uses stdout
      only to act/fix/re-review); same-model tells the parent to **present
      findings as prose**
- [ ] **Remove** `submit_review` (`mcp-tools/review.ts`, AI branch): drop the
      bridge registration (`mcp-shipit-bridge.ts`), the orchestrator submit relay,
      and the `ai_review` write path; `ReviewCard` renders legacy rows only; keep
      the human user-comment endpoints
- [ ] `compose-review-body.test.ts` — neither prompt instructs a `submit_review`
      call; same-model prompt asks for prose findings
- [ ] Remove/adjust the docs/203 `submit_review` card / single-card / patch tests
      that no longer hold (tool removed); keep human user-comment tests

## Docs

- [x] Update `docs/144` §7 — consult card is now content-carrying (Phase 1)
- [x] `src/server/shipit-docs/agent.md` — brokered output is surfaced in the
      consult card (agent need not re-emit it) (Phase 1)
- [ ] Update `docs/203` once Phase 2 lands: mark the cross-agent branch superseded
      by this card path
- [x] Comment the rollout on SHI-195 (Phase 1)
