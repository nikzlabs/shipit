# Checklist — cross-agent review surfacing (Option B)

Design decided (Option B); implementation not started. Every ShipIt-brokered
spawn produces a content-carrying consult card (stripped-down in-card preview +
full markdown on click); `submit_review` demoted/removed; each brokered call is
its own card (no patch-in-place).

## Server

- [ ] `SubAgentConsultCard` gains a content field (e.g. `outputMarkdown`) + carry
      the existing `truncated` marker (`domain-types/chat.ts`)
- [ ] `services/sub-agent.ts` writes the capped `result.text` into the card's
      content field at emit time; keep the per-spawn `cardId` (no patch-in-place)
- [ ] Cap the persisted output length; set `truncated` on a hard cut
- [ ] Confirm `chat-history.ts` round-trips the new field inside the existing
      `sub_agent_consult` JSON column (no new column, no migration)
- [ ] `submit_review` (`mcp-tools/review.ts`): demote to presentation-only or
      remove; if removed, drop bridge registration + the `/review` dependence

## Client

- [ ] `SubAgentConsultCardRow` (`MessageList.tsx`) renders the stripped-down
      preview + a click target
- [ ] Click opens the full output in the shared markdown viewer (file-dialog /
      Present renderer)
- [ ] Confirm `CARD_MESSAGE_FIELDS` already covers `subAgentConsult` (it does)

## Tests

- [ ] `services/sub-agent.test.ts` — card carries content; truncation flagged;
      distinct `cardId` per spawn (two review spawns → two cards, not patched)
- [ ] `chat-history` round-trip + no-dup-on-replay for the new content field;
      add to `EVERY_OPTIONAL_FIELD_MESSAGE`
- [ ] Client card test — preview render + click-to-open-full-markdown
- [ ] Remove/adjust the docs/203 `submit_review` single-card / patch tests that
      no longer hold for the brokered path

## Docs

- [ ] Update `docs/203` (beyond the existing pre-decision note) once code lands:
      mark the cross-agent branch superseded by this card path
- [ ] Update `docs/144` §7 — consult card is now content-carrying
- [ ] `src/server/shipit-docs/agent.md` — note the brokered output is surfaced in
      the consult card (agent need not re-emit it)
- [ ] Comment the rollout on SHI-195 when implementation starts
