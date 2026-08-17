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
- [x] Storage names (`OPENCODE_ZEN_API_KEY`, `OPENCODE_GO_KEY`) deliberately not
      the CLI's own `OPENCODE_API_KEY`, with a test pinning that rule for every
      service
- [x] `opencode.ai` in the three egress lists (default, lifeline, firewall)
- [x] OpenCode's mark in `ServiceLogo`
- [x] The Go billing-hazard notice on the card and in the add-service step
      (req 6) — `ServicesPanel.tsx`
- [x] `x-shipit-secrets` names in `docker-compose.yml`, so the dogfood instance
      can hold both credentials

## Live verification with a real key (the gate on req 5)

Everything here needs an `OPENCODE_API_KEY` with credit; none of it can be done
without one. The rows ship gated (`carriers: ["opencode"]`) until each pair is
measured — see plan.md §7.

- [ ] One real paid turn per (product × style) on OpenCode: Zen
      `anthropic-messages` + `openai-chat-completions`, Go
      `openai-chat-completions`
- [ ] Claude Code × Zen (`anthropic-messages`) — a live turn, then drop
      `carriers` from the Zen credential
- [ ] Codex × Zen / Go (`openai-responses`) — a live turn, then add the
      `@ai-sdk/openai` rows (GPT-5.6 Sol/Terra/Luna, Grok) that are unauthored
      today because no harness could reach them
- [ ] Qwen3.8 Max on Go: settle the source conflict (vendor docs say
      `/messages`, models.dev says chat-completions) and add the row
- [ ] The Go cap-exceeded response shape, and whether "Use balance" leaves
      anything ShipIt could detect
- [ ] Re-pull live models.dev / the vendor tables and re-check every row's
      price, window and style — they drifted measurably in ten days

## Follow-ups (not blocking the rows)

- [ ] `HarnessDef.opencode.nativeService = "opencode"`, once
      `session-agent-env.ts`'s planning#353 guard distinguishes "native" from
      "native and account-delivered" — today setting it would route a
      selection-less OpenCode turn into an unshaped spawn with no credential
- [ ] The console OAuth device login (req 4's follow-up half): a
      `LoginIntegrationId`, an auth manager, and the credential-home symlink
      caveats from docs/268
- [ ] A Go quota reader, if the vendor ever publishes a per-key usage endpoint
      (option (b) in plan.md §8 — accumulating the per-response `cost` against
      the published caps — stays available meanwhile)
