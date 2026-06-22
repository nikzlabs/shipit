# Checklist — cross-agent review surfacing (Option B)

Design decided (Option B); implementation not started. Every ShipIt-brokered
spawn produces a content-carrying consult card (stripped-down in-card preview +
full markdown on click); `submit_review` is **removed** (same-model review then
narrates as prose); each brokered call is its own card (no patch-in-place).

## Server

- [ ] `SubAgentConsultCard` gains a content field (e.g. `outputMarkdown`) + carry
      the existing `truncated` marker (`domain-types/chat.ts`)
- [ ] `services/sub-agent.ts` writes the capped `result.text` into the card's
      content field at emit time; keep the per-spawn `cardId` (no patch-in-place)
- [ ] Cap the persisted output length; set `truncated` on a hard cut
- [ ] Confirm `chat-history.ts` round-trips the new field inside the existing
      `sub_agent_consult` JSON column (no new column, no migration)
- [ ] **Remove** `submit_review` (`mcp-tools/review.ts`, AI branch): drop the
      bridge registration (`mcp-shipit-bridge.ts`), the orchestrator submit relay,
      and the `ai_review` write path; `ReviewCard` renders legacy rows only; keep
      the human user-comment endpoints

## Client

- [ ] `SubAgentConsultCardRow` (`MessageList.tsx`) renders the stripped-down
      preview + a click target
- [ ] Click opens the full output in a **read-only** markdown viewer (dedicated
      modal/pane wrapping `MarkdownContent`) — **not** `FilePreviewModal` over a
      workspace path; no comment / ask-review affordances
- [ ] `compose-review-body.ts`: drop the `submit_review` instruction from **both**
      prompts — cross-agent relies on the auto consult card (parent uses stdout
      only to act/fix/re-review); same-model tells the parent to **present
      findings as prose**
- [ ] Confirm `CARD_MESSAGE_FIELDS` already covers `subAgentConsult` (it does)

## Tests

- [ ] `services/sub-agent.test.ts` — card carries content; truncation flagged;
      distinct `cardId` per spawn (two review spawns → two cards, not patched)
- [ ] `chat-history` round-trip + no-dup-on-replay for the new content field;
      add to `EVERY_OPTIONAL_FIELD_MESSAGE`
- [ ] Client card test — preview render + click-to-open-full-markdown in the
      read-only viewer (asserts no file-review/comment affordances)
- [ ] `compose-review-body.test.ts` — neither prompt instructs a `submit_review`
      call; same-model prompt asks for prose findings
- [ ] Remove/adjust the docs/203 `submit_review` card / single-card / patch tests
      that no longer hold (tool removed); keep human user-comment tests

## Docs

- [ ] Update `docs/203` (beyond the existing pre-decision note) once code lands:
      mark the cross-agent branch superseded by this card path
- [ ] Update `docs/144` §7 — consult card is now content-carrying
- [ ] `src/server/shipit-docs/agent.md` — note the brokered output is surfaced in
      the consult card (agent need not re-emit it)
- [ ] Comment the rollout on SHI-195 when implementation starts
