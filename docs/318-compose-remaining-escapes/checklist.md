# Checklist — 318 Compose remaining file escapes

- [x] Verify all four escapes still hold in current code (post-planning#619)
- [x] Write requirements.md; resolve open questions with the requester
- [x] Write plan.md
- [x] Sync tracker (comment on planning#620)
- [ ] Get go-ahead on the plan (large, daemon-unverifiable change)
- [ ] Mechanism 1: thread session identity into `ComposeCli`; drop uid in `defaultComposeRunner`/`defaultComposeQuery` (root-gated)
- [ ] Mechanism 1: `lchown` the override, service-env files, and docker-secret files to the session identity (root-gated)
- [ ] Mechanism 2: `docker compose config` resolved-model validation before `up`; refuse escaping resolved sources (volumes, env_file, secrets/configs file, build paths)
- [ ] Retire the contained-only interpolation refusal and Open-mode `extends` gate now covered by Mechanism 2; keep literal fast checks
- [ ] Tests: spawn options (uid/gid, root-gated), chown calls + identity, resolved-model validation over crafted `config` output, fail-closed paths
- [ ] Docs: `shipit-docs/compose.md`, `docs/172-agent-containment/plan.md`, `docs/086-shipit-yaml-and-compose/plan.md`
- [ ] `npm run lint:dev`, `npm run typecheck`, affected `npx vitest run`
- [ ] Independent review (`shipit agent run --role reviewer`) against every requirement
- [ ] PR (`Closes planning#620` if item 2 also lands, else `Refs planning#620`)
