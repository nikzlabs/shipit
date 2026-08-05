# Custom models checklist

Blocked: one open question remains in `requirements.md` (the usage indicator), and
implementation does not start while any is open.

- [ ] Answer the usage-indicator open question; record a dated receipt under
      `## Resolved questions` and fold it into the numbered requirements, same change.
- [ ] Service data model: user-owned list of services with credential, base URL, API
      style(s), and offered model ids (reqs 8, 11).
- [ ] Give `AgentId` a declared API style; stop treating it as a provider identity.
- [ ] Derive the picker's model list from configured services × harness API style
      (reqs 9, 10).
- [ ] Replace `hasAnyAuthForProvider` with per-model eligibility, with the backend's
      own account as one service among several (req 12).
- [ ] Settings surface for adding, editing, and removing services (req 11).
- [ ] Per-service credential name through `ALLOWED_ENV_KEYS`; verify both the container
      push and the local-mode startup load (req 5).
- [ ] Spawn shaping at both spawn sites, after the scrub, resolved from the selected
      model's service; test pins the ordering.
- [ ] Route non-turn work (session naming, PR descriptions) through the selected
      model's service (req 13) — no ambient-credential spawns left.
- [ ] Re-prompt for the *failing service's* credential on a 401, not the backend
      vendor's OAuth flow.
- [ ] Usage indicator, per the answer above.
- [ ] Retire or generalize the PR #1997 spike — it must not ship as-is.
- [ ] Fresh-context review of the branch diff against every numbered requirement.
