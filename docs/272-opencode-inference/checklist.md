Implementation checklist for [plan.md](./plan.md) (docs/272, planning#431).

## Catalogue (reqs 1–3, 6)

- [x] `ServiceDef { id: "opencode", name: "OpenCode" }` with the Zen `key` mode and the Go `sub` mode, placed LAST in `SERVICES` so unbiased bare-id resolution and picker order are untouched
- [x] Model subset re-pulled against the current models.dev registry source at authoring time (2026-08-17, `sst/models.dev@dev` — the API host itself is egress-blocked in the session container); prices and styles copied verbatim, contexts from the canonical model files
- [x] Zen rows: Opus 5 / Sonnet 5 / Fable 5 (`anthropic-messages`), DeepSeek V4 Flash & Pro / GLM-5.2 / Kimi K3 (`openai-chat-completions`)
- [x] Go rows: GLM-5.3 / Kimi K3 / Qwen3.8 Max / DeepSeek V4 Pro & Flash / GLM-5.2 (all `openai-chat-completions`)
- [x] Zen's `/responses` models (GPT-5.6 family, Grok) deliberately NOT authored — no launch carrier speaks the style; they arrive with the Codex pair verification
- [x] Endpoints per measured convention: `A_MSG` base without `/v1`, `O_CC` bases with it (`/zen`, `/zen/v1`, `/zen/go/v1`)
- [x] Credentials: `OPENCODE_API_KEY` (Zen) / `OPENCODE_GO_API_KEY` (Go), both `carriers: ["opencode"]` pending req 5's pair runs
- [x] `QuotaIntegrationId` `"opencode-go-usage"` declared, NOT in `IMPLEMENTED_QUOTA_INTEGRATIONS` (req 6, planning#339 shape)

## nativeService and its consumers

- [x] `HarnessDef.opencode` gains `nativeService: "opencode"` (turn attribution may use the CLI's own `cost` on native + key)
- [x] `credential-failure-policy`: `vendorOwnedRecovery` re-keyed on the login integration, so a spent Go plan takes the set-aside/benching path, not a heal that heals nothing
- [x] `session-agent-env` planning#353 guard: the native-vendor skip applies only where an unshaped spawn can authenticate (login-backed vendors) — an OpenCode-key-only install still settles the row
- [x] `session-agent-env` `blockedSubjectFor`: a blocked OpenCode turn names the service ("credential … Settings → Services"), not "connect another account"
- [x] `settings.requireAccountService`: account verbs on OpenCode stay a 400

## Surfaces

- [x] Go "Use balance" warning (req 6) on the Go service card and the add-dialog credential step (`ServicesPanel`)
- [x] `ServiceLogo` mark for OpenCode (simple-icons 16.28.0)
- [x] `docker-compose.yml` dev service `x-shipit-secrets` carries both names (dev only, never onboarding)

## Tests

- [x] `catalogue.test.ts` — docs/272 describe: both modes, carriers gate, quota declared-not-implemented, storage-env pair, spawn-shaping literal URLs, Zen-vs-Anthropic and Zen-vs-Go price independence, native-without-login
- [x] `credential-failure-policy.test.ts` — vendor-owned recovery needs account machinery
- [x] `session-agent-env.test.ts` — selection-less OpenCode-only install settles the row
- [x] `ServicesPanel.test.tsx` — warning on the Go card and Go add step, absent on Zen
- [x] `npm run lint:dev`, `npm run typecheck`, affected + neighbouring suites green

## Live verification (req 5 / plan §7 — needs a real key; egress to opencode.ai also required)

- [ ] One real paid turn per (product × style): Zen `A_MSG`/`O_CC`, Go `O_CC`
- [ ] Cross-harness pair runs (Claude Code, Codex at Zen/Go) → widen `carriers` per verified pair, author the `/responses` rows with the Codex evidence
- [ ] Go cap-exceeded shape (expected 429 `UsageLimitError`-family) feeding the generic benching
- [ ] Re-check the model subset/prices against live models.dev at that time (§4 drift)
- [ ] (follow-up, req 4) console OAuth device login integration
