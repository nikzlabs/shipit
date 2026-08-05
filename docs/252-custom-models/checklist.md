# Custom models checklist

Blocked: implementation cannot start while `requirements.md` has open questions.

- [ ] Get the five open questions in `requirements.md` answered; record each as a
      dated receipt under `## Resolved questions` and fold the answer into the
      numbered requirements, in the same change.
- [ ] Write the design in `plan.md` § Design, citing requirements as `(req N)`.
- [ ] Express "harness + credential + endpoint" without overloading `AgentId`.
- [ ] Model-level route eligibility, replacing provider-level `hasAnyAuthForProvider`.
- [ ] Custom-model credential delivery through `ALLOWED_ENV_KEYS`.
- [ ] Env shaping at both spawn sites, after the scrub; test pins the ordering.
- [ ] Decide the fate of the three known-wrong behaviors (usage pill, 401 recovery
      path, non-turn CLI spawns) per the answers.
- [ ] Retire or generalize the PR #1997 spike — it must not ship as-is.
- [ ] Fresh-context review of the branch diff against every numbered requirement.
