# 024 — Model & Context Display: Checklist

## Server

- [ ] Extend `ClaudeResultEvent` in `src/server/types.ts` with `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`
- [ ] Extend `UsageTurn` in `src/server/types.ts` with `inputTokens`, `outputTokens`
- [ ] Add `WsModelInfo` message type to `src/server/types.ts`
- [ ] Extend `WsUsageUpdate` with `lastTurnInputTokens`, `lastTurnOutputTokens`, `cumulativeInputTokens`
- [ ] Forward `model_info` on Claude CLI `system` init event in `src/server/index.ts`
- [ ] Add `getContextWindowSize(model)` helper in `src/server/index.ts`
- [ ] Track token counts per turn in `src/server/usage.ts`
- [ ] Include token data in `usage_update` messages

## Client

- [ ] Create `StatusBar.tsx` — model name + context usage meter (color-coded: green/yellow/orange/red)
- [ ] Add `formatModelName(model)` helper for display names
- [ ] Extend `UsageModal` with per-turn token breakdown and context usage bar
- [ ] Add `modelInfo` and `contextTokens` state to `App.tsx`
- [ ] Handle `model_info` message in `App.tsx`
- [ ] Handle extended `usage_update` with cumulative tokens in `App.tsx`
- [ ] Render `StatusBar` in layout
- [ ] Context warning toasts at 80% and 95% usage

## Tests

- [ ] Integration tests: `src/server/integration_tests/model-context.test.ts`
  - [ ] Claude init event with model → client receives `model_info` with correct window size
  - [ ] Claude result event with tokens → `usage_update` includes token counts
  - [ ] Various model strings → correct context window sizes
  - [ ] Init event without model → no `model_info` sent
- [ ] Component tests: `src/client/components/StatusBar.test.tsx`
  - [ ] Renders model name correctly (raw ID → display name)
  - [ ] Context meter shows correct percentage and color
  - [ ] Hidden when no model info available
  - [ ] Updates when context tokens change
- [ ] Extended UsageModal tests
  - [ ] Shows per-turn token breakdown
  - [ ] Shows context usage bar
  - [ ] Handles missing token data gracefully
