# Checklist

- [x] Derive per-tool duration server-side (`toolUseStartTimes` + `stampToolDurations`)
- [x] Carry `durationMs` through `extractToolResults` → `ToolResultEntry`
- [x] Persist `durationMs` on `PersistedMessage.toolResults` (JSON column, no migration)
- [x] Thread `durationMs` through the live client path (`agent-event.ts`)
- [x] Thread `durationMs` through the reload path (`session-data.ts`)
- [x] Render duration in `ToolOutputModal` with `formatToolDuration`
- [x] Server unit tests (`stampToolDurations`, `extractToolResults`)
- [x] History round-trip test for `durationMs`
- [x] Client tests (modal render + `formatToolDuration` units)
