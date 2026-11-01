# OpenCode 2 harness integration checklist

Copied from
[docs/266-harness-integration-recipe/integration-checklist.md](../266-harness-integration-recipe/integration-checklist.md);
every line is expanded, with file pointers and gotchas, in
[the recipe's plan.md](../266-harness-integration-recipe/plan.md). The
OpenCode 2 specifics are in [plan.md](./plan.md); the requirements are in
[requirements.md](./requirements.md).

**Phase 0 — assess (before any code)**
- [x] Candidate passes the 15-point capability checklist; start-blockers
      cleared (plan.md "Phase 0 status"; the MCP race is worked around by the
      per-turn server)
- [x] `supportsCompaction` settled by a real probe on the pinned CLI (2.1.1:
      `POST /compact` on the turn's server completed against a mock reply)
- [ ] `supportsReview` settled by the depth-0 probe with the real composed
      review message — needs a live model; declared from the structure
      (`shell` timeout, `subagent`) until then
- [x] Every capability `false` says WHY beside it — `supportsSteering` is
      not-wired, planning#707

**1 — Types**
- [x] Widen `AgentId` with `opencode2` (no new login/quota id: the ChatGPT
      route reuses `openai-chatgpt`, as on v1)
- [x] Widen the ESLint leak-guard regex + add the two folder exemptions

**2 — Catalogue**
- [x] `HarnessDef` row `opencode2`, placed BEFORE `opencode` (req 5 list
      order); binary `opencode2`
- [x] `opencode2` added to every credential `carriers` list that names
      `opencode` (req 4: same sign-in routes)
- [x] `OPENCODE2_TOOL_NAMES`

**3 — Install & images**
- [x] `install-agent-clis.sh`: known set, `@opencode/cli` prefix, `opencode2`
      binary, gated `npm rebuild @opencode/cli`, Codex pulled in for the
      ChatGPT route, `.bin/opencode` re-pointed at v1 after every rebuild, and
      a build failure if `opencode` still reports 2.x (req 2)
- [x] Pinned `@opencode/cli@2.1.1` in `docker/agent-cli/package.json` +
      lockfile
- [x] Default set unchanged (opt-in, docs/271); `deployment/vps/setup.sh` and
      `deployment/local/setup.sh` picker rows
- [x] Credential symlinks (`.local/share/opencode2`) in the 4 Dockerfiles +
      entrypoint prep
- [ ] Dogfood opt-in: pass `SHIPIT_HARNESSES` with `opencode2` to the dogfood
      build, rebuild `dev`, confirm the inner UI shows it installed

**4 — Tables**
- [x] Every required `Record<AgentId, …>` table
- [x] `buildLocalAgentFactory` switch
- [x] The four `buildAgentRuntime` Maps + the local
      `PARALLEL_SESSIONS_SECTIONS` map

**5 — Silent sites**
- [x] Validators, defaults, registry probes, MCP tool subset, shim help text,
      UI name tables
- [x] Every ChatGPT-projection site that special-cases `opencode` also
      covers `opencode2`, with v2's own projection directory
- [x] Req 5: every site that picks a harness from a model ranks `opencode2`
      first and prefers an installed harness; the reviewer and child-session
      rules stay ahead

**6 — Session adapter**
- [x] `session/agents/opencode2/`: per-turn `serve`, MCP readiness wait,
      `run --server`, per-step usage from the message list, server-tree
      teardown
- [x] Run-mode differences: v2 error line, `#variant` model suffix, new tool
      names, `part.id` call ids, `codemode: false`, PWD pin, live env names
- [x] Own data, config and state roots (never v1's)
- [x] ChatGPT token delivery: `auth import` (new id) + `auth switch` +
      `logout`, through the turn's server, re-run when the projection changes
      mid-turn
- [x] Register in `createWorkerAgent` + factory test

**7 — Orchestrator folder**
- [x] `orchestrator/agents/opencode2/` (run-params prep, system prompt) + one
      entry per runtime map
- [x] Session naming for `opencode2`
- [x] Update the other backends' prompts, shipit-docs, wiki, and the voice
      vocabulary that name CLIs by name (OpenCode 1's prompt stays unchanged,
      req 2)

**8 — Client**
- [x] Auth card (`ServicesPanel`) + `ProviderAccountRows` + misc UI tables
- [x] No new theme: themes are per brand, and OpenCode already has two

**9 — Tests**
- [x] Extend the build-breaking parity tests; adapter, server, account and
      normalizer tests; client fixtures

**10 — Verify empirically**
- [x] Re-verify the plan's run-mode findings on the pinned 2.1.1 through the
      real adapter against a mock provider (plan.md "Implementation")
- [ ] Real-account ChatGPT check (token accepted, the v2 route config, its
      model ids) — needs the user's account
- [ ] One dogfood turn per auth mode; `shipit agent run` both directions
- [ ] Probe whether a new process reads the previous turn's prompt cache;
      until then idle compaction skips OpenCode 2
