# Antigravity CLI harness — integration checklist

Copied from
[docs/266-harness-integration-recipe/integration-checklist.md](../266-harness-integration-recipe/integration-checklist.md);
the expansion of every line, with file pointers and gotchas, is in
[that recipe's plan.md](../266-harness-integration-recipe/plan.md). What is
Antigravity-specific is in [plan.md](./plan.md).

**Phase 0 — assess (before any code)**
- [x] Candidate passes the capability checklist items 1–5, 7–10 and 12
      (stream schema: documented and captured; auth: account token file +
      `GEMINI_API_KEY`; reasoning levels: `--effort low|medium|high`); the
      install mechanism (a non-npm branch of the same script) is the user's
      decision of 2026-09-13
- [x] Item 11 settled by a REAL probe: redirected to a local recorder
      (`probes/recorder.js`), `GOOGLE_GEMINI_BASE_URL` sends
      `<base>/v1beta/models/<id>:streamGenerateContent?alt=sse` with the key
      on `x-goog-api-key` (`probes/endpoint-redirect.ndjson`)
- [x] Item 6, runtime half: the pinned install is read-only to the worker uid,
      which covers every turn. The orchestrator-side spawns run as root and
      mode bits do not stop root — see "Still open" below; the orchestrator
      image does not ship the CLI at all, so nothing there can be updated
- [x] `supportsCompaction` (item 14) settled by a REAL probe on BOTH the first
      round's 1.2.2 and the pinned 1.1.27: `/compact` as a resumed headless
      turn's prompt reaches the model as text, no summary step — `false`,
      probed (`probes/compact-b.ndjson`, `probes/compact-1127.ndjson`)
- [ ] `supportsReview` (item 15) NOT settled. The depth-0 probe needs a live
      session on this harness with a credential that can fund a review turn;
      only a free-tier key (5 req/min) was available. Declared `false` with a
      **not-wired** basis rather than `true` unprobed; flipping it is one line
      once the probe runs. Tracked on planning#543
- [x] Every capability `false` (item 13) says WHY beside it (`harnesses.ts`)

**1 — Types**
- [x] `AgentId` widened; `LoginIntegrationId` gains `google-antigravity-oauth`;
      `QuotaIntegrationId` gains `google-antigravity-usage` (declared with no
      reader, so the account shows no meters); `ANTIGRAVITY_PERMISSION_MODES`
      has the full-auto member only (req 8)
- [x] ESLint leak-guard regex widened + the two folder exemptions added

**2 — Catalogue**
- [x] `HarnessDef` row (`styles: ["gemini-generate-content"]`); the `google`
      `ServiceDef` gained a `sub` mode for the account; the docs/302
      "vendor no harness speaks yet" guard is now join assertions
- [x] `GEMINI_API_KEY` declared in the `dev` compose service's
      `x-shipit-secrets` block (docs/302; `agent: true` since PR #2752)
- [x] `ANTIGRAVITY_TOOL_NAMES` (57 names, from `probes/flash-test.ndjson`)

**3 — Install & images**
- [x] `install-agent-clis.sh`: known set, `harness_pkg_prefix` sentinel arm,
      binary, tarball fetch + checksum + `chmod -R a-w` into
      `/opt/antigravity`, prune arm, `installed.json`
- [x] Version pin 1.1.27 (published 2026-09-05), hand-verified against the
      release list as the newest ≥ 7 days old
- [x] `SHIPIT_HARNESSES` defaults unchanged (installable-but-unchecked,
      docs/271); `HARNESS_ROWS` in both `deployment/*/setup.sh`
- [x] Dogfood opt-in: `antigravity` added to the hard-coded `SHIPIT_HARNESSES`
      build arg in BOTH dogfood blocks of `docker-compose.yml`
- [x] Credential symlink `/credentials/.gemini` in the 4 Dockerfiles + the
      `entrypoint.sh` gosu `mkdir -p` block and its read-only-home symlink
      block (which was also missing `.grok`)

**4 — Tables**
- [x] Every required `Record<AgentId, …>` table
- [x] `buildLocalAgentFactory` switch
- [x] The `buildAgentRuntime` maps (auth manager, run-params prep, parallel
      sessions) + the local `PARALLEL_SESSIONS_SECTIONS` map; the auth manager
      is covered by `catalogue.test.ts`'s "every declared login backed by a
      real auth manager" guard

**5 — Silent sites**
- [x] Validators, `?? "claude"` defaults, registry probes, MCP tool subset,
      shim help text, UI name tables, egress allowlist
- [x] Revocation: `SUBTREE_STATE_SUBPATHS` entry for `.gemini` listing the
      state subpaths *under* `antigravity-cli/`, and the removal now walks a
      preserved PATH rather than a bare name
- [x] Nested token path: `tokenFileNamesForSubtree` returns root-relative
      remainders, so `.gemini/antigravity-cli/antigravity-oauth-token` is
      visible to orphan discovery and leak repair
- [x] `settings.json` (`modelProvider`) derived by the adapter at every spawn
      from the home's own token presence
- [ ] Updater suppression probed **as root**. Not done: the orchestrator image
      does not install the CLI, so the sign-in and naming spawns can only run
      where it is installed read-only — but that reasoning is not a measurement

**6 — Session adapter**
- [x] `session/agents/antigravity/` (adapter + tool normalizer + tests) and
      `shared/antigravity-{home,stream}.ts`; registered in `createWorkerAgent`
- [x] Token accounting: the turn's step usages summed (a resumed run's
      `result.usage` is cumulative), context = last step's `input + cache_read`
      (cache reads sit outside `input`); the vendored captures are the fixtures

**7 — Orchestrator folder**
- [x] `orchestrator/agents/antigravity/` (auth manager with `submitCode`,
      run-params prep, system prompt; no limits provider — no usage reader
      exists) + one entry per runtime map
- [x] The *existing* backends' prompts, shipit-docs and the voice vocabulary
      updated to name the fifth CLI

**8 — Client**
- [x] Theme CSS ×2 + `index.css` + `useTheme`
- [x] Auth card: `ServicesPanel.tsx` paste-shape gate is now a set of
      paste-shaped providers; `ProviderAccountRows` label table

**9 — Tests**
- [x] The build-breaking parity tests extended (installer↔catalogue, registry
      list, reviewer ordering, headless validator message)
- [x] Token freshness reader against a committed fixture — see the caveat in
      `token-freshness-guard.test.ts`'s header: the KEY SET is a real
      observation, the file was not re-captured
- [x] Stream conformance replayed from the vendored `probes/*.ndjson`, and an
      adapter test whose guards were each proved red by mutation

**10 — Verify empirically**
- [ ] One dogfood turn per auth mode (billing route), `shipit agent run` both
      directions, and every declared capability flag confirmed against a real
      session. Blocked on a credential: the saved `GEMINI_API_KEY` is
      free-tier (5 req/min, zero quota on Pro)
- [ ] Event-conversion verification: the docs/272 recipe
      (`docs/272-harness-conversion-verification/verification-checklist.md`)
- [ ] Two fixtures still to capture from a real session: a failure **after
      partial output** (never observed; the outcome rule deliberately does not
      assume text implies success), and a real account token file to replace
      the reconstructed freshness fixture

## Still open

- **Updater suppression as root.** Proven for the unprivileged worker uid
  (the log line `Directory … is not fully accessible (readable: true,
  writable: false), skipping update`). The orchestrator-side spawns — sign-in
  and session naming — run as root, and mode bits do not stop root. In
  practice the orchestrator image never installs the CLI, so those spawns only
  happen in single-container installs; measure it there before relying on it.
- **`supportsReview`** — see Phase 0 above.
- **The account-mode host is inferred, not observed.** The egress allowlist
  gains `cloudcode-pa.googleapis.com` from the pinned binary's compiled host
  list, because no signed-in account was available to watch. Re-measure on the
  first real account turn and correct the entry if it is wrong.
