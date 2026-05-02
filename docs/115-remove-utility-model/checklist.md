# Checklist — remove the configurable utility model

## Server: storage layer
- [x] `src/server/orchestrator/credential-store.ts` — delete `UtilityModelProvider` type, `UtilityModelConfig` interface, `utilityModel` field on `CredentialData`, and `getUtilityModel` / `setUtilityModel` / `clearUtilityModel` methods.
- [x] `src/server/orchestrator/credential-store.test.ts` — delete the `describe("utilityModel", ...)` block.

## Server: service + routes
- [x] `src/server/orchestrator/services/settings.ts` — delete `VALID_PROVIDERS`, `setUtilityModel`, `clearUtilityModel`, and the `UtilityModelConfig` / `UtilityModelProvider` type imports.
- [x] `src/server/orchestrator/services/index.ts` — barrel uses `export *`, no edit needed.
- [x] `src/server/orchestrator/api-routes-bootstrap.ts` — delete the three `/api/settings/utility-model` routes (GET/PUT/DELETE), the `setUtilityModel`/`clearUtilityModel` imports, and the "utility model" mention in the file header comment.

## Server: session naming
- [x] `src/server/orchestrator/session-namer.ts` — drop `UtilityModelConfig` import, drop `callOpenAICompatible` and `callAnthropic`, drop the `config` parameter on `generateSessionName`, drop the provider switch, and inline `callClaudeCli` as the only path. Updated top-level docstring.
- [x] `src/server/orchestrator/session-namer.test.ts` — rewrote to cover only the claude-cli path + JSON parsing/fallback behavior.

## Server: WS handler
- [x] `src/server/orchestrator/ws-handlers/send-message.ts` — removed the `getUtilityModel()` gate. `generateSessionName(userText)` is now called unconditionally (the existing `finalizeBranchRenamed` fallback still handles CLI failure). The `else` branch now only fires when `session.workspaceDir` is missing (defensive, shouldn't normally happen).

## Client
- [x] Deleted `src/client/components/UtilityModelCard.tsx`.
- [x] `src/client/components/Settings.tsx` — removed the `UtilityModelCard` import and its render site.

## Doc/comment hygiene
- [x] `src/server/orchestrator/api-routes-bootstrap.ts` file header — "utility model" removed.
- [x] `docs/063-idle-container-cleanup/plan.md` — removed the `utilityModel?: UtilityModelConfig` line from the `CredentialData` example.
- [x] `docs/104-chat-toc-and-summaries/plan.md` — no actual references found (earlier grep hit only the unrelated `claude-haiku` model name).

## Quality gates
- [x] `npm run typecheck` clean.
- [x] `npm run lint` clean.
- [x] `npm run test:dev` — 7 affected files, 184 tests, all green.
- [ ] Spot-check in browser: open Settings UI → confirm no Utility Model card, no console errors. *(manual; not blocking)*

## Wrap-up
- [x] `status: done` in `docs/115-remove-utility-model/plan.md`.
- [x] All actionable items above marked `[x]`.
