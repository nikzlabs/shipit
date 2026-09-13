# Antigravity CLI harness — integration checklist

Copied from
[docs/266-harness-integration-recipe/integration-checklist.md](../266-harness-integration-recipe/integration-checklist.md);
the expansion of every line, with file pointers and gotchas, is in
[that recipe's plan.md](../266-harness-integration-recipe/plan.md). What is
Antigravity-specific is in [plan.md](./plan.md).

**Phase 0 — assess (before any code)**
- [x] Candidate passes the 15-point capability checklist; start-blockers
      cleared or explicitly signed off (stream schema: documented and
      captured; auth: account token file + `GEMINI_API_KEY`; pinnable
      install: per-version release tarball, read-only install dir stops the
      updater — signed off 2026-09-13 as "same script as the other
      harnesses"; reasoning levels: `--effort low|medium|high`)
- [x] `supportsCompaction` (item 14) settled by a REAL probe: `/compact` as a
      resumed headless turn's prompt on 1.2.2 reaches the model as text, no
      summary step — `false`, probed (`probes/compact-b.ndjson`)
- [ ] `supportsReview` (item 15) settled by a depth-0 probe with the real
      composed review message — needs a ShipIt session on the harness
      (Phase 10); `run_command` + `invoke_subagent` exist in `init.tools`
- [x] Every capability `false` (item 13) says WHY beside it (plan.md,
      "Catalogue row")

**1 — Types**
- [ ] Widen `AgentId` (+ `LoginIntegrationId` `google-antigravity-oauth`;
      + `ANTIGRAVITY_PERMISSION_MODES` with the full-auto member only, req 8)
- [ ] Widen the ESLint leak-guard regex + add the two folder exemptions
      (same commit)

**2 — Catalogue**
- [ ] `HarnessDef` row (`styles: ["gemini-generate-content"]`); the `google`
      `ServiceDef` gains a `sub` mode for the account; rewrite the docs/302
      "vendor no harness speaks yet" guard into join assertions
- [x] `GEMINI_API_KEY` declared in the `dev` compose service's
      `x-shipit-secrets` block (docs/302; `agent: true` since PR #2752)
- [ ] `ANTIGRAVITY_TOOL_NAMES` (57 names, `probes/flash-test.ndjson` init)

**3 — Install & images**
- [ ] `install-agent-clis.sh`: known set, `harness_pkg_prefix` sentinel arm,
      binary, tarball fetch + checksum + `chmod -R a-w` into
      `/opt/antigravity`, prune arm, `installed.json` (plan.md, "Install")
- [ ] Version pin: newest release ≥ 7 days old at implementation time,
      hand-verified (the tarball is outside `check-deps`)
- [ ] `SHIPIT_HARNESSES` defaults unchanged (installable-but-unchecked,
      docs/271); `HARNESS_ROWS` in both `deployment/*/setup.sh`
- [ ] Dogfood opt-in: add `antigravity` to the hard-coded `SHIPIT_HARNESSES`
      build arg in BOTH dogfood blocks of `docker-compose.yml`
- [ ] Credential symlink `/credentials/.gemini` in the 3 Dockerfiles + the
      `entrypoint.sh` gosu `mkdir -p` block (+ `Dockerfile.dev`, which today
      lacks `.grok` too)

**4 — Tables**
- [ ] Every required `Record<AgentId, …>` table (the compiler lists them)
- [ ] `buildLocalAgentFactory` switch
- [ ] The four `buildAgentRuntime` Maps + the local
      `PARALLEL_SESSIONS_SECTIONS` map (NOT compiler-forced); the auth manager
      also into `catalogue.test.ts`'s "every declared login backed by a real
      auth manager" guard

**5 — Silent sites**
- [ ] Work the silent-sites list end to end (validators, `?? "claude"`
      defaults, registry probes, MCP tool subset, shim help text, UI name
      tables, egress allowlists: sign-in + account-mode hosts measured first)

**6 — Session adapter**
- [ ] `session/agents/antigravity/` (adapter + spawn home + plugin writer +
      tool normalizer + tests); register in barrel, `AGENT_TOOL_MAPS`,
      `createWorkerAgent` + factory test
- [x] No token-usage normalizer: `total = input + output`, thinking ⊂ output,
      cache_read ⊂ input (verified on every captured step and result)

**7 — Orchestrator folder**
- [ ] `orchestrator/agents/antigravity/` (auth manager with `submitCode`,
      run-params prep, system prompt; no limits provider until a usage
      reader is found) + one entry per runtime map
- [ ] Update the *existing* backends' prompts, shipit-docs, and the voice
      vocabulary that name CLIs by name

**8 — Client**
- [ ] Theme CSS ×2 + `index.css` + `useTheme`
- [ ] Auth card: `ServicesPanel.tsx` paste-shape gate (`=== "claude"` →
      set of paste-shaped providers) + `ProviderAccountRows` label table

**9 — Tests**
- [ ] Extend the build-breaking parity tests (installer↔catalogue: the
      npm-shaped `harness_pkg_prefix` assertion; stub the tarball fetch);
      sibling auth/turn integration tests; client fixtures
- [ ] Token freshness reader verified against a REAL captured token file,
      committed as its `token-freshness-guard.test.ts` fixture (values
      blanked; `expiry` is the field)

**10 — Verify empirically**
- [ ] Stream-capture conformance test from the vendored `probes/*.ndjson`
      (incl. the "answer present, status ERROR" 503 case in
      `plugin-mcp.ndjson`); one dogfood turn per auth mode (billing route!);
      `shipit agent run` both directions; every declared capability flag
      confirmed against observed behaviour; skills disclosure via the plugin
      symlink verified
- [ ] Event-conversion verification: run the docs/272 recipe —
      `docs/272-harness-conversion-verification/verification-checklist.md`
