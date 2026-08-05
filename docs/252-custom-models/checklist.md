# Custom models checklist

`requirements.md` has no open questions.

- [ ] ShipIt-shipped service catalogue (req 8): services keyed by `serviceId`, the API
      styles each speaks, and per style the models that work there plus any
      style-required metadata (Codex needs context window, tool format, reasoning
      settings). Endpoint is per-style, not one base URL per service.
- [ ] Separate the four identities the design depends on: `serviceId` (catalogue),
      credential route (user-owned, several per service), selected model
      `(serviceId, modelId)`, and the turn's resolved route.
- [ ] Curate the catalogue to a maintained subset per service (req 8) — the models
      worth using for coding, not everything a service advertises. Per-model metadata is
      stated per model; no generation or family-rule scheme is needed.
- [ ] User-supplied credentials only, key-authenticated (reqs 7, 10). Subscription-backed
      services stay limited to the vendors ShipIt already implements.
- [ ] Identify a selected model by **(service, model id)**, not by model id alone — the
      same id is reachable through more than one service.
- [ ] Make Anthropic and OpenAI ordinary rows in that list — no built-in or default
      service, no per-`AgentId` account model (reqs 2, 7).
- [ ] Give `AgentId` a declared API style; stop treating it as a service identity.
- [ ] Per-service declaration of which models work under which API style (req 8), and
      derive the picker's list from that plus the harness's style (req 9).
- [ ] Replace `hasAnyAuthForProvider` with per-model **credential** eligibility
      (req 11) — a credential check only. No runtime model validation and no catalogue
      staleness policy: a model that stops working is a catalogue update.
- [ ] Settings surface for supplying, editing, and removing service credentials
      (req 10) — key entry only; no subscription-login flow in this feature.
- [ ] Per-catalogue-service credential key names. A compile-time entry per service is
      now sufficient — req 10's narrowing means a new service is already a ShipIt
      change. Do NOT build a runtime dynamic-key mechanism; its justification is gone.
- [ ] Close the compose delivery gap on its own merits: the `ServiceManager` snapshot
      carries only compose-declared and `mcp__*` secrets, so a stored service key does
      not reach a compose-backed containerized session.
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
- [ ] Session naming already degrades correctly (placeholder retained on `null`) — add
      only the notice (req 12).
- [ ] Normalize a **blank** PR description into the generic fallback (req 12). Today
      `generatePrDescriptionFromContext` returns `generateText`'s value verbatim, which
      is `""` in containerized production; generic prose is reached only from the
      `catch`. Separate tests for the rejection path and the blank-success path.
- [ ] Make the failure notice **durable**, not a toast: naming is fire-and-forget and
      can complete with no viewer attached. Persist it as transcript content via
      `emitChatCard`, scoped by `sessionId` and registered in
      `TRANSCRIPT_SCOPED_MESSAGES` (docs/188, docs/191); dismissal is state on the row.
- [ ] Guard test: the notice survives a reload and a session switch.
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
- [ ] Retired-pair fallback map (req 16): `(serviceId, modelId)` → successor, resolved
      where the session's model is read. Generalize `normalizeCodexModelId`
      (`agent-registry.ts:141`) rather than adding a second shim; key by pair, since two
      services can retire the same model id toward different successors.
- [ ] Guard test: a session pinned to a retired pair takes a turn on the successor and
      reports the successor (req 14), and the retired pair is absent from the picker.
- [ ] Verify req 6 concretely on a non-vendor service: tools, skills, MCP servers, live
      steering, permission modes, plan mode, transcript — establishing that ShipIt adds
      no limitation the harness and model do not already have.
- [x] Retire the spike — removed from this branch on 2026-08-05, leaving the docs as
      the only content. Its findings are recorded in `plan.md`.
- [ ] Fresh-context review of the branch diff against every numbered requirement.
