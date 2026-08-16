---
title: Harness integration checklist (template)
description: Copy this file into the new integration's docs/NNN-*/checklist.md; every line is expanded, with file pointers, in plan.md.
---

# Harness integration checklist — template

The whole integration, one line per step. Copy into the integration's own
`docs/NNN-<harness>/checklist.md` and check off there; the expansion of
every line, with file pointers and gotchas, is in
[plan.md](../266-harness-integration-recipe/plan.md) (a path that still
resolves after the copy). Deliberately *not* named `checklist.md` here — that
name tracks docs/266's own branch work, and this template's boxes stay
unchecked.

**Phase 0 — assess (before any code)**
- [ ] Candidate passes the 13-point capability checklist; start-blockers
      cleared or explicitly signed off (stream schema, auth injection,
      pinnable install, reasoning levels)

**1 — Types**
- [ ] Widen `AgentId` (+ `LoginIntegrationId`/`QuotaIntegrationId` if the
      CLI has its own login/quota; + a per-harness permission-mode constant
      if its mode set differs)
- [ ] Widen the ESLint leak-guard regex + add the two folder exemptions
      (same commit)

**2 — Catalogue**
- [ ] `HarnessDef` row (+ `ServiceDef`/`ApiStyle` for a new vendor or wire
      format)
- [ ] `<X>_TOOL_NAMES`

**3 — Install & images**
- [ ] `install-agent-clis.sh`: known set, pkg prefix, binary
      (+ `npm rebuild` if native postinstall; non-npm CLI → settled design
      decision incl. the `installed.json` report)
- [ ] Pinned dep in `docker/agent-cli/package.json` + lockfile
- [ ] `SHIPIT_HARNESSES` defaults (5 Dockerfiles, vps setup + prompt copy,
      both compose files) if the default set changes
- [ ] Credential symlinks in the 3 Dockerfiles

**4 — Tables**
- [ ] Every required `Record<AgentId, …>` table (the compiler lists them
      once the union is widened)
- [ ] `buildLocalAgentFactory` switch
- [ ] The four `buildAgentRuntime` Maps + the local
      `PARALLEL_SESSIONS_SECTIONS` map (NOT compiler-forced)

**5 — Silent sites**
- [ ] Work the silent-sites list end to end (validators, `?? "claude"`
      defaults, registry probes, MCP tool subset, shim help text, UI name
      tables)

**6 — Session adapter**
- [ ] `session/agents/<id>/` (adapter + tool map + tests); register in
      barrel, `AGENT_TOOL_MAPS`, `createWorkerAgent` + factory test
- [ ] Token-usage normalizer if the CLI's cache figures overlap

**7 — Orchestrator folder**
- [ ] `orchestrator/agents/<id>/` (auth manager, limits provider,
      run-params prep, system prompt) + one entry per runtime map
- [ ] Update the *existing* backends' prompts, shipit-docs, and the voice
      vocabulary that name CLIs by name

**8 — Client**
- [ ] Theme CSS ×2 + `index.css` + `useTheme`
- [ ] Auth card (`ServicesPanel`) + `ProviderAccountRows` + misc UI tables

**9 — Tests**
- [ ] Extend the build-breaking parity tests (repick the installer test's
      bogus-id fixture if it collides); sibling auth/turn integration
      tests; client fixtures

**10 — Verify empirically**
- [ ] Skills-disclosure probe; stream-capture conformance test (incl. a
      synthesized terminal result if the stream is lossy); one dogfood
      turn per auth mode (billing route!); `shipit agent run` both
      directions; every declared capability flag confirmed against
      observed behavior
