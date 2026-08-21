# OpenCode harness integration checklist

Copied from
[docs/266-harness-integration-recipe/integration-checklist.md](../266-harness-integration-recipe/integration-checklist.md);
every line is expanded, with file pointers and gotchas, in
[the recipe's plan.md](../266-harness-integration-recipe/plan.md).

**Phase 0 — assess (before any code)**
- [x] Candidate passes the 13-point capability checklist; start-blockers
      cleared or explicitly signed off (stream schema, auth injection,
      pinnable install, reasoning levels) — findings in [plan.md](./plan.md)

**1 — Types**
- [x] Widen `AgentId` (+ `LoginIntegrationId`/`QuotaIntegrationId` if the
      CLI has its own login/quota — not needed at launch; + a per-harness
      permission-mode constant if its mode set differs — not needed)
- [x] Widen the ESLint leak-guard regex + add the two folder exemptions
      (same commit)

**2 — Catalogue**
- [x] `HarnessDef` row (no new `ServiceDef`/`ApiStyle` needed)
- [x] `OPENCODE_TOOL_NAMES`

**3 — Install & images**
- [x] `install-agent-clis.sh`: known set, pkg prefix, binary + gated
      `npm rebuild opencode-ai` (postinstall fetches the platform binary)
- [x] Pinned `opencode-ai@1.18.15` in `docker/agent-cli/package.json` +
      lockfile
- [x] `SHIPIT_HARNESSES` defaults unchanged (opencode is opt-in) — confirm
      no Dockerfile/vps/compose default edits needed
- [x] Credential symlinks in the 3 Dockerfiles

**4 — Tables**
- [x] Every required `Record<AgentId, …>` table (the compiler lists them
      once the union is widened)
- [x] `buildLocalAgentFactory` switch
- [x] The four `buildAgentRuntime` Maps + the local
      `PARALLEL_SESSIONS_SECTIONS` map (NOT compiler-forced)

**5 — Silent sites**
- [x] Work the silent-sites list end to end (validators, `?? "claude"`
      defaults, registry probes, MCP tool subset, shim help text, UI name
      tables)

**6 — Session adapter**
- [x] `session/agents/opencode/` (adapter + tool map + tests); register in
      barrel, `AGENT_TOOL_MAPS`, `createWorkerAgent` + factory test
- [x] Synthesized-terminal-result conformance test (truncated real stream)
      — token normalizer NOT needed (disjoint figures, verified)

**7 — Orchestrator folder**
- [x] `orchestrator/agents/opencode/` (run-params prep, system prompt; no
      auth manager / limits provider at launch) + one entry per runtime map
- [x] Update the *existing* backends' prompts, shipit-docs, and the voice
      vocabulary that name CLIs by name

**8 — Client**
- [x] Theme CSS ×2 + `index.css` + `useTheme`
- [x] Auth card (`ServicesPanel`) + `ProviderAccountRows` + misc UI tables

**9 — Tests**
- [x] Extend the build-breaking parity tests; sibling auth/turn integration
      tests; client fixtures

**10 — Verify empirically**
- [x] Skills-disclosure probe (`.claude/skills` natively read — no symlink)
- [x] Stream-capture conformance test (incl. the synthesized terminal
      result)
- [x] One dogfood turn in key mode with the billing route (live DeepSeek
      turns through the real adapter; the `openai-chat-completions` endpoint
      driven for the first time). GLM's header question: deferred, no GLM key
      in this container — see plan.md "Phase 10 findings"
- [ ] GLM `sub`-via-string header question (Bearer vs x-api-key) — needs a
      GLM credential
- [ ] `shipit agent run` both directions — needs a full dogfood install;
      deferred (plan.md "Phase 10 findings")
- [x] Every declared capability flag confirmed against observed behavior
      (`supportsSystemPrompt` verified live via config `instructions`;
      `supportsImages` structural only — no vision model reachable with the
      container's credentials)
