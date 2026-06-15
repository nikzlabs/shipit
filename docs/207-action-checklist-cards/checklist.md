# Action checklist cards — checklist

This doc is a **design proposal**. Nothing is implemented yet. Items below are the
build steps for when implementation starts.

- [ ] `propose_actions` MCP tool in `src/server/session/mcp-tools/` (mirror `ask.ts`)
- [ ] Register the tool in the shipit MCP bridge + Codex parity
- [ ] `actionChecklist` field on `PersistedMessage` + column + `toRow`/`fromRow` + migration (immutable list, no patch path)
- [ ] Emit via `emitChatCard` (in-band, persisted-on-fire)
- [ ] `ActionChecklistCard.tsx` — single-button vs checklist render; stays interactive (no lock, **no sent-receipt**)
- [ ] Submit: snapshot selected ids+payloads **atomically** at click, record the user message immediately, never re-read checkbox state after enqueue (queue-aware), reusable across submits
- [ ] "Add comment…" seeds composer with the **payloads** (not labels) as the `[x]`/`[ ]` snapshot; never disabled
- [ ] Stamp submitted message with **provenance** (proposed-at date, branch/HEAD) + "inspect current state, adapt/decline if obsolete" framing
- [ ] Add `actionChecklist` to `CARD_MESSAGE_FIELDS`
- [ ] Rehydrate in `loadSessionHistory`; idempotent-by-id append/upsert
- [ ] History round-trip + no-duplicate-on-replay tests; extend `EVERY_OPTIONAL_FIELD_MESSAGE`
- [ ] Schema/input validation: 1–5 actions, unique non-empty ids, non-empty payloads, max label/desc/payload lengths, deterministic order
- [ ] Accessibility: keyboard-operable checkboxes, accessible names; mobile/touch sizing
- [ ] Tool prompt guidance: form-only; scope guardrails (no routine-command cards, ≤1 card/turn, no prose+card duplication, cap ~3–5 actions)
- [ ] Codex parity (mirror `ask`, docs/147)
