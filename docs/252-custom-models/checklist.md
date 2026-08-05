# Custom models checklist

`requirements.md` has no open questions.

- [ ] Service data model: user-owned list of services with credential (key *or*
      subscription), base URL, API style(s), and offered model ids (reqs 7, 10).
- [ ] Identify a selected model by **(service, model id)**, not by model id alone — the
      same id is reachable through more than one service.
- [ ] Make Anthropic and OpenAI ordinary rows in that list — no built-in or default
      service, no per-`AgentId` account model (reqs 2, 7).
- [ ] Give `AgentId` a declared API style; stop treating it as a service identity.
- [ ] Per-service declaration of which models work under which API style (req 8), and
      derive the picker's list from that plus the harness's style (req 9).
- [ ] Replace `hasAnyAuthForProvider` with per-model eligibility (req 11).
- [ ] Settings surface for adding, editing, and removing services (req 10), covering
      **both** credential flows: storing a key, and running a subscription login.
- [ ] Runtime per-service credential delivery. `ALLOWED_ENV_KEYS` is compile-time and
      cannot satisfy req 10; the compose path (`ServiceManager` snapshot) carries only
      compose-declared and `mcp__*` secrets, so it needs extending too.
- [ ] Subscription-credential delivery via account credential roots — a separate path
      from key delivery, currently unspecified (req 7).
- [ ] Spawn shaping at both spawn sites, after the scrub, resolved from the selected
      model's service; test pins the ordering.
- [ ] Mid-session model and service switching (req 5) — rides the existing
      `releaseResidentOnModelChange` respawn boundary; re-resolve credential and base
      URL on that respawn. No new lifecycle mechanism needed.
- [ ] Explicit user-configured service for non-turn work (req 12), designed as **two**
      paths: session naming (has an implicit agent-bound seam today) and PR
      descriptions via `generateText` (returns empty in containerized production).
- [ ] Surface non-turn work as broken when its configured service stops working (req 12).
- [ ] Stop intercepting auth failures for a *service* credential: a failing service
      ends the turn with a plain report and no ShipIt recovery flow (req 15).
      `AUTH_ERROR_PATTERNS` must not route a service 401 into vendor re-auth.
- [ ] Preserve the carve-out: multi-subscription routing, quota failover and
      account-level auth recovery (docs/142, docs/150) are unchanged (req 15). Guard
      test that a service-credential failure does *not* trigger them.
- [ ] Per-service quota reporting: the map is `AgentId → routeId → limits` and the
      registry is keyed by `AgentId`, so this touches more than `LimitsProvider`. No
      indicator for a service with no quota (req 13), with a guard test that a
      key-based service renders nothing rather than an empty pill.
- [ ] Surface the active model, active service, and whether it bills a key or a
      subscription (req 14).
- [ ] Verify req 6 concretely on a non-vendor service: tools, skills, MCP servers, live
      steering, permission modes, plan mode, transcript.
- [x] Retire the spike — removed from this branch on 2026-08-05, leaving the docs as
      the only content. Its findings are recorded in `plan.md`.
- [ ] Fresh-context review of the branch diff against every numbered requirement.
