# Action checklist cards — checklist

Implemented in SHI-153. Items below are the build steps; all are complete.

- [x] `propose_actions` MCP tool in `src/server/session/mcp-tools/propose-actions.ts` (mirror `ask.ts`)
- [x] Register the tool in the shipit MCP bridge + Codex parity (both `SHIPIT_MCP_TOOLS` lists)
- [x] `actionChecklist` field on `PersistedMessage` + column + `toRow`/`fromRow` + migration (immutable list, no patch path)
- [x] Emit via `emitChatCard` (in-band, persisted-on-fire) — orchestrator `api-routes-propose-actions.ts`
- [x] `ActionChecklistCard.tsx` — single-button vs checklist render; stays interactive (no lock, **no persisted receipt**)
- [x] Transient post-Submit ack: clear boxes + brief "Submitted · N sent" in **client component state only** (Submit path only; Add comment leaves card untouched); discarded on rehydrate so reload shows the original state
- [x] Submit: snapshot selected ids+payloads **atomically** at click, send via the queue-aware follow-up sender (one message → one turn), reusable across submits
- [x] "Add comment…" seeds composer with the **payloads** (not labels) as the `[x]`/`[ ]` snapshot; never disabled
- [x] Stamp submitted message with **provenance** (proposed-at date, branch/HEAD) + "inspect current state, adapt/decline if obsolete" framing
- [x] Add `actionChecklist` to `CARD_MESSAGE_FIELDS`
- [x] Rehydrate in `loadSessionHistory` (payload lives on the message — no store); idempotent-by-id append
- [x] History round-trip + no-duplicate-on-replay tests; extend `EVERY_OPTIONAL_FIELD_MESSAGE`
- [x] Schema/input validation: 1–5 actions, unique non-empty ids, non-empty payloads, max label/desc/payload lengths, deterministic order
- [x] Accessibility: keyboard-operable native checkboxes with accessible names; touch-sized rows
- [x] Tool prompt guidance: form-only; scope guardrails (no routine-command cards, ≤1 card/turn, no prose+card duplication, cap ~3–5 actions) — tool `instructions` + skeleton system-prompt section
- [x] Codex parity (mirror `ask`, docs/147)
