# OpenCode inference — checklist

The investigation is in [requirements.md](./requirements.md) and
[plan.md](./plan.md); this is the build.

## Investigation (docs/272's first PR)

- [x] `requirements.md` from the human's ask, with every gap as an open question
- [x] Product, auth, wire-style, model, pricing and billing-hazard facts, each
      marked ✅ observed or 🔍 stated (plan.md)
- [x] Live pass once egress opened: header matrix, route existence, "no
      cross-style translation", free-model completion, vendor docs
- [x] Go quota investigated to a conclusion — no per-key usage API exists
- [x] All open questions answered by the human, each with a dated receipt

## Catalogue rows (this PR)

- [x] `QuotaIntegrationId` gains `opencode-go-usage`, declared with no reader
      (req 6) — `catalogue/types.ts`
- [x] `ServiceDef { id: "opencode", name: "OpenCode" }` with both modes:
      Zen `key` (`/zen`, `/zen/v1`) and Go `sub` (`/zen/go/v1`) —
      `catalogue/services.ts`
- [x] Per-model styles taken from the vendor's own endpoint table, cross-checked
      against live models.dev, and re-verified per product with a no-key
      registry probe (`ModelError` vs `AuthError`) on 2026-08-17
- [x] Zen and Go carry their own price constants — neither is a pass-through
- [x] `claude-haiku-4-5` alias, so Zen's spelling of Haiku 4.5 is one model with
      Anthropic's — `catalogue/model-identity.ts`
- [x] Storage names `OPENCODE_ZEN_API_KEY` (Zen) and `OPENCODE_GO_KEY` (Go) —
      one per mode, so the two products stay two credential rows. Renamed from
      the vendor's `OPENCODE_API_KEY` on 2026-08-17 at the user's request; an
      adapter test pins that the secret reaches the CLI only as
      `OPENCODE_PROVIDER_API_KEY` and that the auto-detected vendor name stays
      scrubbed from the spawn
- [x] `opencode.ai` in the three egress lists (default, lifeline, firewall)
- [x] OpenCode's mark in `ServiceLogo`
- [x] The Go billing-hazard notice on the card and in the add-service step
      (req 6) — `ServicesPanel.tsx`
- [x] `x-shipit-secrets` names in `docker-compose.yml`, so the dogfood instance
      can hold both credentials
- [x] `HarnessDef.opencode.nativeService = "opencode"`, with the three readers
      that used "native" to mean "has account machinery" switched to ask
      `loginIntegrationForService` (credential-failure policy, the planning#353
      write and the blocked-turn subject, the account verbs in settings)

## Live verification with a real key (the gate on req 5)

Run on 2026-08-17 in the dogfood instance with the user's real key, adopted
from `Settings → Secrets` as `OPENCODE_ZEN_API_KEY` / `OPENCODE_GO_KEY`. The
Zen half of the account has **no credit**, which is what still blocks the rest:
Zen authenticates and then answers `AI_APICallError: Insufficient balance`.

- [x] Go × `openai-chat-completions` (`glm-5.3`) — a real turn, tool call and
      all, answering exactly what it was asked for. Recorded as an INCLUDED
      turn (44 565 tokens, $0 metered, $0.0345 at API rates), so the `sub`
      mode's spend accounting is verified too. Repeated with `--variant high`:
      also clean
- [x] Zen × `openai-chat-completions` (`deepseek-v4-flash`) and Zen ×
      `anthropic-messages` (`claude-haiku-4-5`) — both reach the service and
      authenticate; both are refused for **balance**, not credentials. The
      negative control is a bogus key on the same route, which answers 401
      `AuthError: Invalid API key` from `https://opencode.ai/zen/v1/messages`,
      so the base URL, the `/v1` the adapter appends, the `x-api-key` header
      and the model id are all confirmed on the wire
- [ ] A completed generation on either Zen route — **blocked on Zen credit**
- [ ] Claude Code × Zen (`anthropic-messages`) — a live turn, then drop
      `carriers` from the Zen credential. Also blocked on Zen credit: Claude
      Code speaks only `anthropic-messages`, which only Zen offers, so no
      cross-harness pair can be measured while Zen cannot answer. The gate
      stays exactly as it shipped
- [ ] Codex × Zen / Go (`openai-responses`) — a live turn, then add the
      `@ai-sdk/openai` rows (GPT-5.6 Sol/Terra/Luna, Grok) that are unauthored
      today because no harness could reach them. Neither product declares
      `openai-responses`, so this needs the rows first, not just credit
- [ ] Qwen3.8 Max on Go: settle the source conflict (vendor docs say
      `/messages`, models.dev says chat-completions) and add the row
- [ ] The Go cap-exceeded response shape, and whether "Use balance" leaves
      anything ShipIt could detect
- [ ] Re-pull live models.dev / the vendor tables and re-check every row's
      price, window and style — they drifted measurably in ten days

## What the verification run found

- [x] **Fixed here.** ShipIt declared all seven reasoning variants on every
      provider block. `@ai-sdk/anthropic` validates `effort` against
      `low|medium|high|xhigh|max`, so `none` and `minimal` threw
      `AI_TypeValidationError` **before any request left the process** on every
      anthropic-style turn. The shaping module now omits the levels a style's
      package refuses; an unknown `--variant` is ignored by the CLI, so a user
      who picks `none` gets the provider's default effort instead of a turn
      that cannot start
- [ ] **Not fixed — no schema for it.** `glm-5.3` on Go refuses `none`
      upstream ("[1210] This model always engages in thinking and cannot be
      disabled; please use low, high, or max"). Today that only breaks the
      CLI's own title call, but a user who picks effort `none` for it would
      lose the turn. `ModelDef` has no per-model reasoning field, so carrying
      this needs a catalogue schema change
- [ ] **Not fixed — wider than this feature.** A turn the service refuses
      leaves an EMPTY assistant bubble: "Insufficient balance" reached the
      adapter and became an `agent_result` with `status: "error"`, and the
      transcript still shows no error text, no card, and a credential that
      still reads `ready` in Settings. Measured on both Zen routes. Worth
      checking against the other harnesses before deciding where the text is
      being dropped

## One key, no choice (req 7) — the follow-up this PR was scoped out of

Req 7 arrived while this PR was open and is deliberately NOT in it: today the
user pastes the same key into two modes, which is the distinction the
requirement rejects. What the follow-up has to settle:

- [ ] Where the "one credential, two modes" concept lives. A stored secret is
      keyed by `(service, mode)` today, and that is what forces two rows —
      either a mode-shared credential, or OpenCode as one mode whose product is
      resolved per turn.
- [ ] How the Go entitlement is DETECTED rather than declared. There is no
      usage API (plan.md §8), but the two products have separate bases, so a
      probe against `/zen/go/v1` should distinguish an entitled account from an
      unentitled one. Measure what each answers before designing on it.
- [ ] What the picker and the metered-spend column show once one credential
      can bill two ways — the mode is still the honest answer to "what paid for
      this turn", even when the user never chose it.
- [ ] Whether the "Use balance" hazard (req 6) needs re-wording once Go and Zen
      are one credential, since that option is exactly the case where a turn
      the user thinks is on the plan is billed to credits.

## Follow-ups (not blocking the rows)

- [ ] The console OAuth device login (req 4's follow-up half): a
      `LoginIntegrationId`, an auth manager, and the credential-home symlink
      caveats from docs/268
- [ ] A Go quota reader, if the vendor ever publishes a per-key usage endpoint
      (option (b) in plan.md §8 — accumulating the per-response `cost` against
      the published caps — stays available meanwhile)
