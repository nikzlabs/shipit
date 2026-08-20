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
- [x] A completed generation on both Zen routes, once credit was added:
      `claude-haiku-4-5` over `anthropic-messages` and `deepseek-v4-flash` over
      `openai-chat-completions` each answered exactly what they were asked, and
      each was accounted as a METERED turn ($0.0306 / 24 462 tokens and
      $0.0032 / 22 890 tokens), so the `key` mode's spend path is verified as
      well as its routing
- [x] Claude Code × Zen (`anthropic-messages`) — measured, and it **does not
      work**. The turn authenticates and routes (`route=reserved:env:OPENCODE_
      ZEN_API_KEY`, `opencode/key -> https://opencode.ai/zen`), then Zen
      rejects the request body: `400 [invalid_request_error]
      context_management: Extra inputs are not permitted`. Claude Code sends a
      `context_management` block that Zen's upstream refuses. It is a property
      of the CLI's request rather than of a model, a credential or a row, so
      the gate stays and no row-level change can lift it. A fix would have to
      stop the CLI sending the field; the binary exposes no flag for it
- [x] Codex × Zen / Go (`openai-responses`) — **both pass.** The rows had to
      come first, since the join refuses a pair whose style no model declares:
      Zen now carries `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` and
      `grok-4.6`, and Go carries `gpt-5.6-luna` alone (a no-key registry probe
      on `/zen/go/v1/responses` answers `ModelError` for Sol, so the asymmetry
      is measured, not assumed). Codex then ran a real turn on each product —
      metered on Zen ($0.0049 / 19 454 tokens), **included** on Go ($0 metered,
      $0.0024 at API rates). `carriers` on both credentials is now
      `["opencode", "codex"]`
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
- [ ] **Still not fixed, but no longer unfixable.** `glm-5.3` on Go refuses
      `none` upstream ("[1210] This model always engages in thinking and cannot
      be disabled; please use low, high, or max"). Today that only breaks the
      CLI's own title call, but a user who picks effort `none` for it would
      lose the turn. The catalogue schema this was waiting for now exists —
      docs/274 added `ModelDef.reasoningEfforts`, and the Ox Alpha row below is
      the first OpenCode row to use it against this exact refusal — so the fix
      is `reasoningEfforts: ["max", "high", "low"]` on the Go row. Left for its
      own change: the accepted set here comes from the vendor's error text
      rather than from a per-level probe, which needs a real Go key
- [ ] **Not fixed — wider than this feature.** A turn the service refuses
      leaves an EMPTY assistant bubble: "Insufficient balance" reached the
      adapter and became an `agent_result` with `status: "error"`, and the
      transcript still shows no error text, no card, and a credential that
      still reads `ready` in Settings. Measured on both Zen routes. Worth
      checking against the other harnesses before deciding where the text is
      being dropped

## Ox Alpha — req 8 (2026-08-21)

- [x] `x-preview-f-free` on Zen's `key` mode, `O_CC` only, 1M context, every
      rate $0 — id, style, efforts and cost each measured live against
      `/zen/v1/chat/completions`, with a bogus id as the negative control
- [x] `reasoningEfforts: ["max", "high", "low"]` — `medium` is in OpenCode's
      harness vocabulary and fails the request outright, so without the field
      the picker renders a level that cannot start a turn
- [x] Family `ox`, named in `UNDISCLOSED_LINEAGE`, and `selectReviewer`
      degrading `tierBasis` to `harness-only` on either side — a stealth
      identity is present and undecidable at once, which the existing check
      (implementer identity ABSENT) does not catch
- [x] Keyed by the wire id. `ox-alpha` plus an alias was tried and asserts more
      than the sources do — that a model leaving stealth under a new id is
      still this one
- [x] The per-million price floor exempts an all-zero row only when it is also
      named in the test's `FREE_ROWS`, so a zeroed row nobody vouched for still
      fails
- [x] The per-model effort invariant is scoped to harnesses that can actually
      carry the row, not every harness that joins it by style (grok sees Zen's
      chat-completions rows and can carry none of them)

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
