# Custom models checklist

`requirements.md` has no open questions.

- [ ] ShipIt-shipped service catalogue (req 8): services, the API styles each speaks,
      and per style the models that work there plus any style-required metadata
      (Codex needs context window, tool format, reasoning settings). Endpoint is
      per-style, not one base URL per service.
- [ ] Make catalogue entries compact (req 8) — a rule covering a model family, not one
      row per model, so an aggregator is no more work than a single-model service.
- [ ] User-supplied credentials only, key-authenticated (reqs 7, 10). Subscription-backed
      services stay limited to the vendors ShipIt already implements.
- [ ] Identify a selected model by **(service, model id)**, not by model id alone — the
      same id is reachable through more than one service.
- [ ] Make Anthropic and OpenAI ordinary rows in that list — no built-in or default
      service, no per-`AgentId` account model (reqs 2, 7).
- [ ] Give `AgentId` a declared API style; stop treating it as a service identity.
- [ ] Per-service declaration of which models work under which API style (req 8), and
      derive the picker's list from that plus the harness's style (req 9).
- [ ] Replace `hasAnyAuthForProvider` with per-model eligibility (req 11).
- [ ] Settings surface for supplying, editing, and removing service credentials
      (req 10) — key entry only; no subscription-login flow in this feature.
- [ ] Runtime per-service credential delivery. `ALLOWED_ENV_KEYS` is compile-time and
      cannot satisfy req 10; the compose path (`ServiceManager` snapshot) carries only
      compose-declared and `mcp__*` secrets, so it needs extending too.
- [ ] Confirm existing subscription-backed vendors keep their current credential path
      unchanged (req 7) — this feature adds key delivery, it does not touch theirs.
- [ ] Spawn shaping at both spawn sites, after the scrub, resolved from the selected
      model's service; test pins the ordering.
- [ ] Widen resident-process identity beyond a model string (req 5). The guard
      compares `appliedModel` to the selected model, so a same-id/different-service
      switch reuses the old process, endpoint and credential. Identity must cover
      harness, service, API style, endpoint, credential route and model — sharing a
      representation with the picker's `(service, model)` identity.
- [ ] Regression test: switching the same model id between two services forces a
      respawn and the next turn uses the new endpoint and credential.
- [ ] Explicit user-configured service for non-turn work (req 12), designed as **two**
      paths: session naming (has an implicit agent-bound seam today) and PR
      descriptions via `generateText` (returns empty in containerized production).
- [ ] On non-turn service failure, keep the existing fallback (placeholder title,
      generic PR description) and show a dismissible notice naming the failed service
      (req 12). Never block the surrounding operation; never fail silently.
- [ ] Branch credential-failure handling on **credential type, not error text**
      (req 15): a key-authenticated service stops the turn with a plain report;
      `AUTH_ERROR_PATTERNS` must not route its 401 into vendor re-auth.
- [ ] Gate the same-turn quota retry on credential kind too (`turn-executor.ts:938`
      fires on error text alone, so a key-backed service answering "quota exceeded" is
      retried on the same bad key). Account benching is already gated
      (`bootstrap-managers.ts:442`) — the two must agree.
- [ ] Establish per-harness coverage rather than assuming it: Codex classifies
      separately (`codex/adapter.ts:324`) and a Codex quota failure can arrive as a
      rejected JSON-RPC request that becomes an adapter `error`, not the `agent_result`
      the quota retry watches.
- [ ] Failover between subscriptions **of the same service** only (req 15) — never
      across services, which would change model and price mid-session. Lift the
      existing per-`AgentId` account failover to per-service without widening it.
- [ ] Guard test: an API-keyed service failure triggers no failover and no re-auth
      flow, while a subscription failure still fails over as today (docs/142, docs/150
      behavior unchanged).
- [ ] Per-service quota reporting: the map is `AgentId → routeId → limits` and the
      registry is keyed by `AgentId`, so this touches more than `LimitsProvider`. No
      indicator for a service with no quota (req 13), with a guard test that a
      key-based service renders nothing rather than an empty pill.
- [ ] Surface the active model, active service, and whether it bills a key or a
      subscription (req 14).
- [ ] Verify req 6 concretely on a non-vendor service: tools, skills, MCP servers, live
      steering, permission modes, plan mode, transcript — establishing that ShipIt adds
      no limitation the harness and model do not already have.
- [x] Retire the spike — removed from this branch on 2026-08-05, leaving the docs as
      the only content. Its findings are recorded in `plan.md`.
- [ ] Fresh-context review of the branch diff against every numbered requirement.
