# Action checklist cards — checklist

This doc is a **design proposal**. Nothing is implemented yet. Items below are the
build steps for when implementation starts.

- [ ] `propose_actions` MCP tool in `src/server/session/mcp-tools/` (mirror `ask.ts`)
- [ ] Register the tool in the shipit MCP bridge + Codex parity
- [ ] `actionChecklist` field on `PersistedMessage` + column + `toRow`/`fromRow` + migration (immutable list, no patch path)
- [ ] Emit via `emitChatCard` (in-band, persisted-on-fire)
- [ ] `ActionChecklistCard.tsx` — single-button vs checklist render; stays interactive (no lock)
- [ ] Batch-submit selected `payload`s as one message (queue-aware), reusable across submits
- [ ] Add `actionChecklist` to `CARD_MESSAGE_FIELDS`
- [ ] Rehydrate in `loadSessionHistory`; idempotent-by-id append/upsert
- [ ] History round-trip + no-duplicate-on-replay tests; extend `EVERY_OPTIONAL_FIELD_MESSAGE`
- [ ] Tool prompt guidance: form-only (render existing suggestions as a card), no new frequency bar
- [ ] Codex parity (mirror `ask`, docs/147)
