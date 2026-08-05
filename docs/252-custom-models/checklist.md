# Custom models checklist

Blocked: one open question remains in `requirements.md` (the resting state of the usage
indicator for a service that reports nothing), and implementation does not start while
any is open.

- [ ] Answer the residual usage-indicator question; record a dated receipt under
      `## Resolved questions` and fold it into the numbered requirements, same change.
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
      (req 5) — first establish whether the resident streaming process can change
      model without a respawn.
- [ ] Per-service credential name through `ALLOWED_ENV_KEYS`; verify both the container
      push and the local-mode startup load.
- [ ] Spawn shaping at both spawn sites, after the scrub, resolved from the selected
      model's service; test pins the ordering.
- [ ] Explicit user-configured service for non-turn work (session naming, PR
      descriptions), independent of the session's model (req 12) — and surfaced as
      broken when that service stops working.
- [ ] Re-prompt for the *failing service's* credential on a 401, not a vendor OAuth
      flow (req 11).
- [ ] Per-service usage reporting, shaped to accommodate a service exposing its own
      subscription later (req 13).
- [ ] Retire or generalize the PR #1997 spike — it must not ship as-is.
- [ ] Fresh-context review of the branch diff against every numbered requirement.
