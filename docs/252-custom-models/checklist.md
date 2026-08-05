# Custom models checklist

`requirements.md` has no open questions — implementation is unblocked.

- [ ] Service data model: user-owned list of services with credential (key *or*
      subscription), base URL, API style(s), and offered model ids (reqs 7, 10).
- [ ] Make Anthropic and OpenAI ordinary rows in that list — no built-in or default
      service, no per-`AgentId` account model (reqs 2, 7).
- [ ] Give `AgentId` a declared API style; stop treating it as a service identity.
- [ ] Derive the picker's model list from configured services × harness API style
      (reqs 8, 9).
- [ ] Replace `hasAnyAuthForProvider` with per-model eligibility (req 11).
- [ ] Settings surface for adding, editing, and removing services (req 10).
- [ ] Mid-session model switching on one harness, including across services
      (req 5) — first establish, by reading `StreamingClaudeProcess`, whether a
      resident process can change model without a respawn or must be forced to
      restart.
- [ ] Per-service credential name through `ALLOWED_ENV_KEYS`; verify both the container
      push and the local-mode startup load.
- [ ] Spawn shaping at both spawn sites, after the scrub, resolved from the selected
      model's service; test pins the ordering.
- [ ] Explicit user-configured service for non-turn work (session naming, PR
      descriptions), independent of the session's model (req 12) — and surfaced as
      broken when that service stops working.
- [ ] Re-prompt for the *failing service's* credential on a 401, not a vendor OAuth
      flow (req 11).
- [ ] Per-service quota reporting, shaped to accommodate a service exposing its own
      subscription later; no indicator for a service with no quota (req 13). Guard
      test that a key-based service renders nothing rather than an empty pill.
- [ ] Retire or generalize the PR #1997 spike — it must not ship as-is.
- [ ] Fresh-context review of the branch diff against every numbered requirement.
