# Grok Build harness — integration checklist

Copied from
[docs/266-harness-integration-recipe/integration-checklist.md](../266-harness-integration-recipe/integration-checklist.md);
the expansion of every line, with file pointers and gotchas, is in
[that recipe's plan.md](../266-harness-integration-recipe/plan.md).

**Phase 0 — assess (before any code)**
- [x] Candidate passes the 13-point capability checklist; start-blockers
      cleared or explicitly signed off (stream schema: captured both
      formats; auth: key-only launch signed off, subscription deferred to
      planning#435; pinnable install: npm `@xai-official/grok@1.0.1`;
      reasoning levels: none in key mode — reviewer-default no-levels
      extension approved 2026-08-18)

**1 — Types**
- [x] Widen `AgentId` (no `LoginIntegrationId`/`QuotaIntegrationId` — key-only
      at launch, req 6; `GROK_PERMISSION_MODES` added beside
      `CLAUDE_PERMISSION_MODES`)
- [x] Widen the ESLint leak-guard regex + add the two folder exemptions
      (same commit)

**2 — Catalogue**
- [x] `HarnessDef` row (+ the xAI `ServiceDef`; no new `ApiStyle` — both of
      Grok's are already declared)
- [x] New-vendor `storageEnv` declared in the `dev` compose service's
      `x-shipit-secrets` block (guard-tested; never in `onboarding`) —
      for Grok: `XAI_API_KEY` on the xAI `ServiceDef`
- [x] `GROK_TOOL_NAMES`

**3 — Install & images**
- [x] `install-agent-clis.sh`: known set, pkg prefix, binary, and the
      `npm rebuild @xai-official/grok` line (brotli-compressed platform
      binary decompressed by a postinstall — the OpenCode shape)
- [x] Pinned dep in `docker/agent-cli/package.json` + lockfile
      (`@xai-official/grok@1.0.1`)
- [x] `SHIPIT_HARNESSES` defaults unchanged — Grok ships
      installable-but-unchecked (req 4, docs/271). `deployment/vps/setup.sh`
      gains the picker row without joining `HARNESS_DEFAULT`.
- [x] Dogfood opt-in: `SHIPIT_HARNESSES` build arg added to BOTH dogfood
      build blocks in `docker-compose.yml` (dev + onboarding) — required
      precisely because Grok is not in the default set
- [x] Credential symlinks in the 3 Dockerfiles (`/credentials/.grok`)

**4 — Tables**
- [x] Every required `Record<AgentId, …>` table (the compiler listed them:
      credential paths, credential vars, tool maps, auth error, limit
      labels, provider labels ×2, legacy paths/markers, reviewer default,
      client harness names)
- [x] `buildLocalAgentFactory` switch
- [x] The four `buildAgentRuntime` Maps + the local
      `PARALLEL_SESSIONS_SECTIONS` map (NOT compiler-forced) — Grok gets
      `runParamsPreps` and `parallelSessionsSections`; no auth manager and no
      limits provider (req 6)

**5 — Silent sites**
- [x] Worked end to end: the persisted-route and DB-row validators, the
      provider-account HTTP gate, both query-param validators, the two
      client localStorage validators, `AUTH_ENV_KEYS`, the shim help text,
      `SUB_AGENT_DISPLAY_NAMES`, the `RoleEditor` cast, and the egress
      allowlists (`api.x.ai` — exact host, in all three lists)
- [x] Audited and deliberately unchanged: the `?? "claude"` defaults (Grok is
      not the default harness), Claude-only `--resume` recovery,
      `token-sync-manager` stale-resume (OAuth backends only),
      `ensureCodexHomeInitialized` (Grok creates its own root), and
      `LOCAL_WORKSPACE_TRUST` / `POST_PROVISION_CONFIG` — **probed live: a
      headless run on a never-seen repo needs no trust grant**

**6 — Session adapter**
- [x] `session/agents/grok/` — `adapter.ts`, `stream.ts`, `config-toml.ts`,
      `tool-map.ts` + tests; registered in the barrel, `AGENT_TOOL_MAPS` and
      `createWorkerAgent` (factory test extended in the same commit)
- [x] No token-usage normalizer — the CLI's figures are disjoint (verified
      arithmetically on a real terminal event)

**7 — Orchestrator folder**
- [x] `orchestrator/agents/grok/` (run-params prep + system prompt; no auth
      manager, no limits provider) + one entry per runtime map
- [x] Updated the *existing* backends' prompts, shipit-docs
      (`agent.md`, `environment.md`, `skills.md`) and the voice dictation
      vocabulary

**8 — Client**
- [x] Theme CSS ×2 (`grok.css`, `grok-light.css`) + `index.css` ×4 edits +
      `useTheme`
- [x] `ProviderAccountRows` label table, `ServiceLogo` xAI mark, misc UI
      tables. No `ServicesPanel` sign-in card — Grok has no login flow at
      launch (req 6), so the API-key row is the whole surface.

**9 — Tests**
- [x] Extended the build-breaking parity tests (installer↔catalogue,
      registry counts ×3, reviewer-default guard, headless valid-agents
      message, plugin-skill roots, egress endpoints, theme count / palette /
      contrast); added `adapter.test.ts` and `config-toml.test.ts`

**10 — Verify empirically**
- [x] Skills-disclosure probe (docs/209): `.grok/skills/` AND `.claude/skills/`
      both disclosed, no symlink needed
- [x] Stream-capture conformance test: the two real tool-tour captures are
      vendored under `__fixtures__/` and replayed byte-for-byte, including a
      truncated-stream synthesized-result case
- [x] Live probes that changed the design: `--prompt-file`, `-s`/`-r`
      session-id pre-assignment, `$GROK_HOME/config.toml` as the only MCP
      path, `GROK_HOME`'s real layout, the `--output-format json` envelope,
      workspace trust
- [x] One dogfood turn per auth mode (billing route!) — **key mode only is
      in scope; the subscription turn is planning#435**. Done 2026-08-18 in
      two phases (first attempt blocked on egress; operator granted
      `api.x.ai` mid-run): full tour turn completed on grok-4.6 via the
      `xai:key` route (inner session `6305255a…`, 29s, side effects on
      disk, $0.1247 metered), and the **billing route is proven** by a
      canary + control pair — an invalid *stored* credential fails the turn
      with the CLI's auth error while the valid ambient env key sits unused,
      and restoring the stored value makes the same spawn succeed. Evidence:
      [docs/272 run 2026-08-18-1240](../272-harness-conversion-verification/runs/2026-08-18-1240-grok-1.0.1.md).
- [ ] `shipit agent run` both directions — **blocked structurally**
      2026-08-18: the outer install has no grok harness (and no grok role;
      an explicit grok target is unassemblable by design — no reasoning
      levels), and inner local mode has no `shipit` shim (planning#305).
      Same deferral shape as docs/268's. Details in the run doc above.
- [x] Event-conversion verification: the full docs/272 recipe run
      (tool-tour capture ✅, inventory diff, recognition matrix on persisted
      history + UI) —
      `docs/272-harness-conversion-verification/verification-checklist.md`.
      Ran 2026-08-18, **verdict RED, recorded**: the Step-2 inventory diff
      found no recognition registry claims any grok tool name — the adapter
      ships no transcript-vocabulary normalizer (planning#432 pattern) —
      and the Step-4 live tour confirmed it in persisted history AND the
      rendered DOM on the rehydration path (no task panel, no diff blocks,
      no subagent card; raw-name chips). Filed as **planning#437**; the
      matrix rows go green when it lands, with this run as the baseline to
      diff against. Also **planning#438** (a startup-dead grok turn
      persists no error row), observed live. Evidence:
      [docs/272 run 2026-08-18-1240](../272-harness-conversion-verification/runs/2026-08-18-1240-grok-1.0.1.md).
